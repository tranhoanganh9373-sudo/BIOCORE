// ============================================================
// SP-PLC-3 Phase 2 Commit 5 — cache-metrics 单元测试 (6 项 + 1 bonus)
// 计划: docs/plans/SP-PLC-3-tag-cache-phase2-plan.md  §1 Commit 5 "测试覆盖"
// ============================================================
//
// 覆盖 (与 spec 一致):
//   1. writesTotal 累加 (caller .inc() × N → counter = N)
//   2. dirtyTotal 仅 change 时增 (deadband 抑制 sameValue 时不增)
//   3. sizeGauge 周期采集反映真实 size
//   4. skippedTotal 接受 'back-pressure' / 'no-subscription' 两 reason
//   5. /metrics 输出含 4 新 metric (Prometheus format, 用 registry.serialize() 验)
//   6. stop function 清 interval + unsubscribe (调用后 dirty 不再累计 + interval 清)
//   bonus: 多次 register 同 registry 返同 metric 实例 (factory 幂等)
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MetricsRegistry } from '../../services/metrics';
import { TagCache, type SnapshotInput } from '../tag-cache';
import { registerCacheMetrics } from '../cache-metrics';

const TS = '2026-05-26T00:00:00.000Z';

function snap(values: Record<string, number>, q?: Record<string, 'good' | 'bad' | 'uncertain'>): SnapshotInput {
  const quality: Record<string, 'good' | 'bad' | 'uncertain'> = {};
  for (const tag of Object.keys(values)) quality[tag] = q?.[tag] ?? 'good';
  return { timestamp: TS, values, quality };
}

