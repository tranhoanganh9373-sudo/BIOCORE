# SP-PLC-3 Tag Cache & OPC-style Subscription — Phase 1 实施计划

**Status:** Shipped 2026-05-25 (P1=91a6ee8, P2=bb7eeb2, P3=8f5007e, P4=6d58163). Phase 1 完成.
**Target version:** v1.15.0
**Estimated:** ~700 LOC, 4 commits, +35–40 tests, 6–8h single-engineer
**Scope tier:** Phase 1 (3000 点门槛). Phase 2/3 (5000+ / 10000+) 留作后续 sprint, 见 §9.

---

## Spec recap (locked)

| Q | 决策 |
|---|---|
| Q1 | **三件套同步上**: TagCache + PollingScheduler 接入 + dirty-only 推送. 单独加 cache 无收益, 必须连同 server 层改造 |
| Q2 | **TagCache 数据结构**: `Map<reactorId, Map<tag, { value, ts, quality, lastChanged, prevValue }>>` in-memory only, **不引 Redis** |
| Q3 | **InfluxDB 解耦**: 独立 setInterval 从 cache 取值 batch flush, 默认 1Hz, 可配 (`INFLUX_FLUSH_MS=1000`) |
| Q4 | **WS 推送策略**: 默认 dirty-only (变化超 deadband 才推); deadband 单值 = 0 (全推); 全 tag deadband 配置留 Phase 2 |
| Q5 | **PollingScheduler 接入位置**: 由 `createReactorWiring` 接受 `pollingScheduler` 可选参数; 缺省时回退到现有 mock 循环 (保留 MOCK_PLC 演示路径不破) |
| Q6 | **多采样周期**: 复用 `PollingScheduler` 已有的 `poll_rate_ms` 分组逻辑, Phase 1 不改 schema, 用默认 1000ms; 多周期实战调优留 Phase 2 |
| Q7 | **CUSUM 路径**: 改成从 TagCache 同步 read, **不再依赖** reactor-wiring 同 tick 内的 rawPV 闭包 |
| Q8 | **back-pressure**: WS `bufferedAmount > 1 MB` 时 skip 该 client 一轮推送, 不阻塞其它 client; 入 `console.warn` 但不断 connection |
| Q9 | **quality fallback**: PLC 通讯断 → cache 标 `quality='bad'` + `value` **保留上次良值** (不清零); InfluxDB write 跳过 bad 点 (不写 null), WS 推送 quality 字段让前端自行处理 (灰色/划线) |

---

## Investigation Findings（架构师对代码的实地考察）

1. **`PollingScheduler.pollGroup()` 已实现 region 批量读** — `packages/plc-driver/src/index.ts:558-640`. `groupByRegion(vars) → readBytesRaw(startByte, length, db)` 一次 PDU 读一段, 输出 `snapshot.{values, raw_values, quality}`. **quality 字段就是 OPC 的核心元数据**, 三态: `'good' | 'bad' | 'uncertain'` (代码里目前只见 good/bad). 已 emit `'snapshot'` event, 是天然的 push 入口.

2. **`reactor-wiring.ts:110-120` 完全没用 PollingScheduler**. 自建硬编码循环:
   ```ts
   const TAGS = ['TEMP_PV', 'JACKET_PV', /* …25 个 */];
   for (const tag of TAGS) {
     try { rawPV[tag] = devPlcRead(tag); } catch { rawPV[tag] = 0; }
   }
   ```
   - 单点循环, 调 `devPlcRead` (mock 内存函数)
   - catch 后写 0 — **掩盖了通讯故障**, quality 元数据丢失
   - 加新 tag 要改源码, 不读 `plc_variables` 表

3. **`buildReactorConfig.plcRead` 闭包** (`index.ts:3265`) 在生产模式 `throw new Error('PLC 未连接...')`. 所以 reactor-wiring 的 devPlcRead 调用是**仅 MOCK 模式可用**. 真实硬件下 reactor-wiring 的数据采集**完全没有路径**. SP-PLC-3 同时修复此架构断层.

4. **`broadcast('pv_realtime', payload)`** (`reactor-wiring.ts:167`): 每秒全量推 32 字段, 无 deadband / 无订阅过滤 / 无 client back-pressure 检测. `wss.clients.forEach(c => c.send(data))` — JSON.stringify 100KB 在 10 client 时 main loop 阻塞 ~30ms.

