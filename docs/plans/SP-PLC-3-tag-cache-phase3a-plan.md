# SP-PLC-3 Tag Cache & OPC-style Subscription — Phase 3a (easy wins)

**Status:** Plan-only (2026-05-26). Awaiting user approval.
**Target version:** v1.17.0
**Estimated:** ~600 LOC, 4 commits, +25–30 tests, 4–6h single-engineer
**Scope tier:** Phase 3a (easy wins). Depends on Phase 2 (`c7520a9` HEAD).
**Phase 1/2 ref:** `docs/plans/SP-PLC-3-tag-cache-plan.md` + `…-phase2-plan.md`.

---

## Spec recap (locked)

| Q | 决策 |
|---|---|
| Q1 | **二进制 WS 协议**: 引 `@msgpack/msgpack` (~30KB, 0 native binding). 协议协商: client connect 时 `?wire=msgpack`, server 看 query 决定 send 时序列化用 msgpack vs JSON. 老 client (无 query) 默认 JSON 兼容 |
| Q2 | **Histogram fanout latency**: 复用 SP-FX-28 `MetricsRegistry.Histogram`, 加 `biocore_broadcaster_fanout_seconds` Histogram (无 label 避免高 cardinality); broadcaster fan-out tick 加 `performance.now()` 计时 |
| Q3 | **PollingScheduler 动态 add/remove tag**: 加 `addVariable(v)` / `removeVariable(id)` 增量 API, dirty flag 下次 tick 内 regroupByRegion. **不停现有 timer**, 避免 setVariables + restart 的 1×poll_rate 空窗 |
| Q4 | **min/max/avg downsample**: lib/downsample 加 `minMaxAvgDownsample(values, targetPoints): {min, max, avg}[]`, downsample-flusher 加 `DOWNSAMPLE_ALGORITHM` env (默认 mean 兼容, 切换 minmaxavg 时写 3 字段 per tag 而非 1) |
| Q5 | **msgpack 客户端兼容**: 老 client (`?wire=json` 或无 query) 强制走 JSON; client 升级后 `?wire=msgpack` 走 binary; server 自动适配每 client 一套序列化函数选择 |
| Q6 | **Histogram bucket**: 用 services/metrics.ts 现有固定 buckets `[0.01, 0.05, 0.1, 0.5, 1, 5]` 秒, 适合 fanout 延迟 (5Hz tick 一般 < 10ms = 0.01s 桶) |
| Q7 | **动态 tag API 是否在生产 trigger restart**: 推荐 incremental update — `addVariable` push 进 vars list + dirty flag, 下次 tick 自动包含; `removeVariable` 同; 不重启 scheduler timer |

---

## Investigation Findings（架构师对代码的实地考察）

1. **WS JSON 序列化** 3 处 (`ws-server.ts:215/266/335`): line 215 全推 `JSON.stringify(envelope)`, line 266 subset 推 `JSON.stringify({...envelope, payload: subset})`, line 335 receive `JSON.parse(rawData.toString())`. P3a.1 改造点清晰, 加 `serializeForClient(client, envelope) -> string|Buffer` 抽象.

2. **MetricsRegistry.Histogram 完整实现** (`services/metrics.ts:71`): 固定 buckets `[0.01, 0.05, 0.1, 0.5, 1, 5]`, `observe(value, labels?)`, factory `registry.histogram(name, help)`. P3a.2 复用 0 改动.

3. **PollingScheduler.setVariables** (`plc-driver/src/index.ts:383`): 当前 batch set + restart 模式. 加 incremental API 不破现有 caller (variable-mapping 全 batch 模式), 仅 new caller 用增量.

4. **lib/downsample.ts** P2.5 ship (downsampleValues LTTB + meanDownsample). P3a.4 在同文件加 `minMaxAvgDownsample`.

5. **downsample-flusher.ts** (P2.5 ship): 当前 hardcode `meanDownsample(values, 1)`. P3a.4 加 algorithm 选项 + 字段名后缀 (e.g. `temperature_min`/`temperature_max`/`temperature_avg`).

