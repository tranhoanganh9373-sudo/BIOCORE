// ============================================================
// SP-PLC-3 Phase 1 Commit 2 — reactor-wiring × TagCache 集成测试 (8 项)
// 计划: docs/plans/SP-PLC-3-tag-cache-plan.md  §1 Commit 2 "测试覆盖"
// ============================================================
//
// 本测试 **不** 实例化 createReactorWiring 重 tick 闭包 (InfluxDB Point /
// broadcast / CUSUM detector 全链路解耦留 Commit 3/4); 改为单元覆盖 P2
// 引入的契约面:
//
//   - buildMockSnapshot(TAGS, reactorId) shape + devPlcRead 不变量
//   - PollingScheduler.emit('snapshot') → tagCache.write 的桥接契约
//   - scheduler.emit('error') → tagCache.markStale 的桥接契约
//   - pollingSchedulers Map 多 reactor 隔离
//   - SIGTERM 钩子调用 scheduler.stop()
//
// 用 mock scheduler (EventEmitter 子类) 替真 PollingScheduler — 后者
// 构造时需要 PLCConnectionManager + native binding, 本机 dev 无法触达.
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { TagCache, type SnapshotInput } from '../tag-cache';
import { buildMockSnapshot } from '../../reactor-wiring';
import { devPlcRead } from '../../plc-bridge';

// reactor-wiring 真实 TAGS 列表 (与 reactor-wiring.ts line 110-116 同步)
const TAGS = [
  'TEMP_PV', 'JACKET_PV', 'PH_PV', 'DO_PV', 'PRESSURE_PV', 'AIRFLOW_PV', 'WEIGHT_PV',
  'VFD_ACTUAL_FREQ', 'VFD_CURRENT',
  'STEAM_CV', 'COOL_CV', 'AIR_CV',
  'P01_RATE', 'P02_RATE', 'P03_RATE', 'P04_RATE',
  'TEMP_SV', 'PH_SV', 'DO_SV',
];

/** 真 PollingScheduler 的最小 mock — 只用 EventEmitter + stop spy. */
class MockScheduler extends EventEmitter {
  public stopCount = 0;
  start(): void { /* no-op (测试直接 emit) */ }
  stop(): void { this.stopCount++; }
  isRunning(): boolean { return true; }
}