5. **InfluxDB write 跟 PLC 周期 1:1 同步** (`reactor-wiring.ts:123-140`): `new Point().tag().floatField() × 9 字段 + writePoint + flush` inline 在轮询闭包内. 3000 点等比放大到 3000 floatField/tick → batch size 爆 + Influx HTTP roundtrip ~50ms 阻塞.

6. **CUSUM 实时检测** (`reactor-wiring.ts:171+`): 同 tick 取 rawPV 5 个 channel, 跑 `getCusumKey(batchId)` 的 detector. 跟 polling/broadcast/influx 全耦合在同一闭包. **改 cache 路径后**, CUSUM 改成 `tagCache.readMany(reactorId, ['TEMP_PV', ...])` 同步取, 解耦.

7. **WS 协议**: 没有客户端订阅机制, 全部 client 平等收所有 channel. `broadcast(channel, payload, batchId, reactorId)` 按 reactor 过滤但不按 tag 过滤. Phase 1 不引入订阅 (Phase 2), 但 dirty-only 已能大幅降流量.

8. **`PollingScheduler` 从未实例化**. 全仓 grep `new PollingScheduler` **0 命中**. Class 已写但没人用. Phase 1 要在主 server 启动期实例化, 按每个 reactor 的 PLC 连接配置创建一个 scheduler 实例, 启动 polling.

9. **测试 infra**: `packages/server/src/__tests__/` 用 vitest. `packages/server/src/engine/__tests__/` 已存在 (scada-write-dispatcher 等用), 新建 `tag-cache.test.ts` 跟 `realtime-broadcaster.test.ts` 沿用同模式.

10. **plc-bridge.ts deep import → sub-entry** 刚 ship 在 commit `899309b`, `@biocore/plc-driver/utils` 已可用. Phase 1 新模块 import path 直接用 sub-entry (`PLCVariableMapping` type from `@biocore/plc-driver/utils`).

---

## 1. Commit Sequence — 4 commits

### Commit 1: `feat(server): TagCache 核心 + subscribe API (SP-PLC-3 P1)`

**Scope:** 纯新建模块, 0 改动现有代码. 先把 cache 单元测试跑绿, 再上接入.

**Files touched:**
- `packages/server/src/engine/tag-cache.ts` — 新建 (~180 行)
- `packages/server/src/engine/__tests__/tag-cache.test.ts` — 新建 (~140 行, 15 tests)

**Specific API:**

```ts
// tag-cache.ts
export interface CacheEntry {
  value: number;
  ts: string;            // ISO timestamp
  quality: 'good' | 'bad' | 'uncertain';
  lastChanged: string;   // 上次值变化 (超 deadband) 的 ts
  prevValue: number;     // 用于 deadband 比较
}

export interface CacheSubscription {
  id: string;
  reactorId: string | '*';
  tags: Set<string> | '*';    // '*' 表示全 tag
  callback: (changes: CacheChange[]) => void;
}

export interface CacheChange {
  reactorId: string;
  tag: string;
  entry: CacheEntry;
}

export class TagCache {
  write(reactorId: string, snapshot: {
    timestamp: string;
    values: Record<string, number>;
    quality: Record<string, 'good' | 'bad' | 'uncertain'>;
  }, opts?: { deadband?: number }): CacheChange[]
  // 返回本次变化的 tags (供调用方按需 fan-out); deadband 全局默认 0

  read(reactorId: string, tag: string): CacheEntry | undefined
  readMany(reactorId: string, tags: string[]): Record<string, CacheEntry>
  readAll(reactorId: string): Record<string, CacheEntry>

  subscribe(sub: Omit<CacheSubscription, 'id'>): string  // 返 subscription id
  unsubscribe(id: string): boolean

  // 通讯故障时主动标 bad 但保留上次值
  markStale(reactorId: string, tags?: string[]): void

  // 测试 + 调试用
  size(reactorId?: string): number
  clear(reactorId?: string): void
}
```

