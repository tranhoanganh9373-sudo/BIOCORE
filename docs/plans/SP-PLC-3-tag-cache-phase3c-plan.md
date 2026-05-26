# SP-PLC-3 Tag Cache & OPC-style Subscription — Phase 3c (横向扩展)

**Status:** Shipped 2026-05-26 (P3c.1=`4952067`, P3c.2=`902836b`, P3c.3=`b206a87`, P3c.4=`d062d2a`, P3c.5=pending). Phase 3c 完成。
**Target version:** v1.19.0
**Estimated:** ~1200 LOC, 5 commits, +37 tests, 9–13h single-engineer
**Scope tier:** Phase 3c (Redis + reliable queue + ack). Depends on Phase 3b (TBD).

---

## Spec recap (locked)

| Q | 决策 |
|---|---|
| Q1 | **Redis pub/sub for TagCache 跨实例同步**: 多 server 实例共享 cache state. server A 写 cache → Redis publish → server B 订阅同 channel 写本地 cache (eventual consistency, 不强一致) |
| Q2 | **Redis client**: 选 `ioredis` (~3MB, 全特性, cluster/sentinel/transactions). 不选 `node-redis` (API 差异大), 不选 `@upstash/redis` (REST 模式不适合 pub/sub) |
| Q3 | **subscription state Redis 共享**: ws subStates 当前 WeakMap<ws, SubscriptionState> per-instance. Phase 3c 改 `Map<clientId, SubscriptionState>` + Redis hash 镜像 `subscriptions:{server_id}:{client_id}` |
| Q4 | **reliable message queue 替代 best-effort WS**: 复用 ai_suggestions 的 dispatch_status state machine 模式. 新 sqlite 表 `ws_message_queue`, 仅 critical channel (alarm/state_update/recipe_downloaded) 走 queue, pv_realtime 仍 best-effort WS |
| Q5 | **客户端 ack 机制**: server send msg 时附 `msg_id`, client onmessage 后 send `{type: 'ack', msg_id}`; server 收 ack 后 markDelivered; 未 ack 重试 (与 ai_suggestions 同 retry_count 模式) |
| Q6 | **Flatbuffers vs msgpack**: 主线保 msgpack (P3a.1 ship). Flatbuffers 零拷贝优势仅在 client 反序列化大 payload 时显著 (>10KB), 5Hz pv_realtime 23 字段 ~1KB 不需要. **Phase 3c 不引入 Flatbuffers**, 留 Phase 3d 评估 |
| Q7 | **Redis 部署模式**: 默认单 Redis 实例 (开发 + 单生产); cluster/sentinel 支持但不强制 (ioredis API 兼容) |
| Q8 | **server_id 来源**: 启动期生成 UUID 或读 env `SERVER_ID`; Redis channel 含 server_id 避免自回环 |
| Q9 | **降级路径**: Redis 连不上 → 全 server 实例独立工作 (subscription 不跨 server, queue 仍走本地 sqlite), console.error 报警. 单实例部署 = Phase 1+2+3a+3b 行为 (Redis opt-in) |
| Q10 | **跨 server 转发协议**: 复杂度高, **Phase 3c 不实现**, 用 sticky session (LB 层) 替代 (nginx ip_hash 配置). Phase 3d 评估完整 forward |

---

## Investigation Findings（架构师对代码的实地考察）

1. **Redis / ioredis 0 现有依赖** — 全新引入. Phase 3c 加 `ioredis` dep 给 server.

2. **scada-write-dispatcher reliable queue 模板已 ship** (`packages/data-service/src/sqlite-service.ts:418-465`): 完整 `claimPendingDispatches`/`markDispatched`/`markFailed`/`incrementRetry`/`rollbackInProgressDispatches`/`retryFailed`. P3c.3 ws_message_queue 直接复制此模式.

3. **TagCache.write** (P1 ship): 同步 + 同步 callback. Phase 3c 加 Redis publish 钩子, 不破现有 callback (异步 publish 用 ioredis pipeline batch, 不阻塞 write 返回).