6. **broadcaster.ts fan-out** (P3 ship): tick 内 `for (const change of changes)` 循环, 然后 broadcast helper 调用. P3a.2 在 tick 边界 wrap `performance.now()` 测全 reactor fan-out 总 latency.

7. **`@msgpack/msgpack` npm 包**: 0 transitive dep, 0 native binding, 浏览器 + Node 双兼容. 用法: `encode(obj) -> Uint8Array`, `decode(buf) -> obj`. 完美匹配 ws.send(Buffer) 接口.

8. **PollingScheduler.start/stop/restart** 当前: start 内 `groupByRegion(vars)` 后 setInterval 每周期 read region. 增量改造: `addVariable` push 进 internal vars + dirty flag, tick 开始时 if (dirty) 重 group.

9. **wireMode 推断** (P3a.1): server 在 connection handler 解析 `req.url` query, 把 wireMode='msgpack'|'json' 存到 ws 实例 (`(ws as any).wireMode = ...`); broadcaster fan-out 读取该 flag 选 serializer.

10. **client (web-ui) msgpack 解码**: `realtime-store.ts:onmessage` 现 `JSON.parse(event.data)`. 改造: 探测 `event.data instanceof Blob` (msgpack) vs string (JSON), Blob → arrayBuffer → msgpack decode. 加 `wire=msgpack` 到 WS URL.

---

## 1. Commit Sequence — 4 commits

### Commit 1: `feat(server,web-ui): WS msgpack 二进制协议 (SP-PLC-3 P3a.1)`

**Scope:** server + web-ui 双包. 引 `@msgpack/msgpack` dep. 协议协商通过 `?wire=msgpack` query, 老 client 默认 JSON 兼容.

**Files touched:**
- `packages/server/package.json` — 加 `@msgpack/msgpack`
- `packages/web-ui/package.json` — 加 `@msgpack/msgpack`
- `packages/server/src/ws-server.ts` — wireMode 推断 + serializer 选择 (~50/-15)
- `packages/web-ui/src/stores/realtime-store.ts` — connect URL 加 `?wire=msgpack` + onmessage 双协议处理 (~30/-5)
- 新建 `packages/server/src/engine/__tests__/wire-protocol.test.ts` (~100, 6 tests)

**协议协商**:
- client connect: `ws://...?wire=msgpack&token=...`
- server 解析 `url.searchParams.get('wire') → ws.wireMode = 'msgpack' | 'json'`
- broadcast 内 `client.wireMode === 'msgpack' ? msgpack.encode(obj) : JSON.stringify(obj)`
- ws.send 接受 string 或 Buffer/Uint8Array (二进制 frame opcode=2, text opcode=1)

**老 client 兼容**: 不传 query → 默认 'json' → 行为完全 = Phase 2

**测试** (6):
- wireMode='msgpack' client 收到二进制 Buffer 能正确 decode
- wireMode='json' client 收到 string 能正确 JSON.parse
- 无 wire query → 默认 json
- 非法 wire 值 → 默认 json (不抛)
- mixed clients (一些 msgpack 一些 json) 同 broadcast 各自正确 encode
- 老 client (Phase 2 web-ui) 升级 server 后无破坏 (回归 test)

### Commit 2: `feat(server): broadcaster fanout latency Histogram (SP-PLC-3 P3a.2)`

**Scope:** 复用 P2.5 cache-metrics handle, 加 `fanoutHistogram` 测每次 broadcaster tick 全 reactor fan-out 总耗时.

**Files touched:**
- `packages/server/src/engine/cache-metrics.ts` — 加 `fanoutHistogram` 到 handle (~15)
- `packages/server/src/engine/realtime-broadcaster.ts` — tick 内 wrap `performance.now()` (~10)
- `packages/server/src/index.ts` — 注入 fanoutHistogram callback (~5)
- `packages/server/src/engine/__tests__/cache-metrics.test.ts` — 扩 (~30, 3 tests)

**新 metric**:
- `biocore_broadcaster_fanout_seconds` Histogram, buckets [0.01, 0.05, 0.1, 0.5, 1, 5]
- 无 label (避免高 cardinality, P2 spec Q(v) 决策)

