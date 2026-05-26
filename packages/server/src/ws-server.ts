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
import { timingSafeEqual } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type Database from 'better-sqlite3';

import { hashApiKey } from './middlewares/auth';
import type { MqttPublisher } from './mqtt-publisher';
import { PV_FIELDS } from './engine/realtime-broadcaster';

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

const subStates = new WeakMap<WebSocket, SubscriptionState>();

/** broadcaster (或测试) 读 ws 的订阅状态. */
export function getSubscriptionState(ws: WebSocket): SubscriptionState | undefined {
  return subStates.get(ws);
}

/**
 * 解析客户端 subscribe/unsubscribe message, 应用到指定 ws 的 SubscriptionState.
 * 抽出来便于单元测试 (绕过 真实 ws.on('message') 注入).
 *
 * 返回:
 *   - true: 消息合法已应用
 *   - false: 消息非法 (缺字段 / 类型错) — 静默忽略 (不抛, 不 close)
 */
export function handleSubscriptionMessage(ws: WebSocket, msg: any): boolean {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.type !== 'subscribe' && msg.type !== 'unsubscribe') return false;
  if (typeof msg.reactorId !== 'string' || !msg.reactorId) return false;

  let state = subStates.get(ws);

  if (msg.type === 'subscribe') {
    if (!state) {
      state = { subs: new Map() };
      subStates.set(ws, state);
    }
    if (!state.subs) state.subs = new Map();
    const tagSet: Set<string> | '*' =
      msg.tags === '*' ? '*' : Array.isArray(msg.tags) ? new Set(msg.tags) : new Set();
    state.subs.set(msg.reactorId, tagSet);
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
}

export function createWsServer(opts: CreateWsServerOptions): WsServerHandles {
  const { server, sqlite, verifyJWT, authEnabled, mqttPublisher } = opts;

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
    const fullMsg = JSON.stringify(envelope);

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

      let payloadToSend: string = fullMsg;
      if (useFilter) {
        const state = subStates.get(client);
        const resolved = resolveReactorTags(state, reactorId as string);
        if (resolved === null) {
          // 老 client — 全推 (Phase 1 兼容)
          payloadToSend = fullMsg;
        } else if (resolved === undefined) {
          // 已订阅但不含此 reactor → skip
          return;
        } else if (resolved === '*') {
          payloadToSend = fullMsg;
        } else {
          // Set<string> — 仅推订阅 tag 子集
          const subsetPayload = buildSubsetPvPayload(payload, resolved);
          if (!subsetPayload) return; // 无任何订阅字段命中 → skip
          payloadToSend = JSON.stringify({ ...envelope, payload: subsetPayload });
        }
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
    console.log(`[${new Date().toISOString()}] [INFO] [WS] 客户端连接 user=${user.user_id} from=${remoteIp} (总数: ${wss.clients.size})`);

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
      // SP-PLC-3 P2.3: WeakMap 兜底删除 — ws GC 后 entry 自动消失,
      // 但显式 delete 让生命周期可见 (plan §2a 双保).
      subStates.delete(ws);
      console.log(`[${new Date().toISOString()}] [INFO] [WS] 客户端断开 user=${user.user_id} (剩余: ${wss.clients.size})`);
    });
  });

  return { wss, broadcast };
}
