// SP-PLC-3 Phase 1 Commit 1 — TagCache 单元测试 (15 项)
// SP-PLC-3 Phase 2 Commit 1 (P2.1) — per-tag deadband 扩展 (+5 项 → 20 项)
// 计划: docs/plans/SP-PLC-3-tag-cache-plan.md  §1 Commit 1 "测试覆盖"
//      docs/plans/SP-PLC-3-tag-cache-phase2-plan.md  §1 Commit 1 "测试覆盖"
import { describe, it, expect, beforeEach } from 'vitest';
import { TagCache, type CacheChange, type DeadbandResolver } from '../tag-cache';

const TS1 = '2026-05-25T00:00:00.000Z';
const TS2 = '2026-05-25T00:00:01.000Z';
const TS3 = '2026-05-25T00:00:02.000Z';

function snap(values: Record<string, number>, qualityOverride?: Record<string, 'good' | 'bad' | 'uncertain'>, timestamp = TS1) {
  const quality: Record<string, 'good' | 'bad' | 'uncertain'> = {};
  for (const tag of Object.keys(values)) quality[tag] = qualityOverride?.[tag] ?? 'good';
  return { timestamp, values, quality };
}

describe('TagCache', () => {
  let cache: TagCache;
  beforeEach(() => { cache = new TagCache(); });

  it('write 新 tag 创建 entry, ts/quality/lastChanged 正确', () => {
    const changes = cache.write('R1', snap({ TEMP_PV: 37.0 }));
    const entry = cache.read('R1', 'TEMP_PV');
    expect(entry).toBeDefined();
    expect(entry!.value).toBe(37.0);
    expect(entry!.ts).toBe(TS1);
    expect(entry!.quality).toBe('good');
    expect(entry!.lastChanged).toBe(TS1);
    expect(entry!.prevValue).toBe(37.0);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({ reactorId: 'R1', tag: 'TEMP_PV', entry: { ...entry! } });
  });

  it('write 同 tag 同值 → lastChanged 不变, prev 字段更新, 不返回 change', () => {
    cache.write('R1', snap({ TEMP_PV: 37.0 }, undefined, TS1));
    const changes = cache.write('R1', snap({ TEMP_PV: 37.0 }, undefined, TS2));
    const entry = cache.read('R1', 'TEMP_PV')!;
    expect(entry.lastChanged).toBe(TS1);
    expect(entry.ts).toBe(TS2);
    expect(entry.prevValue).toBe(37.0);
    expect(changes).toHaveLength(0);
  });

  it('write 同 tag 不同值 → lastChanged = ts, 返回 change', () => {
    cache.write('R1', snap({ TEMP_PV: 37.0 }, undefined, TS1));
    const changes = cache.write('R1', snap({ TEMP_PV: 38.5 }, undefined, TS2));
    const entry = cache.read('R1', 'TEMP_PV')!;
    expect(entry.value).toBe(38.5);
    expect(entry.lastChanged).toBe(TS2);
    expect(entry.prevValue).toBe(37.0);
    expect(changes).toHaveLength(1);
    expect(changes[0].tag).toBe('TEMP_PV');
  });

  it('deadband=0.5 时 abs(Δ) ≤ 0.5 视为同值', () => {
    cache.write('R1', snap({ TEMP_PV: 37.0 }, undefined, TS1), { deadband: 0.5 });
    // Δ=0.5 (边界) 视为同值
    const c1 = cache.write('R1', snap({ TEMP_PV: 37.5 }, undefined, TS2), { deadband: 0.5 });
    expect(c1).toHaveLength(0);
    expect(cache.read('R1', 'TEMP_PV')!.value).toBe(37.0);
    expect(cache.read('R1', 'TEMP_PV')!.lastChanged).toBe(TS1);
    // Δ=0.6 超 deadband → change
    const c2 = cache.write('R1', snap({ TEMP_PV: 37.6 }, undefined, TS3), { deadband: 0.5 });
    expect(c2).toHaveLength(1);
    expect(cache.read('R1', 'TEMP_PV')!.value).toBe(37.6);
  });

  it("quality 'bad' 时 value 不覆盖现存 good 值 (保留 last-known-good)", () => {
    cache.write('R1', snap({ TEMP_PV: 37.0 }, undefined, TS1));
    const changes = cache.write('R1', snap({ TEMP_PV: 0 }, { TEMP_PV: 'bad' }, TS2));
    const entry = cache.read('R1', 'TEMP_PV')!;
    expect(entry.value).toBe(37.0); // last-known-good 保留
    expect(entry.quality).toBe('bad');
    expect(entry.ts).toBe(TS2);
    expect(entry.lastChanged).toBe(TS1); // 未变
    expect(changes).toHaveLength(0); // 不算 change
  });

  it("subscribe('*', '*', cb) → 任意 reactor 任意 tag write 都收", () => {
    const received: CacheChange[][] = [];
    cache.subscribe({ reactorId: '*', tags: '*', callback: (c) => received.push(c) });
    cache.write('R1', snap({ TEMP_PV: 37.0 }));
    cache.write('R2', snap({ PH_PV: 7.2 }));
    expect(received).toHaveLength(2);
    expect(received[0][0].reactorId).toBe('R1');
    expect(received[1][0].reactorId).toBe('R2');
  });

  it("subscribe(reactorId, ['TEMP_PV']) → 只收该 reactor 该 tag", () => {
    const received: CacheChange[][] = [];
    cache.subscribe({ reactorId: 'R1', tags: new Set(['TEMP_PV']), callback: (c) => received.push(c) });
    cache.write('R1', snap({ TEMP_PV: 37.0, PH_PV: 7.2 }));
    cache.write('R2', snap({ TEMP_PV: 38.0 }));
    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(1);
    expect(received[0][0].tag).toBe('TEMP_PV');
    expect(received[0][0].reactorId).toBe('R1');
  });

  it('unsubscribe 后不再回调', () => {
    const received: CacheChange[][] = [];
    const id = cache.subscribe({ reactorId: '*', tags: '*', callback: (c) => received.push(c) });
    cache.write('R1', snap({ TEMP_PV: 37.0 }, undefined, TS1));
    expect(received).toHaveLength(1);
    expect(cache.unsubscribe(id)).toBe(true);
    expect(cache.unsubscribe(id)).toBe(false); // 二次 unsubscribe 返 false
    cache.write('R1', snap({ TEMP_PV: 38.0 }, undefined, TS2));
    expect(received).toHaveLength(1); // 未增加
  });

  it('read 不存在 reactor/tag 返 undefined', () => {
    expect(cache.read('NOPE', 'TEMP_PV')).toBeUndefined();
    cache.write('R1', snap({ TEMP_PV: 37.0 }));
    expect(cache.read('R1', 'NO_SUCH_TAG')).toBeUndefined();
  });

  it('readMany 部分 tag 不存在仅返存在的', () => {
    cache.write('R1', snap({ TEMP_PV: 37.0, PH_PV: 7.2 }));
    const result = cache.readMany('R1', ['TEMP_PV', 'NO_TAG', 'PH_PV']);
    expect(Object.keys(result).sort()).toEqual(['PH_PV', 'TEMP_PV']);
    expect(result.TEMP_PV.value).toBe(37.0);
    expect(result.PH_PV.value).toBe(7.2);
    // 不存在的 reactor
    expect(cache.readMany('NO_REACTOR', ['TEMP_PV'])).toEqual({});
  });

  it("markStale 单 tag → 仅该 tag quality='bad', value 保留", () => {
    cache.write('R1', snap({ TEMP_PV: 37.0, PH_PV: 7.2 }));
    cache.markStale('R1', ['TEMP_PV']);
    expect(cache.read('R1', 'TEMP_PV')!.quality).toBe('bad');
    expect(cache.read('R1', 'TEMP_PV')!.value).toBe(37.0); // 保留
    expect(cache.read('R1', 'PH_PV')!.quality).toBe('good'); // 未动
  });

  it("markStale 全 reactor → 所有 tag quality='bad'", () => {
    cache.write('R1', snap({ TEMP_PV: 37.0, PH_PV: 7.2, DO_PV: 80 }));
    cache.markStale('R1');
    expect(cache.read('R1', 'TEMP_PV')!.quality).toBe('bad');
    expect(cache.read('R1', 'PH_PV')!.quality).toBe('bad');
    expect(cache.read('R1', 'DO_PV')!.quality).toBe('bad');
    // value 全保留
    expect(cache.read('R1', 'TEMP_PV')!.value).toBe(37.0);
    expect(cache.read('R1', 'DO_PV')!.value).toBe(80);
  });

  it('多 reactor 隔离: reactor1 write 不影响 reactor2 read', () => {
    cache.write('R1', snap({ TEMP_PV: 37.0 }));
    cache.write('R2', snap({ TEMP_PV: 99.0 }));
    expect(cache.read('R1', 'TEMP_PV')!.value).toBe(37.0);
    expect(cache.read('R2', 'TEMP_PV')!.value).toBe(99.0);
    expect(cache.readAll('R1')).toEqual({ TEMP_PV: expect.objectContaining({ value: 37.0 }) });
    expect(cache.readAll('R2')).toEqual({ TEMP_PV: expect.objectContaining({ value: 99.0 }) });
  });

  it('size/clear 行为', () => {
    expect(cache.size()).toBe(0);
    cache.write('R1', snap({ TEMP_PV: 37.0, PH_PV: 7.2 }));
    cache.write('R2', snap({ DO_PV: 80 }));
    expect(cache.size('R1')).toBe(2);
    expect(cache.size('R2')).toBe(1);
    expect(cache.size('NOPE')).toBe(0);
    expect(cache.size()).toBe(3);
    cache.clear('R1');
    expect(cache.size('R1')).toBe(0);
    expect(cache.size('R2')).toBe(1);
    cache.clear();
    expect(cache.size()).toBe(0);
  });

  it('subscription callback 抛错不影响其它 subscriber (隔离 try/catch)', () => {
    const goodReceived: CacheChange[][] = [];
    cache.subscribe({ reactorId: '*', tags: '*', callback: () => { throw new Error('boom'); } });
    cache.subscribe({ reactorId: '*', tags: '*', callback: (c) => goodReceived.push(c) });
    // write 调用方不应感知抛错
    expect(() => cache.write('R1', snap({ TEMP_PV: 37.0 }))).not.toThrow();
    expect(goodReceived).toHaveLength(1);
    expect(goodReceived[0][0].tag).toBe('TEMP_PV');
  });
});