**测试** (3):
- fan-out 调用后 histogram count 增 1
- 大 batch (100 reactor) fan-out latency 入桶 (不超 5s)
- 0 dirty (空 tick) 不 observe (避免噪声)

### Commit 3: `feat(plc-driver): PollingScheduler 动态 addVariable/removeVariable (SP-PLC-3 P3a.3)`

**Scope:** 避免 plc-config UI 改 poll_rate_ms 触发 scheduler.restart 1×poll_rate 空窗 (P2.4 Risk 2b).

**Files touched:**
- `packages/plc-driver/src/index.ts` — PollingScheduler 加 addVariable/removeVariable + 内部 vars 维护 (~50)
- `packages/server/src/plc-config-routes.ts` — 改 PUT handler 调 add/remove 替代 restart (~15/-5)
- `packages/server/src/__tests__/plc-variable-update.test.ts` — 扩 (~50, 3 新 tests)

**新 API**:
```ts
class PollingScheduler {
  /** 增量加单 variable, 下次 tick 自动包含 (不重启 timer) */
  addVariable(v: PLCVariableMapping): void {
    this.vars.push(v);
    this._dirty = true;  // 下次 tick 内 regroupByRegion
  }

  /** 增量删 variable (按 id), 下次 tick 自动跳过 */
  removeVariable(id: string): void {
    this.vars = this.vars.filter(v => v.id !== id);
    this._dirty = true;
  }

  /** poll tick 内: if (_dirty) groupByRegion(vars) + _dirty = false */
}
```

**plc-config-routes 改动**: 旧 (P2.4) scheduler.restart() → 新 (P3a.3) remove+add (upsert 语义)

**测试** (3):
- addVariable 后下次 tick 包含新 var
- removeVariable 后下次 tick 跳过
- upsert (remove+add) poll_rate 变化生效, 期间无 tick miss

### Commit 4: `feat(server): min/max/avg downsample 算法 (SP-PLC-3 P3a.4)`

**Scope:** lib/downsample 加 minMaxAvgDownsample, downsample-flusher 加 DOWNSAMPLE_ALGORITHM env (mean 兼容 / minmaxavg 写 3 字段 per tag).

**Files touched:**
- `packages/server/src/lib/downsample.ts` — 加 minMaxAvgDownsample (~30)
- `packages/server/src/engine/downsample-flusher.ts` — 加 algorithm 选项 + 字段后缀 (~30/-10)
- 新建 `packages/server/src/__tests__/downsample.test.ts` — 算法单测 (~50, 5 tests)
- `packages/server/src/engine/__tests__/downsample-flusher.test.ts` — 扩 (~30, 2 tests)

**minMaxAvgDownsample**:
```ts
export interface MinMaxAvgPoint { min: number; max: number; avg: number }
export function minMaxAvgDownsample(values: number[], targetPoints = 1): MinMaxAvgPoint[]
```

**downsample-flusher algorithm 选项**:
```ts
const ALGORITHM = process.env.DOWNSAMPLE_ALGORITHM ?? 'mean';
// 'mean' (默认): 现行 meanDownsample, 1 字段 per tag
// 'minmaxavg': minMaxAvgDownsample, 3 字段 per tag (temperature_min/_max/_avg)
```

**测试** (5 算法 + 2 flusher = 7):
- minMaxAvgDownsample 单桶 / 多桶 / 空 / 单值 / targetPoints=2
- flusher algorithm='minmaxavg' 写 3 字段
- flusher algorithm='mean' 默认行为不变

---

### Total deltas

| Package | New files | Modified | New tests | New npm dep |
|---|---|---|---|---|
| `server/` | wire-protocol.test.ts, downsample.test.ts | ws-server.ts, cache-metrics.ts, realtime-broadcaster.ts, downsample-flusher.ts, plc-config-routes.ts, lib/downsample.ts, index.ts, package.json | 6+3+3+5+2 = 19 | @msgpack/msgpack |
| `web-ui/` | — | realtime-store.ts, package.json | — | @msgpack/msgpack |
| `plc-driver/` | — | index.ts | — | — |
| `server/src/__tests__/` | — | plc-variable-update.test.ts | 3 | — |