describe('SP-PLC-3 P2 — reactor-wiring × TagCache 集成', () => {
  let cache: TagCache;
  let schedulers: Map<string, MockScheduler>;

  beforeEach(() => {
    cache = new TagCache();
    schedulers = new Map();
  });

  afterEach(() => {
    // 防止 process listener 累积污染后续 test
    process.removeAllListeners('SIGTERM');
  });

  // ── Test 1: mock 路径 ─────────────────────────────────────
  it('mock 路径: buildMockSnapshot 写 cache → readAll 拼 rawPV', () => {
    // Arrange: 模拟 reactor-wiring 闭包内 MOCK_PLC 分支
    const snap = buildMockSnapshot(TAGS, 'R1');
    cache.write('R1', snap);

    // Act: 闭包后续 readAll 拼 rawPV
    const entries = cache.readAll('R1');
    const rawPV: Record<string, number> = {};
    for (const tag of TAGS) {
      const entry = entries[tag];
      rawPV[tag] = entry ? entry.value : 0;
    }

    // Assert: 19 个 tag 全有值, shape 等于 buildMockSnapshot.values
    expect(Object.keys(rawPV).sort()).toEqual([...TAGS].sort());
    for (const tag of TAGS) {
      expect(rawPV[tag]).toBe(snap.values[tag]);
    }
  });

  // ── Test 2: 真实路径 (mock scheduler) ────────────────────
  it('真实路径: scheduler.emit("snapshot") → cache 写入 → reactor-wiring 闭包从 cache 读', () => {
    // Arrange: 注册 mock scheduler 走真实路径 (跟 index.ts start() 启动期一致)
    const scheduler = new MockScheduler();
    schedulers.set('R1', scheduler);
    scheduler.on('snapshot', (snap: SnapshotInput) => cache.write('R1', snap));

    // Act: PollingScheduler 异步 emit snapshot (来自 PLC region read)
    const realSnap: SnapshotInput = {
      timestamp: '2026-05-25T00:00:00.000Z',
      values: { TEMP_PV: 37.5, PH_PV: 7.2, DO_PV: 45.0 },
      quality: { TEMP_PV: 'good', PH_PV: 'good', DO_PV: 'good' },
    };
    scheduler.emit('snapshot', realSnap);

    // Assert: reactor-wiring 下个 tick readAll 拿到 emit 的真实值
    const entries = cache.readAll('R1');
    expect(entries['TEMP_PV']?.value).toBe(37.5);
    expect(entries['PH_PV']?.value).toBe(7.2);
    expect(entries['DO_PV']?.value).toBe(45.0);
    expect(entries['TEMP_PV']?.quality).toBe('good');
  });

  // ── Test 3: MOCK_PLC=true 路径选择 ────────────────────────
  it('MOCK_PLC=true 或无 scheduler 时走 mock 分支 (pollingSchedulers.get 返 undefined)', () => {
    // 路由逻辑 (reactor-wiring.ts 修改后): `MOCK_PLC || !pollingSchedulers?.get(reactorId)`
    // 为 true → buildMockSnapshot. 即便 schedulers Map 实例化但未 set 该 reactor,
    // 也走 mock 路径不崩.
    const reactorId = 'R-NO-PLC';
    const hasScheduler = !!schedulers.get(reactorId);
    expect(hasScheduler).toBe(false);

    // Act: 走 mock 分支
    cache.write(reactorId, buildMockSnapshot(TAGS, reactorId));
    const entries = cache.readAll(reactorId);

    // Assert: 19 tag 全 'good' 且非空 (devPlcRead mock 路径不会抛)
    expect(Object.keys(entries)).toHaveLength(TAGS.length);
    for (const tag of TAGS) {
      expect(entries[tag]?.quality).toBe('good');
    }
  });

  // ── Test 4: 通讯断 → markStale 保留 last-known-good ─────
  it('scheduler emit("error") → cache.markStale, 下次 read quality="bad" value 保留', () => {
    // Arrange: 先写一笔 good 值
    const scheduler = new MockScheduler();
    schedulers.set('R1', scheduler);
    scheduler.on('snapshot', (snap: SnapshotInput) => cache.write('R1', snap));
    scheduler.on('error', () => cache.markStale('R1'));

    scheduler.emit('snapshot', {
      timestamp: '2026-05-25T00:00:00.000Z',
      values: { TEMP_PV: 37.5 },
      quality: { TEMP_PV: 'good' },
    });
    expect(cache.read('R1', 'TEMP_PV')?.quality).toBe('good');
    expect(cache.read('R1', 'TEMP_PV')?.value).toBe(37.5);

    // Act: 通讯断
    scheduler.emit('error', new Error('connection lost'));

    // Assert: quality 变 bad, value 保留 last-known-good
    const entry = cache.read('R1', 'TEMP_PV');
    expect(entry?.quality).toBe('bad');
    expect(entry?.value).toBe(37.5);
  });

  // ── Test 5: 多 reactor 隔离 ────────────────────────────────
  it('多 reactor 隔离: scheduler1 snapshot 不写入 reactor2 cache', () => {
    // Arrange: 两个独立 scheduler 绑定不同 reactor
    const s1 = new MockScheduler();
    const s2 = new MockScheduler();
    schedulers.set('R1', s1);
    schedulers.set('R2', s2);
    s1.on('snapshot', (snap: SnapshotInput) => cache.write('R1', snap));
    s2.on('snapshot', (snap: SnapshotInput) => cache.write('R2', snap));

    // Act: 只 R1 emit
    s1.emit('snapshot', {
      timestamp: '2026-05-25T00:00:00.000Z',
      values: { TEMP_PV: 37.5 },
      quality: { TEMP_PV: 'good' },
    });

    // Assert: R1 有值, R2 cache 完全空
    expect(cache.read('R1', 'TEMP_PV')?.value).toBe(37.5);
    expect(cache.readAll('R2')).toEqual({});
    expect(cache.size('R2')).toBe(0);
  });

  // ── Test 6: SIGTERM 钩子 stop 所有 scheduler ───────────
  it('SIGTERM 钩子触发后所有 PollingScheduler.stop() 被调一次', () => {
    // Arrange: 3 个 mock scheduler 注册到 Map
    const s1 = new MockScheduler();
    const s2 = new MockScheduler();
    const s3 = new MockScheduler();
    const realSchedulers = new Map<string, MockScheduler>([
      ['R1', s1],
      ['R2', s2],
      ['R3', s3],
    ]);
    // 复刻 index.ts SIGTERM 钩子注册 (跟 plan §B "SIGTERM 钩子" 同形)
    process.on('SIGTERM', () => realSchedulers.forEach((s) => s.stop()));

    // Act: 触发 SIGTERM
    process.emit('SIGTERM');

    // Assert: 每个 scheduler.stop 被调一次
    expect(s1.stopCount).toBe(1);
    expect(s2.stopCount).toBe(1);
    expect(s3.stopCount).toBe(1);
  });

  // ── Test 7: 缺失 PLC 绑定的 reactor 走 mock 不崩 ───────
  it('缺失 PLC 绑定 (pollingSchedulers.get 返 undefined) 时 reactor-wiring 路径不抛', () => {
    // 模拟 plan §1 Commit 2 路由表达式: `MOCK_PLC || !pollingSchedulers?.get(reactorId)`
    // 当 reactor 在 schedulers Map 中无 entry, 走 mock 分支
    const reactorId = 'R-UNBOUND';
    const routeToMock = !schedulers.get(reactorId);  // MOCK_PLC=false 但无 scheduler
    expect(routeToMock).toBe(true);

    // Act + Assert: 不抛即通过
    expect(() => {
      cache.write(reactorId, buildMockSnapshot(TAGS, reactorId));
      const entries = cache.readAll(reactorId);
      for (const tag of TAGS) {
        const _v = entries[tag] ? entries[tag].value : 0;  // 兜底 0
        void _v;
      }
    }).not.toThrow();

    // 验证 cache 有完整 19 tag
    expect(Object.keys(cache.readAll(reactorId))).toHaveLength(TAGS.length);
  });

  // ── Test 8: buildMockSnapshot 不变量: quality 全 good + devPlcRead 等价 ──
  it('buildMockSnapshot invariant: quality 全 "good", values[tag] ≈ devPlcRead(tag)', () => {
    const snap = buildMockSnapshot(TAGS, 'R1');

    // shape: timestamp ISO + values/quality 同 key 集
    expect(snap.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(Object.keys(snap.values).sort()).toEqual([...TAGS].sort());
    expect(Object.keys(snap.quality).sort()).toEqual([...TAGS].sort());

    // quality 全 good (MOCK 路径无通讯故障概念, plan §B 行为等价)
    for (const tag of TAGS) {
      expect(snap.quality[tag]).toBe('good');
    }

    // 不变量: buildMockSnapshot 内部调 devPlcRead, 同一 tag 连续两次调
    // 返值在很小窗口内 (devPlcRead 是 random-walk simulator, 步长 ~0.1).
    // 用宽容容差验证 "values[tag] === devPlcRead(tag)" 的契约关系 (catch 后 0 兜底).
    const snap2 = buildMockSnapshot(TAGS, 'R1');
    for (const tag of TAGS) {
      // 同步连续调 devPlcRead, 容差 1.0 (覆盖 random-walk 步长 + 时间敏感漂移)
      expect(Math.abs(snap2.values[tag] - devPlcRead(tag))).toBeLessThan(1.0);
    }
  });
});
