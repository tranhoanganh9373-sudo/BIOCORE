# SP-PLC-2 PLC Tag 调试面板 — 实现计划

**Sprint**: SP-PLC-2
**Spec**: [2026-05-21-sp-plc-2-tag-debug-panel-design.md](../specs/2026-05-21-sp-plc-2-tag-debug-panel-design.md)
**日期**: 2026-05-21

---

## TDD 节律

每个 T 任务严格 RED → GREEN → 微 REFACTOR；commit 一次。

## T1 — plc-driver: write endpoint

**文件**: `packages/plc-driver/src/api-server.ts`, `packages/plc-driver/src/__tests__/plc-driver.test.ts`

**RED 测试** (`packages/plc-driver/src/__tests__/plc-driver.test.ts`)：
- `POST /api/plc/variables/:id/write` 缺 `confirmed` → 400 `"confirmation required"`
- variable id 不存在 → 404
- variable.direction === 'READ' → 400 `"read-only tag"`
- 非法地址（mock parseAddr throw）→ 400
- 成功路径 → 200 `{success:true, wrote, raw, address}`，且 mock `client.WriteArea` 被以正确 buf 调用一次

**GREEN 实现**：
- 新增 `varWriteMatch = path.match(/^\/api\/plc\/variables\/([^/]+)\/write$/)`
- 复用 `parseAddr` + 新写 `encode(eng, v)`（反 scale + Buffer write，按 data_type 分支）
- 复用 `s7Busy`（重命名 `readOnlyBusy` → `s7Busy`，统一互斥；旧名保留 alias 防 break）

**验证**：`pnpm -F plc-driver vitest run` +5 cases 绿（含 1 个 encode 单元测试）。

## T2 — server: /api/v1/plc-write proxy + audit

**文件**: `packages/server/src/index.ts`, `packages/server/src/__tests__/plc-write.test.ts`（新）

**RED**：
- 未登录 → 401
- 已登录但缺 confirmed → 400 透传 plc-driver 的错误
- 已登录 + confirmed=true + 成功 → 200，且 `audit_logs` 表插入 1 行（mock plc-driver fetch 成功）
- plc-driver 5xx → 500 + audit 仍记录 `outcome: 'failed'`

**GREEN**：
- 新增 `app.post('/api/v1/plc-write', requireAuth, async (req,res) => {...})`
- 取 `user_id` from `(req as any).user`，body `{variable_id, value, confirmed}`
- fetch `http://localhost:8080/api/plc/variables/${variable_id}/write` body `{value, confirmed}`
- 不论成败都 `sqlite.insertAuditLog({actor, action:'plc-write', target:variable_id, payload:JSON.stringify({value, outcome})})`

**验证**：`pnpm -F server vitest run` +4 绿。

## T3 — UI: useTagPolling hook

**文件**: `packages/web-ui/src/hooks/useTagPolling.ts`（新）, `packages/web-ui/src/hooks/__tests__/useTagPolling.test.ts`（新）

**RED**：
- `start()` 后每 `intervalMs` 调一次 `fetcher`（用 vi.useFakeTimers）
- `stop()` 后不再调
- `intervalMs < 250` 被 clamp 到 250
- unmount 自动清 timer

**GREEN**：~50 行 hook：`useEffect` + `setInterval` + ref-stable fetcher + samples 数组 capped 60。

**验证**：`pnpm -F web-ui vitest run hooks/__tests__/useTagPolling.test.ts` 4 绿。

## T4 — UI: Debug tab + 数值显示 + sparkline

**文件**: `packages/web-ui/src/app/settings/plc-config/page.tsx`, `packages/web-ui/src/app/settings/plc-config/__tests__/debug-tab.test.tsx`（新）

**RED**：
- 切到 "调试" tab，渲染 PLC 下拉 + Tag 下拉
- 选 tag 后，点 ▶ 调用 fetch 至少一次（fake timer + mock fetch）
- 显示 raw + eng + 时间戳；sparkline 60 点 polyline 元素

**GREEN**：~180 行：
- TabsList 加 `<TabsTrigger value="debug">调试</TabsTrigger>`
- TabsContent value="debug" → 拆 `<DebugTab>` 子组件（保持 page.tsx 不爆 800 行；放同文件用函数，超 800 行再抽）
- 复用 useTagPolling
- Sparkline 内联函数 ~25 行

**验证**：`pnpm -F web-ui vitest run` +2 绿。

## T5 — UI: 写入区 + audit.confirm 集成

**文件**: 同 T4 + page.test 文件

**RED**：
- 选 direction='READ' 的 tag → 写入 input 不渲染
- 选 direction='WRITE'/'READWRITE' → 渲染输入框 + "写入" 按钮
- 点 "写入" → 触发 `audit.confirm({...})`（mock confirm，断言 description 含 tag_name 和 value）
- confirm 通过 → fetch `/api/v1/plc-write` 带 `confirmed:true`

**GREEN**：~40 行 UI + 调用既有 `audit.confirm` API（既有用法见 page.tsx 374）。

**验证**：`pnpm -F web-ui vitest run` +3 绿。

## T6 — sw.js bump + verify all + commit

- `SW_VERSION = 'v74'` → `'v75'`
- `pnpm vitest run` 全 monorepo → 期望 web-ui 1276-1280 / plc-driver +5 / server +4 全绿
- Spec mark APPROVED ✓（已完成于本次写入）
- Commit 拆 4 笔：
  - `feat(plc): SP-PLC-2 T1 — plc-driver write endpoint + 5 tests`
  - `feat(plc): SP-PLC-2 T2 — server /api/v1/plc-write proxy + audit + 4 tests`
  - `feat(plc): SP-PLC-2 T3-T5 — Debug tab + useTagPolling + write UI + 9 tests`
  - `docs(sp-plc-2): spec + plan APPROVED`

## 不做（YAGNI）

- 多 tag 并行轮询（仅 single tag deep inspect，下个 sprint 再扩）
- 历史 trend 持久化（仅内存 60 点）
- 折线图缩放/平移交互
- 写入回滚（用 audit_log 留痕，不做 transactional undo）
- ACL（用既有 requireAuth 即可，单独 role check 留 SP-PLC-3）