// ────────────────────────────────────────────────────────────────────
// SP-PLC-3 P2.1: per-tag deadband (5 新 tests + 1 除零守卫 = 6 tests)
// ────────────────────────────────────────────────────────────────────
describe('TagCache - SP-PLC-3 P2.1 per-tag deadband', () => {
  let cache: TagCache;
  beforeEach(() => { cache = new TagCache(); });

  it('per-tag deadband_abs 触发 change (|Δ| > abs)', () => {
    // resolver 全 tag 返 abs=0.5 pct=0
    const resolver: DeadbandResolver = () => ({ abs: 0.5, pct: 0 });
    cache.write('R1', snap({ TEMP_PV: 37.0 }, undefined, TS1), { deadbandResolver: resolver });

    // Δ=0.4 (< abs) → 不返 change
    const c1 = cache.write('R1', snap({ TEMP_PV: 37.4 }, undefined, TS2), { deadbandResolver: resolver });
    expect(c1).toHaveLength(0);
    expect(cache.read('R1', 'TEMP_PV')!.value).toBe(37.0);

    // Δ=0.5 (边界, 等于视为同值) → 不返 change
    const c2 = cache.write('R1', snap({ TEMP_PV: 37.5 }, undefined, TS3), { deadbandResolver: resolver });
    expect(c2).toHaveLength(0);
    expect(cache.read('R1', 'TEMP_PV')!.value).toBe(37.0);

    // Δ=0.6 (> abs) → 返 change
    const c3 = cache.write('R1', snap({ TEMP_PV: 37.6 }, undefined, TS3), { deadbandResolver: resolver });
    expect(c3).toHaveLength(1);
    expect(cache.read('R1', 'TEMP_PV')!.value).toBe(37.6);
  });

  it('per-tag deadband_pct 触发 change (|Δ%| > pct)', () => {
    // resolver 返 abs=0 pct=5 → 5% 阈值
    const resolver: DeadbandResolver = () => ({ abs: 0, pct: 5 });
    cache.write('R1', snap({ TEMP_PV: 100 }, undefined, TS1), { deadbandResolver: resolver });

    // Δ=4 → Δ%=4 (< 5) → 不返 change
    const c1 = cache.write('R1', snap({ TEMP_PV: 104 }, undefined, TS2), { deadbandResolver: resolver });
    expect(c1).toHaveLength(0);
    expect(cache.read('R1', 'TEMP_PV')!.value).toBe(100);

    // Δ=6 → Δ%=6 (> 5) → 返 change
    const c2 = cache.write('R1', snap({ TEMP_PV: 106 }, undefined, TS3), { deadbandResolver: resolver });
    expect(c2).toHaveLength(1);
    expect(cache.read('R1', 'TEMP_PV')!.value).toBe(106);
  });

  it('abs 和 pct 同时配 = OR (任一维度独立触发)', () => {
    // resolver abs=0.5, pct=5 → 任一超就 change
    const resolver: DeadbandResolver = () => ({ abs: 0.5, pct: 5 });

    // Case A: prev=100, 走 abs 维度 (abs 先触发)
    cache.write('R1', snap({ TAG_A: 100 }, undefined, TS1), { deadbandResolver: resolver });
    // Δ=0.6 → abs 触发 (0.6 > 0.5); Δ%=0.6 < 5 pct 不触发; OR → change
    const cA = cache.write('R1', snap({ TAG_A: 100.6 }, undefined, TS2), { deadbandResolver: resolver });
    expect(cA).toHaveLength(1);
    expect(cache.read('R1', 'TAG_A')!.value).toBe(100.6);

    // Case B: prev=100, 走 pct 维度 (pct 先触发)
    // 用新 reactor 隔离 state
    cache.write('R2', snap({ TAG_B: 100 }, undefined, TS1), { deadbandResolver: resolver });
    // Δ=6 → abs 触发 (6 > 0.5); 也 pct 触发 (6 > 5); 任一 OR → change
    const cB = cache.write('R2', snap({ TAG_B: 106 }, undefined, TS2), { deadbandResolver: resolver });
    expect(cB).toHaveLength(1);

    // Case C: 两维度都不触发
    cache.write('R3', snap({ TAG_C: 100 }, undefined, TS1), { deadbandResolver: resolver });
    // Δ=0.3 → abs 0.3<=0.5 不触发; Δ%=0.3 < 5 不触发; → 不 change
    const cC = cache.write('R3', snap({ TAG_C: 100.3 }, undefined, TS2), { deadbandResolver: resolver });
    expect(cC).toHaveLength(0);
    expect(cache.read('R3', 'TAG_C')!.value).toBe(100);
  });

  it('deadband resolver 返 undefined → fallback opts.deadband 全局', () => {
    // resolver 全返 undefined → fallback opts.deadband=1.0
    const resolver: DeadbandResolver = () => undefined;
    cache.write('R1', snap({ TEMP_PV: 100 }, undefined, TS1), { deadband: 1.0, deadbandResolver: resolver });

    // Δ=0.5 (≤ 1.0) → 不返 change
    const c1 = cache.write('R1', snap({ TEMP_PV: 100.5 }, undefined, TS2), { deadband: 1.0, deadbandResolver: resolver });
    expect(c1).toHaveLength(0);
    expect(cache.read('R1', 'TEMP_PV')!.value).toBe(100);

    // Δ=2.0 (> 1.0) → 返 change
    const c2 = cache.write('R1', snap({ TEMP_PV: 102 }, undefined, TS3), { deadband: 1.0, deadbandResolver: resolver });
    expect(c2).toHaveLength(1);
    expect(cache.read('R1', 'TEMP_PV')!.value).toBe(102);
  });

  it('旧 opts.deadband 仍可用 (向后兼容 Phase 1, 不传 resolver)', () => {
    // 完全不传 resolver, 仅 opts.deadband=0.3
    cache.write('R1', snap({ TEMP_PV: 37.0 }, undefined, TS1), { deadband: 0.3 });

    // Δ=0.3 (边界, ≤) → 不返 change (Phase 1 行为)
    const c1 = cache.write('R1', snap({ TEMP_PV: 37.3 }, undefined, TS2), { deadband: 0.3 });
    expect(c1).toHaveLength(0);
    expect(cache.read('R1', 'TEMP_PV')!.value).toBe(37.0);

    // Δ=0.4 (> 0.3) → 返 change
    const c2 = cache.write('R1', snap({ TEMP_PV: 37.4 }, undefined, TS3), { deadband: 0.3 });
    expect(c2).toHaveLength(1);
    expect(cache.read('R1', 'TEMP_PV')!.value).toBe(37.4);
  });

  it('prev=0 时 deadband_pct 除零守卫 (Risk 2c)', () => {
    // resolver 返 abs=0 pct=5 → 仅 pct 维度; prev=0 时 pct 不可用
    const resolver: DeadbandResolver = () => ({ abs: 0, pct: 5 });
    cache.write('R1', snap({ TAG_X: 0 }, undefined, TS1), { deadbandResolver: resolver });

    // prev=0, 写 0.1: abs=0 关闭, pct 模式 prev=0 跳过 → 既不 NaN 也不 Infinity, 不返 change
    const c1 = cache.write('R1', snap({ TAG_X: 0.1 }, undefined, TS2), { deadbandResolver: resolver });
    expect(c1).toHaveLength(0);
    expect(cache.read('R1', 'TAG_X')!.value).toBe(0);
    // 验证 prev 守卫生效: value 没被覆盖, 也没崩
    const entry = cache.read('R1', 'TAG_X')!;
    expect(Number.isFinite(entry.value)).toBe(true);
    expect(entry.lastChanged).toBe(TS1); // 未变
  });
});