**总计**: ~600 LOC, +1 npm dep (msgpack ~30KB), +1 env var (DOWNSAMPLE_ALGORITHM), +~25-30 tests.

---

## 2. Risk Areas

### 2a. msgpack 与现有 Node ws 库 send Buffer 接口
- ws.send 接受 string (text frame) 或 Buffer/Uint8Array (binary frame). msgpack.encode 返 Uint8Array, 直接传 ws.send OK
- **风险**: 反向, client onmessage event.data 是 Blob (browser) vs Buffer (Node)
- **对策**: client 端 instanceof Blob 检测 + arrayBuffer() async 转, 双协议处理 (string vs binary)

### 2b. mixed client wireMode 性能
- 同一 broadcaster tick 内, 一半 client msgpack 一半 json → 同 payload encode 两次 (msgpack + JSON.stringify)
- **对策**: 缓存 per-tick 两种序列化结果, fan-out 内 if (msgpack) 用 cachedMsgpack else 用 cachedJSON; 一次 encode 一次 stringify

### 2c. PollingScheduler regroup 影响真 PLC 读
- addVariable/removeVariable 设 dirty flag, 下次 tick 内 regroupByRegion
- regroupByRegion 本身 O(N log N), N=3000 时 < 1ms 不构成瓶颈
- **对策**: 不阻塞 tick, regroup 在 tick 开始时执行

### 2d. Histogram cardinality
- 加 {reactor} label 大量 reactor 时桶数爆
- **对策**: P3a.2 决策不加 label (单 unlabeled Histogram)

### 2e. minMaxAvgDownsample 3 字段 per tag InfluxDB 写入量
- algorithm='minmaxavg' downsample bucket 写入是 mean 模式 3 倍
- **对策**: env 默认 mean (向后兼容), 生产按需切

### 2f. msgpack 解码错误导致 client 崩
- 老 server (P2) 不发 binary frame, 但客户端如果先升级 + 服务端未升级 → wireMode=msgpack 但收到 JSON string
- **对策**: client 检测 string + 尝试 JSON.parse 兼容 (fallback), 不强制 binary

### 2g. addVariable 与 setVariables 互动
- 现有 caller (variable-mapping init) 仍调 setVariables 全量, 后续 plc-config UI 调 addVariable/removeVariable 增量
- 风险: setVariables 覆盖 addVariable 的增量更新
- **对策**: setVariables 仅在启动期调一次; UI 操作走 add/remove. 文档明示约定

---

## 3. Test Coverage Plan

### server/engine
- `wire-protocol.test.ts` (P3a.1) 6 新
- `cache-metrics.test.ts` (P3a.2) +3
- `downsample-flusher.test.ts` (P3a.4) +2

### server/src
- `plc-variable-update.test.ts` (P3a.3) +3

### server/src/__tests__
- `downsample.test.ts` (P3a.4) 5 新

**总计 +19-22 new tests (按合并/拆分细节)**

### 覆盖率目标
- 新模块 (msgpack wire / minMaxAvgDownsample): 90%+
- 总体 server/engine 包: 维持 80%+

---

## 4. Rollback Strategy

### Per-commit `git revert` impact

| Commit | Revert 影响 |
|---|---|
| P3a.1 (msgpack) | 全 client 回 JSON; client 升级后 ?wire=msgpack 失效但 fallback 接 JSON, 0 数据丢 |
| P3a.2 (Histogram) | /metrics 少一个 metric; broadcaster 行为不变 |
| P3a.3 (动态 tag) | UI 改 poll_rate 回到 scheduler.restart 1×poll 空窗 (P2.4 行为) |
| P3a.4 (min/max/avg) | downsample 回 mean only; 已写 minmaxavg 字段历史保留 |

### Hot-rollback env 开关
- `WS_WIRE_MODE_FORCED=json` 强制全 client JSON
- `DOWNSAMPLE_ALGORITHM=mean` 强制 mean (默认即此)

---

## 5. Anti-Spec Items（out of scope）

