# SP-PLC-3 Tag Cache & OPC-style Subscription — Phase 2 实施计划

**Status:** Plan-only (2026-05-26). Awaiting user approval.
**Target version:** v1.16.0
**Estimated:** ~900 LOC, 5 commits, +40–50 tests, 8–12h single-engineer
**Scope tier:** Phase 2 (5000+ 点 / 10+ reactor). Depends on Phase 1 (`3dfd9ef` HEAD).
**Phase 1 ref:** `docs/plans/SP-PLC-3-tag-cache-plan.md` (Shipped 2026-05-25).

---

## Spec recap (locked)

| Q | 决策 |
|---|---|
| Q1 | **Per-tag deadband 落 schema**: `plc_variable_mappings` 表加 `deadband_abs REAL DEFAULT 0` + `deadband_pct REAL DEFAULT 0` 两列, 任一为 0 = 关闭该模式, 同时配 = OR 关系 (abs OR pct 触发) |
| Q2 | **TagCache 接 per-tag deadband**: `write` 时按 tag id 查 deadband 配置 (注入 `deadbandResolver: (tag) => { abs, pct }`); cache 内不存 deadband, 由调用方传入避免循环 import |
| Q3 | **broadcaster + flusher 接 deadband**: 共用 TagCache.write 返回的 changes 数组, dirty-only 推送自然 reflect deadband; flusher 仅写 quality='good' 且**值真变化**的字段 (deadband 抑制无意义写入) |
| Q4 | **客户端订阅协议**: WS message `{type: 'subscribe', reactorId, tags: string[]|'*'}` / `{type: 'unsubscribe', reactorId, tags}`; server 维护 `Map<ws, SubscriptionSet>`, broadcaster fan-out 按 subscription 过滤; 未订阅 client 收 0 流量 |
| Q5 | **客户端订阅缺省行为**: 老 client 无 subscribe message 时**保留全推**(Phase 1 行为不破); 显式 subscribe 一次后转为订阅模式; unsubscribe 全部后回到全推 |
| Q6 | **多采样周期 UI**: plc-config 页加 `poll_rate_ms` 下拉 (3 档: 100ms fast / 1000ms normal / 10000ms slow), 改后 server 通过 PollingScheduler.restart() 热生效, 不重启 server |
| Q7 | **/metrics 注册 cache 指标**: 复用 SP-FX-28 MetricsRegistry, 加 4 个指标 — `tagcache_size{reactor}` Gauge / `tagcache_writes_total` Counter / `tagcache_dirty_total` Counter / `broadcaster_skipped_total{reason}` Counter; 不引 Prometheus client 依赖 |
| Q8 | **InfluxDB 分级采样**: 新增 `INFLUX_DOWNSAMPLED_BUCKET` env (默认 `BIOCore_Data_downsampled`); flusher 主路径写 raw 1Hz, 新 downsample-flusher 跑 10s tick 用 `downsampleValues` 算法 (复用 batch-intelligence-routes.ts:54) 写聚合点到 downsampled bucket; 不写时跳过 |
| Q9 | **Downsampled bucket retention**: env-driven (`INFLUX_DOWNSAMPLED_RETENTION=30d` 默认), 但实际 retention 由 Influx 端管控 (server 不主动 enforce, doc 说明运维需手动设 bucket retention) |
| Q10 | **subscription leak 防护**: ws.on('close') 自动清 subscription; subscription map 用 WeakMap 不阻止 ws GC; broadcaster fan-out 前快速过滤死 client (readyState !== OPEN) |

---

## Investigation Findings（架构师对代码的实地考察）

1. **`plc_variable_mappings` 表 schema** — 不在 SQL migration 文件, 而在 `packages/plc-driver/src/variable-mapping.ts:34` 动态 `CREATE TABLE IF NOT EXISTS` (init 时建表). Phase 2 加 deadband 列**不走 migration 040**, 应改成: (a) 在 variable-mapping.ts 加 idempotent ALTER 之类, **或** (b) 走 server/migrations/040 走标准 umzug migration path, 让 schema 进入版本管理. **方案 (b) 推荐**, 与现有 migrator 体系一致, 040-plc-deadband.sql 显式 ALTER 2 列.

