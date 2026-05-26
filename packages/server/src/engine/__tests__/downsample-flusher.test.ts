// ============================================================
// SP-PLC-3 Phase 2 Commit 5 — downsample-flusher 单元测试 (6 项 + 1 bonus)
// 计划: docs/plans/SP-PLC-3-tag-cache-phase2-plan.md  §1 Commit 5 "测试覆盖"
// ============================================================
//
// 覆盖 (与 spec 一致):
//   1. 10s tick 写 1 Point per reactor (measurement='process_data_downsampled',
//      mean of accum, rpm=freq×24)
//   2. quality='bad' 字段 skip 不入 accum (subscribe 过滤良值)
//   3. 全 reactor 0 value (accum 空) → 不调 writePoint
//   4. writePoint 抛错被 catch + console.error, 不崩 tick
//   5. flushMs=500 真生效 (假时钟驱动)
//   6. stop function 清 interval + unsubscribe + accum (停止后 cache write 不再累)
//   bonus: influxDownsampleApi=null 时 noop (subscribe 仍在但不 writePoint)
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TagCache, type SnapshotInput } from '../tag-cache';
import { startDownsampleFlusher } from '../downsample-flusher';

const TS = '2026-05-26T00:00:00.000Z';

function snap(values: Record<string, number>, q?: Record<string, 'good' | 'bad' | 'uncertain'>): SnapshotInput {
  const quality: Record<string, 'good' | 'bad' | 'uncertain'> = {};
  for (const tag of Object.keys(values)) quality[tag] = q?.[tag] ?? 'good';
  return { timestamp: TS, values, quality };
}

/**
 * 解析 InfluxDB line protocol (复用 influx-flusher.test.ts 同款 parser).
 *   measurement[,tag=val,...] field=val[,...] [timestamp]
 */
interface CapturedPoint {
  measurement: string;
  tags: Record<string, string>;
  fields: Array<[string, number]>;
  raw: string;
}

