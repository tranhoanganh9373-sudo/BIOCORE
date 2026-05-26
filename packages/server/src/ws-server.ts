// ============================================================
// ws-server — WebSocketServer setup + connection auth + broadcast
// ============================================================
// Extracted from index.ts (v1.9.0 P2 bucket 1).
//
// createWsServer() builds a WebSocketServer attached to a given http
// server, wires the connection-time auth gate (JWT token / API key /
// AUTH_ENABLED=false dev fallback), and returns the server instance
// plus a hardened broadcast() helper.
//
// broadcast() preserves v1.7.1 hardening: per-client try/catch around
// ws.send() so a single misbehaving client cannot bubble synchronous
// throws into BatchController EventEmitter listeners and trip
// runtime-guard's uncaughtException handler.
// ============================================================

import http from 'http';
import { timingSafeEqual, randomUUID } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import type Database from 'better-sqlite3';

import { hashApiKey } from './middlewares/auth';
import type { MqttPublisher } from './mqtt-publisher';
import { PV_FIELDS } from './engine/realtime-broadcaster';
import { getRedisClient } from './lib/redis-client';
import { CRITICAL_CHANNELS, enqueueCriticalMessage } from './engine/ws-message-queue';

// ============================================================
// SP-PLC-3 Phase 3c Commit 2 (P3c.2) — subscription state Redis 镜像
// ============================================================
// 计划: docs/plans/SP-PLC-3-tag-cache-phase3c-plan.md  §1 Commit 2
//
// 目标: 让 ws subStates 跨 server 可查. 改造点:
//   - subStates 从 WeakMap<ws, SubscriptionState> 改 Map<clientId,
//     SubscriptionState>; key 由 connection 期生成的 clientId (uuid).
//   - 每 connection send back {type:'connection.id', clientId} 让 client 持有.
//   - subscribe/unsubscribe 处理后异步 mirror 到 Redis hash
//     `subscriptions:{SERVER_ID}:{clientId}` (field=reactorId, value=tags JSON).
//   - ws.on('close') 同步 delete Map entry + 异步 redis.del 整 hash.
//
// 兼容性:
//   - 老 client (不发 subscribe) → 无 hash 条目, Phase 1 全推路径不变.
//   - Redis 不可用 (getRedisClient() === null) → 本地 Map 仍工作, hash noop.
//   - handleSubscriptionMessage / getSubscriptionState / resolveReactorTags
//     函数签名不变 (仍接收 ws 参数), 内部读 (ws as any).clientId 查 Map.
//
// SERVER_ID 来源 (与 P3c.1 redis-cache-sync.serverId 独立 — 该 handle 在
// index.ts:3743 异步初始化, 远晚于 createWsServer 同步创建):
//   - env SERVER_ID 优先 (允许部署期固定 ID 让多实例升级时 hash key 稳定)
//   - 默认进程启动期 randomUUID, ws-server module 加载即固定
// 此 ID 与 P3c.1 cacheSyncHandle.serverId 不一定相同 (后者也 default UUID),
// 实际生产建议两者都用 env SERVER_ID 固定为同值 — 留 P3c.5 deployment doc.
// ============================================================
export const WS_SERVER_ID = process.env.SERVER_ID ?? randomUUID();

/** Redis hash key 格式: `subscriptions:{SERVER_ID}:{clientId}`. */
export function subscriptionHashKey(serverId: string, clientId: string): string {
  return `subscriptions:${serverId}:${clientId}`;
}

// ============================================================
// SP-PLC-3 Phase 2 Commit 3 (P2.3) — WS 客户端订阅协议
// ============================================================
// 单 ws 维护一个 SubscriptionState. subs=null 表示老 client (Phase 1
// 行为, 全推); 一旦收到任意 subscribe message → subs 切到 Map 模式, 后
// 续仅推订阅集合 (即使再 unsubscribe 到 Map 为空也不回退 null).
//
// WeakMap 让 ws 被 GC 时 entry 自动清, 但生命周期不可见; 因此 ws.on('close')
// 显式 delete(ws) 作兜底 (plan §2a 双保).
// ============================================================
export interface SubscriptionState {
  /**
   * null = 老 client 没 subscribe → 全推 (Phase 1 兼容).
   * Map<reactorId, Set<tag> | '*'> = 显式订阅; '*' 表示该 reactor 下全 tag.
   * Map 内还可以用 reactorId='*' 作 wildcard (订阅所有 reactor).
   */
  subs: null | Map<string, Set<string> | '*'>;
}