**测试覆盖** (15 tests):
- write 新 tag 创建 entry, ts/quality/lastChanged 正确
- write 同 tag 同值 → `lastChanged` 不变, prev 字段更新, 不返回 change
- write 同 tag 不同值 → `lastChanged = ts`, 返回 change
- deadband=0.5 时 abs(Δ) ≤ 0.5 视为同值
- quality 'bad' 时 value 不覆盖现存 good 值 (保留 last-known-good)
- subscribe('*', '*', cb) → 任意 reactor 任意 tag write 都收
- subscribe(reactorId, ['TEMP_PV']) → 只收该 reactor 该 tag
- unsubscribe 后不再回调
- read 不存在 reactor/tag 返 undefined
- readMany 部分 tag 不存在仅返存在的
- markStale 单 tag → 仅该 tag quality='bad', value 保留
- markStale 全 reactor → 所有 tag quality='bad'
- 多 reactor 隔离: reactor1 write 不影响 reactor2 read
- size/clear 行为
- subscription callback 抛错不影响其它 subscriber (隔离 try/catch)

**安全验证**:
- write 后 read 立即可见 (无异步)
- subscribe callback **同步** 调用 (避免 microtask 累积)
- 内部 Map 不暴露给消费者 (避免外部 mutation)

---

### Commit 2: `feat(server): PollingScheduler 接入 + reactor-wiring 走 cache (SP-PLC-3 P2)`

**Scope:** 把 reactor-wiring 的 mock 单点循环替换为 PollingScheduler subscription. 保留 MOCK_PLC 演示路径不破.

**Files touched:**
- `packages/server/src/reactor-wiring.ts` — 改动 (~60/-30)
- `packages/server/src/index.ts` — 启动期实例化 scheduler (~30/-5)
- `packages/server/src/engine/__tests__/reactor-wiring-cache.test.ts` — 新建 (~120 行, 8 tests)

**关键改动**:

`reactor-wiring.ts`:
- `createReactorWiring(opts)` 参数加 `tagCache: TagCache` (必传) + `pollingSchedulers?: Map<reactorId, PollingScheduler>` (可选)
- 删除 `for (const tag of TAGS) rawPV[tag] = devPlcRead(tag)` 整段 (line 110-120)
- 替换为:
  ```ts
  // MOCK_PLC 路径: 用 mock snapshot 写 cache (兼容现有演示)
  // 真实路径: pollingScheduler.on('snapshot', snap => tagCache.write(reactorId, snap))
  let rawPV: Record<string, number>;
  if (MOCK_PLC || !pollingSchedulers?.get(reactorId)) {
    const mockSnap = buildMockSnapshot(TAGS); // 抽出 helper, 内部仍调 devPlcRead
    tagCache.write(reactorId, mockSnap);
  }
  rawPV = mapCacheToRawPV(tagCache.readAll(reactorId));
  ```
- 真实路径在 `index.ts` 启动期 wire: `scheduler.on('snapshot', snap => tagCache.write(reactorId, snap))`

`index.ts` 启动期 (createReactorWiring 调用前):
- `const tagCache = new TagCache()`
- `const pollingSchedulers = new Map<string, PollingScheduler>()`
- 遍历 `sqlite.listReactors()`:
  ```ts
  if (!MOCK_PLC) {
    const conn = sqlite.getReactorPLCConnection(reactorId);
    if (!conn) continue;  // 无 PLC 绑定的 reactor 走 MOCK 路径
    const mgr = new PLCConnectionManager(conn);
    await mgr.connect();
    const scheduler = new PollingScheduler(mgr);
    scheduler.on('snapshot', snap => tagCache.write(reactorId, snap));
    scheduler.on('error', err => console.error(`[scheduler:${reactorId}]`, err));
    scheduler.start();
    pollingSchedulers.set(reactorId, scheduler);
  }
  ```
- 进程退出时 `process.on('SIGTERM', () => pollingSchedulers.forEach(s => s.stop()))`

**测试覆盖** (8 tests):
- mock 路径: TAGS 全 0 → cache 写入 → reactor-wiring 闭包从 cache read 拼 rawPV
- 真实路径 (mock scheduler): scheduler.emit('snapshot', {…}) → cache 写入 → CUSUM 读到正确值
- MOCK_PLC=true 时 pollingSchedulers 不实例化
- 通讯断 (scheduler emit 'error'): cache markStale, 下次 read quality='bad'
- 多 reactor 隔离: scheduler1 snapshot 不写入 reactor2 cache
- SIGTERM stop 所有 scheduler timer (clearInterval 调用次数 = scheduler 数)
- 缺失 PLC 绑定的 reactor 仍能跑 (走 mock 路径不崩)
- buildMockSnapshot 返 `quality: 'good'` 全字段 (跟真实 snapshot 同 shape)