2. **plc-config 前端 1235 行** (`packages/web-ui/src/app/settings/plc-config/page.tsx`). `poll_rate_ms` 已在类型 (`types/index.ts:61`) 和 const 默认数组里, 但 UI 表单**没有编辑字段**. Phase 2 P4 加 inline edit (1 个 select 元素), 不引入新组件.

3. **`/metrics` 端点** (`packages/server/src/metrics-routes.ts:39`) SP-FX-28 ship. 用 `MetricsRegistry` (`services/metrics.ts:202` 完整 Counter/Histogram/Gauge). Phase 2 P5 仅在主 server 启动期 register 4 个新指标到现有 registry, 0 新端点.

4. **`downsampleValues` 算法** 在 `batch-intelligence-routes.ts:54-129`, **作为内部 helper 不 export**. Phase 2 P5 需把它抽到共享模块 `packages/server/src/lib/downsample.ts` 给 downsample-flusher 复用. 不改算法本身 (bucketize + 取平均).

5. **WS subscribe protocol** 全仓 0 命中 (`grep "type.*subscribe"` empty). 当前 ws-server.ts 仅有 connection 鉴权 (SP-FX-23/47 上线), **没有任何 client→server 消息处理**. Phase 2 P3 要新增 ws.on('message') handler + subscription state, 不破现有鉴权.

6. **TagCache.write 当前签名** (`engine/tag-cache.ts:32`): `write(reactorId, snapshot, opts?: { deadband?: number })` — 已支持**全局 deadband**, Phase 2 改为 **per-tag deadband resolver**. 向后兼容: 老 opts.deadband 仍工作作为 fallback (per-tag 未配时用).

7. **broadcaster 当前 fan-out 逻辑** (`engine/realtime-broadcaster.ts:140-170`): 遍历 dirtyQueue 后 broadcast(channel, payload, batchId, reactorId), broadcast helper 内部 `wss.clients.forEach(c => c.send(data))`. Phase 2 P3 需要把 client filter 注入 broadcast 调用栈 (按 client subscription 决定是否 send).

8. **PollingScheduler.restart()** (`packages/plc-driver/src/index.ts:610`) **已实现**, "Restart polling after variable list changes" — Phase 2 P4 改 plc-config UI 调 server PUT endpoint, server 改 DB 后调 scheduler.restart() 热生效, 不重启 server.

9. **influxWriteApi 实例** (`server/index.ts:305`): 当前单 bucket (env `INFLUX_BUCKET`). Phase 2 P5 需新增 `influxDownsampleApi = influxClient.getWriteApi(INFLUX_ORG, INFLUX_DOWNSAMPLED_BUCKET, 's')` 第二实例, 不动主 bucket.

10. **subscription cleanup hook** (ws-server.ts ws.on('close')): 当前仅 console.log 客户端断开 + decrement size 计数, 无 subscription state 概念. Phase 2 P3 加 subscription WeakMap 清理 + 死 client filter (`ws.readyState !== ws.OPEN` 直接跳过).

---

## 1. Commit Sequence — 5 commits

### Commit 1: `feat(server): per-tag deadband schema + TagCache resolver (SP-PLC-3 P2.1)`

**Scope:** schema migration + TagCache.write 接 per-tag deadband resolver. broadcaster/flusher 不动 (P2.2 再接).

**Files touched:**
- `packages/server/migrations/040-plc-deadband.sql` — 新建 (~10 行)
- `packages/server/src/engine/tag-cache.ts` — 改动 (~30/-5)
- `packages/server/src/engine/__tests__/tag-cache.test.ts` — 扩 (~50, 5 新 tests)

