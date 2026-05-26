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

    // 下次 tick 仍跑
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
