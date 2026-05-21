# SP-PLC-2 PLC Tag 调试面板 — 设计规范

**Sprint**: SP-PLC-2
**日期**: 2026-05-21
**状态**: APPROVED — 2026-05-21（写入走 Option A server 代理；轮询 min 250ms；server proxy 需登录 + audit user_id）

---

## 1. 背景

SP-PLC-1 落地了 PLC ↔ Unit 1:1 绑定。运维与现场工程师在调试新接入的 PLC、排查 tag 地址/缩放错误时，目前只能用变量列表里的 "测试" 按钮逐次点按、看一次值，不能：

- 持续轮询观察值的实时变化（trend / sparkline）
- 对 `direction=WRITE` 或 `READWRITE` 的 tag 做现场写入测试

本 sprint 在 PLC 配置页新增第 3 个 tab **"调试 (Debug)"**，支持单 tag 深度只读轮询 + 受控写入。

## 2. 约束

- **ZERO 新第三方 dep** — sparkline 用纯 SVG inline 渲染；轮询用 `setInterval`
- **写入严格 gated** — 后端要求 `confirmed===true` 才执行，UI 先弹二次确认
- **写入仅允许 `direction !== 'READ'` 的 tag** — UI 隐藏 + 后端校验
- **每次写入落 audit_logs** — actor / tag / 旧值 / 新值 / 时间
- **不破 animation-engine T8 安全 invariant** — animation 永不直写 PLC，本 sprint 只是给操作员手动调试入口
- **Baseline web-ui 1270 vitest 全绿；期望 +6~10**

## 3. 数据模型

无新表。复用：
- `plc_connections`（plc-driver 内存表）
- `plc_variables`（plc-driver 内存表）
- `audit_logs`（既有 sqlite 表）

## 4. API

### 4.1 新增：`POST /api/plc/variables/:id/write`（plc-driver）

**Request body**:
```json
{
  "value": 42.5,
  "confirmed": true
}
```

**Behavior**:
- `confirmed !== true` → 400 `{ "error": "confirmation required" }`
- 找不到 variable → 404
- `direction === 'READ'` → 400 `{ "error": "read-only tag" }`
- 地址校验失败 → 400
- 写入成功 → 200 `{ "success": true, "wrote": 42.5, "raw": 425, "address": "DB1.DBD8" }`
- 写入失败 → 500 `{ "success": false, "message": "..." }`

实现复用 `parseAddr` / `encode`（反向 scale）/ `client.WriteArea`。借鉴 heartbeat write 的 `readOnlyBusy` 互斥锁，新增 `writeBusy` 或合并为 `s7Busy` 通用锁，避免并发读写撞 client。

### 4.2 复用：`POST /api/plc/variables/:id/test`（只读）

UI 轮询时每 N 毫秒调用一次（N 来自 `poll_rate_ms`，min 250ms 防 abuse）。

### 4.3 server/index.ts 代理 + audit

考虑到 plc-driver 在 8080，web-ui 在 3000，本来 testVariable 已直连 plc-driver。为了让 audit 落到主 sqlite，write 走法：

**Option A**：UI → `POST /api/v1/plc-write` (server:3001) → server proxy → plc-driver:8080 + 落 audit_log。
**Option B**：UI → 直 plc-driver + 单独 `POST /api/v1/audit-log` 给 server。

**采用 Option A**：单次往返、auth/audit 集中、未来加 ACL 容易。

## 5. UI 设计

### 5.1 Tab 新增

`plc-config/page.tsx`:

```tsx
useState<'connections' | 'variables' | 'debug'>('connections')
```

第 3 个 TabsTrigger 文案 "调试"。

### 5.2 Debug Tab 布局

```
┌─────────────────────────────────────────────────┐
│ PLC: [F01-PLC ▾]   Tag: [Temp_T1 ▾]            │
├─────────────────────────────────────────────────┤
│ 地址: DB1.DBD8   类型: FLOAT32   方向: READWRITE │
│ 缩放: 0~32767 → 0~100 °C                        │
├─────────────────────────────────────────────────┤
│ 实时值                                           │
│   ┌────────────────────┐                        │
│   │      67.4 °C       │   raw=22094            │
│   │  ▁▂▃▅▆▇▇▆▅▃▂▁     │   24.3 ms ago          │
│   └────────────────────┘                        │
│  [▶ 开始轮询] [⏸ 停止]  间隔: [1000] ms         │
├─────────────────────────────────────────────────┤
│ 写入 (仅 WRITE/READWRITE 可见)                  │
│  新值: [____] °C   [写入] → 二次确认 dialog     │
└─────────────────────────────────────────────────┘
```

### 5.3 状态机

```
idle  →[选 tag]→  ready  →[▶]→  polling  →[⏸]→  ready
                                    ↓ fetch err
                                  error (红色提示，保持上次值)
```

### 5.4 Sparkline

纯 SVG `<polyline>`，points 来自最近 60 次采样的 `eng` 值，宽 240 / 高 40，无 axis，仅显示曲线。SP-PLC-2 不引 chart 库。

### 5.5 写入流程

1. 用户输入新值，点 "写入"
2. 触发 `useAuditConfirm`（既有 audit 中间件，参考 `audit.confirm` 用法 in line 374）；对话框文案 `"确认对 ${tag_name} (${plc_address}) 写入 ${value} ${eng_unit}?"`，需要用户输入工号/原因（保持既有 audit 流程）
3. 用户确认 → `fetch('/api/v1/plc-write', { body: {...confirmed:true} })`
4. server 写 audit_logs → 转发 plc-driver
5. 成功 toast；失败弹错误

## 6. 任务拆分（TDD）

| # | 内容 | 测试 |
|---|------|------|
| T1 | plc-driver: `POST /variables/:id/write` endpoint | plc-driver.test.ts +4 cases (no confirm / read-only / addr invalid / ok) |
| T2 | server: `POST /api/v1/plc-write` proxy + audit | server-side integration +3 cases |
| T3 | UI: `useTagPolling` hook (start/stop/interval) | hook test +3 cases |
| T4 | UI: Debug tab + select + 数值显示 + sparkline | page snapshot/dom test +2 cases |
| T5 | UI: 写入区 + confirm 集成 | dom test +2 cases (隐藏 for READ / 触发 confirm) |
| T6 | sw.js bump v74→v75；全 vitest 绿；本 spec mark APPROVED | — |

**预算**：~280 行 UI + ~80 行 plc-driver + ~60 行 server + ~150 行 tests，共 ~570 行。

## 7. 验证

- `pnpm -F web-ui vitest run` → 1276~1280/全绿
- `pnpm -F plc-driver vitest run` → +4 绿
- `pnpm -F server vitest run` → +3 绿
- 手动 E2E（本机 mock PLC）：开轮询 30 秒、改间隔、停、写入一次 + 看 audit_logs

## 8. 风险

| 风险 | 缓解 |
|------|------|
| 轮询打爆 PLC | UI min 250ms / 切 tab 自动停 / unmount 清 timer |
| 写错值 | 二次确认 + audit + 类型/范围校验 + UI 显示当前值供对照 |
| 并发读写撞 client | 复用 plc-driver `readOnlyBusy` 模式 → 合并为 `s7Busy` |
| testVariable 现已直连 plc-driver，write 走 server 不一致 | 接受不一致：read 高频走直连低延迟；write 低频走 server 落 audit |
