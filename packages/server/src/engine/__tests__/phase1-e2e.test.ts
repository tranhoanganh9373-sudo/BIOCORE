// ============================================================
// SP-PLC-3 Phase 1 Commit 4 — 端到端验收测试 (5 项)
// 计划: docs/plans/SP-PLC-3-tag-cache-plan.md  §1 Commit 4 "端到端测试"
//
// 验收点 (plan §1 Commit 4 列):
//   1. Mock PLC → cache → WS → Influx 全链路 (CUSUM 路径单独 unit, 这里
//      验前 3 跳: cache.write → broadcaster fan-out → flusher Point 写入).
//   2. 通讯断模拟: markStale → cache 保 last-known-good → broadcaster 推
//      quality='bad' → flusher 跳过.
//   3. dirty-only 行为: 同 snapshot 重复 write 不触发推送, 值真变化才推.
//   4. 多 reactor 隔离: 一 reactor 变化不污染另一 reactor 推送.
//   5. back-pressure: client.bufferedAmount 超阈 → broadcaster skip +
//      console.warn 触发.
//
// 测试纪律:
//   - vi.useFakeTimers + restoreAllMocks afterEach (沿用 P3 测试模式).
//   - TagCache 真实例 (P1 单测 15/15 已验); broadcaster / flusher 用真启动
//     函数 (P3 已 ship). broadcast / writePoint / console.warn 用 vi.fn() spy.
//   - 不引入真实 sqlite / WS / Influx HTTP client — 全 stub.
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TagCache, type SnapshotInput } from '../tag-cache';
import { startRealtimeBroadcaster } from '../realtime-broadcaster';
import { startInfluxFlusher } from '../influx-flusher';

const TS = '2026-05-25T00:00:00.000Z';

/** 构造 snapshot, quality 默认全 good. */
function snap(
  values: Record<string, number>,
  q?: Record<string, 'good' | 'bad' | 'uncertain'>,
): SnapshotInput {
  const quality: Record<string, 'good' | 'bad' | 'uncertain'> = {};
  for (const tag of Object.keys(values)) quality[tag] = q?.[tag] ?? 'good';
  return { timestamp: TS, values, quality };
}

/** ws.WebSocketServer 的 minimal duck (与 P3 broadcaster.test.ts 一致). */
function makeWss(clients: Array<{ bufferedAmount: number }> = []) {
  return {
    clients: {
      forEach(cb: (c: { bufferedAmount: number }) => void) {
        clients.forEach(cb);
      },
    },
  };
}

/** 收集 writePoint line protocol, 与 influx-flusher.test.ts 同模式. */
function makeWriteApi() {
  const lines: string[] = [];
  const flushSpy = vi.fn(() => Promise.resolve());
  const api: any = {
    writePoint(p: any) {
      const line = typeof p.toLineProtocol === 'function' ? p.toLineProtocol() : undefined;
      if (line) lines.push(line);
    },
    flush: flushSpy,
  };
  return { api, lines, flushSpy };
}

/**
 * 9 字段完整 PLC snapshot 模板. flusher 9 字段 + broadcaster 19 字段都从这
 * 9 个 tag 衍生 (broadcaster 还要 STEAM_CV/COOL_CV/... 等控制字段, 这里只
 * 测 PV 字段是否落对位即可; 缺失字段在 broadcaster 内 fallback 0 + quality=bad).
 */
const FULL_PV_SNAPSHOT: Record<string, number> = {
  TEMP_PV: 37.0,
  JACKET_PV: 36.0,
  PH_PV: 7.2,
  DO_PV: 80.0,
  PRESSURE_PV: 1.2,
  AIRFLOW_PV: 50.0,
  WEIGHT_PV: 100.0,
  VFD_ACTUAL_FREQ: 25.0,
  VFD_CURRENT: 3.1,
};