function parseLine(line: string): CapturedPoint {
  const firstSpace = line.indexOf(' ');
  const secondSpace = line.indexOf(' ', firstSpace + 1);
  const head = line.slice(0, firstSpace);
  const fieldsPart = secondSpace === -1 ? line.slice(firstSpace + 1) : line.slice(firstSpace + 1, secondSpace);
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
    if (v.endsWith('i')) v = v.slice(0, -1);
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

describe('SP-PLC-3 P2.5 — startDownsampleFlusher', () => {
  let cache: TagCache;

  beforeEach(() => {
    cache = new TagCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // 1. 10s tick 写 1 Point per reactor (mean of accumulated values)
  it('10s tick 写 1 Point per reactor (measurement=process_data_downsampled, mean of accum, rpm=freq×24)', () => {
    const { api, points } = makeWriteApi();
    const stop = startDownsampleFlusher({
      tagCache: cache,
      influxDownsampleApi: api,
      reactorIds: () => ['R1'],
      getBatchId: () => 'b1',
      flushMs: 10000,
    });

    // 累计 3 个不同的 TEMP_PV 值, mean = (36 + 37 + 38) / 3 = 37
    cache.write('R1', snap({ TEMP_PV: 36 }));
    cache.write('R1', snap({ TEMP_PV: 37 }));
    cache.write('R1', snap({ TEMP_PV: 38 }));
    // 累计 2 个 VFD_ACTUAL_FREQ, mean=24.5, rpm = 24.5 × 24 = 588
    cache.write('R1', snap({ VFD_ACTUAL_FREQ: 24 }));
    cache.write('R1', snap({ VFD_ACTUAL_FREQ: 25 }));

    vi.advanceTimersByTime(10000);
    expect(points).toHaveLength(1);
    expect(points[0].measurement).toBe('process_data_downsampled');
    expect(points[0].tags).toEqual({ reactor_id: 'R1', batch_id: 'b1' });

    const tempField = points[0].fields.find((f) => f[0] === 'temperature');
    expect(tempField).toBeDefined();
    expect(tempField![1]).toBe(37); // (36+37+38)/3

    const rpmField = points[0].fields.find((f) => f[0] === 'rpm');
    expect(rpmField).toBeDefined();
    expect(rpmField![1]).toBe(588); // 24.5 × 24

    stop();
  });

  // 2. quality='bad' 字段 skip 不入 accum
  it("quality='bad' 字段 skip 不入 accum (subscribe 过滤良值)", () => {
    const { api, points } = makeWriteApi();
    const stop = startDownsampleFlusher({
      tagCache: cache,
      influxDownsampleApi: api,
      reactorIds: () => ['R1'],
      getBatchId: () => 'b1',
      flushMs: 10000,
    });

    // TEMP_PV 走 good 路径, 入 accum.
    cache.write('R1', snap({ TEMP_PV: 37 }));
    // 首次写入 PH_PV 带 quality='bad' — P1 TagCache 行为: 首次写入即便 quality='bad'
    // 也接受 newValue 并 fan-out 携带 entry.quality='bad' (tag-cache.ts:162-170).
    // 我们的 subscribe callback 校验 c.entry.quality !== 'good' → skip 不入 accum.
    cache.write('R1', snap({ PH_PV: 7 }, { PH_PV: 'bad' }));

    vi.advanceTimersByTime(10000);
    expect(points).toHaveLength(1);
    const fieldNames = points[0].fields.map((f) => f[0]);
    expect(fieldNames).toContain('temperature'); // good 累计
    expect(fieldNames).not.toContain('pH'); // quality=bad → 未入 accum
    stop();
  });

  // 3. 全 reactor 0 value (accum 空) → 不调 writePoint
  it('全 reactor 0 value (accum 空) → 不调 writePoint + 不 flush', () => {
    const { api, points, flushSpy } = makeWriteApi();
    const stop = startDownsampleFlusher({
      tagCache: cache,
      influxDownsampleApi: api,
      reactorIds: () => ['R1', 'R2'],
      getBatchId: () => 'idle',
      flushMs: 10000,
    });
    // 不写入任何 tag → accum 全空
    vi.advanceTimersByTime(10000);
    expect(points).toHaveLength(0);
    expect(flushSpy).not.toHaveBeenCalled();
    stop();
  });

  // 4. writePoint 抛错被 catch + console.error
  it('writePoint 抛错被 catch + console.error, 不崩 tick, 下次 tick 继续跑', () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const flushSpy = vi.fn(() => Promise.resolve());
    let throwOnce = true;
    const api: any = {
      writePoint() {
        if (throwOnce) {
          throwOnce = false;
          throw new Error('boom');
        }
      },
      flush: flushSpy,
    };

    const stop = startDownsampleFlusher({
      tagCache: cache,
      influxDownsampleApi: api,
      reactorIds: () => ['R1'],
      getBatchId: () => 'b1',
      flushMs: 10000,
    });

    cache.write('R1', snap({ TEMP_PV: 37 }));
    vi.advanceTimersByTime(10000);
    // 抛错被吞, console.error 调用
    expect(consoleErrSpy).toHaveBeenCalled();
    // 下次 tick 仍能跑 (新写值 → 新 Point 成功写)
    cache.write('R1', snap({ TEMP_PV: 38 }));
    vi.advanceTimersByTime(10000);
    expect(flushSpy).toHaveBeenCalled();
    stop();
  });

  // 5. flushMs=500 真生效
  it('flushMs=500 真生效 (假时钟驱动)', () => {
    const { api, points } = makeWriteApi();
    const stop = startDownsampleFlusher({
      tagCache: cache,
      influxDownsampleApi: api,
      reactorIds: () => ['R1'],
      getBatchId: () => 'b1',
      flushMs: 500,
    });
    cache.write('R1', snap({ TEMP_PV: 37 }));
    vi.advanceTimersByTime(499);
    expect(points).toHaveLength(0); // 还未到周期
    vi.advanceTimersByTime(1);
    expect(points).toHaveLength(1); // 500ms 到, 写 1 Point

    // 再写新值, 再过 500ms, 又一 Point.
    cache.write('R1', snap({ TEMP_PV: 38 }));
    vi.advanceTimersByTime(500);
    expect(points).toHaveLength(2);
    stop();
  });

  // 6. stop function 清 interval + unsubscribe + accum
  it('stop() 清 interval + unsubscribe + accum: 停止后 cache write 不再累, tick 不再触发', () => {
    const { api, points } = makeWriteApi();
    const stop = startDownsampleFlusher({
      tagCache: cache,
      influxDownsampleApi: api,
      reactorIds: () => ['R1'],
      getBatchId: () => 'b1',
      flushMs: 500,
    });
    cache.write('R1', snap({ TEMP_PV: 37 }));
    vi.advanceTimersByTime(500);
    expect(points).toHaveLength(1);

    stop();

    // 停止后 cache write 不再 callback (unsubscribe), interval 不再 tick.
    cache.write('R1', snap({ TEMP_PV: 38 }));
    vi.advanceTimersByTime(5000); // 跨多个 tick 周期
    expect(points).toHaveLength(1); // 仍是停止前的 1 Point

    // 重复 stop() 安全
    expect(() => stop()).not.toThrow();
  });

  // bonus: influxDownsampleApi=null noop (但不抛 + 维持订阅 + 周期 reset accum 防泄漏)
  it('influxDownsampleApi=null 时 noop (不抛 + 不 writePoint + accum 仍 reset 防泄漏)', () => {
    const stop = startDownsampleFlusher({
      tagCache: cache,
      influxDownsampleApi: null,
      reactorIds: () => ['R1'],
      getBatchId: () => 'b1',
      flushMs: 500,
    });
    cache.write('R1', snap({ TEMP_PV: 37 }));
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    // tick 跑过且 buffer reset (内部代码路径覆盖); 无 api 可观测 Point.
    stop();
  });
});