4. **ws-server subStates WeakMap** (P2.3 ship): 当前 per-instance. Phase 3c 需要 cross-server 可见 → 改 `Map<clientId, SubscriptionState>` + Redis hash 镜像 (clientId 通过 ws connection handshake 注入).

5. **server module-scope state**:
   - `permissions/middlewares/permissions.ts:17 cache` — per-instance OK (TTL 短自动同步)
   - `pollingSchedulers Map / tagCache / subStates WeakMap` — Phase 3c 改造重点
   - `ai-report-routes / index.ts 各 let local` — 路由内 scope OK

6. **ioredis npm 包**: 3MB unpacked, 0 native binding (纯 JS); 支持 cluster/sentinel/pipeline/Lua script. 文档完善, TypeScript-first.

7. **Redis channel 命名约定** (推荐):
   - `tagcache:write` (cache 跨实例同步, payload = {reactorId, snap, source: server_id})
   - 所有 channel payload 加 server_id 避免自回环

8. **client_id 注入** (P3c 新增): ws connection 时 server 生成 client UUID, send back 给 client `{type: 'connection.id', clientId}`; client store clientId 给 ack message 用.

9. **跨 server 转发 (Q10)** 是大复杂度. 备选 sticky session 在 LB 配置层 (nginx ip_hash 或 cookie) 不需要 server 改动. **Phase 3c 先实现 Redis 共享 cache + subscription 跨实例查询, 不实现跨 server WS 转发**.

10. **ws_message_queue 表设计**: 新 migration 041 加表 (id PK, client_id, channel, payload TEXT JSON, status ENUM, retry_count INT, last_error TEXT, created_at, delivered_at). 复用 dispatch_status state machine.

---

## 1. Commit Sequence — 5 commits

### Commit 1: `feat(server): Redis client + TagCache 跨实例 pub/sub (SP-PLC-3 P3c.1)`

**Scope:** 引入 ioredis + TagCache 写入跨 Redis publish + 订阅同 channel 写本地 cache.

**Files:**
- `packages/server/package.json` — 加 `ioredis ^5.4.0`
- 新建 `packages/server/src/lib/redis-client.ts` (~80) — Redis 单例 + 健康检查
- `packages/server/src/engine/tag-cache.ts` — 加 `onWrite` 钩子 (~10)
- 新建 `packages/server/src/engine/redis-cache-sync.ts` (~120) — publish + subscribe 桥接
- `packages/server/src/index.ts` — startup 注入 redis-cache-sync (~25)
- 新建 `packages/server/src/engine/__tests__/redis-cache-sync.test.ts` (~120, 8 tests, mock redis)

**Redis 协议**: channel `tagcache:write`, payload `{ source: server_id, reactorId, snap }`; 自回环检测 `if (source === my_id) skip`.

**测试** (8): publish 触发 / subscribe 写本地 / 自回环 skip / 降级 / pipeline / REDIS_URL 空 / UUID / 健康检查

### Commit 2: `feat(server): subscription state Redis 镜像 + clientId (SP-PLC-3 P3c.2)`

**Scope:** ws subStates 从 WeakMap 改 Map<clientId, SubscriptionState> + Redis hash 镜像.

**Files:**
- `packages/server/src/ws-server.ts` — clientId 生成 + Redis hash 同步 (~60)
- `packages/web-ui/src/stores/realtime-store.ts` — 收 'connection.id' message 存 clientId (~15)
- 新建 `packages/server/src/engine/__tests__/subscription-redis.test.ts` (~100, 6 tests)

**ws-server 改动**:
```ts
const clientId = randomUUID();
ws.send(JSON.stringify({ type: 'connection.id', clientId }));
(ws as any).clientId = clientId;
// subscribe:
await redis.hset(`subscriptions:${SERVER_ID}:${clientId}`, reactorId, JSON.stringify(tags));
// close:
await redis.del(`subscriptions:${SERVER_ID}:${clientId}`);
```

