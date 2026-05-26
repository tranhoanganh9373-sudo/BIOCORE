// ============================================================
// SP-PLC-3 P3c.3 — ws_message_queue dispatcher 单测
// ============================================================
// 测试范围:
//   1. enqueueCriticalMessage 写 sqlite
//   2. dispatcher 启动期 rollbackInProgressWsMessages
//   3. tick claim 后送达成功 → markDelivered
//   4. client 不在线 → incrementRetry 'client offline'
//   5. client readyState !== OPEN → incrementRetry
//   6. send 抛错且 retry_count < max → incrementRetry
//   7. retry_count + 1 >= max → markFailed
//   8. batch claim 返多条全 process
//   9. 0 pending tick noop
//  10. CRITICAL_CHANNELS = {alarm, state_update, recipe_downloaded}
//
// 用 dispatcher.tickOnce() 手动跑 tick 避免假时钟; mock WsQueueSqliteShape
// 6 vi.fn + mock WsServerShape clients Set.
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  CRITICAL_CHANNELS,
  enqueueCriticalMessage,
  startWsMessageQueueDispatcher,
  WS_QUEUE_DEFAULTS,
  __resetPendingAcksForTests,
  type WsMessageQueueDeps,
  type WsQueueSqliteShape,
} from '../ws-message-queue';

// ─── mock helpers ────────────────────────────────────────────

function makeMockSqlite(): WsQueueSqliteShape {
  return {
    enqueueWsMessage: vi.fn().mockReturnValue(42),
    claimPendingWsMessages: vi.fn().mockReturnValue([]),
    markWsMessageDelivered: vi.fn(),
    incrementWsMessageRetry: vi.fn(),
    markWsMessageFailed: vi.fn(),
    rollbackInProgressWsMessages: vi.fn(),
  };
}

function makeMockWs(clientId: string, readyState = 1): WebSocket {
  return {
    clientId,
    readyState,
    send: vi.fn(),
  } as unknown as WebSocket;
}

function makeDeps(
  sqlite: WsQueueSqliteShape = makeMockSqlite(),
  clients: WebSocket[] = [],
  opts?: { maxRetries?: number; tickMs?: number; batchSize?: number },
): WsMessageQueueDeps {
  return {
    sqlite,
    wss: { clients: new Set(clients) },
    tickMs: opts?.tickMs ?? 10000, // 大值防 timer 自动跑, 测试用 tickOnce
    batchSize: opts?.batchSize,
    maxRetries: opts?.maxRetries,
  };
}

// 启动 dispatcher 后立即 stop (避免 timer 跑) 但保留 tickOnce 接口
function startAndCapture(deps: WsMessageQueueDeps) {
  const handle = startWsMessageQueueDispatcher(deps);
  return handle;
}

// ─── tests ────────────────────────────────────────────────────

