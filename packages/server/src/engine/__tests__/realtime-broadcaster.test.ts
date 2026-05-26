// ============================================================
// SP-PLC-3 Phase 1 Commit 3 — realtime-broadcaster 单元测试 (8 项)
// 计划: docs/plans/SP-PLC-3-tag-cache-plan.md  §1 Commit 3 "测试覆盖"
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TagCache, type SnapshotInput } from '../tag-cache';
import { startRealtimeBroadcaster } from '../realtime-broadcaster';

const TS = '2026-05-25T00:00:00.000Z';

function snap(values: Record<string, number>, q?: Record<string, 'good' | 'bad' | 'uncertain'>): SnapshotInput {
  const quality: Record<string, 'good' | 'bad' | 'uncertain'> = {};
  for (const tag of Object.keys(values)) quality[tag] = q?.[tag] ?? 'good';
  return { timestamp: TS, values, quality };
}

/** ws.WebSocketServer 的 minimal duck: 一组带 bufferedAmount 的 client. */
function makeWss(clients: Array<{ bufferedAmount: number }> = []) {
  return {
    clients: {
      forEach(cb: (c: { bufferedAmount: number }) => void) {
        clients.forEach(cb);
      },
    },
  };
}

describe('SP-PLC-3 P3 — startRealtimeBroadcaster', () => {
  let cache: TagCache;

  beforeEach(() => {
    cache = new TagCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── Test 1: 单 tag change → next tick fan-out 含该 tag ──
  it('单 tag change → next tick fan-out 含该 tag', () => {
    const broadcast = vi.fn();
    const stop = startRealtimeBroadcaster({
      tagCache: cache,
      broadcast,
      wss: makeWss(),
      getBatchId: () => null,
      tickMs: 200,
    });

    cache.write('R1', snap({ TEMP_PV: 37.0 }));
    expect(broadcast).not.toHaveBeenCalled(); // tick 前不推
    vi.advanceTimersByTime(200);
    expect(broadcast).toHaveBeenCalledTimes(1);
    const [channel, payload, batchId, reactorId] = broadcast.mock.calls[0];
    expect(channel).toBe('pv_realtime');
    expect(reactorId).toBe('R1');
    expect(batchId).toBe(null);
    expect(payload['AI-0']).toBe(37.0); // TEMP_PV 映射到 AI-0
    expect(payload.quality.TEMP_PV).toBe('good');
    stop();
  });

  // ── Test 2: 同 tick 多 tag change → 一次 broadcast 聚合 ──
  it('同 tick 多 tag change → 一次 broadcast 聚合 (单 reactor)', () => {
    const broadcast = vi.fn();
    const stop = startRealtimeBroadcaster({
      tagCache: cache,
      broadcast,
      wss: makeWss(),
      getBatchId: () => 'b1',
      tickMs: 200,
    });

    cache.write('R1', snap({ TEMP_PV: 37.0, PH_PV: 7.2, DO_PV: 80 }));
    vi.advanceTimersByTime(200);
    expect(broadcast).toHaveBeenCalledTimes(1);
    const payload = broadcast.mock.calls[0][1];
    expect(payload['AI-0']).toBe(37.0);
    expect(payload['AI-2']).toBe(7.2);
    expect(payload['AI-3']).toBe(80);
    expect(broadcast.mock.calls[0][2]).toBe('b1'); // batchId 透传
    stop();
  });

  // ── Test 3: 跨 reactor change → 分别 broadcast ──
  it('跨 reactor change → 分别 broadcast (按 reactor 隔离)', () => {
    const broadcast = vi.fn();
    const stop = startRealtimeBroadcaster({
      tagCache: cache,
      broadcast,
      wss: makeWss(),
      getBatchId: (id) => `batch-${id}`,
      tickMs: 200,
    });

    cache.write('R1', snap({ TEMP_PV: 37.0 }));
    cache.write('R2', snap({ TEMP_PV: 38.5 }));
    vi.advanceTimersByTime(200);
    expect(broadcast).toHaveBeenCalledTimes(2);
    const reactors = broadcast.mock.calls.map((c) => c[3]).sort();
    expect(reactors).toEqual(['R1', 'R2']);
    const r1Call = broadcast.mock.calls.find((c) => c[3] === 'R1');
    const r2Call = broadcast.mock.calls.find((c) => c[3] === 'R2');
    expect(r1Call![1]['AI-0']).toBe(37.0);
    expect(r2Call![1]['AI-0']).toBe(38.5);
    stop();
  });

  // ── Test 4: bufferedAmount > 阈值 → skip + console.warn ──
  it('bufferedAmount 超阈 → 整个 reactor skip + console.warn 触发', () => {
    const broadcast = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const slowClient = { bufferedAmount: 2 * 1024 * 1024 }; // 2 MB > 1 MB 阈值
    const stop = startRealtimeBroadcaster({
      tagCache: cache,
      broadcast,
      wss: makeWss([slowClient]),
      getBatchId: () => null,
      tickMs: 200,
      maxBufferedAmount: 1024 * 1024,
    });

    cache.write('R1', snap({ TEMP_PV: 37.0 }));
    vi.advanceTimersByTime(200);
    expect(broadcast).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/back-pressure skip reactor=R1/);
    stop();
  });

  // ── Test 5: 无变化时无 broadcast (静态期 0 流量) ──
  it('无变化时无 broadcast 调用 (静态期零流量)', () => {
    const broadcast = vi.fn();
    const stop = startRealtimeBroadcaster({
      tagCache: cache,
      broadcast,
      wss: makeWss(),
      getBatchId: () => null,
      tickMs: 200,
    });

    // 写一次让 cache 有值
    cache.write('R1', snap({ TEMP_PV: 37.0 }));
    vi.advanceTimersByTime(200);
    expect(broadcast).toHaveBeenCalledTimes(1);

    // 后续 3 个 tick 无新 write → 0 推送
    vi.advanceTimersByTime(600);
    expect(broadcast).toHaveBeenCalledTimes(1);

    // 同值 write → 不算 change → 0 推送
    cache.write('R1', snap({ TEMP_PV: 37.0 }));
    vi.advanceTimersByTime(200);
    expect(broadcast).toHaveBeenCalledTimes(1);
    stop();
  });

  // ── Test 6: stop function 清 interval + unsubscribe ──
  it('stop function 清 interval + unsubscribe (cache 后续 write 不再触发 callback)', () => {
    const broadcast = vi.fn();
    const stop = startRealtimeBroadcaster({
      tagCache: cache,
      broadcast,
      wss: makeWss(),
      getBatchId: () => null,
      tickMs: 200,
    });

    cache.write('R1', snap({ TEMP_PV: 37.0 }));
    vi.advanceTimersByTime(200);
    expect(broadcast).toHaveBeenCalledTimes(1);

    stop();

    // stop 后再 write + advance: 不应有 broadcast (interval 清 + 订阅退出)
    cache.write('R1', snap({ TEMP_PV: 38.5 }));
    vi.advanceTimersByTime(1000);
    expect(broadcast).toHaveBeenCalledTimes(1); // 仍是 stop 前那 1 次

    // 重复 stop 不抛
    expect(() => stop()).not.toThrow();
  });

  // ── Test 7: subscription callback 抛错不影响其它 reactor ──
  // 注: P1 已测 tag-cache fanOut 异常隔离; 本测验证 broadcaster 内 tick
  // 单 reactor 的 try/catch 不会污染其它 reactor 本 tick.
  it('单 reactor tick 抛错不影响其它 reactor 本 tick', () => {
    const broadcast = vi.fn((channel, payload, _b, reactorId) => {
      if (reactorId === 'R1') throw new Error('R1 broadcast 故意抛错');
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stop = startRealtimeBroadcaster({
      tagCache: cache,
      broadcast,
      wss: makeWss(),
      getBatchId: () => null,
      tickMs: 200,
    });

    cache.write('R1', snap({ TEMP_PV: 37.0 }));
    cache.write('R2', snap({ TEMP_PV: 38.5 }));
    vi.advanceTimersByTime(200);
    // 两 reactor 都尝试推, R1 抛错被吞但 console.error 触发, R2 正常推
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0][0]).toMatch(/reactor=R1 tick failed/);
    stop();
  });

  // ── Test 8: quality 字段在 payload 中存在且正确 ──
  it('quality 字段透传到 payload (bad/good 混合)', () => {
    const broadcast = vi.fn();
    const stop = startRealtimeBroadcaster({
      tagCache: cache,
      broadcast,
      wss: makeWss(),
      getBatchId: () => null,
      tickMs: 200,
    });

    // 先写一好值
    cache.write('R1', snap({ TEMP_PV: 37.0, PH_PV: 7.2 }));
    // markStale TEMP_PV → quality='bad', value 保留 37 (last-known-good)
    cache.markStale('R1', ['TEMP_PV']);
    // 再写 PH_PV 变化触发 dirty (markStale 不触发 fan-out, 单靠它 broadcaster 不会动)
    cache.write('R1', snap({ PH_PV: 7.3 }));
    vi.advanceTimersByTime(200);

    expect(broadcast).toHaveBeenCalledTimes(1);
    const payload = broadcast.mock.calls[0][1];
    expect(payload['AI-0']).toBe(37.0);       // last-known-good 仍是 37
    expect(payload['AI-2']).toBe(7.3);
    expect(payload.quality.TEMP_PV).toBe('bad');
    expect(payload.quality.PH_PV).toBe('good');
    stop();
  });
});