**测试** (6): clientId 生成 / hset / hdel / close 整删 / Redis 降级 / 跨 server query

### Commit 3: `feat(data-service,server): ws_message_queue 表 + reliable queue (SP-PLC-3 P3c.3)`

**Scope:** 新 sqlite 表 + reliable queue 服务. critical channel 走 queue, pv_realtime 仍 best-effort.

**Files:**
- `packages/server/migrations/041-ws-message-queue.sql` (~20)
- `packages/data-service/src/sqlite-service.ts` — ws_message_queue CRUD (复用 dispatch_status 模式) (~100)
- 新建 `packages/server/src/engine/ws-message-queue.ts` (~150) — 入队 + 出队 dispatcher
- `packages/server/src/ws-server.ts` — critical channel 入队替代直发 (~20)
- 新建 `packages/server/src/engine/__tests__/ws-message-queue.test.ts` (~150, 10 tests)

**Migration 041**:
```sql
CREATE TABLE ws_message_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT
);
CREATE INDEX idx_ws_queue_status ON ws_message_queue(status, created_at);
CREATE INDEX idx_ws_queue_client ON ws_message_queue(client_id, status);
```

**Dispatcher**: 500ms tick (与 scada-write-dispatcher 同周期), claim 100 pending → ws.send → 等 ack/timeout 5s → markDelivered or incrementRetry.

**测试** (10): enqueue / tick 取 pending / ack markDelivered / 超时 retry / retry_count >= 3 markFailed / 断线不发 / 重连重发 / batch claim / 0 pending noop / 字段验证

### Commit 4: `feat(web-ui,server): 客户端 ack 机制 + msg_id (SP-PLC-3 P3c.4)`

**Scope:** server send critical msg 附 msg_id, client send back ack, server markDelivered.

**Files:**
- `packages/server/src/engine/ws-message-queue.ts` — 加 msg_id + ack 处理 (~30)
- `packages/server/src/ws-server.ts` — ack message handler (~20)
- `packages/web-ui/src/stores/realtime-store.ts` — critical channel auto send ack (~25)
- 新建 `packages/server/src/engine/__tests__/ws-ack.test.ts` (~120, 8 tests)

**协议**: `{ msg_id: uuid, channel: 'alarm', payload }` ↔ `{ type: 'ack', msg_id }`

**测试** (8): server 含 msg_id / client auto-ack critical / pv_realtime 不 ack / markDelivered spy / 重复 ack idempotent / 不存在 msg_id ignore / 超时重发 / max 3 markFailed

### Commit 5: `feat(server): Phase 3c E2E + metrics + 文档 (SP-PLC-3 P3c.5)`

**Scope:** 端到端验收 + 新 metrics + 部署文档.

**Files:**
- `packages/server/src/engine/cache-metrics.ts` — 加 4 新 metric (~20)
- 新建 `packages/server/src/engine/__tests__/phase3c-e2e.test.ts` (~150, 5 E2E)
- `docs/部署说明.md` — Redis 配置 + sticky session 说明 (~50)
- `docs/plans/SP-PLC-3-tag-cache-phase3c-plan.md` — status 改 Shipped
- `CHANGELOG.md` — Phase 3c entry (~20)

**新 metrics**:
- `biocore_redis_connected` Gauge
- `biocore_redis_publish_total{channel}` Counter
- `biocore_ws_queue_size{status}` Gauge
- `biocore_ws_ack_latency_seconds` Histogram

**E2E** (5):
- 2 server 实例 Redis 共享 cache (server A write → server B 看到)
- 跨 server subscription query
- 重启 server 恢复 ws_message_queue pending (rollbackInProgressDispatches 模式)
- Redis 断连降级
- alarm critical message ack 路径完整

---

### Total deltas

