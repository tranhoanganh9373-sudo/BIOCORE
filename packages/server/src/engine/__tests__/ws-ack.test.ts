// ============================================================
// SP-PLC-3 Phase 3c Commit 4 (P3c.4) — msg_id + 客户端 ack 单测
// ============================================================
// 计划: docs/plans/SP-PLC-3-tag-cache-phase3c-plan.md  §1 Commit 4
//
// 8 tests (plan 列出):
//   1. server send envelope 含 msg_id 字段
//   2. client auto-send ack only for CRITICAL_CHANNELS (模拟 client 行为)
//   3. pv_realtime 不发 ack (client 行为模拟)
//   4. server 收 ack → markAckReceived 调 markWsMessageDelivered
//   5. ack 超时 5s (假时钟) → incrementWsMessageRetry 'ack timeout'
//   6. 重复 ack 同 msg_id idempotent (第二次返 false 不再 markDelivered)
//   7. 不存在 msg_id ack → markAckReceived 返 false ignore + 不 markDelivered
//   8. send 抛错时仍 incrementRetry (P3c.3 路径不破)
//
// 用 dispatcher.tickOnce() 手动跑 tick 避免假时钟; mock WsQueueSqliteShape
// + mock WsServerShape clients Set + 注入 now() 控制 ack 超时.
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  CRITICAL_CHANNELS,
  markAckReceived,
  startWsMessageQueueDispatcher,
  WS_QUEUE_DEFAULTS,
  __resetPendingAcksForTests,
  getPendingAckCount,
  type WsMessageQueueDeps,
  type WsQueueSqliteShape,
} from '../ws-message-queue';

// ─── mock helpers ────────────────────────────────────────────

