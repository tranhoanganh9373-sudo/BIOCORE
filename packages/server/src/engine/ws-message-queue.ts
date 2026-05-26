// ============================================================
// SP-PLC-3 Phase 3c Commit 3 (P3c.3) — ws_message_queue dispatcher
// ============================================================
// 计划: docs/plans/SP-PLC-3-tag-cache-phase3c-plan.md  §1 Commit 3
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
//          - send 成功 → markWsMessageDelivered (P3c.3 简化; P3c.4 改 ack 触发)
//
// 不变量:
//   - 启动期 rollbackInProgressWsMessages() 复位上次崩溃残留 'dispatching'.
//   - P3c.3 不实现 ack 机制 — send 成功立即视为 delivered. P3c.4 把这一步移到
//     ack message handler, 同时引入 ack 超时跟踪 (本 dispatcher 仍为 ack 入口).
//   - critical channel 入队判定在 ws-server.ts broadcast() 内, 本模块不感知
//     channel 白名单, 仅按入队顺序投递.
// ============================================================

import type { WebSocket } from 'ws';

const DEFAULT_TICK_MS = 500;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_RETRIES = 3;

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

  // 启动期复位上次崩溃残留 (与 scada-write-dispatcher 同模式).
  deps.sqlite.rollbackInProgressWsMessages();

  const tick = (): void => {
    const rows = deps.sqlite.claimPendingWsMessages(batchSize);
    for (const row of rows) {
      dispatchOne(row, deps, maxRetries);
    }
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
 */
function dispatchOne(row: any, deps: WsMessageQueueDeps, maxRetries: number): void {
  const client = findClientById(deps.wss, row.client_id);
  // ws.OPEN === 1 — 不 import WebSocket 常量, 用裸值避免循环依赖 / 让 mock 简单
  const WS_OPEN = 1;
  if (!client || (client as any).readyState !== WS_OPEN) {
    bumpRetryOrFail(row, deps, maxRetries, 'client offline');
    return;
  }
  try {
    const payload = JSON.parse(row.payload);
    const envelope = JSON.stringify({ channel: row.channel, payload });
    client.send(envelope);
    // P3c.3 简化: send 成功立即 markDelivered. P3c.4 把这一步移到 ack handler.
    deps.sqlite.markWsMessageDelivered(row.id);
  } catch (err) {
    bumpRetryOrFail(row, deps, maxRetries, (err as Error).message);
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
} as const;

/** ws-server.ts critical channel 白名单. P3c.4 不变. */
export const CRITICAL_CHANNELS: ReadonlySet<string> = new Set([
  'alarm',
  'state_update',
  'recipe_downloaded',
]);