**风险**:
- 启动期 `await mgr.connect()` 多 reactor 串行 → 慢启动. 用 `Promise.allSettled` 并行 + 失败 reactor 退化 mock 路径
- PollingScheduler.start 后立即 emit 第一个 snapshot 的延迟 = poll_rate_ms (默认 1000ms), 启动后第 1 秒 cache 空. reactor-wiring 闭包要容忍 (readMany 返空对象 → CUSUM skip 本 tick)

---

### Commit 3: `feat(server): dirty-only WS 推送 + InfluxDB writer 解耦 (SP-PLC-3 P3)`

**Scope:** 拆解 reactor-wiring 闭包里的 broadcast + influx 写入, 改成 cache 订阅驱动.

**Files touched:**
- `packages/server/src/engine/realtime-broadcaster.ts` — 新建 (~120 行)
- `packages/server/src/engine/influx-flusher.ts` — 新建 (~90 行)
- `packages/server/src/reactor-wiring.ts` — 删 broadcast/influx inline 段 (~40/-50)
- `packages/server/src/index.ts` — 启动 broadcaster + flusher (~15/-3)
- `packages/server/src/engine/__tests__/realtime-broadcaster.test.ts` — 新建 (~100 行, 8 tests)
- `packages/server/src/engine/__tests__/influx-flusher.test.ts` — 新建 (~80 行, 6 tests)

**realtime-broadcaster.ts**:

```ts
export interface BroadcasterDeps {
  tagCache: TagCache;
  broadcast: (channel: string, payload: any, batchId: string | null, reactorId: string) => void;
  wss: { clients: Set<{ bufferedAmount: number }> };  // back-pressure 度量
  tickMs?: number;                    // 默认 200ms (5Hz batched fan-out)
  maxBufferedAmount?: number;         // 默认 1MB
}

export function startRealtimeBroadcaster(deps: BroadcasterDeps): () => void;
// 返 stop function
```

逻辑:
- 订阅 `tagCache` 全 reactor 全 tag (`subscribe({ reactorId: '*', tags: '*', callback })`)
- 内部维护 `dirtyQueue: Map<reactorId, Set<tag>>`, callback 仅 push 进 queue
- setInterval(tickMs) 每周期 flush queue: 按 reactor 聚合, 组 pv_realtime payload (含 quality), broadcast
- back-pressure: 推送前检查任一 client `ws.bufferedAmount`, 超阈 skip + console.warn
- batch_id 通过外部注入 (从 sqlite reactor state 读 — 走现有 getBatchId helper)

**influx-flusher.ts**:

```ts
export interface FlusherDeps {
  tagCache: TagCache;
  influxWriteApi: any;
  reactorIds: () => string[];          // 从 sqlite 拿
  getBatchId: (reactorId: string) => string;  // 'idle' 或 batch_id
  flushMs?: number;                    // 默认 1000ms (Phase 1 跟旧行为一致)
}

export function startInfluxFlusher(deps: FlusherDeps): () => void;
```

逻辑:
- setInterval(flushMs) 每周期遍历 reactorIds
- 每 reactor 从 cache 读固定 9 字段集 (temperature/jacket_temp/pH/DO/pressure/airflow/weight/rpm/vfd_current), quality='bad' 的字段 skip 不入 Point
- 一次 writePoint + 异步 flush, 失败 console.error 不抛

**reactor-wiring.ts 改动**:
- 删除 `new Point('process_data')...` 整段 (line 123-140)
- 删除 `broadcast('pv_realtime', pvPayload, ...)` (line 167)
- CUSUM 段保留但改成从 cache read (见 Commit 4)
- 闭包简化为: 只负责 batch-controller 跑步 + state update + 触发 phase 事件

**测试覆盖** (broadcaster 8 + flusher 6 = 14 tests):