**Migration 040** (idempotent ALTER):
```sql
-- SP-PLC-3 P2.1 (2026-05-26): per-tag deadband (abs OR pct, 0 = 关闭)
-- 不动 plc-driver/src/variable-mapping.ts 的 IF NOT EXISTS DDL (兼容老库),
-- migration 040 在新部署时 idempotent 加列.
ALTER TABLE plc_variable_mappings ADD COLUMN deadband_abs REAL NOT NULL DEFAULT 0;
ALTER TABLE plc_variable_mappings ADD COLUMN deadband_pct REAL NOT NULL DEFAULT 0;
```

注意 sqlite ALTER 限制: 不支持 IF NOT EXISTS column, migrator 必须有"已应用"标记 (现有 umzug 元数据已支持).

**TagCache.write 签名变更**:
```ts
interface DeadbandResolver {
  (reactorId: string, tag: string): { abs: number; pct: number } | undefined;
}

write(
  reactorId: string,
  snapshot: SnapshotInput,
  opts?: { deadband?: number; deadbandResolver?: DeadbandResolver }
): CacheChange[]
```

判断逻辑 (per-tag 优先, fallback 全局):
```ts
function isChange(prev: number, curr: number, abs: number, pct: number, globalDeadband: number): boolean {
  if (abs > 0 || pct > 0) {
    if (abs > 0 && Math.abs(curr - prev) > abs) return true;
    if (pct > 0 && Math.abs(prev) > 0 && Math.abs((curr - prev) / prev) * 100 > pct) return true;
    return false;
  }
  return Math.abs(curr - prev) > globalDeadband;
}
```

**测试覆盖** (5 新 tests):
- per-tag deadband_abs 触发 change (Δ > abs)
- per-tag deadband_pct 触发 change (Δ% > pct)
- abs 和 pct 同时配 = OR (任一触发)
- deadband resolver 返 undefined → fallback 全局
- 旧 opts.deadband 仍可用 (向后兼容)

---

### Commit 2: `feat(server): broadcaster + flusher 应用 per-tag deadband (SP-PLC-3 P2.2)`

**Scope:** 让 broadcaster 推送 + flusher InfluxDB 写都按 tag 真变化判定 (复用 P2.1 deadbandResolver).

**Files touched:**
- `packages/server/src/index.ts` — startup 注入 deadbandResolver 给 tagCache (~20)
- `packages/server/src/engine/realtime-broadcaster.ts` — fan-out 时 readMany 已经从 cache 拿 entry, dirty 集合即是 deadband-respected; 无代码改动? 需核实 (P1 设计已支持)
- `packages/server/src/engine/influx-flusher.ts` — quality='good' 且 lastChanged > lastFlushedTs 才写 (避免重复写无意义点) (~25/-5)
- `packages/data-service/src/sqlite-service.ts` — 加 `listPlcVariableDeadbands(): Map<{reactor, tag}, {abs, pct}>` (~15)
- `packages/server/src/engine/__tests__/influx-flusher.test.ts` — 扩 (~30, 3 新 tests)

**deadbandResolver 注入** (index.ts 启动期):
```ts
const deadbandResolver: DeadbandResolver = (reactorId, tag) => {
  const plcId = bindings.get(reactorId);
  if (!plcId) return undefined;
  const mapping = varManager.getVariables(plcId).find(v => v.tag_name === tag);
  if (!mapping) return undefined;
  return { abs: mapping.deadband_abs || 0, pct: mapping.deadband_pct || 0 };
};
scheduler.on('snapshot', (snap) => tagCache.write(reactorId, snap, { deadbandResolver }));
```

**flusher lastChanged 判断**:
```ts
const lastFlushedAt: Map<string, string> = new Map();
for (const [tag, entry] of Object.entries(entries)) {
  if (entry.quality !== 'good') continue;
  const lastFlush = lastFlushedAt.get(tag);
  if (lastFlush && lastFlush === entry.lastChanged) continue;  // 未变化 skip
  lastFlushedAt.set(tag, entry.lastChanged);
}
```