// SP-PLC-3 P3c.2: 从 WeakMap<ws> 改 Map<clientId>. clientId 在 ws.on('connection')
// 时生成并写到 (ws as any).clientId, 之后整链 (handleSubscriptionMessage /
// getSubscriptionState / fan-out) 都按 clientId 查. ws.on('close') 显式 delete
// (无 GC 自动清理), 同时 redis.del 整 hash.
const subStates = new Map<string, SubscriptionState>();

/** 仅供测试: 清空 module-scope subStates, 避免跨 it 污染. */
export function __resetSubStatesForTests(): void {
  subStates.clear();
}

/** 从 ws 实例读 clientId. P3c.2 起 createWsServer 在 connection 期注入. */
function getClientId(ws: WebSocket): string | undefined {
  return (ws as any).clientId;
}

/** broadcaster (或测试) 读 ws 的订阅状态. */
export function getSubscriptionState(ws: WebSocket): SubscriptionState | undefined {
  const cid = getClientId(ws);
  if (!cid) return undefined;
  return subStates.get(cid);
}

/**
 * 序列化 SubscriptionState.subs.get(reactorId) 给 Redis hash field 用.
 * '*' → 字符串 "*"; Set → JSON array; 其它 → "[]".
 */
function serializeReactorTags(value: Set<string> | '*' | undefined): string {
  if (value === '*') return '*';
  if (value instanceof Set) return JSON.stringify(Array.from(value));
  return '[]';
}

/**
 * SP-PLC-3 P3c.2: 把 subscribe/unsubscribe 操作的最终 reactor tag 集合
 * 镜像到 Redis hash. async fire-and-forget — Redis 不可用 (getRedisClient 返
 * null) 直接 noop; 任何 redis 错误 console.error 吞, 不传回 caller (避免
 * 把网络抖动暴露给 handleSubscriptionMessage 调用方).
 *
 * 设计说明:
 *   - 每次 subscribe(R, tags) → hset(key, R, serialize(tags))
 *   - unsubscribe(R, '*' | null) → hdel(key, R)
 *   - unsubscribe(R, [...]) 减集合, 减空 → hdel(key, R), 否则 hset 覆盖
 *   - state 删 reactor 后我们 read state 再写, 保证 hash 与 Map 一致
 */
function mirrorSubscribeToRedis(
  clientId: string,
  reactorId: string,
  state: SubscriptionState,
): void {
  const redis = getRedisClient();
  if (!redis) return;
  const key = subscriptionHashKey(WS_SERVER_ID, clientId);
  const existing = state.subs?.get(reactorId);
  if (existing === undefined) {
    // reactor 已从 Map 删 (e.g. unsubscribe 把集合减空)
    redis.hdel(key, reactorId).catch((err: Error) => {
      console.error(`[ws-server] redis.hdel ${key} ${reactorId} failed:`, err.message);
    });
    return;
  }
  redis.hset(key, reactorId, serializeReactorTags(existing)).catch((err: Error) => {
    console.error(`[ws-server] redis.hset ${key} ${reactorId} failed:`, err.message);
  });
}

/**
 * 解析客户端 subscribe/unsubscribe message, 应用到指定 ws 的 SubscriptionState.
 * 抽出来便于单元测试 (绕过 真实 ws.on('message') 注入).
 *
 * 返回:
 *   - true: 消息合法已应用
 *   - false: 消息非法 (缺字段 / 类型错 / 缺 clientId) — 静默忽略 (不抛, 不 close)
 *
 * SP-PLC-3 P3c.2: 函数签名不变 (兼容 P2.3 测试). 内部读 (ws as any).clientId,
 * 缺 clientId → 返 false (老调用者忘了在 connection 期注入 → 静默忽略, 与原
 * "非法 message" 路径一致). 同时把成功操作 mirror 到 Redis hash.
 */