- ❌ **Worker thread PLC IO** — Phase 3b
- ❌ **Redis pub/sub** — Phase 3c
- ❌ **reliable message queue (Kafka/Redis Streams)** — Phase 3c
- ❌ **客户端 ack 机制** — Phase 3c
- ❌ **OPC UA gateway** — 独立 sprint
- ❌ **Flatbuffers zero-copy** — Phase 3c 评估
- ❌ **Histogram percentile (p99/p999) 计算** — Phase 3b/c (需引 prom-client)

---

## 6. Open Questions（需用户决定的）

### (i) msgpack 协议协商方式 ⚠️ 用户决定

候选 A: `?wire=msgpack` query string (上线推荐)
候选 B: WebSocket subprotocol header

**推荐 A**: 与现有 `?token=...&api_key=...` 路径一致, 0 ws 配置改动.

### (ii) min/max/avg 字段命名约定 ⚠️ 用户决定

候选 A: `temperature_min` / `temperature_max` / `temperature_avg` (3 字段)
候选 B: 加 `aggregation` tag (`temperature{aggregation='min'}`)

**推荐 A**: InfluxDB 单 field 单值, 后缀清晰直接, Grafana query 简单.

### (iii) Histogram label 决策 ⚠️ 用户决定

候选 A: 无 label 单一 Histogram
候选 B: `{reactor}` label

**推荐 A**: 单 reactor 主导, 全局够用; 多 reactor 部署后再切 B.

### (iv) 动态 tag 是否支持 batch ⚠️ 用户决定

候选 A: 仅单 tag add/remove
候选 B: 同时加 addVariables/removeVariables batch

**推荐 A**: 单 tag UI 场景已覆盖; batch 是优化, Phase 3b 再加.

---

## 7. Migration / Dependencies

### Schema migration
**0 migration**.

### npm dependencies
- `@msgpack/msgpack` (~30KB, 0 native): server + web-ui 各加一份

### Env vars (新增)
- `DOWNSAMPLE_ALGORITHM` (默认 'mean', 可选 'minmaxavg')
- `WS_WIRE_MODE_FORCED` (默认空, 设 'json' 强制全 client JSON 回滚)

---

## 8. Verification Checklist

### 通用
- [ ] server build 0 TS 错误
- [ ] web-ui build 0 TS 错误
- [ ] 全新 ~25 vitest tests 全过
- [ ] Phase 1+2 全 99 tests 不退化
- [ ] `docs/部署说明.md` 加 2 个新 env var 文档

### Commit P3a.1 — msgpack
- [ ] 6 wire-protocol test 全过
- [ ] msgpack client 收到 binary 正确 decode
- [ ] json client (P2 老版本) 兼容回归
- [ ] mixed client 各自正确

### Commit P3a.2 — Histogram
- [ ] 3 新 cache-metrics test 全过
- [ ] /metrics curl 含 `biocore_broadcaster_fanout_seconds_bucket{...}` 8 行 (6 buckets + +Inf + count)

### Commit P3a.3 — 动态 tag
- [ ] 3 新 plc-variable-update test 全过
- [ ] plc-config UI 改 poll_rate → server log 无 scheduler.restart 调用, addVariable + removeVariable 各一次

### Commit P3a.4 — min/max/avg
- [ ] 7 新 test 全过
- [ ] DOWNSAMPLE_ALGORITHM=minmaxavg 启动后 downsample bucket 写 3 字段
- [ ] 默认 mean 行为不变

### 性能 baseline
- [ ] msgpack payload 字节数 < JSON 的 60% (10 reactor × 23 字段 实测)
- [ ] fanout latency p50 < 5ms, p99 < 20ms

---

## 9. Future Phase 3b/3c Outlook (informational)

**Phase 3b** (Worker thread, 3-4h):
- PLC IO 移 worker_threads
- IPC: postMessage snapshot 给 main thread
- 真 PLC 接入前置 (避免 native binding block main loop)

**Phase 3c** (横向扩展, 9-13h):
- Redis pub/sub (多 server 共享 cache state)
- reliable message queue (Kafka/Redis Streams) 替代 WS
- 客户端 ack 机制
- Flatbuffers zero-copy 协议 (msgpack 不够时)

---

## End of Plan
