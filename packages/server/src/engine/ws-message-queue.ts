// ============================================================
// SP-PLC-3 Phase 3c Commit 3 (P3c.3) — ws_message_queue dispatcher
// SP-PLC-3 Phase 3c Commit 4 (P3c.4) — msg_id + 客户端 ack 机制
// ============================================================
// 计划: docs/plans/SP-PLC-3-tag-cache-phase3c-plan.md  §1 Commit 3 / Commit 4
//
// 角色: critical WS channel (alarm / state_update / recipe_downloaded) 的
// 可靠投递 dispatcher. 模板复用 packages/server/src/engine/scada-write-dispatcher.ts
// (500ms tick + claim/markDelivered/incrementRetry/rollbackInProgress).
//
// 协议:
//   - enqueueCriticalMessage(sqlite, clientId, channel, payload)
//     → sqlite.enqueueWsMessage 入队, 立即返回 row id (caller fire-and-forget).
//   - dispatcher tick (默认 500ms):
//       1. claimPendingWsMessages(batchSize=100) — 原子取一批 'pending' 改 'dispatching'
//       2. 对每行: findClientById(clientId) 查 ws.clients
//          - 不在线/未 OPEN → incrementWsMessageRetry('client offline')
//          - send 异常 → retry_count+1 >= maxRetries(3) markFailed, 否则 incrementRetry
//          - send 成功 → 放入 pendingAcks Map (P3c.4); 不再立即 markDelivered
//       3. checkAckTimeouts: 扫 pendingAcks, sentAt + ackTimeoutMs (默认 5000)
//          超时则 incrementWsMessageRetry('ack timeout') 让下一 tick claim 重投递.
//   - server 收到 client {type:'ack', msg_id} → markAckReceived(sqlite, msgId):
//       1. pendingAcks.get(msgId) 不存在 → 返 false (idempotent: 重复 ack / 已 timeout / 未知 id)
//       2. 存在 → markWsMessageDelivered(rowId) + pendingAcks.delete(msgId) + 返 true
//
// 不变量:
//   - 启动期 rollbackInProgressWsMessages() 复位上次崩溃残留 'dispatching'.
//   - msg_id 直接复用 row.id (sqlite autoincrement, 全局唯一), 不额外生成 uuid.
//   - pendingAcks 是 module scope Map<msgId, {rowId, sentAt}>; dispatcher stop
//     不主动清 (acceptable: server restart 由 rollbackInProgressWsMessages 恢复).
//   - critical channel 入队判定在 ws-server.ts broadcast() 内, 本模块不感知
//     channel 白名单, 仅按入队顺序投递.
//   - ack 超时不区分 retry_count, 复用 incrementWsMessageRetry; sqlite 内部
//     根据 row 当前 retry_count + maxRetries 决定是否升级 failed (与 send-fail
//     路径不同 — 后者用 claim 快照 retry_count + 1 vs max 判定).
// ============================================================

import type { WebSocket } from 'ws';

const DEFAULT_TICK_MS = 500;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_RETRIES = 3;
/** P3c.4: ack 超时默认 5s (Q(iv) 默认值). 超时后 incrementRetry 让下一 tick 重投. */
const DEFAULT_ACK_TIMEOUT_MS = 5000;

/**
 * P3c.4: 已 send 但还没收 ack 的消息. msg_id (= row.id) → {rowId, sentAt}.
 * module scope: 跨 tick 跟踪; dispatcher 多 handle 共用 (实际只 1 个).
 * server restart 后清空 → 残留 'dispatching' row 靠 rollbackInProgressWsMessages
 * 重置为 'pending', 下一 tick 自然重投递, 不会丢消息.
 */
const pendingAcks = new Map<number, { rowId: number; sentAt: number }>();

/** 仅供测试: 清空 pendingAcks, 避免跨 it 污染. */
export function __resetPendingAcksForTests(): void {
  pendingAcks.clear();
}

/** 仅供测试 / 调试: 暴露当前 pendingAcks 大小. */
export function getPendingAckCount(): number {
  return pendingAcks.size;
}

/** 测试或 server 启动期使用的最小 sqlite shape (避免 import 整 SQLiteService). */
export interface WsQueueSqliteShape {
  enqueueWsMessage(entry: { client_id: string; channel: string; payload: any }): number;
  claimPendingWsMessages(limit: number): any[];
  markWsMessageDelivered(id: number): void;
  incrementWsMessageRetry(id: number, err: string): void;
  markWsMessageFailed(id: number, err: string): void;
  rollbackInProgressWsMessages(): void;
}

/** 仅暴露 dispatcher 需要的 wss 字段 (clients Set), 便于 mock. */
export interface WsServerShape {
  clients: Set<WebSocket> | Iterable<WebSocket>;
}

