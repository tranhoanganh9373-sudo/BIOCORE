// ============================================================
// SP-PLC-3 Phase 1 Commit 3 — influx-flusher 单元测试 (6 项 + 1 bonus)
// 计划: docs/plans/SP-PLC-3-tag-cache-plan.md  §1 Commit 3 "测试覆盖"
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TagCache, type SnapshotInput } from '../tag-cache';
import { startInfluxFlusher } from '../influx-flusher';

const TS = '2026-05-25T00:00:00.000Z';

function snap(values: Record<string, number>, q?: Record<string, 'good' | 'bad' | 'uncertain'>): SnapshotInput {
  const quality: Record<string, 'good' | 'bad' | 'uncertain'> = {};
  for (const tag of Object.keys(values)) quality[tag] = q?.[tag] ?? 'good';
  return { timestamp: TS, values, quality };
}

/**
 * 解析 InfluxDB line protocol 字符串:
 *   measurement[,tag=val,...] field=val[,...] [timestamp]
 *
 * client 内部字段 (private name/tags/fields/time) TS 不允许直接读, 用
 * Point.toLineProtocol() 拿规范化输出再 parse. tag/field 值已被 escape,
 * 但单元测试用的合成 measurement / tag / field 名都不含特殊字符, parse
 * 直接 split 安全.
 */
interface CapturedPoint {
  measurement: string;
  tags: Record<string, string>;
  fields: Array<[string, number]>;
  raw: string;
}

function parseLine(line: string): CapturedPoint {
  // 三段: <measurement[,tags]> <fields> [ts]
  const firstSpace = line.indexOf(' ');
  const secondSpace = line.indexOf(' ', firstSpace + 1);
  const head = line.slice(0, firstSpace);
  const fieldsPart = secondSpace === -1
    ? line.slice(firstSpace + 1)
    : line.slice(firstSpace + 1, secondSpace);
  const headParts = head.split(',');
  const measurement = headParts[0];
  const tags: Record<string, string> = {};
  for (let i = 1; i < headParts.length; i++) {
    const [k, v] = headParts[i].split('=');
    tags[k] = v;
  }
  const fields: Array<[string, number]> = [];
  for (const kv of fieldsPart.split(',')) {
    const eq = kv.indexOf('=');
    const k = kv.slice(0, eq);
    let v = kv.slice(eq + 1);
    if (v.endsWith('i')) v = v.slice(0, -1); // integer suffix
    fields.push([k, Number(v)]);
  }
  return { measurement, tags, fields, raw: line };
}

function makeWriteApi() {
  const points: CapturedPoint[] = [];
  const flushSpy = vi.fn(() => Promise.resolve());
  const api: any = {
    writePoint(p: any) {
      const line = typeof p.toLineProtocol === 'function' ? p.toLineProtocol() : undefined;
      if (!line) return;
      points.push(parseLine(line));
    },
    flush: flushSpy,
  };
  return { api, points, flushSpy };
}