export function handleSubscriptionMessage(ws: WebSocket, msg: any): boolean {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.type !== 'subscribe' && msg.type !== 'unsubscribe') return false;
  if (typeof msg.reactorId !== 'string' || !msg.reactorId) return false;

  const clientId = getClientId(ws);
  if (!clientId) return false;

  let state = subStates.get(clientId);

  if (msg.type === 'subscribe') {
    if (!state) {
      state = { subs: new Map() };
      subStates.set(clientId, state);
    }
    if (!state.subs) state.subs = new Map();
    const tagSet: Set<string> | '*' =
      msg.tags === '*' ? '*' : Array.isArray(msg.tags) ? new Set(msg.tags) : new Set();
    state.subs.set(msg.reactorId, tagSet);
    mirrorSubscribeToRedis(clientId, msg.reactorId, state);
    return true;
  }

  // unsubscribe
  if (!state || !state.subs) return false;
  if (msg.tags === '*' || msg.tags == null) {
    state.subs.delete(msg.reactorId);
  } else if (Array.isArray(msg.tags)) {
    const existing = state.subs.get(msg.reactorId);
    if (existing === '*') {
      // 从 wildcard 退化到指定 tag 减集合, 当前 spec 不支持; 直接整 reactor 删
      state.subs.delete(msg.reactorId);
    } else if (existing instanceof Set) {
      for (const tag of msg.tags) existing.delete(tag);
      if (existing.size === 0) state.subs.delete(msg.reactorId);
    }
  }
  mirrorSubscribeToRedis(clientId, msg.reactorId, state);
  return true;
}

/**
 * 给定 ws + reactorId, 解析该 ws 订阅的 tag 集:
 *   - null = 老 client (subs=null) → 全推
 *   - '*' = 该 reactor 全 tag 推
 *   - Set<string> = 仅推这些 tag
 *   - undefined = 已订阅但不含此 reactor → 不推
 */
export function resolveReactorTags(
  state: SubscriptionState | undefined,
  reactorId: string,
): null | '*' | Set<string> | undefined {
  if (!state || !state.subs) return null; // 老 client
  const direct = state.subs.get(reactorId);
  const wild = state.subs.get('*');
  if (direct === '*' || wild === '*') return '*';
  if (direct instanceof Set && wild instanceof Set) {
    const merged = new Set(direct);
    for (const t of wild) merged.add(t);
    return merged;
  }
  if (direct instanceof Set) return direct;
  if (wild instanceof Set) return wild;
  return undefined;
}

/**
 * 给定 full pv_realtime payload + 订阅 tag 集合, 生成 subset payload.
 * subset 仅含订阅 tag 的字段 + 对应 quality + 必要 meta (timestamp/batch_id/temp_mode).
 * 若 subset 不含任何 PV field 返 null (caller skip send).
 */
export function buildSubsetPvPayload(
  fullPayload: any,
  subscribedTags: Set<string>,
): any | null {
  const subset: Record<string, any> = {
    timestamp: fullPayload.timestamp,
    batch_id: fullPayload.batch_id,
  };
  if (typeof fullPayload.temp_mode !== 'undefined') subset.temp_mode = fullPayload.temp_mode;
  const subsetQuality: Record<string, string> = {};
  let hasField = false;
  for (const { field, tag } of PV_FIELDS) {
    if (subscribedTags.has(tag)) {
      subset[field] = fullPayload[field];
      if (fullPayload.quality && typeof fullPayload.quality[tag] !== 'undefined') {
        subsetQuality[tag] = fullPayload.quality[tag];
      }
      hasField = true;
    }
  }
  if (!hasField) return null;
  subset.quality = subsetQuality;
  return subset;
}

/** 控制是否启用 P2.3 订阅过滤 (hot-rollback 开关, plan §4). */
const WS_SUBSCRIPTION_ENABLED =
  (process.env.WS_SUBSCRIPTION_ENABLED ?? 'true').toLowerCase() !== 'false';