function makeMockSqlite(): WsQueueSqliteShape {
  return {
    enqueueWsMessage: vi.fn().mockReturnValue(1),
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
  sqlite: WsQueueSqliteShape,
  clients: WebSocket[],
  opts?: { maxRetries?: number; ackTimeoutMs?: number; now?: () => number },
): WsMessageQueueDeps {
  return {
    sqlite,
    wss: { clients: new Set(clients) },
    tickMs: 10000, // 大值防 timer 自动跑
    maxRetries: opts?.maxRetries,
    ackTimeoutMs: opts?.ackTimeoutMs,
    now: opts?.now,
  };
}

// ─── client 行为模拟 helper ──────────────────────────────────
// 模拟 web-ui/src/stores/realtime-store.ts onmessage: 只对 CRITICAL_CHANNELS 发 ack.

function simulateClientAckBehavior(client: WebSocket, envelope: any): void {
  // 此 helper 只模拟 client 端逻辑, 不真的走 server. 用于 T2/T3.
  // 真 client 见 packages/web-ui/src/stores/realtime-store.ts.
  if (envelope.msg_id !== undefined && CRITICAL_CHANNELS.has(envelope.channel)) {
    // ack 发送回 server 用 client.send (这里 mock 是 ws.send spy, 借用同 spy 验)
    (client.send as any)(JSON.stringify({ type: 'ack', msg_id: envelope.msg_id }));
  }
}

// ─── tests ────────────────────────────────────────────────────

describe('SP-PLC-3 P3c.4 — msg_id + client ack 机制', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetPendingAcksForTests();
  });

  it('T1: server send envelope 含 msg_id 字段 (= row.id)', () => {
    const sqlite = makeMockSqlite();
    const ws = makeMockWs('client-1', 1);
    (sqlite.claimPendingWsMessages as any).mockReturnValueOnce([
      { id: 100, client_id: 'client-1', channel: 'alarm', payload: JSON.stringify({ severity: 'critical' }), retry_count: 0 },
    ]);
    const deps = makeDeps(sqlite, [ws]);
    const handle = startWsMessageQueueDispatcher(deps);
    handle.tickOnce();
    expect(ws.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse((ws.send as any).mock.calls[0][0] as string);
    expect(sent).toHaveProperty('msg_id', 100);
    expect(sent).toHaveProperty('channel', 'alarm');
    expect(sent).toHaveProperty('payload');
    expect(sent.payload).toEqual({ severity: 'critical' });
    handle.stop();
  });

  it('T2: client auto-send ack for CRITICAL_CHANNELS (alarm/state_update/recipe_downloaded)', () => {
    // 模拟 client 收到 envelope 后的反送行为. 用 web-ui 同等逻辑.
    const ws = makeMockWs('client-1', 1);
    for (const channel of ['alarm', 'state_update', 'recipe_downloaded']) {
      (ws.send as any).mockClear();
      const envelope = { msg_id: 42, channel, payload: { x: 1 } };
      simulateClientAckBehavior(ws, envelope);
      expect(ws.send).toHaveBeenCalledTimes(1);
      const ack = JSON.parse((ws.send as any).mock.calls[0][0] as string);
      expect(ack).toEqual({ type: 'ack', msg_id: 42 });
    }
  });

  it('T3: pv_realtime 不发 ack (非 critical channel — best-effort)', () => {
    const ws = makeMockWs('client-1', 1);
    const envelope = { msg_id: 42, channel: 'pv_realtime', payload: { temp: 30 } };
    simulateClientAckBehavior(ws, envelope);
    expect(ws.send).not.toHaveBeenCalled();

    // heartbeat 同理
    const envelope2 = { msg_id: 43, channel: 'heartbeat', payload: {} };
    simulateClientAckBehavior(ws, envelope2);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('T4: server 收 ack → markAckReceived 调 markWsMessageDelivered + 返 true', () => {
    const sqlite = makeMockSqlite();
    const ws = makeMockWs('client-1', 1);
    (sqlite.claimPendingWsMessages as any).mockReturnValueOnce([
      { id: 200, client_id: 'client-1', channel: 'alarm', payload: '{}', retry_count: 0 },
    ]);
    const deps = makeDeps(sqlite, [ws]);
    const handle = startWsMessageQueueDispatcher(deps);
    handle.tickOnce();
    expect(getPendingAckCount()).toBe(1);
    expect(sqlite.markWsMessageDelivered).not.toHaveBeenCalled();

    // 模拟 server 收到 client ack
    const ok = markAckReceived(sqlite, 200);
    expect(ok).toBe(true);
    expect(sqlite.markWsMessageDelivered).toHaveBeenCalledWith(200);
    expect(getPendingAckCount()).toBe(0);
    handle.stop();
  });

  it('T5: ack 超时 5s → incrementWsMessageRetry 含 "ack timeout"', () => {
    const sqlite = makeMockSqlite();
    const ws = makeMockWs('client-1', 1);
    (sqlite.claimPendingWsMessages as any).mockReturnValueOnce([
      { id: 300, client_id: 'client-1', channel: 'alarm', payload: '{}', retry_count: 0 },
    ]);
    // 用假 now: t=1000 send, t=7000 (>5000+1000) 检查超时.
    let fakeNow = 1000;
    const deps = makeDeps(sqlite, [ws], { ackTimeoutMs: 5000, now: () => fakeNow });
    const handle = startWsMessageQueueDispatcher(deps);
    handle.tickOnce(); // send at t=1000
    expect(sqlite.incrementWsMessageRetry).not.toHaveBeenCalled();
    expect(getPendingAckCount()).toBe(1);

    // 推进时钟超过 5s.
    fakeNow = 7001; // 7001 - 1000 = 6001 > 5000
    // 0 pending row, tickOnce 只跑 checkAckTimeouts.
    (sqlite.claimPendingWsMessages as any).mockReturnValueOnce([]);
    handle.tickOnce();
    expect(sqlite.incrementWsMessageRetry).toHaveBeenCalledWith(300, 'ack timeout');
    expect(getPendingAckCount()).toBe(0);
    handle.stop();
  });

  it('T6: 重复 ack 同 msg_id idempotent (第二次返 false 不再 markDelivered)', () => {
    const sqlite = makeMockSqlite();
    const ws = makeMockWs('client-1', 1);
    (sqlite.claimPendingWsMessages as any).mockReturnValueOnce([
      { id: 400, client_id: 'client-1', channel: 'alarm', payload: '{}', retry_count: 0 },
    ]);
    const deps = makeDeps(sqlite, [ws]);
    const handle = startWsMessageQueueDispatcher(deps);
    handle.tickOnce();

    const first = markAckReceived(sqlite, 400);
    expect(first).toBe(true);
    expect(sqlite.markWsMessageDelivered).toHaveBeenCalledTimes(1);

    // 第二次 ack — entry 已删, 返 false, 不再 markDelivered.
    const second = markAckReceived(sqlite, 400);
    expect(second).toBe(false);
    expect(sqlite.markWsMessageDelivered).toHaveBeenCalledTimes(1); // 仍 1 次
    handle.stop();
  });

  it('T7: 不存在 msg_id ack → 返 false 静默忽略 不抛 不调 markDelivered', () => {
    const sqlite = makeMockSqlite();
    // pendingAcks 空, ack 一个从未存在的 msg_id
    const result = markAckReceived(sqlite, 999);
    expect(result).toBe(false);
    expect(sqlite.markWsMessageDelivered).not.toHaveBeenCalled();
  });

  it('T8: send 抛错 → incrementRetry (P3c.3 路径不破, 不入 pendingAcks)', () => {
    const sqlite = makeMockSqlite();
    const ws = makeMockWs('client-1', 1);
    (ws.send as any).mockImplementation(() => {
      throw new Error('socket write failed');
    });
    (sqlite.claimPendingWsMessages as any).mockReturnValueOnce([
      { id: 500, client_id: 'client-1', channel: 'alarm', payload: '{}', retry_count: 0 },
    ]);
    const deps = makeDeps(sqlite, [ws], { maxRetries: 3 });
    const handle = startWsMessageQueueDispatcher(deps);
    handle.tickOnce();
    expect(sqlite.incrementWsMessageRetry).toHaveBeenCalledWith(500, 'socket write failed');
    expect(sqlite.markWsMessageDelivered).not.toHaveBeenCalled();
    // send 失败的 row 不应进入 pendingAcks (避免重复 retry).
    expect(getPendingAckCount()).toBe(0);
    handle.stop();
  });

  it('TX: WS_QUEUE_DEFAULTS.ACK_TIMEOUT_MS 默认 5000 (Q(iv) 默认值)', () => {
    expect(WS_QUEUE_DEFAULTS.ACK_TIMEOUT_MS).toBe(5000);
  });
});