broadcaster:
- 单 tag change → next tick fan-out 含该 tag
- 同 tick 多 tag change → 一次 broadcast 聚合
- 跨 reactor change → 分别 broadcast
- bufferedAmount > 阈值 → skip 该 client, console.warn 触发
- 无变化时无 broadcast 调用 (静态期零流量)
- stop function 清 interval + unsubscribe
- subscription callback 抛错不影响其它 reactor
- quality 字段在 payload 中存在且正确

flusher:
- 1Hz tick 写 1 个 Point per reactor
- quality='bad' 字段 skip 不入 Point
- 全 reactor 全 bad → 不调 writePoint
- writePoint 抛错被吞 (console.error), 不崩 tick
- flushMs=500 真生效 (假时钟测)
- stop function 清 interval

**性能预期**:
- 3000 点静态期 (无变化): broadcaster 5Hz tick 空跑 ~0.1ms, 0 WS 流量
- 3000 点稳态变化率 1% (30 tag/s): broadcaster 5Hz × 30 entries ≈ 1KB/s/client (vs 旧 100KB/s/client)

---

### Commit 4: `feat(server): CUSUM 改 cache 读 + Phase 1 端到端验收 (SP-PLC-3 P4)`

**Scope:** 最后一处依赖 inline rawPV 的 CUSUM 段改成 cache 读. Phase 1 收官 + E2E 测试.

**Files touched:**
- `packages/server/src/reactor-wiring.ts` — CUSUM 段 (~25/-10)
- `packages/server/src/engine/__tests__/phase1-e2e.test.ts` — 新建 (~150 行, 5 tests)
- `docs/plans/SP-PLC-3-tag-cache-plan.md` — 本文件 status 更新为 "Shipped 2026-xx-xx"
- `CHANGELOG.md` — Unreleased 段加 SP-PLC-3 entry

**CUSUM 改动**:

```ts
// 旧 (依赖同 tick rawPV):
const pvMap: Record<string, number> = {
  temperature: rawPV['TEMP_PV'],
  pH: rawPV['PH_PV'],
  // …
};

// 新 (从 cache 读, quality 守卫):
const entries = tagCache.readMany(reactorId, ['TEMP_PV', 'PH_PV', 'DO_PV', 'PRESSURE_PV', 'VFD_ACTUAL_FREQ']);
const pvMap: Record<string, number> = {};
const tagMap: Array<[string, string]> = [
  ['TEMP_PV', 'temperature'], ['PH_PV', 'pH'], ['DO_PV', 'DO'],
  ['PRESSURE_PV', 'pressure'], ['VFD_ACTUAL_FREQ', 'rpm'],
];
for (const [tag, mapped] of tagMap) {
  const entry = entries[tag];
  if (entry && entry.quality === 'good') {
    pvMap[mapped] = mapped === 'rpm' ? entry.value * 24 : entry.value;
  }
}
// CUSUM 跳过 quality bad 的 channel (不污染 detector 状态)
if (Object.keys(pvMap).length > 0) {
  const cusumResults = runCusum(pvMap, ...);
  // ...
}
```

**端到端测试** (5 tests):

1. **Mock PLC → cache → WS → Influx → CUSUM 全链路**:
   - 启动 mock scheduler emit snapshot (TEMP_PV=37.0)
   - 验证 tagCache.read 返 37.0 good
   - 验证 broadcaster fan-out pv_realtime 含 37.0
   - 验证 flusher 写 1 个 Point 含 temperature=37.0
   - 验证 CUSUM detector 收到 temperature=37.0

2. **通讯断模拟**:
   - scheduler emit 'error' 3 次连续
   - markStale 被调用
   - cache read TEMP_PV quality='bad', value=37.0 (last-known-good 保留)
   - broadcaster 推送 payload 含 quality='bad'
   - flusher skip 不写 Influx
   - CUSUM skip 不进 detector

3. **dirty-only 行为验证**:
   - mock scheduler emit 同 snapshot 3 次 (无变化)
   - broadcaster tick 3 次仍 0 推送
   - 第 4 次 TEMP_PV 变 38.0 → tick 推送 1 条 含 TEMP_PV

4. **多 reactor 隔离**:
   - reactor1 scheduler emit snapshot, reactor2 不变
   - tagCache.readAll(reactor2) 为空
   - broadcaster fan-out 只 reactor1 channel

5. **back-pressure**:
   - mock client bufferedAmount = 2MB
   - broadcaster tick → 该 client skip, console.warn 触发, 其它 client 正常推送

