# SP-PLC-3 Tag Cache & OPC-style Subscription — Phase 3b (Worker thread)

**Status:** Plan-only (2026-05-26). Awaiting user approval.
**Target version:** v1.18.0
**Estimated:** ~400 LOC, 2 commits, +12 tests, 3–4h single-engineer
**Scope tier:** Phase 3b (Worker thread PLC IO). Depends on Phase 3a (`6a5ac48` HEAD).

---

## Spec recap (locked)

| Q | 决策 |
|---|---|
| Q1 | **PollingScheduler 移 worker_threads**: main thread 仅持 Worker 句柄, 真 PLC IO (snap7/modbus read) 在 worker. main thread 不阻塞 native binding 调用 |
| Q2 | **IPC 协议**: 用 `parentPort.postMessage`/`worker.on('message')` 传 snapshot JSON. snapshot 是结构化数据可序列化, 不需要 SharedArrayBuffer |
| Q3 | **真 PLC 接入前置**: Phase 3b ship 后才能安全接真 PLC (MOCK 模式不需要 worker, 但接口已就位) |
| Q4 | **worker 启动失败 fallback**: worker spawn 失败 / native binding 加载失败 → 回退 main thread PollingScheduler (Phase 3a 行为), 不阻塞 server 启动. log warn |
| Q5 | **worker 生命周期**: 每 reactor 一个 worker (与现 pollingSchedulers Map 1:1), SIGTERM 时主进程 worker.terminate(), 5s 超时强 kill |
| Q6 | **worker 重启策略**: worker.on('error') / worker.on('exit') 非 0 退出 → exponential backoff 1s/2s/4s 最多 3 次, 失败后降级 mock 路径 + console.error 报警 |
| Q7 | **可观测性**: 加 `biocore_plc_worker_state{reactor}` Gauge (1=running / 0=failed); 复用 P2.5 MetricsRegistry |
| Q8 | **snap7 native binding 在 worker**: node-snap7 是 nan-based addon, **worker 加载理论安全** (Node.js worker 各自独立 V8 isolate, native module 自动 thread-safe re-init). 需实测验证 |

---

## Investigation Findings（架构师对代码的实地考察）

1. **worker_threads 0 现有用法** — 全仓 grep `worker_threads` empty. Phase 3b 全新引入概念.

2. **node-snap7** (`packages/plc-driver/src/index.ts:15`): `import { S7Client } from 'node-snap7'`. S7Client 是 nan-based addon. Node worker_threads + nan addon **兼容性已知**: nan ≥ 2.13 + napi ≥ 6 安全 (snap7 1.0.6 满足).

3. **PollingScheduler 当前** (P3a.3 ship, `plc-driver/src/index.ts:559+`): 已含 instance vars + groupedByRate + dirty flag + addVariable/removeVariable; 在 main thread setInterval. Phase 3b 把 setInterval 闭包整体移 worker.

4. **PLCConnectionManager** 持 S7Client 实例 + `connect/disconnect/readBytesRaw`. Worker 内重建 mgr 实例, IPC 不传 mgr 对象本身 (含 native handle 不可序列化).

5. **TagCache.write** (P1 ship): 在 main thread, worker emit snapshot 后 main thread 收 message → `tagCache.write(reactorId, snap, {deadbandResolver})`. 与 P2.2 wiring 兼容.

6. **deadbandResolver** (P2.2 ship): 调 `sqlite.getPlcReactorBindingsByReactor` + `varManager.getVariables(plcId)`. 仅 main thread 调 sqlite + varManager, worker 不访问 DB. resolver 在 main thread 注入 TagCache.write.

7. **MetricsRegistry** (P2.5 ship): main thread 单例. worker 内不直接调 metrics, 通过 IPC message 报告 state 给 main thread 转写 metrics.

8. **现 cache-metrics.ts** (P2.5 ship): 加 `plcWorkerState` Gauge 复用同 registry. caller 注入 `(reactor, isRunning) => gauge.set(isRunning ? 1 : 0, {reactor})`.

9. **node-snap7 binary** (`node-snap7/build/Release/snap7_lib.node`): npm install 时编译, monorepo workspace 共享. 部署机需有 Snap7 C 库 (libsnap7) 安装 (生产已知约束).

10. **MOCK_PLC 模式不需要 worker**: index.ts startup `if (!MOCK_PLC)` 才启动 PollingScheduler; Phase 3b 同分支启动 worker. MOCK 路径完全不变.

---

## 1. Commit Sequence — 2 commits

### Commit 1: `feat(plc-driver): PollingScheduler worker scaffold + IPC 协议 (SP-PLC-3 P3b.1)`

