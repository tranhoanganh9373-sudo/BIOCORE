# Changelog

All notable changes since v1.14.0.

## Unreleased — feat/scada-data-model (2026-05-15)

158 commits. Adds full SCADA-style HMI with widget editor, write-intent loop, alarm system, and PLC dispatcher.

### SCADA (7 sub-projects)

**Sub-project 1 — Data model + REST API**
- `028-scada-schema.sql`: `scada_views` table (id, name, widgets JSON, bindings JSON, version)
- `scada-routes.ts`: 11 endpoints (list/get/create/update/delete/duplicate/publish + write-intent)
- Auth: `requireRole('admin'|'operator')` per route, audit log on every mutation
- 16/16 integration tests pass

**Sub-project 2 — useTag + useTagHistory hooks**
- Global `_tick` field on realtime-store (1Hz staleness signal)
- `useTag(reactorId, tag)`: subscribes to single tag, returns `{value, stale, lastUpdate}`
- `useTagHistory(reactorId, tag, windowMs)`: ring buffer + cutoff-based prune
- vitest + jsdom + @testing-library/react infra added to web-ui
- 6/6 hook tests pass

**Sub-project 3 — Widget library**
- 9 widgets: Lamp, Indicator, Pump, Valve, Tank, Trend, Button, Label, BoundWidget wrapper
- `registry.ts`: discriminated-union widget defs + render dispatch
- `transform.ts`: scaling + unit conversion (multiplier/offset)
- 11 widget tests pass

**Sub-project 4 — Widget view + write-intent**
- `WidgetView` reads `scada_views` + binds widgets to live tags via `useTag`
- `WriteIntentDialog`: operator-confirmed write-intent submission
- `ViewActionRouter`: routes button clicks → suggestion API (NEVER direct PLC)
- 3 component tests pass

**Sub-project 5 — Editor**
- `/scada/[viewId]/edit` page: drag-from-palette, property panel, bindings editor, save bar
- `useEditorState` with undo/redo (autosave + dirty tracking)
- Publish gates: name required, >=1 widget, all bindings resolved
- 10 editor tests pass

**Sub-project 6 — Suggestion review UI + WS toast**
- `/scada/suggestions` page: pending + failed lists
- `ScadaToast`: red dispatch_failed + yellow created variants (action allowlist)
- `SuggestionRow` dispatch_status badge: pending/dispatching/dispatched/failed
- Manual retry for failed dispatches (POST `/ai/suggestions/:id/retry-dispatch`)
- 15 new component tests

**Sub-project 7 — Engine PLC writer**
- `029-scada-dispatch.sql`: dispatch_status/retry_count/error/dispatched_at columns
- 6 SQLite dispatch methods (setDispatchPending, claimPendingDispatches, markDispatched,
  markDispatchFailed, incrementDispatchRetry, rollbackInProgressDispatches) + retryFailedDispatch
- `engine/plc-writer.ts`: PlcWriter interface + MockPlcWriter / S7PlcWriter (node-snap7) /
  ModbusPlcWriter skeleton; `createPlcWriter` factory with MOCK_PLC short-circuit
- `engine/scada-write-dispatcher.ts`: 500ms tick + retry state machine + audit
- `engine/recipe-plc-write.ts`: shared plcWrite for batch-controller recipe steps
- Live verified: suggestion #124 (accepted) -> dispatched in <1s via MockPlcWriter
- 14 new tests across data-service + server/engine

### Alarms

- `027-alarm-definitions.sql`: alarm_definitions table (user-configurable thresholds)
- `/alarm-configs` REST: POST/GET/PUT/DELETE + UNIQUE(code) validation (7 tests)
- `/alarms/history`: operational/cusum/all category split + severity/reactor/ack filters (6 tests)
- `/cusum/history`: cusum-only view (source=cusum_anomaly OR ai:* OR alarm_code=CUSUM_*)
- Web UI: `/settings/alarm-config` CRUD page, `/analysis/alarm-history`, `/analysis/cusum-history`

### HMI / FUXA

- FUXA migrated to monorepo native (`fuxa/` dir, docker-compose.fuxa.yml)
- HMI iframe edit-mode toggle (`/editor` vs `/lab`) + force-reload on toggle
- Replaced unreliable reachability probe with on-demand help overlay
- Friendly fallback when FUXA offline

### Refactors

- Recipe plcWrite extracted to `engine/recipe-plc-write.ts` (shared with SCADA dispatcher)
- M2.6 raw-materials feature removed (component, routes, migration, page)
- InterlockPanel inlined into ControlPanel + compact card layout
- Analysis page padding tightened (p-6 -> p-4)
- SPC nav icon TrendingUp -> BarChart3 (visual disambiguation)