---

### Total deltas

| Package | New files | Modified | New tests |
|---|---|---|---|
| `server/src/engine/` | tag-cache.ts (~180), realtime-broadcaster.ts (~120), influx-flusher.ts (~90) | (none) | 4 test files (15+8+8+6+5 = 42 tests) |
| `server/src/` | (none) | reactor-wiring.ts (~125 lines net change), index.ts (~50) | reactor-wiring-cache.test.ts (~120) |
| `docs/` | (none) | plans/SP-PLC-3 status, CHANGELOG | — |

**预估 LOC**: +700 lines (含测试), +0 schema migration, +0 dependency.

---

## 2. Risk Areas

### 2a. 启动期 PLC 连接慢启动
- 多 reactor 串行 `await mgr.connect()` 在 LAN 上每个 ~500ms, 10 reactor = 5s 启动阻塞
- **对策**: `Promise.allSettled` 并行 connect; 失败 reactor 退化 mock 路径 + console.warn 不阻塞启动

### 2b. 第 1 秒 cache 空窗
- scheduler.start() 后立即 emit 第一个 snapshot 的延迟 = `poll_rate_ms` (默认 1000ms)
- reactor-wiring 第 1 秒 readMany 返空, CUSUM skip 本 tick, broadcaster 0 推送
- **对策**: 启动期 broadcaster tick 跳过有意义, 不算 bug; 文档明示 "PLC subscription warm-up 期 1×poll_rate_ms"

### 2c. cache 内存增长
- Map 存活时间 = 进程生命周期, 不主动清
- 3000 tag × 10 reactor × ~80 bytes/entry = ~2.4 MB. 静态不增长 (覆盖 write 不增 entry)
- **对策**: 仅在 reactor 被删除时清; 不需 LRU. 监控指标加 `tagCache.size()` 暴露给 /metrics (Phase 2)

### 2d. dirty queue 在高频变化下的累积
- 假设 3000 点全部 100Hz 变化 → 5Hz tick 每次 fan-out 60000 entries (3000 × 20 tick gap) — 不可能
- 现实: 工业 PV 变化率 < 1Hz, dirty queue 上限 ~50 entries/tick
- **对策**: Phase 1 不做溢出保护; Phase 2 加 `maxDirtyPerTick` 配置 (溢出取最新值, 旧值 drop)

### 2e. WS back-pressure skip 导致丢值
- 客户端断网或慢, bufferedAmount 撑大, 被 skip 后**永远收不到这次变化**
- 客户端依赖事件流的功能 (告警、phase 切换) 可能漏
- **对策**: Phase 1 仅警告; 真正的 reliable 推送要走 message queue (Kafka/Redis Streams) — Phase 3 范围
- **mitigation**: 重要事件 (alarm/phase) 不走 broadcaster, 走独立路径 + ack 机制 (现有)

### 2f. 与 batch-controller.plcWrite 闭包的解耦
- Recipe-driven 写仍走 `buildReactorConfig.plcWrite` (`index.ts:3270`) → `executeRecipePlcWrite` → `createPlcWriter`
- **Phase 1 不动写路径**. cache 只管 read; 写路径在 Phase 2 评估是否接入 cache 做乐观更新

### 2g. MOCK_PLC 路径行为变化
- 原 mock loop 直接 devPlcRead 返实时值; 新路径 mock 写 cache → 读 cache
- **行为差异**: 同 tick 内 mock snapshot 写完立即 read, 行为等价
- 风险: `buildMockSnapshot` 必须**精确复现** `devPlcRead` 的 25 个 tag 值生成逻辑 (温度漂移/pH 漂移 etc)
- **对策**: `buildMockSnapshot` helper 内复用 `devPlcRead`, 不重复实现; 加 snapshot 测试 `buildMockSnapshot('TEMP_PV') === devPlcRead('TEMP_PV')`

---

## 3. Test Coverage Plan

### server/engine
- `tag-cache.test.ts` (15) — Commit 1
- `reactor-wiring-cache.test.ts` (8) — Commit 2
- `realtime-broadcaster.test.ts` (8) — Commit 3
- `influx-flusher.test.ts` (6) — Commit 3
- `phase1-e2e.test.ts` (5) — Commit 4