| Package | New files | Modified | New tests |
|---|---|---|---|
| `server/src/lib/` | redis-client.ts (~80) | — | — |
| `server/src/engine/` | redis-cache-sync.ts (~120), ws-message-queue.ts (~150) | tag-cache.ts (~10), cache-metrics.ts (~20) | — |
| `server/src/engine/__tests__/` | 5 new test files (~700 总) | — | 8+6+10+8+5 = 37 |
| `server/src/` | — | ws-server.ts (~100), index.ts (~25), package.json | — |
| `server/migrations/` | 041-ws-message-queue.sql (~20) | — | — |
| `data-service/src/` | — | sqlite-service.ts (~100) | — |
| `web-ui/src/` | — | stores/realtime-store.ts (~40) | — |
| `docs/` | — | 部署说明.md, plan status, CHANGELOG | — |

**总计**: ~1200 LOC, +1 npm dep (ioredis), +1 sqlite migration (041), +6 新 env vars, +37 tests.

---

## 2. Risk Areas

### 2a. Redis 单点故障
- Redis 挂 → 跨实例同步 + reliable queue 全失效
- **对策**: 单实例部署忽略 (Redis opt-in); 多实例用 sentinel/cluster

### 2b. eventual consistency 导致 cache stale
- server A 写 cache → publish → server B 收到延迟 ~10ms
- **对策**: PLC 数据本身 1Hz, 10ms 延迟可接受

### 2c. Redis pub/sub 不保证投递
- Redis pub/sub best-effort (subscriber 离线时消息丢)
- **对策**: TagCache 同步用 pub/sub 可接受 (下次 PLC tick 重发); reliable queue 走 sqlite 不走 pub/sub

### 2d. ack message 风暴
- 仅 critical channel (alarm/state/recipe) 走 ack, pv_realtime 不 ack
- **对策**: critical 频率低 (< 10/s/client), 不会瓶颈

### 2e. 跨 server 转发复杂度 (Q10)
- Phase 3c 不实现, 用 sticky session (LB 层) 替代
- **对策**: ops 配置 nginx ip_hash; 减少 server 复杂度

### 2f. ws_message_queue sqlite 写入瓶颈
- critical 实际频率低 (< 10/s), sqlite 单写线程足够
- **对策**: 若需更高吞吐 Phase 3d 换 Redis Streams

### 2g. client 断线重连后 ack 漏 + 重复推送
- ack 超时 → retry → 重连后又 send → 重复
- **对策**: client 端 msg_id 去重 (Set 记最近 100 个)

### 2h. server_id 多实例冲突
- 启动期 UUID 唯一; env 配置错可能冲突
- **对策**: env 配置时 Redis SET NX 检查, 冲突 fail-fast

---

## 3. Test Coverage Plan

- `redis-cache-sync.test.ts` (P3c.1) 8 新
- `subscription-redis.test.ts` (P3c.2) 6 新
- `ws-message-queue.test.ts` (P3c.3) 10 新
- `ws-ack.test.ts` (P3c.4) 8 新
- `phase3c-e2e.test.ts` (P3c.5) 5 新

**总计 +37 new tests** (全 mock redis, 不需真 Redis 实例)

---

## 4. Rollback Strategy

### Per-commit `git revert` impact

| Commit | Revert 影响 |
|---|---|
| P3c.1 (Redis cache sync) | cache 不跨实例; 单实例 fall back |
| P3c.2 (subscription Redis) | subscription 退回 per-instance WeakMap |
| P3c.3 (ws_message_queue) | critical 退回 best-effort (Phase 2 行为) |
| P3c.4 (ack 机制) | server 不知送达; queue 仅靠超时 |
| P3c.5 (E2E + metrics) | metrics 少 4 个 |

### Hot-rollback env 开关
- `REDIS_URL=` (空) → 全 Redis 路径关, 回 Phase 2 行为
- `WS_QUEUE_DISABLED=true` → critical 走 best-effort
- `WS_ACK_DISABLED=true` → 不发 ack

---

## 5. Anti-Spec Items（out of scope）