**测试** (3 新 flusher tests):
- 同 lastChanged 重复写时 skip
- lastChanged 变化时正常写
- quality='bad' 仍 skip (现有行为不变)

---

### Commit 3: `feat(server,web-ui): WS 客户端订阅协议 (SP-PLC-3 P2.3)`

**Scope:** WS 加 subscribe/unsubscribe message + server 按订阅过滤 broadcaster fan-out + web-ui useTag 自动订阅.

**Files touched:**
- `packages/server/src/ws-server.ts` — ws.on('message') handler + SubscriptionState (~60)
- `packages/server/src/engine/realtime-broadcaster.ts` — broadcast helper 改接 SubscriptionFilter (~30/-10)
- `packages/web-ui/src/stores/realtime-store.ts` — 加 sendSubscribe / sendUnsubscribe helper (~25)
- `packages/web-ui/src/hooks/useTag.ts` — mount 时自动 sendSubscribe, unmount sendUnsubscribe (~20)
- `packages/web-ui/src/hooks/useTagHistory.ts` — 同上 (~15)
- 新建 `packages/server/src/engine/__tests__/subscription.test.ts` (~120, 8 tests)
- `packages/web-ui/src/hooks/__tests__/useTag.test.tsx` — 扩 (~30, 3 新 tests)

**WS subscribe message 格式**:
```ts
{ type: 'subscribe', reactorId: 'R1', tags: ['TEMP_PV', 'PH_PV'] }
{ type: 'subscribe', reactorId: '*', tags: '*' }
{ type: 'unsubscribe', reactorId: 'R1', tags: ['TEMP_PV'] }
```

**SubscriptionState** (per ws):
```ts
interface SubscriptionState {
  // null = 老 client 没 subscribe → 全推 (Phase 1 行为)
  subs: null | Map<string, Set<string> | '*'>;
}
```

**broadcaster fan-out 过滤**:
```ts
for (const client of wss.clients) {
  if (client.readyState !== WebSocket.OPEN) continue;
  const state = subStates.get(client);
  if (state?.subs) {
    const reactorSubs = state.subs.get(reactorId) || state.subs.get('*');
    if (!reactorSubs) continue;
    if (reactorSubs !== '*') {
      const subset: any = { quality: {} };
      for (const tag of changedTags) {
        if (reactorSubs.has(tag)) subset[tagToField(tag)] = payload[tagToField(tag)];
      }
      if (Object.keys(subset).length <= 1) continue;
      client.send(JSON.stringify({ ...envelope, payload: subset }));
    } else {
      client.send(JSON.stringify(fullEnvelope));
    }
  } else {
    // 老 client: 全推 (Phase 1 兼容)
    client.send(JSON.stringify(fullEnvelope));
  }
}
```

**useTag 自动订阅** (mount lifecycle):
```ts
useEffect(() => {
  if (!parsed) return;
  sendSubscribe(parsed.reactorId, [tagForField(parsed.field)]);
  return () => sendUnsubscribe(parsed.reactorId, [tagForField(parsed.field)]);
}, [parsed?.reactorId, parsed?.field]);
```

**测试** (8 server + 3 useTag):
- subscribe 单 tag 后只收该 tag / subscribe '*' 全 reactor 收所有 / unsubscribe 后不收 / 老 client 全推 / 同 reactor 多 client 互不干扰 / ws close 后 state 清理 / 死 client fan-out skip / 未订阅 reactor 不推 / useTag mount subscribe / unmount unsubscribe / re-mount idempotent

---

### Commit 4: `feat(web-ui,server): plc-config UI 编辑 poll_rate_ms + scheduler 热重启 (SP-PLC-3 P2.4)`

**Scope:** plc-config 页 row 加 poll_rate_ms 下拉 + PUT endpoint 更新 + PollingScheduler.restart 热生效.