export interface WsMessageQueueDeps {
  sqlite: WsQueueSqliteShape;
  wss: WsServerShape;
  /** tick 周期 ms, 默认 500. */
  tickMs?: number;
  /** 每 tick 取最多多少行, 默认 100. */
  batchSize?: number;
  /** 重试上限 (>= 即终态 failed), 默认 3. */
  maxRetries?: number;
  /** P3c.4: ack 超时 ms (超时后 incrementRetry), 默认 5000. */
  ackTimeoutMs?: number;
  /** P3c.4: 注入 now() 便于假时钟测试; 默认 Date.now. */
  now?: () => number;
}

export interface WsQueueDispatcherHandle {
  stop(): void;
  /** 暴露给测试: 手动跑一次 tick (不等 timer). */
  tickOnce(): void;
}

/**
 * 把一条 critical 消息入队. caller 在 ws-server.ts broadcast() 内对每个匹配
 * 订阅的 client 调用一次 (per-client 入队 = per-client at-least-once 投递).
 * 返回 row id 供调试/metrics, 入队失败抛 (caller 决定吞还是冒泡).
 */
export function enqueueCriticalMessage(
  sqlite: Pick<WsQueueSqliteShape, 'enqueueWsMessage'>,
  clientId: string,
  channel: string,
  payload: any,
): number {
  return sqlite.enqueueWsMessage({ client_id: clientId, channel, payload });
}

/**
 * 启动 dispatcher. 返回 handle 可 stop (clearInterval) + tickOnce (测试用).
 * 调用方负责在 server 退出期调 stop() 避免 leak.
 */
export function startWsMessageQueueDispatcher(deps: WsMessageQueueDeps): WsQueueDispatcherHandle {
  const tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
  const ackTimeoutMs = deps.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  const nowFn = deps.now ?? Date.now;

  // 启动期复位上次崩溃残留 (与 scada-write-dispatcher 同模式).
  deps.sqlite.rollbackInProgressWsMessages();

  const tick = (): void => {
    const rows = deps.sqlite.claimPendingWsMessages(batchSize);
    for (const row of rows) {
      dispatchOne(row, deps, maxRetries, nowFn);
    }
    // P3c.4: 同 tick 内一并跑 ack 超时检查 (减少 timer 数; tickMs=500 << ackTimeoutMs=5000
    // 精度足够). 独立 timer 仅在测试 (tickMs=10000) 时 ack 检测延迟, 实际生产 OK.
    checkAckTimeouts(deps, ackTimeoutMs, nowFn());
  };

  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    try {
      tick();
    } catch (err) {
      console.error('[ws-msg-queue] tick error:', (err as Error).message);
    }
  }, tickMs);

  return {
    stop: () => clearInterval(timer),
    tickOnce: tick,
  };
}

/**
 * 单条 row 投递. 失败分两类:
 *   - client 不在线 (找不到 / readyState !== OPEN) → incrementRetry('client offline')
 *     注: 这里也算一次 retry, 防止僵尸 row 永远 pending. 真实场景 client 重连
 *     拿同 clientId 才能命中 (P3c.2 clientId 是 connection 期 uuid, 重连会变).
 *     断线 client 的 row 最终会到 maxRetries 转 failed, 之后由 P3d cleanup 清理.
 *   - send 抛异常 → 同 retry 流程
 *
 * P3c.4 变化: send 成功**不**再立即 markDelivered, 改为放入 pendingAcks Map
 * 等待 client {type:'ack', msg_id} 反送; envelope 内附 msg_id (= row.id).
 * ack 超时由 checkAckTimeouts 处理.
 */
function dispatchOne(row: any, deps: WsMessageQueueDeps, maxRetries: number, nowFn: () => number): void {
  const client = findClientById(deps.wss, row.client_id);
  // ws.OPEN === 1 — 不 import WebSocket 常量, 用裸值避免循环依赖 / 让 mock 简单
  const WS_OPEN = 1;
  if (!client || (client as any).readyState !== WS_OPEN) {
    bumpRetryOrFail(row, deps, maxRetries, 'client offline');
    return;
  }
  try {
    const payload = JSON.parse(row.payload);
    // P3c.4: envelope 加 msg_id (= row.id), client 收后 send back {type:'ack', msg_id}.
    const envelope = JSON.stringify({ msg_id: row.id, channel: row.channel, payload });
    client.send(envelope);
    // P3c.4: 不再立即 markDelivered, 放入 pendingAcks 等 ack. row.id 全局唯一作 msg_id.
    pendingAcks.set(row.id, { rowId: row.id, sentAt: nowFn() });
  } catch (err) {
    bumpRetryOrFail(row, deps, maxRetries, (err as Error).message);
  }
}