describe('SP-PLC-3 P2.5 — registerCacheMetrics', () => {
  let cache: TagCache;
  let registry: MetricsRegistry;

  beforeEach(() => {
    cache = new TagCache();
    registry = new MetricsRegistry();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. writesTotal 累加
  it('writesTotal 累加: caller .inc() × N → counter = N', () => {
    const h = registerCacheMetrics({ registry, tagCache: cache, reactorIds: () => [] });
    for (let i = 0; i < 5; i++) h.writesTotal.inc();
    expect(h.writesTotal.get()).toBe(5);
    h.stop();
  });

  // 2. dirtyTotal 仅 change 时增 (deadband 抑制 sameValue 时不增)
  it('dirtyTotal 仅 change 时增: deadband 抑制 sameValue 时 counter 不增', () => {
    const h = registerCacheMetrics({ registry, tagCache: cache, reactorIds: () => [] });
    // 首次写入: 全 change (无 prev), counter +1 per tag.
    cache.write('R1', snap({ TEMP_PV: 37.0 }));
    expect(h.dirtyTotal.get({ reactor: 'R1' })).toBe(1);

    // 同值再写: prevValue=newValue, sameValue=true (deadband=0 时绝对相等也算 same).
    // TagCache.write 不 fan-out → subscribe callback 不触发 → counter 不增.
    cache.write('R1', snap({ TEMP_PV: 37.0 }));
    expect(h.dirtyTotal.get({ reactor: 'R1' })).toBe(1);

    // 值真变: fan-out → counter +1.
    cache.write('R1', snap({ TEMP_PV: 37.5 }));
    expect(h.dirtyTotal.get({ reactor: 'R1' })).toBe(2);
    h.stop();
  });

  // 3. sizeGauge 周期采集反映真实 size
  it('sizeGauge 周期采集反映真实 size', () => {
    cache.write('R1', snap({ TEMP_PV: 37, PH_PV: 7 }));
    cache.write('R2', snap({ TEMP_PV: 38 }));
    const h = registerCacheMetrics({
      registry,
      tagCache: cache,
      reactorIds: () => ['R1', 'R2'],
      sizeSampleMs: 100, // 测试用短周期
    });

    // 启动后立即采集 (setInterval 第一次 tick 在 100ms 后).
    expect(h.sizeGauge.get({ reactor: 'R1' })).toBe(0); // 还未 tick
    vi.advanceTimersByTime(100);
    expect(h.sizeGauge.get({ reactor: 'R1' })).toBe(2);
    expect(h.sizeGauge.get({ reactor: 'R2' })).toBe(1);

    // 增加 tag, 下次 tick 反映.
    cache.write('R1', snap({ DO_PV: 30 }));
    vi.advanceTimersByTime(100);
    expect(h.sizeGauge.get({ reactor: 'R1' })).toBe(3);
    h.stop();
  });

  // 4. skippedTotal 接受 'back-pressure' / 'no-subscription' 两 reason
  it('skippedTotal 接 back-pressure / no-subscription 两 reason', () => {
    const h = registerCacheMetrics({ registry, tagCache: cache, reactorIds: () => [] });
    // 模拟 broadcaster onSkip / createWsServer onSkip 注入 (caller 在 index.ts wiring 时这样做).
    const skipCb = (reason: 'back-pressure' | 'no-subscription') =>
      h.skippedTotal.inc({ reason });
    skipCb('back-pressure');
    skipCb('back-pressure');
    skipCb('no-subscription');
    expect(h.skippedTotal.get({ reason: 'back-pressure' })).toBe(2);
    expect(h.skippedTotal.get({ reason: 'no-subscription' })).toBe(1);
    h.stop();
  });

  // 5. /metrics 输出含 4 新 metric (Prometheus format)
  it('registry.serialize() 输出含 4 新 metric (Prometheus format)', () => {
    const h = registerCacheMetrics({
      registry,
      tagCache: cache,
      reactorIds: () => ['R1'],
      sizeSampleMs: 50,
    });
    cache.write('R1', snap({ TEMP_PV: 37 })); // 先 register 再 write, dirtyTotal 才累计
    h.writesTotal.inc();
    h.skippedTotal.inc({ reason: 'back-pressure' });
    vi.advanceTimersByTime(50); // 触发 size 采集
    const out = registry.serialize();
    expect(out).toContain('# TYPE biocore_tagcache_writes_total counter');
    expect(out).toContain('# TYPE biocore_tagcache_size gauge');
    expect(out).toContain('# TYPE biocore_tagcache_dirty_total counter');
    expect(out).toContain('# TYPE biocore_broadcaster_skipped_total counter');
    // 验值真出现
    expect(out).toContain('biocore_tagcache_writes_total 1');
    expect(out).toContain('biocore_tagcache_size{reactor="R1"} 1');
    expect(out).toContain('biocore_tagcache_dirty_total{reactor="R1"} 1');
    expect(out).toContain('biocore_broadcaster_skipped_total{reason="back-pressure"} 1');
    h.stop();
  });

  // 6. stop function 清 interval + unsubscribe
  it('stop() 清 interval + unsubscribe: 调用后 dirty 不增, size 不再周期采', () => {
    const h = registerCacheMetrics({
      registry,
      tagCache: cache,
      reactorIds: () => ['R1'],
      sizeSampleMs: 100,
    });
    cache.write('R1', snap({ TEMP_PV: 37 }));
    expect(h.dirtyTotal.get({ reactor: 'R1' })).toBe(1);
    vi.advanceTimersByTime(100);
    expect(h.sizeGauge.get({ reactor: 'R1' })).toBe(1);

    h.stop();

    // 停止后再 write 值: subscribe 已 unsubscribe → counter 不增.
    cache.write('R1', snap({ TEMP_PV: 38 }));
    expect(h.dirtyTotal.get({ reactor: 'R1' })).toBe(1);

    // 加更多 tag, advance 时间, gauge 应保持旧值 (interval 已清).
    cache.write('R1', snap({ PH_PV: 7 }));
    vi.advanceTimersByTime(100);
    expect(h.sizeGauge.get({ reactor: 'R1' })).toBe(1); // 仍是停止前的快照

    // 重复 stop() 安全
    expect(() => h.stop()).not.toThrow();
  });

  // bonus: 多次 register 同 registry 返同 metric 实例 (factory 幂等)
  it('多次 register 同一 registry 返同 metric 实例 (factory 幂等)', () => {
    const h1 = registerCacheMetrics({ registry, tagCache: cache, reactorIds: () => [] });
    const h2 = registerCacheMetrics({ registry, tagCache: cache, reactorIds: () => [] });
    expect(h1.writesTotal).toBe(h2.writesTotal); // 同 Counter 实例
    h1.stop();
    h2.stop();
  });
});

// ============================================================
// SP-PLC-3 Phase 3a Commit 2 (P3a.2) — broadcaster fan-out latency Histogram
// 计划: docs/plans/SP-PLC-3-tag-cache-phase3a-plan.md  §1 Commit 2
// ============================================================
//
// 覆盖 (与 plan §1 Commit 2 spec 完全一致):
//   1. fan-out 调用后 histogram count 增 1 (observe 0.005s → 0.01 桶 +1)
//   2. 大 batch (100 reactor) fan-out latency 入桶 (observe 0.5s → ≤0.5 桶 +1, 不超 5s)
//   3. 0 dirty (空 tick) 不 observe (无人调 .observe → count 仍 0)
//
// 注: 这 3 项是 cache-metrics handle 侧的 Histogram 行为验证, 用 fanoutHistogram
// 直接 observe 模拟 broadcaster.onFanout 回调. broadcaster 端 onFanout 仅在
// reactorsToFlush.length>=1 时调一次的契约由 realtime-broadcaster.ts 早返保证.
// ============================================================

describe('SP-PLC-3 P3a.2 — fanoutHistogram (broadcaster fan-out latency)', () => {
  let cache: TagCache;
  let registry: MetricsRegistry;

  beforeEach(() => {
    cache = new TagCache();
    registry = new MetricsRegistry();
  });

  // 1. fan-out 调用后 histogram count 增 1, 且 0.01 桶 +1
  it('observe 0.005s → count=1 sum=0.005 且 0.01 / 0.05 / ... 全桶各 +1', () => {
    const h = registerCacheMetrics({ registry, tagCache: cache, reactorIds: () => [] });

    // 模拟 broadcaster.onFanout(0.005) 一次, 即 5ms fan-out 完成
    h.fanoutHistogram.observe(0.005);

    const snap = h.fanoutHistogram.snapshot();
    expect(snap.count).toBe(1);
    expect(snap.sum).toBeCloseTo(0.005, 6);
    // 0.005 ≤ 0.01 → 全部 ≥0.01 的桶累积都 +1 (services/metrics Histogram 语义)
    expect(snap.buckets[0.01]).toBe(1);
    expect(snap.buckets[0.05]).toBe(1);
    expect(snap.buckets[0.1]).toBe(1);
    expect(snap.buckets[0.5]).toBe(1);
    expect(snap.buckets[1]).toBe(1);
    expect(snap.buckets[5]).toBe(1);

    // Prometheus 序列化含本 metric (8 行: 6 buckets + +Inf + sum + count)
    const out = registry.serialize();
    expect(out).toContain('# HELP biocore_broadcaster_fanout_seconds');
    expect(out).toContain('# TYPE biocore_broadcaster_fanout_seconds histogram');
    expect(out).toContain('biocore_broadcaster_fanout_seconds_count 1');

    h.stop();
  });

  // 2. 大 batch (100 reactor) fan-out latency 入桶 (~0.5s), 不超 5s 上限
  it('大 batch fan-out 0.5s observe → ≤0.5 桶各 +1, ≤0.1 桶不增', () => {
    const h = registerCacheMetrics({ registry, tagCache: cache, reactorIds: () => [] });

    // 模拟 100 reactor 大 fan-out, 总耗时 0.5s (上限边界)
    h.fanoutHistogram.observe(0.5);

    const snap = h.fanoutHistogram.snapshot();
    expect(snap.count).toBe(1);
    expect(snap.sum).toBeCloseTo(0.5, 6);
    // 0.5 ≤ 0.5 = true → 0.5 桶 +1; 但 > 0.1 → 0.01/0.05/0.1 桶不增
    expect(snap.buckets[0.01]).toBe(0);
    expect(snap.buckets[0.05]).toBe(0);
    expect(snap.buckets[0.1]).toBe(0);
    expect(snap.buckets[0.5]).toBe(1);
    expect(snap.buckets[1]).toBe(1);
    expect(snap.buckets[5]).toBe(1);
    // 0.5s 远低于 5s 上限, 不应丢失 (无 +Inf 桶溢出)

    h.stop();
  });

  // 3. 0 dirty 空 tick 不 observe — fanoutHistogram 在无人调时 count 保持 0
  it('0 dirty 空 tick 不 observe: 从未调 fanoutHistogram.observe → count=0 sum=0', () => {
    const h = registerCacheMetrics({ registry, tagCache: cache, reactorIds: () => [] });

    // 注: broadcaster 端 (realtime-broadcaster.ts tick) 的 dirtyQueue.size===0
    // 早返契约保证 onFanout 不被调用; 此处从 cache-metrics handle 视角验证
    // "无人调 observe → Histogram 状态保持初值".
    const snap = h.fanoutHistogram.snapshot();
    expect(snap.count).toBe(0);
    expect(snap.sum).toBe(0);
    for (const bound of [0.01, 0.05, 0.1, 0.5, 1, 5]) {
      expect(snap.buckets[bound]).toBe(0);
    }

    h.stop();
  });
});