### Security

- JWT_SECRET rotation post-public-push
- `.claude/settings.local.json` untracked + gitignored (contained admin JWTs)
- `.env.bak-*` gitignored
- audit-confirm uses apiFetch helper for consistent auth header injection
- MIT LICENSE added

### Tooling

- vitest + jsdom + @testing-library/react test infra (web-ui)
- gitignore: .bak files, nohup.out, package-lock.json, yarn.lock (repo uses pnpm)

### SP-PLC-3 Phase 1 — TagCache & OPC-style subscription (2026-05-25)

3000 点门槛性能升级. 0 schema migration, 0 new dependency. 详见 `docs/plans/SP-PLC-3-tag-cache-plan.md`.

- **TagCache 核心** (`91a6ee8`, P1): `engine/tag-cache.ts` in-mem `Map<reactorId, Map<tag, CacheEntry>>` + subscribe API + deadband + last-known-good 保留 (`quality='bad'` 不覆盖现存 good value). 15/15 tests.
- **PollingScheduler 接入** (`bb7eeb2`, P2): 修复 reactor-wiring 架构断层 (旧 mock 单点循环写死), 数据采集统一走 cache; `createReactorWiring` 接 `tagCache` + `pollingSchedulers?`, MOCK_PLC 路径行为不变 (`buildMockSnapshot` helper). 8/8 tests.
- **dirty-only WS + Influx 解耦** (`8f5007e`, P3): `engine/realtime-broadcaster.ts` 订阅 cache 变化, 5Hz dirty-only fan-out (静态期 0 推送); `engine/influx-flusher.ts` 独立 1Hz tick 跳过 `quality='bad'` 字段; back-pressure `client.bufferedAmount > 1MB` skip + console.warn. 8 + 6 + 1 = 15 tests.
- **CUSUM cache 读 + E2E 验收** (P4, hash pending): CUSUM 段 pvMap 从 `tagCache.readMany` 读, `quality='bad'` channel 直接 skip (不进 detector 不污染历史 — 旧 `catch→0` bug 修); reactor-wiring `rawPV`/`rpmRaw` orphan 删除 (本闭包内无其它消费者). 5/5 端到端 tests (cache → broadcaster + flusher + last-known-good + dirty-only + 多 reactor 隔离 + back-pressure).

总: +700 LOC, +43 new vitest tests, server 367/367 pass, engine 59/59 pass.

新 env vars (默认即旧行为, 不需配置): `INFLUX_FLUSH_MS=1000`, `BROADCAST_TICK_MS=200`, `WS_MAX_BUFFERED_AMOUNT=1048576`.

### SP-PLC-3 Phase 3c — 横向扩展 + reliable queue + ack (2026-05-26)

Redis-based 多 server 实例支持. 9-13h scope, 5 commit + ~37 tests. 详见 `docs/plans/SP-PLC-3-tag-cache-phase3c-plan.md`.

- **Redis client + TagCache 跨实例 pub/sub** (`4952067`, P3c.1): channel `tagcache:write`, 自回环防护, REDIS_URL 空 = Phase 2 兼容. ioredis ^5.4.0 引入. 8 tests.
- **subscription Redis hash + clientId 握手** (`902836b`, P3c.2): subStates WeakMap→Map<clientId>, Redis hash 镜像 `subscriptions:{server_id}:{client_id}` 跨 server 可查. 6 tests.
- **ws_message_queue reliable queue** (`b206a87`, P3c.3): sqlite migration 041 + 复用 ai_suggestions dispatch_status state machine. critical channel (alarm/state_update/recipe_downloaded) 走 queue, pv_realtime 仍 best-effort. 10 tests.
- **客户端 ack + msg_id** (`d062d2a`, P3c.4): server send 附 msg_id, client send back ack 触发 markDelivered, 5s 超时 retry. 9 tests.
- **E2E + 4 metrics + 部署文档** (P3c.5, hash pending): `biocore_redis_connected` Gauge, `biocore_redis_publish_total{channel}` Counter, `biocore_ws_queue_size{status}` Gauge, `biocore_ws_ack_latency_seconds` Histogram. 5 E2E + 部署说明 §13 + dispatcher 启动 wire-up.

总: +1 npm dep (ioredis ~3MB), +1 SQL migration (041), +6 env vars (REDIS_URL, SERVER_ID, WS_QUEUE_DISABLED, WS_ACK_DISABLED, WS_ACK_TIMEOUT_MS, WS_QUEUE_RETRY_MAX), +~40 tests. engine 138/138 pass, server vitest pass count +5 (455→460).