/**
 * P3c.4: server 收到 client {type:'ack', msg_id} 时调. 返 true=成功 markDelivered;
 * false=msg_id 不在 pendingAcks (重复 ack / 已超时被 retry / 未知 id) — 静默忽略,
 * 不抛 (idempotent 设计: client 重复发 ack / network 重传 都安全).
 *
 * 注意: 调用方 (ws-server.ts message handler) 不需要做 sqlite 错误兜底,
 * 本函数只在 entry 存在时调 markWsMessageDelivered; sqlite 抛错冒泡到 caller.
 *
 * P3c.5: opts.onAckLatency 可选钩子, 成功 markDelivered 路径调一次, 入参为
 * 秒数 (= (now - sentAt) / 1000). 给 cache-metrics
 * biocore_ws_ack_latency_seconds Histogram observe 用. 钩子异常被吞.
 * opts.now 可注入假时钟 (默认 Date.now), 用于测试.
 */
export function markAckReceived(
  sqlite: Pick<WsQueueSqliteShape, 'markWsMessageDelivered'>,
  msgId: number,
  opts?: { onAckLatency?: (seconds: number) => void; now?: () => number },
): boolean {
  const entry = pendingAcks.get(msgId);
  if (!entry) return false;
  sqlite.markWsMessageDelivered(entry.rowId);
  pendingAcks.delete(msgId);
  // P3c.5: latency observe — 在 sqlite 写入后调, 钩子异常不回滚 markDelivered.
  if (opts?.onAckLatency) {
    try {
      const nowMs = (opts.now ?? Date.now)();
      opts.onAckLatency((nowMs - entry.sentAt) / 1000);
    } catch (err) {
      console.error(`[ws-msg-queue] onAckLatency hook threw msgId=${msgId}: ${(err as Error).message}`);
    }
  }
  return true;
}

/**
 * P3c.4: 扫 pendingAcks, sentAt + ackTimeoutMs 超时则 incrementWsMessageRetry
 * ('ack timeout') 让下一 tick claim 重投递. 不区分 retry_count, 委托 sqlite
 * 内部依据 row 当前 retry_count 决定是否升级 failed.
 *
 * 删除 entry 必须在 mutate Map 时小心: 用快照数组遍历避免 iterator invalidation
 * (Map.forEach 边遍边 delete 是合法的, 但批量收集后 delete 更稳).
 */
function checkAckTimeouts(deps: WsMessageQueueDeps, ackTimeoutMs: number, now: number): void {
  const expired: number[] = [];
  for (const [msgId, entry] of pendingAcks) {
    if (now - entry.sentAt > ackTimeoutMs) expired.push(msgId);
  }
  for (const msgId of expired) {
    const entry = pendingAcks.get(msgId);
    if (!entry) continue;
    pendingAcks.delete(msgId);
    try {
      deps.sqlite.incrementWsMessageRetry(entry.rowId, 'ack timeout');
    } catch (err) {
      console.error(`[ws-msg-queue] ack timeout incrementRetry failed id=${entry.rowId}: ${(err as Error).message}`);
    }
  }
}

/** retry_count+1 >= max → markFailed, 否则 incrementRetry. row.retry_count 是 claim 时快照. */
function bumpRetryOrFail(
  row: any,
  deps: WsMessageQueueDeps,
  maxRetries: number,
  errMsg: string,
): void {
  const nextRetry = (row.retry_count ?? 0) + 1;
  if (nextRetry >= maxRetries) {
    deps.sqlite.markWsMessageFailed(row.id, errMsg);
  } else {
    deps.sqlite.incrementWsMessageRetry(row.id, errMsg);
  }
}

/**
 * 在 wss.clients 里按 clientId 查 ws. clientId 由 P3c.2 在 ws-server connection
 * 期注入到 (ws as any).clientId. 找不到返 undefined (caller 视为 offline).
 * 性能: O(N) 扫描, N=在线 client 数 (典型 < 100), 5Hz tick 内可接受;
 * 若 N 变大, P3d 可换 Map<clientId, ws> 维护.
 */
function findClientById(wss: WsServerShape, clientId: string): WebSocket | undefined {
  for (const c of wss.clients) {
    if ((c as any).clientId === clientId) return c;
  }
  return undefined;
}

/** 测试用: 暴露常量便于 assert. */
export const WS_QUEUE_DEFAULTS = {
  TICK_MS: DEFAULT_TICK_MS,
  BATCH_SIZE: DEFAULT_BATCH_SIZE,
  MAX_RETRIES: DEFAULT_MAX_RETRIES,
  ACK_TIMEOUT_MS: DEFAULT_ACK_TIMEOUT_MS,
} as const;

/** ws-server.ts critical channel 白名单. P3c.4 不变. */
export const CRITICAL_CHANNELS: ReadonlySet<string> = new Set([
  'alarm',
  'state_update',
  'recipe_downloaded',
]);