// ============================================================
// SP-PLC-3 Phase 3a Commit 1 (P3a.1) — WS msgpack 二进制协议
// ============================================================
// 协议协商: client connect 时附 `?wire=msgpack` query → server 解析存
// (ws as any).wireMode; 老 client 不传 query → wireMode='json' (Phase 2
// 行为完全一致). 非法值 (e.g. wire=xml) → 默认 'json' (不抛, 不 close).
//
// Hot-rollback: WS_WIRE_MODE_FORCED=json 全 client 强制 JSON, 无视 query.
// 用于线上 msgpack 解码出 bug 时立即回退, 不需 client 端 deploy.
// ============================================================
export type WireMode = 'msgpack' | 'json';

const WS_WIRE_MODE_FORCED = (process.env.WS_WIRE_MODE_FORCED ?? '').toLowerCase();

/**
 * 从 connection 时 req.url 解析 wireMode. 老 client / 无 query / 非法值 / env
 * 强制 → 'json'. 仅 query 严格 = 'msgpack' 且未被 env force 时 → 'msgpack'.
 */
export function resolveWireMode(reqUrl: string | undefined, host: string | undefined): WireMode {
  if (WS_WIRE_MODE_FORCED === 'json') return 'json';
  try {
    const url = new URL(reqUrl ?? '', `ws://${host ?? 'localhost'}`);
    const wire = url.searchParams.get('wire');
    return wire === 'msgpack' ? 'msgpack' : 'json';
  } catch {
    return 'json';
  }
}

/**
 * 给定 envelope (broadcast 全推或 subset), 按 client.wireMode 选择 serializer.
 * msgpack → Uint8Array (ws.send → binary frame opcode=2);
 * json    → string      (ws.send → text frame opcode=1).
 *
 * 调用方: broadcast fan-out 内. 为避免重复 encode (同 envelope 推 N 个 client),
 * 建议 caller 用 cache 包装 (见 ws-server.ts broadcast() 内 getJSON/getMsgpack).
 */
export function serializeForClient(
  wireMode: WireMode,
  envelope: any,
): string | Uint8Array {
  return wireMode === 'msgpack' ? msgpackEncode(envelope) : JSON.stringify(envelope);
}