**总计**: 42 new tests, vitest 单文件平均 < 200ms.

### 现有测试不动
- `reactor-wiring.test.ts` (若存在): 验证保留 mock 路径行为不变
- `cusum.test.ts`: 验证 CUSUM detector 接 pvMap 行为不变 (仅注入路径改了)

### 覆盖率目标
- `tag-cache.ts`: 95%+ (核心模块)
- `realtime-broadcaster.ts`: 85%+
- `influx-flusher.ts`: 85%+
- 总体 server/engine 包: 维持 80%+ (现有 baseline)

---

## 4. Rollback Strategy

### Per-commit `git revert` impact

| Commit | Revert 影响 |
|---|---|
| P1 (tag-cache.ts 新建) | 0 影响 — 无消费者, 纯加模块 |
| P2 (PollingScheduler 接入) | 回到 mock 单点循环; 真实 PLC 数据采集再次断开 |
| P3 (broadcaster + flusher 解耦) | broadcast/influx 写入回到 reactor-wiring 闭包内; cache 仍写但无消费 |
| P4 (CUSUM cache 读) | CUSUM 退回同 tick rawPV; 通讯断时 CUSUM 仍会跑 (旧 bug 复现) |

### 推荐 rollback recipe

完全 rollback Phase 1: `git revert <P4>..<P1>` (倒序), 重新 commit. 不需要 down-migration (无 schema 改动).

部分 rollback: 单 commit revert 即可, 互相不强依赖 (P2/P3/P4 各自独立闭环).

### 生产 hot-rollback (无 deploy 窗口)
环境变量开关 (Phase 1 不引入, Phase 2 加):
- `TAG_CACHE_ENABLED=false` → reactor-wiring 走旧 mock 循环 + inline broadcast/influx
- 通过 feature flag 而非 git revert 走线上回退

---

## 5. Anti-Spec Items（out of scope）

明确**不**在 Phase 1 范围:

- ❌ **客户端订阅** (subscribe tags list from frontend) — Phase 2
- ❌ **per-tag deadband 配置** — Phase 2, `plc_variables` 加 `deadband_abs`/`deadband_pct` 列
- ❌ **多采样周期分组实战调优** (fast 100ms / slow 10s) — 基础设施 P2 已支持, 调优留 Phase 2
- ❌ **InfluxDB 分级采样** (raw 1Hz + downsampled 10s) — Phase 2
- ❌ **二进制 WS 协议** (MessagePack / Flatbuffers) — Phase 3
- ❌ **Worker thread PLC IO** — Phase 3
- ❌ **Redis pub/sub 横向扩展** — Phase 3
- ❌ **OPC UA gateway** (对外暴露给第三方 SCADA) — 独立 sprint, 不在 Phase 任何阶段
- ❌ **写路径接 cache** (乐观更新) — Phase 2 评估
- ❌ **reliable message queue** (Kafka/Redis Streams) 替代 WS — Phase 3
- ❌ **/metrics 端点** 暴露 `tagCache.size` / dirty rate — 可加但非 Phase 1 必须

---

## 6. Open Questions（需用户决定的）

### (i) `poll_rate_ms` 字段是否需要 migration 暴露到 UI ⚠️ 用户决定

`PLCVariableMapping.poll_rate_ms` 字段在 schema 是否已暴露给前端 PLC 配置页? 若已暴露, 改 cache 后操作员能直接调单 tag 采样率; 若未暴露, Phase 1 全用默认 1000ms.

**默认**: 不改 UI, Phase 1 全 1Hz; UI 配置留 Phase 2.

### (ii) cache 是否做持久化 (crash recovery) ⚠️ 用户决定

进程崩溃重启后 cache 是空的, 需要 1×poll_rate_ms 暖机. 是否需要 SIGTERM 时 `JSON.stringify(cache) → fs.writeSync('./data/tagcache-snapshot.json')`, 启动时 read 回?

**默认**: 不做. 1 秒暖机可接受, 持久化加复杂度.

### (iii) broadcaster `tickMs` 默认值 ⚠️ 用户决定

候选: 200ms (5Hz, 平滑前端体验) / 100ms (10Hz, 接近 PLC 周期) / 1000ms (1Hz, 跟旧行为一致最保守).

**推荐**: 200ms — 兼顾延迟感知 (< 200ms 人眼无感) + CPU 友好.