describe('SP-PLC-3 Phase 1 — 端到端验收 (P4)', () => {
  let cache: TagCache;

  beforeEach(() => {
    cache = new TagCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── E2E 1: Mock PLC → cache → WS → Influx 全链路 ──
  it('Mock PLC → cache → WS → Influx 全链路: write 触发 broadcaster + flusher 同步生效', () => {
    const broadcastSpy = vi.fn();
    const { api, lines } = makeWriteApi();

    // 启动 broadcaster (5Hz) + flusher (1Hz)
    const stopBroadcaster = startRealtimeBroadcaster({
      tagCache: cache,
      broadcast: broadcastSpy,
      wss: makeWss(),
      getBatchId: () => 'b1',
      tickMs: 200,
    });
    const stopFlusher = startInfluxFlusher({
      tagCache: cache,
      influxWriteApi: api,
      reactorIds: () => ['R1'],
      getBatchId: () => 'b1',
      flushMs: 1000,
    });

    // PLC snapshot 写入 cache
    cache.write('R1', snap(FULL_PV_SNAPSHOT));

    // 立即 cache.read 验证
    const tempEntry = cache.read('R1', 'TEMP_PV');
    expect(tempEntry).toBeDefined();
    expect(tempEntry!.value).toBe(37.0);
    expect(tempEntry!.quality).toBe('good');

    // broadcaster 5Hz tick → 1 次 pv_realtime
    vi.advanceTimersByTime(200);
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    const [channel, payload, batchIdArg, reactorIdArg] = broadcastSpy.mock.calls[0];
    expect(channel).toBe('pv_realtime');
    expect(reactorIdArg).toBe('R1');
    expect(batchIdArg).toBe('b1');
    expect(payload['AI-0']).toBe(37.0);                      // TEMP_PV → AI-0
    expect(payload['AI-2']).toBe(7.2);                       // PH_PV → AI-2
    expect(payload.rpm).toBe(600);                           // 25 × 24 = 600 (Math.round)
    expect(payload.quality.TEMP_PV).toBe('good');
    expect(payload.quality.PH_PV).toBe('good');

    // flusher 1Hz tick → 1 个 Point
    vi.advanceTimersByTime(800); // 200 + 800 = 1000 (flusher 第一次 tick)
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^process_data,/);
    expect(lines[0]).toContain('reactor_id=R1');
    expect(lines[0]).toContain('batch_id=b1');
    expect(lines[0]).toContain('temperature=37'); // 主验 temperature 字段在
    expect(lines[0]).toContain('rpm=600');        // rpm = 25 × 24

    stopBroadcaster();
    stopFlusher();
  });

  // ── E2E 2: 通讯断模拟 — last-known-good + bad 跳过 ──
  it('通讯断: markStale 保 last-known-good, broadcaster 推 quality=bad, flusher skip', () => {
    const broadcastSpy = vi.fn();
    const { api, lines } = makeWriteApi();

    const stopBroadcaster = startRealtimeBroadcaster({
      tagCache: cache,
      broadcast: broadcastSpy,
      wss: makeWss(),
      getBatchId: () => 'b1',
      tickMs: 200,
    });
    const stopFlusher = startInfluxFlusher({
      tagCache: cache,
      influxWriteApi: api,
      reactorIds: () => ['R1'],
      getBatchId: () => 'b1',
      flushMs: 1000,
    });

    // 先 write 一次 good
    cache.write('R1', snap({ TEMP_PV: 37.0 }));
    expect(cache.read('R1', 'TEMP_PV')!.quality).toBe('good');

    // 模拟通讯断 → markStale 全 reactor
    cache.markStale('R1');
    const afterStale = cache.read('R1', 'TEMP_PV');
    expect(afterStale!.quality).toBe('bad');
    expect(afterStale!.value).toBe(37.0); // last-known-good 保留, 未清零

    // broadcaster tick — 注意: markStale 不算 change (write→good 算 change),
    // 所以下面 advance 触发的是先前 cache.write 入 dirty queue 的一次 fan-out.
    // 验证 fan-out payload 的 quality 字段是 bad (因为读 cache 时已是 stale 状态).
    vi.advanceTimersByTime(200);
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    const [, payload] = broadcastSpy.mock.calls[0];
    expect(payload.quality.TEMP_PV).toBe('bad');

    // flusher tick — bad TEMP_PV 应被 skip, 整个 reactor 唯一字段 bad → 不调
    // writePoint (line 81-82 of influx-flusher.ts: fieldCount === 0 → continue)
    vi.advanceTimersByTime(800);
    expect(lines).toHaveLength(0);

    stopBroadcaster();
    stopFlusher();
  });

  // ── E2E 3: dirty-only 行为 ──
  it('dirty-only: 同 snapshot 重复 write 不推送; 值真变化才推', () => {
    const broadcastSpy = vi.fn();

    const stopBroadcaster = startRealtimeBroadcaster({
      tagCache: cache,
      broadcast: broadcastSpy,
      wss: makeWss(),
      getBatchId: () => null,
      tickMs: 200,
    });

    // 首次 write — 算 change, 入 dirty queue
    cache.write('R1', snap({ TEMP_PV: 37.0 }));
    // 重复 write 同值 3 次 — 不算 change (tag-cache.ts line 145-159: sameValue → 不 fan-out)
    cache.write('R1', snap({ TEMP_PV: 37.0 }));
    cache.write('R1', snap({ TEMP_PV: 37.0 }));
    cache.write('R1', snap({ TEMP_PV: 37.0 }));

    // 第 1 个 tick: 首次 write 的 dirty 被 flush — 1 次 broadcast
    vi.advanceTimersByTime(200);
    expect(broadcastSpy).toHaveBeenCalledTimes(1);

    // 接下来 3 个 tick 期间无 cache.write — broadcaster 应静默
    vi.advanceTimersByTime(600);
    expect(broadcastSpy).toHaveBeenCalledTimes(1); // 仍 1 (静态期 0 推送)

    // 值真变化 → 触发 fan-out
    cache.write('R1', snap({ TEMP_PV: 38.0 }));
    vi.advanceTimersByTime(200);
    expect(broadcastSpy).toHaveBeenCalledTimes(2);
    const [, payload] = broadcastSpy.mock.calls[1];
    expect(payload['AI-0']).toBe(38.0);

    stopBroadcaster();
  });

  // ── E2E 4: 多 reactor 隔离 ──
  it('多 reactor 隔离: R1/R2 各自变化触发独立 broadcast, 不交叉', () => {
    const broadcastSpy = vi.fn();

    const stopBroadcaster = startRealtimeBroadcaster({
      tagCache: cache,
      broadcast: broadcastSpy,
      wss: makeWss(),
      getBatchId: (rid) => (rid === 'R1' ? 'b1' : 'b2'),
      tickMs: 200,
    });

    cache.write('R1', snap({ TEMP_PV: 37.0 }));
    cache.write('R2', snap({ PH_PV: 7.5 }));

    vi.advanceTimersByTime(200);

    // 一次 tick 内两 reactor 各 fan-out 一次
    expect(broadcastSpy).toHaveBeenCalledTimes(2);

    const byReactor = new Map<string, any>();
    for (const call of broadcastSpy.mock.calls) {
      const [, payload, batchId, reactorId] = call;
      byReactor.set(reactorId, { payload, batchId });
    }

    const r1 = byReactor.get('R1');
    const r2 = byReactor.get('R2');
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
    expect(r1.batchId).toBe('b1');
    expect(r2.batchId).toBe('b2');
    expect(r1.payload['AI-0']).toBe(37.0);            // R1 TEMP_PV
    expect(r1.payload['AI-2']).toBe(0);               // R1 无 PH_PV write → fallback 0
    expect(r2.payload['AI-2']).toBe(7.5);             // R2 PH_PV
    expect(r2.payload['AI-0']).toBe(0);               // R2 无 TEMP_PV write → fallback 0

    stopBroadcaster();
  });

  // ── E2E 5: back-pressure ──
  it('back-pressure: client.bufferedAmount > 1MB → skip 该 reactor + console.warn', () => {
    const broadcastSpy = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // 单 client, bufferedAmount = 2MB (> 1MB 默认阈值)
    const slowClient = { bufferedAmount: 2 * 1024 * 1024 };

    const stopBroadcaster = startRealtimeBroadcaster({
      tagCache: cache,
      broadcast: broadcastSpy,
      wss: makeWss([slowClient]),
      getBatchId: () => null,
      tickMs: 200,
    });

    cache.write('R1', snap({ TEMP_PV: 37.0 }));
    vi.advanceTimersByTime(200);

    // broadcast 被 skip (broadcaster.ts line 130-135: slowClientCount > 0 → continue)
    expect(broadcastSpy).not.toHaveBeenCalled();
    // console.warn 被调, 含 back-pressure / reactor=R1
    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = warnSpy.mock.calls[0][0];
    expect(warnMsg).toMatch(/back-pressure/);
    expect(warnMsg).toMatch(/reactor=R1/);

    stopBroadcaster();
  });
});
