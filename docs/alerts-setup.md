# BIOCore 告警通知系统配置指南 (SP-FX-42)

## 1. 概述

BIOCore 告警通知系统支持以下触发场景向操作员推送通知：

- **threshold** — 数值越界（如温度 > 80°C）
- **audit_log** — 用户审计日志写入（如删除操作）
- **write_intent_reject** — 写意图被拒绝
- **system_error** — 系统错误日志

告警仅为通知，**永远不触发 PLC**。

---

## 2. 渠道配置

支持三种渠道类型：

### 2.1 Slack (Incoming Webhook)

1. 在 Slack 工作区创建 Incoming Webhook
2. 复制 Webhook URL
3. 在 BIOCore 管理界面 `/scada2/alerts` → Channels → 新建渠道

**config JSON**:
```json
{
  "url": "https://hooks.slack.com/services/XXX/YYY/ZZZ"
}
```

### 2.2 Email (SMTP Stub)

当前版本为 SMTP stub，仅在服务器日志中打印邮件内容。真实 SMTP 集成留 future sprint。

**config JSON**:
```json
{
  "recipients": ["ops@example.com", "admin@example.com"]
}
```

### 2.3 Webhook (Generic HTTP)

向任意 HTTP 端点推送 JSON 消息。

**config JSON**:
```json
{
  "url": "https://your-system.example.com/hooks/biocore-alert",
  "method": "POST"
}
```

请求 body 格式：
```json
{
  "message": "[BIOCore 告警] 规则名 | 触发: threshold | 上下文: {\"value\":92}",
  "timestamp": "2026-05-18T10:00:00.000Z"
}
```

---

## 3. condition_expr 表达式语法

`condition_expr` 是一个 JavaScript 表达式字符串，求值为 true/false。

支持操作符：`>`, `<`, `>=`, `<=`, `==`, `===`, `&&`, `||`, `!`

上下文变量由触发源注入：

| 触发类型 | 可用变量 |
|---------|---------|
| threshold | `value` (数值) |
| audit_log | `action` (字符串), `resource_type` (字符串) |
| write_intent_reject | `tag` (字符串), `value` (数值) |
| system_error | `message` (字符串) |

**示例**:

```
value > 80                     # 数值超过 80
value >= 95 && value <= 100    # 数值在 95-100 之间
action == 'DELETE'             # 审计日志中有删除操作
true                           # 无条件触发
```

---

## 4. 测试发送 SOP

1. 进入 `/scada2/alerts` → Channels tab
2. 选择已配置的渠道，点击"测试"按钮
3. 检查目标渠道（Slack 频道 / 邮件 / Webhook 日志）是否收到测试消息
4. 如未收到，检查服务器日志排查网络连通性

也可通过 API 测试：

```bash
curl -X POST http://localhost:3001/api/v1/alerts/test/<channelId> \
  -H "Authorization: Bearer <admin-token>"
```

---

## 5. Retry 机制

- 每次触发尝试最多 3 次
- 全部失败时：`alert_history.delivered=false, retry_count=3`
- 历史记录可在 `/scada2/alerts` → History tab 查看

---

## 6. API 参考

全部接口需 admin 权限（`Authorization: Bearer <token>`）。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/v1/alerts/rules | 列所有规则 |
| POST | /api/v1/alerts/rules | 新建规则 |
| PUT | /api/v1/alerts/rules/:id | 更新规则 |
| DELETE | /api/v1/alerts/rules/:id | 删除规则 |
| GET | /api/v1/alerts/channels | 列所有渠道 |
| POST | /api/v1/alerts/channels | 新建渠道 |
| PUT | /api/v1/alerts/channels/:id | 更新渠道 |
| DELETE | /api/v1/alerts/channels/:id | 删除渠道 |
| GET | /api/v1/alerts/history?limit=100 | 列历史 |
| POST | /api/v1/alerts/test/:channelId | 测试发送 |