### (iv) quality='uncertain' 何时使用 ⚠️ 用户决定

OPC 三态中 'uncertain' 用于 "通讯 OK 但传感器漂移/校准异常" 等情况. 当前 PollingScheduler 只 emit good/bad. 是否需要 uncertain 路径?

**默认**: Phase 1 不引入 uncertain; cache `quality` 类型保留 union 含 uncertain 给将来; broadcaster/flusher 把 uncertain 当 good 处理.

### (v) MOCK_PLC 模式下 PollingScheduler 是否启动 ⚠️ 用户决定

候选 A: 不启动 (跟现状一致, mock loop 直接写 cache)
候选 B: 启动一个 "MockPollingScheduler", emit 假 snapshot — 真正统一路径

**推荐 A**: MOCK_PLC 是开发演示模式, 没必要复刻完整生产路径; 抽 `buildMockSnapshot` helper 后两路径都写 cache, 已足够统一.

---

## 7. Migration / Dependencies

### Schema migration
**0 migration**. Phase 1 不动 sqlite schema. (Phase 2 才加 `plc_variables.deadband_abs/pct` 列.)

### npm dependencies
**0 new dependency**. 全用现有 stack (vitest / express / ws / influxdb-client / @biocore/plc-driver).

### Env vars (新增 + 文档)
- `INFLUX_FLUSH_MS` (默认 1000) — influx-flusher 写入周期, 文档加到 `docs/部署说明.md`
- `BROADCAST_TICK_MS` (默认 200) — realtime-broadcaster fan-out 周期
- `WS_MAX_BUFFERED_AMOUNT` (默认 1048576, 即 1MB) — back-pressure 阈值

---

## 8. Verification Checklist

### 通用
- [ ] `corepack pnpm --filter @biocore/server build` 0 TS 错误
- [ ] 所有新 vitest 42 tests 全过
- [ ] 现有 reactor-wiring 相关测试不退化
- [ ] `docs/部署说明.md` 加 3 个新 env var 文档

### Commit 1 — TagCache
- [ ] 15 tests 全过
- [ ] 覆盖率 ≥ 95%
- [ ] 无消费者, build 通过

### Commit 2 — PollingScheduler 接入
- [ ] 8 tests 全过
- [ ] MOCK_PLC=true 启动后 cache 有数据, reactor-wiring 行为不变
- [ ] MOCK_PLC=false + 无 PLC 配置 → reactor 退化 mock 路径不崩
- [ ] SIGTERM 后 PollingScheduler.stop 真被调

### Commit 3 — broadcaster + flusher
- [ ] 14 tests 全过
- [ ] 同 snapshot 重复 emit → broadcaster 0 推送
- [ ] PV 变化 → broadcaster next tick 推送
- [ ] InfluxDB writer 周期独立, 不跟 PLC 周期耦合

### Commit 4 — CUSUM cache 读 + E2E
- [ ] 5 E2E tests 全过
- [ ] 通讯断时 CUSUM 不进 bad value (旧 bug 修)
- [ ] CHANGELOG 加 SP-PLC-3 entry

### 性能 baseline (MOCK 模式 25 tag)
- [ ] WS payload 同 snapshot 时 0 字节 (vs 旧每秒 1.2KB)
- [ ] CPU usage 同等或更低 (新增 cache write + tick 抵消减少的 inline 工作)

---

## 9. Future Phase 2/3 Outlook (informational)

**Phase 2** (5000+ 点 / 10+ reactor, 估 ~8-12h):
- 客户端订阅 (frontend subscribe API)
- per-tag deadband (schema migration 040)
- 多采样周期实战调优 + UI 配置
- InfluxDB 分级采样 (raw + downsampled)
- /metrics 端点暴露 cache 指标

**Phase 3** (10000+ 点 / 高可用, 估 ~15-20h):
- 二进制 WS 协议 (MessagePack)
- Worker thread PLC IO
- Redis pub/sub 横向扩展
- reliable message queue (Kafka/Redis Streams)

**OPC UA gateway** (独立 sprint, 估 ~10-15h): 用 `node-opcua` 当**对外接口**给第三方 SCADA 客户端连, **不**当内部 cache 用. 必要时跟 Phase 3 并行做.

---

## End of Plan