**Files touched:**
- `packages/web-ui/src/app/settings/plc-config/page.tsx` — 行内 select + handleSave 调 PUT (~30)
- `packages/server/src/plc-driver-routes.ts` — PUT /api/v1/plc/variables/:id 接 poll_rate_ms (~15)
- `packages/server/src/index.ts` — PUT handler 后调对应 reactor 的 scheduler.restart() (~10)
- 新建 `packages/server/src/__tests__/plc-variable-update.test.ts` (~80, 5 tests)

**UI**: 表格 row 新列 `采样率` 显示 + 编辑模式 select 三选项

**Server**: 现有 PUT 端点扩字段; 新增 emit `plc_variable_updated` event → index.ts 监听 → 对应 reactor scheduler.restart()

**测试** (5):
- PUT poll_rate_ms=100 → DB 写入 + scheduler.restart 调用 spy / 非法值 400 / 不存在 id 404 / partial update 不动 / 并发 PUT 后写赢

---

### Commit 5: `feat(server): /metrics 注册 cache 指标 + InfluxDB 分级采样 (SP-PLC-3 P2.5)`

**Scope:** /metrics 注册 4 个 cache 指标 (复用 MetricsRegistry) + 新增 downsample-flusher 写 downsampled bucket.

**Files touched:**
- `packages/server/src/index.ts` — startup 注册 4 metrics + 启动 downsample-flusher (~25)
- 新建 `packages/server/src/engine/cache-metrics.ts` — TagCache events → metrics counter/gauge (~80)
- 新建 `packages/server/src/lib/downsample.ts` — 抽 batch-intelligence-routes.ts:54 downsampleValues 共享 (~30)
- `packages/server/src/batch-intelligence-routes.ts` — import 共享 downsample (~3/-25)
- 新建 `packages/server/src/engine/downsample-flusher.ts` — 类似 influx-flusher 但 10s tick + 写 downsampled bucket (~120)
- 新建 `packages/server/src/engine/__tests__/cache-metrics.test.ts` (~80, 6 tests)
- 新建 `packages/server/src/engine/__tests__/downsample-flusher.test.ts` (~100, 6 tests)

**4 新 metrics** (`cache-metrics.ts`):
- `biocore_tagcache_size{reactor}` Gauge
- `biocore_tagcache_writes_total` Counter
- `biocore_tagcache_dirty_total` Counter (deadband 抑制时不增)
- `biocore_broadcaster_skipped_total{reason}` Counter (back-pressure / no-subscription)

**downsample-flusher.ts**: setInterval(DOWNSAMPLE_FLUSH_MS=10000), 每 reactor 累计 10s 内的 9 字段 → downsampleValues(values, 1) 取均值 → 1 Point per field per reactor per 10s → 写 influxDownsampleApi.

**env vars**: `INFLUX_DOWNSAMPLED_BUCKET=BIOCore_Data_downsampled`, `DOWNSAMPLE_FLUSH_MS=10000`

**测试** (6+6 = 12):
- cache-metrics: writesTotal/dirtyTotal/size/skipped 增/正确 + /metrics 输出含 4 新 metric + 旧 SP-FX-28 不退化
- downsample-flusher: 10s tick 写 + 内部 array 不无限增长 + null api noop + 全 reactor 0 value skip + stop function 清 interval + 与主 flusher 写 raw bucket 不冲突

---

### Total deltas

| Package | New files | Modified | New tests |
|---|---|---|---|
| `server/migrations/` | 040-plc-deadband.sql | — | — |
| `server/src/engine/` | cache-metrics.ts (80), downsample-flusher.ts (120) | tag-cache.ts (~30), realtime-broadcaster.ts (~30), influx-flusher.ts (~25) | 5 test files (5+3+11+5+12 = 36 tests) |
| `server/src/` | — | index.ts (~80), ws-server.ts (~60), plc-driver-routes.ts (~15) | — |
| `server/src/lib/` | downsample.ts (30) | — | — |
| `data-service/src/` | — | sqlite-service.ts (~15) | — |
| `web-ui/src/` | — | hooks/useTag.ts (~20), useTagHistory.ts (~15), stores/realtime-store.ts (~25), app/settings/plc-config/page.tsx (~30) | useTag.test +3 |