**Scope:** worker thread 文件 + IPC 协议设计. 不接真 snap7 (仍 mock snapshot in worker), 让 wiring 端到端跑通.

**Files touched:**
- `packages/plc-driver/src/worker/polling-scheduler-worker.ts` — 新建 (~120 行)
- `packages/plc-driver/src/index.ts` — 加 `startSchedulerInWorker(config) -> WorkerHandle` helper (~50)
- `packages/plc-driver/src/__tests__/polling-scheduler-worker.test.ts` — 新建 (~80, 6 tests)

**IPC 协议**:
```ts
// main → worker (init)
{ type: 'init', plcConfig, variables, pollRates: number[] }

// main → worker (动态 tag)
{ type: 'addVariable', variable }
{ type: 'removeVariable', id }

// main → worker (shutdown)
{ type: 'stop' }

// worker → main
{ type: 'snapshot', reactorId, snap: SnapshotInput }
{ type: 'error', message }
{ type: 'state', state: 'running' | 'connecting' | 'failed' }
```

**测试** (6):
- worker init + snap 通过 IPC 传回 main 正确解析
- addVariable IPC 后 worker 内 PollingScheduler 含新 var
- removeVariable IPC 同
- stop message 后 worker 干净退出
- worker error event → main 收 'error' message
- worker exit 非 0 → state='failed' 通知

### Commit 2: `feat(server): index.ts wire worker + 真 snap7 in worker + metrics (SP-PLC-3 P3b.2)`

**Scope:** index.ts startup 改用 `startSchedulerInWorker` 替代 main thread `new PollingScheduler`. worker 内连真 snap7 (P3b.1 mock 路径转生产). worker 重启 + fallback + cache-metrics 集成.

**Files touched:**
- `packages/plc-driver/src/worker/polling-scheduler-worker.ts` — 接真 PLCConnectionManager + connect (~30/-10)
- `packages/server/src/index.ts` — startup 改 worker spawn + exponential backoff 重启 + fallback (~60/-15)
- `packages/server/src/engine/cache-metrics.ts` — 加 `plcWorkerState` Gauge (~10)
- `packages/server/src/__tests__/worker-lifecycle.test.ts` — 新建 (~100, 6 tests)

**重启策略**:
- 1s/2s/4s backoff, 最多 3 次
- 失败后 console.error + 降级 mock 路径 (tagCache 不写新数据, 老数据仍可读)

**测试** (6):
- worker spawn 成功 main 收 'running' state
- worker error 触发 1 次 backoff 重启
- 3 次失败后降级 mock + console.error
- worker.terminate (SIGTERM) 5s 内干净退出, 超时强 kill
- plcWorkerState gauge 反映状态 (running=1, failed=0)
- MOCK_PLC=true 不启动 worker (向后兼容)

---

### Total deltas

| Package | New files | Modified | New tests |
|---|---|---|---|
| `plc-driver/src/worker/` | polling-scheduler-worker.ts (~150 总) | — | — |
| `plc-driver/src/` | — | index.ts (~50) | — |
| `plc-driver/src/__tests__/` | polling-scheduler-worker.test.ts (~80) | — | 6 |
| `server/src/` | — | index.ts (~60/-15), engine/cache-metrics.ts (~10) | — |
| `server/src/__tests__/` | worker-lifecycle.test.ts (~100) | — | 6 |

**总计**: ~400 LOC, 0 npm dep (worker_threads 内置), 1 env var (PLC_WORKER_DISABLED), +12 tests.

---

## 2. Risk Areas

### 2a. node-snap7 在 worker thread 加载
- nan-based addon worker 加载理论安全 (Node.js worker 各 V8 isolate); 实际可能 segfault
- **对策**: P3b.1 mock 路径先验 IPC; P3b.2 实测真 snap7. 失败时回退 main thread PollingScheduler (P3a.3 行为)

### 2b. worker 启动开销
- 每 reactor 1 worker, 10 reactor = 10 worker, 每 worker ~30MB heap + 启动 ~50ms
- **对策**: 接受 ~300MB 额外 memory + 500ms 启动延迟; 多 reactor 部署生产场景值得

### 2c. IPC 序列化开销
- snapshot 每 1s × N reactor × N vars 通过 postMessage, JSON.stringify+parse
- **对策**: snapshot 小 (~1KB/reactor), 5Hz × 10 reactor = 50KB/s IPC, 远低于 Node IPC 带宽

### 2d. worker.terminate 强 kill 资源泄漏
- SIGTERM 5s 超时强 kill snap7 native handle 可能不释放
- **对策**: 接受 (生产 restart 不频繁); 文档明示 SIGTERM 后等 5s 再 SIGKILL