// SP-FX-47 F-06 (HIGH): timing-safe API Key hash 比较，防止 timing attack。
// hashApiKey 输出固定 64-char hex (SHA-256)；防御性处理长度不等情况。
export function safeCompareApiKeyHash(computed: string, stored: string): boolean {
  if (!computed || !stored) return false;
  const bufA = Buffer.from(computed);
  const bufB = Buffer.from(stored);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export type BroadcastFn = (
  channel: string,
  payload: any,
  batchId?: string | null,
  reactorId?: string | null,
) => void;

export interface WsServerHandles {
  wss: WebSocketServer;
  broadcast: BroadcastFn;
}

export interface CreateWsServerOptions {
  server: http.Server;
  sqlite: { getDatabase: () => Database.Database };
  verifyJWT: (token: string) => Record<string, any> | null;
  authEnabled: boolean;
  mqttPublisher?: MqttPublisher;   // 可选: 提供时所有 broadcast 自动 mirror 到 MQTT topic
  /**
   * SP-PLC-3 P2.5: 可选 skip 事件回调. pv_realtime fan-out 时若某 client
   * 因 subscription 不匹配而 skip (subs Map 不含 reactor / subset payload
   * 命中 0 字段), 调一次 onSkip('no-subscription'). 用于 cache-metrics 累计
   * biocore_broadcaster_skipped_total{reason='no-subscription'} 计数器.
   * 不传 → 行为不变 (老 wiring 兼容).
   */
  onSkip?: (reason: 'no-subscription') => void;
  /**
   * SP-PLC-3 P3c.3: 可选 critical channel 入队回调. 注入时所有 channel ∈
   * CRITICAL_CHANNELS ('alarm' | 'state_update' | 'recipe_downloaded') 的
   * broadcast 走 ws_message_queue 可靠投递 (per-client per-message enqueue);
   * 不注入 → critical 退化为现有全推路径 (Phase 2 行为, 向后兼容).
   *
   * 函数签名只暴露 enqueueWsMessage 单方法 (避免拉整 SQLiteService 类型),
   * 与 engine/ws-message-queue.ts 的 WsQueueSqliteShape 子集兼容. 实际接通
   * 在 P3c.5 server 启动期: opts.enqueueWsMessage = (e) => sqlite.enqueueWsMessage(e).
   */
  enqueueWsMessage?: (entry: { client_id: string; channel: string; payload: any }) => number;
}

export function createWsServer(opts: CreateWsServerOptions): WsServerHandles {
  const { server, sqlite, verifyJWT, authEnabled, mqttPublisher, onSkip, enqueueWsMessage } = opts;

  const wss = new WebSocketServer({ server, path: '/ws' });

  const broadcast: BroadcastFn = (channel, payload, batchId, reactorId) => {
    // 镜像到 MQTT (fire-and-forget, 失败不阻塞 WS 主路径)
    if (mqttPublisher) {
      try {
        mqttPublisher.publish(channel, payload, batchId, reactorId);
      } catch (e) {
        console.warn(`[MQTT-mirror] publish 失败 channel=${channel}: ${(e as Error).message}`);
      }
    }

    const envelope = {
      channel,
      timestamp: new Date().toISOString(),
      batch_id: batchId ?? null,
      reactor_id: reactorId ?? null,
      payload,
    };

    // SP-PLC-3 P3c.3: critical channel (alarm/state_update/recipe_downloaded)
    // 走 ws_message_queue 可靠投递. per-online-client per-message 入队 →
    // dispatcher tick 真正 ws.send + ack 跟踪 (P3c.4). 入队后直接 return,
    // 不走下方 fan-out 路径 (避免重复发送). MQTT mirror 已在前面发出 (critical
    // channel 通常需要审计, MQTT 镜像保留独立路径).
    //
    // 不变量:
    //   - opts.enqueueWsMessage 未注入 (P3c.5 之前 / hot-rollback) → critical
    //     仍走全推路径 (Phase 2 行为, 兼容性优先).
    //   - critical 不参与 wireMode (msgpack/json) — dispatcher 统一 JSON 字符串.
    //     P3c.4 引入 msg_id 后仍 JSON, msgpack 优化留 Phase 3d.
    //   - per-client envelope 含整 channel + payload (与 fan-out 路径 envelope
    //     结构对齐), batch_id/reactor_id/timestamp 字段暂未入队 — caller 业务
    //     通常已嵌在 payload 内 (e.g. alarm.batch_id), P3c.3 不引入字段冗余.
    if (enqueueWsMessage && CRITICAL_CHANNELS.has(channel)) {
      wss.clients.forEach((client) => {
        if (client.readyState !== WebSocket.OPEN) return;
        const cid = (client as any).clientId;
        if (typeof cid !== 'string' || !cid) return; // 老 client 无 clientId → skip queue
        try {
          enqueueCriticalMessage(
            { enqueueWsMessage },
            cid,
            channel,
            payload,
          );
        } catch (e) {
          // 入队失败 (sqlite 异常) — 不冒泡到 EventEmitter caller, console.warn 留痕
          console.warn(`[WS] critical channel enqueue 失败 channel=${channel} cid=${cid}: ${(e as Error).message}`);
        }
      });
      return;
    }

    // SP-PLC-3 P3a.1: per-tick serializer cache. 同 envelope 推 N 个 client
    // 时一次 encode 一次 stringify (lazy), 避免每 client 重复. mixed clients
    // (msgpack + json) 各只算一次. 老 JSON 路径行为不变, 只是延迟到 first read.
    let cachedJSON: string | null = null;
    let cachedMsgpack: Uint8Array | null = null;
    const getJSON = (): string => (cachedJSON ??= JSON.stringify(envelope));
    const getMsgpack = (): Uint8Array => (cachedMsgpack ??= msgpackEncode(envelope));

    // SP-PLC-3 P2.3: 仅 pv_realtime 走 per-client 订阅过滤. 其它 channel
    // (alarm/step_progress/heartbeat/scada:* 等) 全推 — 与 Phase 1 行为
    // 完全一致, 不在 P2.3 spec scope. 老 client (subs=null) 即使在 pv_realtime
    // 路径下也是全推 (Phase 1 兼容, Open Q (ii) 推荐 A).
    const useFilter =
      WS_SUBSCRIPTION_ENABLED && channel === 'pv_realtime' && typeof reactorId === 'string';

    // v1.7.1 hardening: ws.send() can throw synchronously when the underlying
    // socket is half-closed or its send buffer is exhausted. The broadcast()
    // helper is invoked from EventEmitter listeners (phase_started /
    // phase_completed / branch_evaluated) — letting an exception escape would
    // bubble through ctrl.emit() into readyNextPhase() and trip runtime-guard's
    // uncaughtException handler, taking the whole server down for a single
    // misbehaving WS client. Wrap each per-client send so one bad client cannot
    // crash the engine.
    wss.clients.forEach((client) => {
      if (client.readyState !== WebSocket.OPEN) return;

      // SP-PLC-3 P3a.1: 每 client 一套 wireMode 选择 serializer. 默认 'json'
      // 兼容 connection-handler 未设置的旧路径 (e.g. AUTH_ENABLED=false 早返).
      const wireMode: WireMode = (client as any).wireMode === 'msgpack' ? 'msgpack' : 'json';

      let payloadToSend: string | Uint8Array;
      if (useFilter) {
        // SP-PLC-3 P3c.2: subStates 改 Map<clientId>, fan-out 按 clientId 查.
        // 老 client (无 clientId, 不应发生因 connection 期总会注入, 防御性兼容)
        // → state=undefined → resolveReactorTags 返 null → 全推.
        const state = getSubscriptionState(client);
        const resolved = resolveReactorTags(state, reactorId as string);
        if (resolved === null) {
          // 老 client — 全推 (Phase 1 兼容)
          payloadToSend = wireMode === 'msgpack' ? getMsgpack() : getJSON();
        } else if (resolved === undefined) {
          // 已订阅但不含此 reactor → skip
          // SP-PLC-3 P2.5: 累计 no-subscription skip 度量 (try/catch 隔离).
          if (onSkip) {
            try { onSkip('no-subscription'); } catch (e) {
              console.warn(`[WS] onSkip threw: ${(e as Error).message}`);
            }
          }
          return;
        } else if (resolved === '*') {
          payloadToSend = wireMode === 'msgpack' ? getMsgpack() : getJSON();
        } else {
          // Set<string> — 仅推订阅 tag 子集. subset envelope 不命中 cache
          // (每 client subset 不同), 直接 serialize 一次给该 client.
          const subsetPayload = buildSubsetPvPayload(payload, resolved);
          if (!subsetPayload) {
            // 无任何订阅字段命中 → skip
            // SP-PLC-3 P2.5: 同上, 累计 no-subscription skip 度量.
            if (onSkip) {
              try { onSkip('no-subscription'); } catch (e) {
                console.warn(`[WS] onSkip threw: ${(e as Error).message}`);
              }
            }
            return;
          }
          payloadToSend = serializeForClient(wireMode, { ...envelope, payload: subsetPayload });
        }
      } else {
        payloadToSend = wireMode === 'msgpack' ? getMsgpack() : getJSON();
      }

      try {
        client.send(payloadToSend);
      } catch (e) {
        console.warn(`[WS] broadcast send failed (channel=${channel}):`, (e as Error).message);
      }
    });
  };

  // WS 鉴权:
  //   - 客户端连接 ws://localhost:3001/ws?token=<JWT>  (前端 UI)
  //   - 或 ws://localhost:3001/ws?api_key=<rawKey>     (MES/外部系统)
  //   - 或 X-API-Key header 方式 (但 WebSocket 标准不推荐 header)
  //   - 鉴权失败 close(1008, 'Unauthorized')
  //   - 开发回退: AUTH_ENABLED=false 时跳过验证 (与 HTTP middleware 一致)
  wss.on('connection', (ws, req) => {
    const remoteIp = req.socket.remoteAddress;
    let user: any = null;

    if (authEnabled) {
      try {
        const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
        const token = url.searchParams.get('token');
        const apiKey = url.searchParams.get('api_key') || (req.headers['x-api-key'] as string | undefined);

        if (apiKey) {
          // 验证 API Key
          const dotIdx = apiKey.indexOf('.');
          if (dotIdx > 0) {
            const keyId = apiKey.slice(0, dotIdx);
            const rawKey = apiKey.slice(dotIdx + 1);
            const row: any = sqlite.getDatabase().prepare(
              'SELECT key_hash, salt, scopes FROM api_keys WHERE key_id = ? AND revoked = 0'
            ).get(keyId);
            // SP-FX-47 F-06: 使用 timingSafeEqual 防止 timing attack
            if (row && safeCompareApiKeyHash(hashApiKey(rawKey, row.salt), row.key_hash)) {
              user = { user_id: `apikey:${keyId}`, role: 'service' };
              sqlite.getDatabase().prepare('UPDATE api_keys SET last_used_at = datetime("now") WHERE key_id = ?').run(keyId);
            }
          }
        } else if (token) {
          const payload = verifyJWT(token);
          if (payload) user = payload;
        }
      } catch { /* parse error → user 仍为 null */ }

      if (!user) {
        console.warn(`[${new Date().toISOString()}] [WARN] [WS] 未授权连接拒绝: ${remoteIp}`);
        ws.close(1008, 'Unauthorized');
        return;
      }
    } else {
      // 开发模式回退
      user = { user_id: 'admin-001', role: 'admin' };
    }

    (ws as any).user = user;

    // SP-PLC-3 P3a.1: 解析 wireMode 存到 ws 实例 (`?wire=msgpack` query
    // → 'msgpack', 否则 'json'). broadcast 内 fan-out 读此字段选 serializer.
    // WS_WIRE_MODE_FORCED=json 强制全 client JSON (hot-rollback).
    (ws as any).wireMode = resolveWireMode(req.url, req.headers.host);

    // SP-PLC-3 P3c.2: 生成 clientId 并 send back 给 client. clientId 是
    // subStates Map / Redis hash key 的 key, 也是后续 ack message (P3c.4) 用.
    // send 失败 (ws 已 close) try/catch 吞, 不阻塞 connection handler.
    const clientId = randomUUID();
    (ws as any).clientId = clientId;
    try {
      ws.send(JSON.stringify({ type: 'connection.id', clientId }));
    } catch (e) {
      console.warn(`[WS] send connection.id failed for ${clientId}: ${(e as Error).message}`);
    }

    console.log(`[${new Date().toISOString()}] [INFO] [WS] 客户端连接 user=${user.user_id} clientId=${clientId} wire=${(ws as any).wireMode} from=${remoteIp} (总数: ${wss.clients.size})`);

    // SP-PLC-3 P2.3: 处理客户端 subscribe / unsubscribe message. 不合法消息
    // (parse 失败 / type 不识别) 静默忽略 — 不抛, 不 close, 兼容老 client (它们
    // 不发任何 message → subStates 永远没有 entry → broadcast 走 subs=null
    // 全推路径, Phase 1 行为完全一致).
    ws.on('message', (rawData) => {
      let msg: any;
      try {
        msg = JSON.parse(rawData.toString());
      } catch {
        return;
      }
      // P2.3 仅处理订阅协议; 其它 message type (writeTag 等)
      // 已有 handler 在别处接管 — 我们的 handleSubscriptionMessage 返 false 不影响.
      handleSubscriptionMessage(ws, msg);
    });

    ws.on('close', () => {
      // SP-PLC-3 P3c.2: subStates 是 Map<clientId>, 显式删 entry (无 GC
      // 自动清理 — 不删 → 内存泄漏). 同时 redis.del 整 hash 让跨 server
      // query 不会看到僵尸 subscription (异步, 错误吞).
      subStates.delete(clientId);
      const redis = getRedisClient();
      if (redis) {
        const key = subscriptionHashKey(WS_SERVER_ID, clientId);
        redis.del(key).catch((err: Error) => {
          console.error(`[ws-server] redis.del ${key} failed:`, err.message);
        });
      }
      console.log(`[${new Date().toISOString()}] [INFO] [WS] 客户端断开 user=${user.user_id} clientId=${clientId} (剩余: ${wss.clients.size})`);
    });
  });

  return { wss, broadcast };
}