**总计**: +900 LOC (含测试), +1 SQL migration, +0 npm dep, +4 env vars.

---

## 2. Risk Areas

### 2a. WS subscription 状态泄漏
- WeakMap<ws, SubscriptionState> 若 ws 实例被其它地方意外引用 → GC 失效
- **对策**: ws.on('close') 显式 `subStates.delete(ws)` 兜底, 不依赖 GC; 定期 (1min) 扫一次 fan-out 路径 dead client filter

### 2b. PollingScheduler.restart() 接 PLC 真硬件
- 真 PLC restart 需要 stop → 等 emit 收尾 → 重建 timer → start; 期间 1×poll_rate_ms 空窗
- **对策**: restart 间窗内 client UI 仍能收上次 cache 值 (Phase 1 last-known-good 已支持); 不破前端体验

### 2c. deadband_pct 在 prevValue=0 时除零
- 公式 `|Δ| / |prev| * 100 > pct`, prev=0 时除零
- **对策**: `if (Math.abs(prev) > 0)` 守卫, prev=0 时仅看 abs 维度

### 2d. downsample-flusher 写时机 vs 主 flusher
- 主 flusher 1Hz 写 raw bucket; downsample 10s tick 写 downsampled bucket
- 两者**完全独立**, 不存在数据一致性问题 (Influx append-only)
- **对策**: 各自 setInterval + 各自 lastChanged 跟踪, 不共享状态

### 2e. plc_variable_mappings ALTER 在已部署生产
- migration 040 在生产已运行 DB 上跑 ALTER ADD COLUMN
- sqlite ALTER ADD COLUMN DEFAULT 0 会回填现有 rows
- **对策**: 现有 rows deadband=0 = 关闭 per-tag, fallback 全局, 行为不变; 0 数据迁移

### 2f. subscription tag filter 与 quality 字段
- subscribe `['TEMP_PV']` → broadcaster fan-out 子集仅含 AI-0 + 对应 quality
- **对策**: subset payload 中 quality 也按订阅 tag 过滤

### 2g. 老 client 升级路径
- Phase 1 老 client 启动不 sendSubscribe → 全推 (subs=null fallback)
- Phase 2 升级后 useTag 自动 subscribe → 转订阅模式
- **对策**: server 默认 subs=null = 全推 (向后兼容)

### 2h. metrics counter 高频 inc 性能
- tagcacheWritesTotal 5Hz × N reactor × 19 tag = 万次/秒 inc
- Counter.inc 是 Map.set, 微秒级开销
- **对策**: 实测; 若慢可降级到每 100 次 inc 一次 (counter 容忍误差)

---

## 3. Test Coverage Plan

### server/engine
- `tag-cache.test.ts` 扩 +5 (P2.1) → 20 total
- `influx-flusher.test.ts` +3 (P2.2) → 10 total
- `subscription.test.ts` (P2.3) 8 新
- `cache-metrics.test.ts` (P2.5) 6 新
- `downsample-flusher.test.ts` (P2.5) 6 新

### server/src
- `plc-variable-update.test.ts` (P2.4) 5 新

### web-ui
- `useTag.test.tsx` 扩 +3 (subscribe/unsubscribe lifecycle)

**总计 +36 new tests**

### 覆盖率目标
- 新模块 (cache-metrics, downsample-flusher, subscription): 85%+
- 总体 server/engine 包: 维持 80%+

---

## 4. Rollback Strategy

### Per-commit `git revert` impact