- ❌ **Flatbuffers zero-copy 协议** — Phase 3d
- ❌ **跨 server WS 转发** (Q10) — sticky session 替代
- ❌ **Redis cluster 自动 failover 配置** — ioredis 内置, ops 配置
- ❌ **ws_message_queue cleanup 任务** — Phase 3d
- ❌ **client 消息去重 (msg_id Set)** — 客户端实现
- ❌ **Histogram percentile (p99)** — prom-client 引入留 Phase 3d
- ❌ **Pub/Sub 替换 Kafka/Redis Streams** — Phase 3d

---

## 6. Open Questions（需用户决定的）

### (i) Redis 部署模式 ⚠️ 用户决定
A: 单实例 (推荐); B: sentinel; C: cluster
**推荐 A**: 起步够用, ioredis 自动兼容 B/C 后续升级.

### (ii) reliable queue 范围 ⚠️ 用户决定
A: 仅 critical channel (推荐); B: 全 channel; C: 自定义白名单
**推荐 A**: pv_realtime 5Hz 全 queue 会爆 sqlite.

### (iii) 跨 server 转发 (Q10) ⚠️ 用户决定
A: 不实现, sticky session (推荐); B: Redis pub/sub forward
**推荐 A**: 减少 server 复杂度.

### (iv) ack 超时时长 ⚠️ 用户决定
A: 5s (推荐); B: 10s; C: 30s
**推荐 A**: client RTT < 100ms, 5s 覆盖偶发慢网.

### (v) Flatbuffers 引入 ⚠️ 用户决定
A: 不引入 (推荐); B: 引入
**推荐 A**: msgpack payload < 10KB 不需要零拷贝.

---

## 7. Migration / Dependencies

### Schema migration
- **041-ws-message-queue.sql**: 新表 + 2 index

### npm dependencies
- `ioredis ^5.4.0` (~3MB, 0 native)

### Env vars (新增 6 个)
- `REDIS_URL` (默认空 = 单实例模式)
- `SERVER_ID` (默认启动期 UUID)
- `WS_QUEUE_DISABLED` (默认空)
- `WS_ACK_DISABLED` (默认空)
- `WS_ACK_TIMEOUT_MS` (默认 5000)
- `WS_QUEUE_RETRY_MAX` (默认 3)

---

## 8. Verification Checklist

### 通用
- [ ] server build 0 TS 错误
- [ ] 全新 ~37 tests 全过 (mock redis)
- [ ] Phase 1+2+3a+3b 全测试不退化

### Commit P3c.1
- [ ] 8 redis-cache-sync test 全过
- [ ] REDIS_URL 空时不启动 Redis (单实例兼容)

### Commit P3c.2
- [ ] 6 subscription-redis test 全过
- [ ] clientId 生成 + send back

### Commit P3c.3
- [ ] 10 ws-message-queue test 全过
- [ ] migration 041 应用 + idempotent
- [ ] critical channel 入队

### Commit P3c.4
- [ ] 8 ws-ack test 全过
- [ ] pv_realtime 不发 ack
- [ ] ack 超时 retry

### Commit P3c.5
- [ ] 5 E2E test 全过
- [ ] 4 新 metric 在 /metrics 输出
- [ ] 部署文档 + CHANGELOG

### 性能 baseline
- [ ] 2 server 实例 Redis 同步延迟 < 50ms
- [ ] 1000 pending message 吞吐 > 100/s
- [ ] Redis 断连降级 < 1s 检测

---

## 9. Future Phase 3d Outlook (informational)

Phase 3d (深度优化, ~5-8h):
- Flatbuffers zero-copy
- Kafka/Redis Streams 替代 pub/sub (持久化 + consumer group)
- prom-client 替代自写 MetricsRegistry (p99/p999)
- 跨 server WS forward (Q10 替代 sticky session)
- ws_message_queue cleanup 任务
- TagCache LRU + 内存上限保护

**OPC UA gateway** (独立 sprint, ~10-15h)

---

## End of Plan