### 2e. worker_threads vs cluster
- Phase 3b 选 worker_threads (单进程 + 多线程 V8 isolate); cluster 是多进程 fork
- worker_threads 适合 CPU 密集 / native binding 隔离; cluster 适合横向扩展
- **对策**: 真横向扩展是 Phase 3c (Redis pub/sub), Phase 3b 只解决 main loop 阻塞

### 2f. MOCK_PLC 路径兼容
- reactor-wiring.ts MOCK 路径调 buildMockSnapshot 直接 tagCache.write, 不走 worker
- **对策**: MOCK_PLC=true 时不启动 worker (默认), 保持 mock 演示路径不变

### 2g. 单 worker 内多 reactor (vs 每 reactor 1 worker)
- 候选: per-reactor (推荐, 隔离故障) vs shared worker (省内存)
- **决策**: per-reactor (Q5), 故障隔离优先

---

## 3. Test Coverage Plan

- `polling-scheduler-worker.test.ts` (P3b.1) 6 新 (IPC 协议)
- `worker-lifecycle.test.ts` (P3b.2) 6 新 (spawn / backoff / fallback / terminate / Gauge / MOCK)

**总计 +12 new tests**

---

## 4. Rollback Strategy

### Per-commit `git revert` impact

| Commit | Revert 影响 |
|---|---|
| P3b.1 (scaffold) | 0 影响 (worker 模块仅新增, 无 caller) |
| P3b.2 (wire + snap7) | startup 回 main thread PollingScheduler (P3a.3 行为) |

### Hot-rollback env 开关
- `PLC_WORKER_DISABLED=true` → 强制 main thread (P3a 行为), 不启动 worker

---

## 5. Anti-Spec Items（out of scope）

- ❌ **多 reactor 共享单 worker** (per-reactor 决策)
- ❌ **SharedArrayBuffer 零拷贝 IPC** (snapshot 小不需要)
- ❌ **cluster / 多进程** (Phase 3c Redis 横向扩展)
- ❌ **worker pool / 复用** (per-reactor 1:1 简单可靠)
- ❌ **worker 内访问 sqlite** (worker 仅 PLC IO; DB 操作 main thread)
- ❌ **worker 内 broadcaster / flusher** (这些仍 main thread)

---

## 6. Open Questions（需用户决定的）

### (i) worker per reactor vs shared ⚠️ 用户决定
候选 A: per-reactor (推荐, 故障隔离); B: shared (省内存 ~270MB @ 10 reactor)
**推荐 A**: 10 reactor × 30MB 可接受.

### (ii) worker 重启 backoff 上限 ⚠️ 用户决定
候选 A: 3 次 (1/2/4s) 降级 mock; B: 无限; C: 5 次
**推荐 A**: 3 次覆盖瞬时网络抖动.

### (iii) IPC 协议 ⚠️ 用户决定
候选 A: postMessage JSON; B: MessageChannel + Transferable; C: SharedArrayBuffer
**推荐 A**: snapshot 小, JSON 序列化 < 0.1ms.

### (iv) 失败降级行为 ⚠️ 用户决定
候选 A: 降级 mock (tagCache 不写新, 老数据可读); B: server crash; C: 隔离故障 reactor
**推荐 A 或 C**: per-reactor 设计天然达成 C.

---

## 7. Migration / Dependencies

### Schema migration
**0 migration**.

### npm dependencies
**0 new** (worker_threads 内置).

### Env vars (新增)
- `PLC_WORKER_DISABLED` (默认空, 设 'true' 回退 main thread)

---

## 8. Verification Checklist

### 通用
- [ ] server build 0 TS 错误
- [ ] plc-driver build 0 TS 错误
- [ ] 全新 ~12 tests 全过
- [ ] Phase 1+2+3a 全测试不退化

### Commit P3b.1
- [ ] 6 worker IPC test 全过
- [ ] worker spawn + init + stop 完整生命周期

### Commit P3b.2
- [ ] 6 worker-lifecycle test 全过
- [ ] 真 snap7 在 worker 加载不 segfault (需真 PLC 或 mock binding)
- [ ] worker 3 次失败降级 mock
- [ ] plcWorkerState gauge 反映状态

---

## 9. Future Phase 3c Outlook (informational)

Phase 3c (横向扩展, 9-13h):
- Redis pub/sub (TagCache 多 server 共享)
- subscription state Redis 共享
- reliable message queue (复用 ai_suggestions 模式)
- 客户端 ack 机制
- Flatbuffers zero-copy 协议

---

## End of Plan