| Commit | Revert 影响 |
|---|---|
| P2.1 (deadband schema + TagCache) | 全局 deadband fallback 生效 (deadband=0 = 全推); 0 行为变化 |
| P2.2 (broadcaster + flusher) | flusher 退回每秒写所有字段 (Phase 1 行为); Influx 写入量回升 |
| P2.3 (WS 订阅) | 老 client 路径强制走; web-ui useTag subscribe noop |
| P2.4 (plc-config UI) | UI 编辑功能消失; 后端默认 1000ms 不动 |
| P2.5 (metrics + downsample) | /metrics 仍工作 (旧 SP-FX-28); downsample bucket 不写, 主 bucket 不受影响 |

### Down-migration
- migration 040 down: sqlite 不支持 DROP COLUMN, 必须 CREATE TABLE NEW + INSERT + DROP OLD + RENAME
- **推荐不写 down-migration**, 走 git revert + 保留列 (列默认 0 等于关闭)

### 推荐 rollback recipe
完全 rollback Phase 2: `git revert <P2.5>..<P2.1>` 倒序, DB 列保留不影响 Phase 1 行为.
部分 rollback: 单 commit revert 即可, 互相独立.

### 生产 hot-rollback (无 deploy 窗口) — 3 env 开关
- `WS_SUBSCRIPTION_ENABLED=false` → server 强制全推 (跟 Phase 1 等价)
- `INFLUX_DOWNSAMPLED_BUCKET=` (空) → downsample-flusher 不启动
- `TAGCACHE_DEADBAND_DISABLED=true` → deadbandResolver 忽略, fallback 全局 0

---

## 5. Anti-Spec Items（out of scope）

- ❌ **二进制 WS 协议** (MessagePack / Flatbuffers) — Phase 3
- ❌ **Worker thread PLC IO** — Phase 3
- ❌ **Redis pub/sub 横向扩展** — Phase 3
- ❌ **reliable message queue** — Phase 3
- ❌ **OPC UA gateway** — 独立 sprint
- ❌ **Per-reactor subscription rate limit** — Phase 3
- ❌ **InfluxDB raw bucket 自动清理 / retention 管控** — 运维任务
- ❌ **/metrics 端点 unauthenticated 暴露** — 维持 requireRole('admin')
- ❌ **PollingScheduler 动态 add/remove single tag** — Phase 3
- ❌ **dashboard 趋势图 5Hz 渲染优化** (Recharts 瓶颈) — Phase 3

---

## 6. Open Questions（需用户决定的）

### (i) plc_variable_mappings schema migration 路径 ⚠️ 用户决定

候选 A: migration 040 SQL ALTER (标准 umzug 路径)
候选 B: 改 variable-mapping.ts 的 IF NOT EXISTS DDL 加列 (动态 schema)

**推荐 A**: 与 server/migrations/ 体系一致, schema 版本化.

### (ii) 客户端订阅默认行为 ⚠️ 用户决定

候选 A: 老 client (无 subscribe) → 全推 (Phase 1 行为, 兼容)
候选 B: 老 client → 0 推 (强制 client 升级)

**推荐 A**: 升级期 mixed client 不破; Phase 3 后可考虑切到 B.

### (iii) deadband 默认值 ⚠️ 用户决定

候选 A: 全 tag 默认 0 (= 关闭 deadband, 全推 — Phase 1 行为)
候选 B: 全 tag 默认 abs=0.1 (经验值)

**推荐 A**: 默认不破 Phase 1 行为, 操作员按需配置.

### (iv) downsample-flusher 算法 ⚠️ 用户决定

候选 A: 均值 (复用 downsampleValues 已有算法)
候选 B: LTTB (保留极值, 适合图表)
候选 C: min/max/avg 三值聚合 (Prometheus 风格)

**推荐 A**: 复用算法 0 新代码; mean 够用. B/C 留 Phase 3.

### (v) /metrics 是否暴露 broadcaster fan-out latency Histogram ⚠️ 用户决定