describe('SP-PLC-3 P3c.3 — ws_message_queue dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // P3c.4: module-scope pendingAcks 跨 test 污染防护.
    __resetPendingAcksForTests();
  });

  it('T1: enqueueCriticalMessage 写 sqlite + 返 row id', () => {
    const sqlite = makeMockSqlite();
    const id = enqueueCriticalMessage(sqlite, 'client-1', 'alarm', { foo: 'bar' });
    expect(sqlite.enqueueWsMessage).toHaveBeenCalledWith({
      client_id: 'client-1',
      channel: 'alarm',
      payload: { foo: 'bar' },
    });
    expect(id).toBe(42);
  });

  it('T2: dispatcher 启动期调 rollbackInProgressWsMessages', () => {
    const sqlite = makeMockSqlite();
    const deps = makeDeps(sqlite);
    const handle = startAndCapture(deps);
    expect(sqlite.rollbackInProgressWsMessages).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it('T3: tickOnce claim 后 ws.send 含 msg_id, **不**立即 markDelivered (P3c.4: 等 ack)', () => {
    const sqlite = makeMockSqlite();
    const ws = makeMockWs('client-1', 1);
    (sqlite.claimPendingWsMessages as any).mockReturnValueOnce([
      { id: 10, client_id: 'client-1', channel: 'alarm', payload: JSON.stringify({ a: 1 }), retry_count: 0 },
    ]);
    const deps = makeDeps(sqlite, [ws]);
    const handle = startAndCapture(deps);
    handle.tickOnce();
    expect(ws.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse((ws.send as any).mock.calls[0][0] as string);
    // P3c.4: envelope 加 msg_id (= row.id), 等 client send back {type:'ack', msg_id} 才 markDelivered.
    expect(sent).toEqual({ msg_id: 10, channel: 'alarm', payload: { a: 1 } });
    expect(sqlite.markWsMessageDelivered).not.toHaveBeenCalled();
    expect(sqlite.incrementWsMessageRetry).not.toHaveBeenCalled();
    expect(sqlite.markWsMessageFailed).not.toHaveBeenCalled();
    handle.stop();
  });

  it('T4: client 不在 wss.clients → incrementRetry "client offline"', () => {
    const sqlite = makeMockSqlite();
    (sqlite.claimPendingWsMessages as any).mockReturnValueOnce([
      { id: 11, client_id: 'absent-client', channel: 'alarm', payload: '{}', retry_count: 0 },
    ]);
    const deps = makeDeps(sqlite, []); // 空 clients
    const handle = startAndCapture(deps);
    handle.tickOnce();
    expect(sqlite.incrementWsMessageRetry).toHaveBeenCalledWith(11, 'client offline');
    expect(sqlite.markWsMessageDelivered).not.toHaveBeenCalled();
    handle.stop();
  });

  it('T5: client readyState !== OPEN(1) → incrementRetry', () => {
    const sqlite = makeMockSqlite();
    const closingWs = makeMockWs('client-2', 2); // CLOSING
    (sqlite.claimPendingWsMessages as any).mockReturnValueOnce([
      { id: 12, client_id: 'client-2', channel: 'state_update', payload: '{}', retry_count: 0 },
    ]);
    const deps = makeDeps(sqlite, [closingWs]);
    const handle = startAndCapture(deps);
    handle.tickOnce();
    expect(closingWs.send).not.toHaveBeenCalled();
    expect(sqlite.incrementWsMessageRetry).toHaveBeenCalledWith(12, 'client offline');
    handle.stop();
  });

  it('T6: send 抛错 + retry_count < max → incrementRetry 含错误信息', () => {
    const sqlite = makeMockSqlite();
    const ws = makeMockWs('client-3', 1);
    (ws.send as any).mockImplementation(() => {
      throw new Error('socket write failed');
    });
    (sqlite.claimPendingWsMessages as any).mockReturnValueOnce([
      { id: 13, client_id: 'client-3', channel: 'alarm', payload: '{}', retry_count: 0 },
    ]);
    const deps = makeDeps(sqlite, [ws], { maxRetries: 3 });
    const handle = startAndCapture(deps);
    handle.tickOnce();
    expect(sqlite.incrementWsMessageRetry).toHaveBeenCalledWith(13, 'socket write failed');
    expect(sqlite.markWsMessageFailed).not.toHaveBeenCalled();
    handle.stop();
  });

  it('T7: retry_count + 1 >= maxRetries → markFailed (不再 incrementRetry)', () => {
    const sqlite = makeMockSqlite();
    const ws = makeMockWs('client-4', 1);
    (ws.send as any).mockImplementation(() => {
      throw new Error('persistent failure');
    });
    (sqlite.claimPendingWsMessages as any).mockReturnValueOnce([
      { id: 14, client_id: 'client-4', channel: 'recipe_downloaded', payload: '{}', retry_count: 2 }, // next = 3 = max
    ]);
    const deps = makeDeps(sqlite, [ws], { maxRetries: 3 });
    const handle = startAndCapture(deps);
    handle.tickOnce();
    expect(sqlite.markWsMessageFailed).toHaveBeenCalledWith(14, 'persistent failure');
    expect(sqlite.incrementWsMessageRetry).not.toHaveBeenCalled();
    handle.stop();
  });

  it('T8: batch claim 返多条全 send (P3c.4: markDelivered 由 ack 触发, 此处仍 0)', () => {
    const sqlite = makeMockSqlite();
    const ws1 = makeMockWs('c1', 1);
    const ws2 = makeMockWs('c2', 1);
    const ws3 = makeMockWs('c3', 1);
    (sqlite.claimPendingWsMessages as any).mockReturnValueOnce([
      { id: 20, client_id: 'c1', channel: 'alarm', payload: '{}', retry_count: 0 },
      { id: 21, client_id: 'c2', channel: 'alarm', payload: '{}', retry_count: 0 },
      { id: 22, client_id: 'c3', channel: 'alarm', payload: '{}', retry_count: 0 },
    ]);
    const deps = makeDeps(sqlite, [ws1, ws2, ws3]);
    const handle = startAndCapture(deps);
    handle.tickOnce();
    expect(ws1.send).toHaveBeenCalledTimes(1);
    expect(ws2.send).toHaveBeenCalledTimes(1);
    expect(ws3.send).toHaveBeenCalledTimes(1);
    // P3c.4: send 后入 pendingAcks 等 ack, 不再立即 markDelivered.
    expect(sqlite.markWsMessageDelivered).not.toHaveBeenCalled();
    handle.stop();
  });

  it('T9: claim 返 [] 时 tick noop (0 send / 0 markDelivered)', () => {
    const sqlite = makeMockSqlite(); // 默认 mockReturnValue([])
    const ws = makeMockWs('client-5', 1);
    const deps = makeDeps(sqlite, [ws]);
    const handle = startAndCapture(deps);
    handle.tickOnce();
    expect(sqlite.claimPendingWsMessages).toHaveBeenCalledWith(WS_QUEUE_DEFAULTS.BATCH_SIZE);
    expect(ws.send).not.toHaveBeenCalled();
    expect(sqlite.markWsMessageDelivered).not.toHaveBeenCalled();
    expect(sqlite.incrementWsMessageRetry).not.toHaveBeenCalled();
    expect(sqlite.markWsMessageFailed).not.toHaveBeenCalled();
    handle.stop();
  });

  it('T10: CRITICAL_CHANNELS 集合 = {alarm, state_update, recipe_downloaded}', () => {
    expect(CRITICAL_CHANNELS.has('alarm')).toBe(true);
    expect(CRITICAL_CHANNELS.has('state_update')).toBe(true);
    expect(CRITICAL_CHANNELS.has('recipe_downloaded')).toBe(true);
    expect(CRITICAL_CHANNELS.has('pv_realtime')).toBe(false);
    expect(CRITICAL_CHANNELS.has('heartbeat')).toBe(false);
    expect(CRITICAL_CHANNELS.size).toBe(3);
  });
});