describe('SP-PLC-3 P3 — startInfluxFlusher', () => {
  let cache: TagCache;

  beforeEach(() => {
    cache = new TagCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── Test 1: 1Hz tick 写 1 Point per reactor ──
  it('1Hz tick 写 1 Point per reactor (9 字段, tag=reactor_id+batch_id, rpm=freq×24)', () => {
    const { api, points } = makeWriteApi();
    cache.write('R1', snap({
      TEMP_PV: 37, JACKET_PV: 36, PH_PV: 7.2, DO_PV: 80, PRESSURE_PV: 1.2,
      AIRFLOW_PV: 50, WEIGHT_PV: 100, VFD_ACTUAL_FREQ: 25, VFD_CURRENT: 3.1,
    }));

    const stop = startInfluxFlusher({
      tagCache: cache,
      influxWriteApi: api,
      reactorIds: () => ['R1'],
      getBatchId: () => 'b1',
      flushMs: 1000,
    });

    vi.advanceTimersByTime(1000);
    expect(points).toHaveLength(1);
    expect(points[0].measurement).toBe('process_data');
    expect(points[0].tags).toEqual({ reactor_id: 'R1', batch_id: 'b1' });
    const fieldNames = points[0].fields.map((f) => f[0]).sort();
    expect(fieldNames).toEqual(['DO', 'airflow', 'jacket_temp', 'pH', 'pressure', 'rpm', 'temperature', 'vfd_current', 'weight']);
    // rpm = VFD_ACTUAL_FREQ × 24 = 25 × 24 = 600
    const rpmField = points[0].fields.find((f) => f[0] === 'rpm');
    expect(rpmField![1]).toBe(600);
    stop();
  });

  // ── Test 2: quality='bad' 字段 skip 不入 Point ──
  it("quality='bad' 字段 skip 不入 Point (其它字段正常写)", () => {
    const { api, points } = makeWriteApi();
    cache.write('R1', snap({ TEMP_PV: 37, PH_PV: 7.2, DO_PV: 80 }));
    cache.markStale('R1', ['TEMP_PV']); // TEMP_PV quality → bad

    const stop = startInfluxFlusher({
      tagCache: cache,
      influxWriteApi: api,
      reactorIds: () => ['R1'],
      getBatchId: () => 'b1',
      flushMs: 1000,
    });

    vi.advanceTimersByTime(1000);
    expect(points).toHaveLength(1);
    const fieldNames = points[0].fields.map((f) => f[0]);
    expect(fieldNames).not.toContain('temperature'); // skip bad
    expect(fieldNames).toContain('pH');
    expect(fieldNames).toContain('DO');
    stop();
  });

  // ── Test 3: 全 reactor 全 bad → 不调 writePoint ──
  it('全 reactor 字段全 bad → 不调 writePoint (空 Point 无意义) + 不 flush', () => {
    const { api, points, flushSpy } = makeWriteApi();
    cache.write('R1', snap({ TEMP_PV: 37 }));
    cache.markStale('R1', ['TEMP_PV']);

    const stop = startInfluxFlusher({
      tagCache: cache,
      influxWriteApi: api,
      reactorIds: () => ['R1'],
      getBatchId: () => 'idle',
      flushMs: 1000,
    });

    vi.advanceTimersByTime(1000);
    expect(points).toHaveLength(0);
    expect(flushSpy).not.toHaveBeenCalled();
    stop();
  });

  // ── Test 4: writePoint 抛错被吞 (console.error), 不崩 tick ──
  it('writePoint 抛错被 catch + console.error, 下次 tick 仍跑, 不影响其它 reactor', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    cache.write('R1', snap({ TEMP_PV: 37 }));
    cache.write('R2', snap({ TEMP_PV: 38 }));
    let r1Called = 0, r2Called = 0;
    const api: any = {
      writePoint(p: any) {
        // 走 line protocol 拿 tag (跟 makeWriteApi 同套读取方法)
        const line = (typeof p.toLineProtocol === 'function' ? p.toLineProtocol() : '') || '';
        const isR1 = line.includes('reactor_id=R1');
        const isR2 = line.includes('reactor_id=R2');
        if (isR1) { r1Called++; throw new Error('R1 writePoint 故意抛错'); }
        if (isR2) r2Called++;
      },
      flush: vi.fn(() => Promise.resolve()),
    };

    const stop = startInfluxFlusher({
      tagCache: cache,
      influxWriteApi: api,
      reactorIds: () => ['R1', 'R2'],
      getBatchId: () => 'idle',
      flushMs: 1000,
    });

    vi.advanceTimersByTime(1000);
    expect(r1Called).toBe(1);
    expect(r2Called).toBe(1);                   // R1 抛错不影响 R2
    expect(errSpy).toHaveBeenCalled();
    expect(errSpy.mock.calls[0][0]).toMatch(/reactor=R1 tick failed/);

    // SP-PLC-3 P2.2: 下次 tick 前更新 cache 值 (新 lastChanged), 否则 flusher
    // 见 lastChanged 未变会 skip → 测不到 "下次 tick 仍跑" 的语义 (本 test
    // 测的是 R1 抛错后 R2 不受影响 + 轮询不崩, 不是 dedup 行为).
    // 注: R1 抛错路径让 lastFlushedAt 未更新, R1 见 lastChanged 不同 (因 R2 之前
    // 成功更新过自己的, 这里 R1 之前也写过但抛错→未更新 lastFlushedAt) → R1 仍能再写.
    // 但稳健起见显式更新两个 reactor 的值.
    cache.write('R1', { timestamp: '2026-05-25T00:00:02.000Z', values: { TEMP_PV: 40 }, quality: { TEMP_PV: 'good' } });
    cache.write('R2', { timestamp: '2026-05-25T00:00:02.000Z', values: { TEMP_PV: 41 }, quality: { TEMP_PV: 'good' } });
    vi.advanceTimersByTime(1000);
    expect(r1Called).toBe(2);
    expect(r2Called).toBe(2);
    stop();
  });

  // ── Test 5: flushMs=500 真生效 (假时钟测) ──
  it('flushMs=500 真生效 (advance 500ms 触发 1 tick)', () => {
    const { api, points } = makeWriteApi();
    cache.write('R1', snap({ TEMP_PV: 37 }));

    const stop = startInfluxFlusher({
      tagCache: cache,
      influxWriteApi: api,
      reactorIds: () => ['R1'],
      getBatchId: () => 'idle',
      flushMs: 500,
    });

    vi.advanceTimersByTime(499);
    expect(points).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(points).toHaveLength(1);
    // SP-PLC-3 P2.2: 第二次 tick 前更新 cache (新 lastChanged) 让 flusher 写新 Point,
    // 否则 lastChanged 未变会 skip — 本 test 测的是 tick 频率而非 dedup 行为.
    cache.write('R1', { timestamp: '2026-05-25T00:00:01.000Z', values: { TEMP_PV: 38 }, quality: { TEMP_PV: 'good' } });
    vi.advanceTimersByTime(500);
    expect(points).toHaveLength(2);
    stop();
  });

  // ── Test 6: stop function 清 interval ──
  it('stop function 清 interval (advance 不再 tick), 重复 stop 不抛', () => {
    const { api, points } = makeWriteApi();
    cache.write('R1', snap({ TEMP_PV: 37 }));

    const stop = startInfluxFlusher({
      tagCache: cache,
      influxWriteApi: api,
      reactorIds: () => ['R1'],
      getBatchId: () => 'idle',
      flushMs: 1000,
    });

    vi.advanceTimersByTime(1000);
    expect(points).toHaveLength(1);

    stop();
    vi.advanceTimersByTime(5000);
    expect(points).toHaveLength(1); // 仍是 stop 前那 1 个

    expect(() => stop()).not.toThrow();
  });

  // ── Bonus: influxWriteApi=null → 整 flusher noop ──
  it('influxWriteApi=null → 整 flusher noop, reactorIds 不被调用, stop 不抛', () => {
    const reactorIdsFn = vi.fn(() => ['R1']);
    const stop = startInfluxFlusher({
      tagCache: cache,
      influxWriteApi: null,
      reactorIds: reactorIdsFn,
      getBatchId: () => 'idle',
      flushMs: 1000,
    });

    vi.advanceTimersByTime(3000);
    expect(reactorIdsFn).not.toHaveBeenCalled(); // null api 早 return
    expect(() => stop()).not.toThrow();
  });
});

// ============================================================
// SP-PLC-3 P2.2 (2026-05-26): lastChanged 判定 (deadband 抑制后 skip 写入)
// ============================================================
describe('influx-flusher - SP-PLC-3 P2.2 lastChanged 判断', () => {
  let cache: TagCache;

  beforeEach(() => {
    cache = new TagCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── P2.2 Test 1: 同 lastChanged 重复 flush 时 skip 该 tag ──
  it('同 lastChanged 重复 flush 时 skip (deadband 抑制 → cache.lastChanged 不更新 → flusher 不重复写)', () => {
    const { api, points } = makeWriteApi();
    // 首次写入 TEMP_PV=37
    cache.write('R1', snap({ TEMP_PV: 37 }, undefined));

    const stop = startInfluxFlusher({
      tagCache: cache,
      influxWriteApi: api,
      reactorIds: () => ['R1'],
      getBatchId: () => 'b1',
      flushMs: 1000,
    });

    // Tick 1: 首次 flush, lastFlushedAt 空 → temperature 字段写入
    vi.advanceTimersByTime(1000);
    expect(points).toHaveLength(1);
    expect(points[0].fields.find((f) => f[0] === 'temperature')).toBeDefined();

    // 模拟 deadband 抑制: 再写同值 (cache 内同值不更新 lastChanged)
    cache.write('R1', { timestamp: '2026-05-25T00:00:05.000Z', values: { TEMP_PV: 37 }, quality: { TEMP_PV: 'good' } });

    // Tick 2: entry.lastChanged 未变 → temperature 字段 skip → fieldCount=0 → 不写 Point
    vi.advanceTimersByTime(1000);
    expect(points).toHaveLength(1); // 仍是 tick 1 那 1 个 Point, tick 2 全 skip
    stop();
  });

  // ── P2.2 Test 2: lastChanged 变化时正常写 (deadband 未抑制 → cache 更新 → flusher 写入) ──
  it('lastChanged 变化时正常写 (cache.lastChanged 更新 → flusher 写新 Point)', () => {
    const { api, points } = makeWriteApi();
    cache.write('R1', snap({ TEMP_PV: 37 }, undefined));

    const stop = startInfluxFlusher({
      tagCache: cache,
      influxWriteApi: api,
      reactorIds: () => ['R1'],
      getBatchId: () => 'b1',
      flushMs: 1000,
    });

    // Tick 1
    vi.advanceTimersByTime(1000);
    expect(points).toHaveLength(1);
    expect(points[0].fields.find((f) => f[0] === 'temperature')![1]).toBe(37);

    // 值真变化 → cache.lastChanged 更新到新 ts
    cache.write('R1', { timestamp: '2026-05-25T00:00:05.000Z', values: { TEMP_PV: 42 }, quality: { TEMP_PV: 'good' } });

    // Tick 2: lastChanged 已变 → 重新写入 + 新 value
    vi.advanceTimersByTime(1000);
    expect(points).toHaveLength(2);
    expect(points[1].fields.find((f) => f[0] === 'temperature')![1]).toBe(42);
    stop();
  });

  // ── P2.2 Test 3: quality='bad' 仍 skip (现有行为不变, lastChanged 判断在 quality 之后) ──
  it("quality='bad' 仍 skip (P2.2 lastChanged 路径不破现有 bad 行为)", () => {
    const { api, points } = makeWriteApi();
    cache.write('R1', snap({ TEMP_PV: 37, PH_PV: 7.2 }, undefined));
    cache.markStale('R1', ['TEMP_PV']); // TEMP_PV quality → bad, value 保留 last-known-good 37

    const stop = startInfluxFlusher({
      tagCache: cache,
      influxWriteApi: api,
      reactorIds: () => ['R1'],
      getBatchId: () => 'b1',
      flushMs: 1000,
    });

    // Tick 1: temperature skip (quality bad), pH 正常写入
    vi.advanceTimersByTime(1000);
    expect(points).toHaveLength(1);
    const tick1Fields = points[0].fields.map((f) => f[0]);
    expect(tick1Fields).not.toContain('temperature');
    expect(tick1Fields).toContain('pH');

    // Tick 2: temperature 仍 bad → 仍 skip; pH lastChanged 未变 → skip
    // → fieldCount=0 → 不写 Point
    vi.advanceTimersByTime(1000);
    expect(points).toHaveLength(1);

    // 重新 good 一个新值给 pH (lastChanged 变化) → tick 3 pH 重新写
    cache.write('R1', { timestamp: '2026-05-25T00:00:05.000Z', values: { PH_PV: 7.5 }, quality: { PH_PV: 'good' } });
    vi.advanceTimersByTime(1000);
    expect(points).toHaveLength(2);
    const tick3Fields = points[1].fields.map((f) => f[0]);
    expect(tick3Fields).not.toContain('temperature'); // TEMP_PV 仍 bad
    expect(tick3Fields).toContain('pH');              // PH_PV lastChanged 已变
    stop();
  });
});