候选 A: 仅 4 个 cache 指标 (size/writes/dirty/skipped)
候选 B: + Histogram (5Hz × N reactor 延迟分布)

**推荐 A**: 监控起步够用, latency histogram 高 cardinality 风险.

### (vi) plc-config UI 多采样周期下拉档位 ⚠️ 用户决定

候选 A: 3 档 100ms / 1000ms / 10000ms
候选 B: 自由输入 (100-60000 范围)
候选 C: 5 档 100/500/1000/5000/10000ms

**推荐 A**: 覆盖工业常见场景, UI 简洁, 误配率低.

---

## 7. Migration / Dependencies

### Schema migration
- **040-plc-deadband.sql**: ALTER plc_variable_mappings ADD COLUMN deadband_abs/_pct REAL DEFAULT 0

### npm dependencies
**0 new dependency**.

### Env vars (新增 + 文档)
- `INFLUX_DOWNSAMPLED_BUCKET` (默认 `BIOCore_Data_downsampled`)
- `DOWNSAMPLE_FLUSH_MS` (默认 10000)
- `WS_SUBSCRIPTION_ENABLED` (默认 true)
- `TAGCACHE_DEADBAND_DISABLED` (默认 false)

---

## 8. Verification Checklist

### 通用
- [ ] server build 0 TS 错误
- [ ] web-ui build 0 TS 错误
- [ ] 全新 36 vitest tests 全过
- [ ] Phase 1 全 58 tests 不退化
- [ ] `docs/部署说明.md` 加 4 个新 env var 文档

### Commit P2.1 — schema + TagCache
- [ ] migration 040 在新部署应用
- [ ] migration 040 在已有 DB 上 idempotent
- [ ] 5 新 tag-cache test 全过
- [ ] 旧 15 tag-cache test 不退化

### Commit P2.2 — broadcaster + flusher
- [ ] 3 新 flusher test 全过
- [ ] influx 写入量在 deadband 配置后下降 (实测前后对比)

### Commit P2.3 — WS 订阅
- [ ] 8 subscription test + 3 useTag test 全过
- [ ] 老 client 全推路径不破 (Phase 1 web-ui 兼容)
- [ ] 多 client 不同 subscription 互不干扰

### Commit P2.4 — plc-config UI
- [ ] 5 plc-variable-update test 全过
- [ ] 浏览器 QA: plc-config 改 poll_rate_ms → 保存 → server log scheduler.restart

### Commit P2.5 — metrics + downsample
- [ ] 12 新 test 全过
- [ ] /metrics curl 输出含 4 新 metric
- [ ] downsample bucket 启动后 10s 内有点写入
- [ ] downsample bucket env 空 → 不启动 flusher

### 性能 baseline (5000 点 × 10 reactor × deadband_pct=2%)
- [ ] WS 流量 (稳态变化率 5%): broadcaster 推送字节数下降 60%+ vs Phase 1
- [ ] InfluxDB 写入率: raw 1Hz + downsampled 0.1Hz, 总写入下降
- [ ] /metrics tagcacheDirtyTotal vs tagcacheWritesTotal 比率反映 deadband 效果

---

## 9. Future Phase 3 Outlook (informational)

**Phase 3** (10000+ 点 / 高可用, 估 ~15-20h):
- 二进制 WS 协议 (MessagePack ~3x 压缩, 或 Flatbuffers 零拷贝)
- Worker thread PLC IO (PollingScheduler 移 worker)
- Redis pub/sub 横向扩展 (多 server 共享 cache)
- reliable message queue (Kafka/Redis Streams) 替代 WS
- Histogram metrics (fanout latency, p99/p999)
- LTTB / min-max-avg downsample 算法
- PollingScheduler 动态 add/remove tag (不重启)

**OPC UA gateway** (独立 sprint, ~10-15h): node-opcua 当对外接口给第三方 SCADA 连.

---

## End of Plan
