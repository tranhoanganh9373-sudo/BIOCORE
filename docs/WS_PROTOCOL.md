# BIOCore WebSocket 协议规范

> 为 MES 等外部系统对接 biocore 实时数据流提供的协议文档

## 1. 连接

```
ws://<biocore_host>:3001/ws?<credential>
wss://<biocore_host>:3001/ws?<credential>   (生产 TLS)
```

### 认证(2 选 1)

| 方式 | URL 参数 | 说明 |
|---|---|---|
| **JWT** | `?token=<JWT>` | 前端 UI 用,有效期 24h,需要先 POST `/api/v1/auth/login` 获取 |
| **API Key** | `?api_key=ak_xxx.xxxxx` | MES/外部系统用,长期有效,可在 `/settings/api-keys` 创建 |

```js
// JavaScript 客户端示例
const token = '<from /api/v1/auth/login>';
const ws = new WebSocket(`ws://localhost:3001/ws?token=${encodeURIComponent(token)}`);

// MES 用 API Key
const apiKey = 'ak_xxx.xxxxx';
const ws = new WebSocket(`ws://localhost:3001/ws?api_key=${encodeURIComponent(apiKey)}`);
```

> **安全提示**: `token` / `api_key` 出现在 URL 查询字符串中,可能被中间代理(Nginx/防火墙)的 access log 记录,也可能在浏览器 history / referrer 中泄露。
> - **生产环境强烈建议走 WSS** (TLS 加密链路) 屏蔽链路嗅探;
> - 未来版本计划改走 `Sec-WebSocket-Protocol` 子协议头方式传 credential (本期按 spec 仍用 query string 以兼容 wscat / 浏览器原生 `WebSocket()`);
> - API Key 应限定最小 scope, 定期轮换, 一旦泄露立即在 `/settings/api-keys` revoke。

### Close codes

| Code | 含义 | 客户端应做的事 |
|---|---|---|
| **1000** | 正常关闭 | 不重连 |
| **1008** | Unauthorized — 凭证缺失/无效/已撤销 | 检查 token 是否过期/被撤销,重新登录后再连 |
| **1011** | 服务端内部错误 | 退避 5-30 秒后重试 |
| **1006** | 连接异常关闭(网络断) | 立即重连 + 指数退避 |

## 2. 消息格式

服务端推送的所有消息统一为:

```json
{
  "channel": "<channel name>",
  "timestamp": "2026-04-08T10:23:45.678Z",
  "batch_id": "BATCH-001" | null,
  "reactor_id": "Reactor-1" | null,
  "payload": { ... }
}
```

客户端**不需要**向服务端发送任何消息;biocore 当前 WS 是单向广播(server → client)。

## 3. Channel 列表

> 当前所有 channel 都是**广播**,所有连接的客户端都会收到。后续版本会按 user/scopes 过滤。

| Channel | 触发时机 | payload 示例 |
|---|---|---|
| `pv_realtime` | 每秒 (collector 采样) | `{ "AI-0": 37.0, "AI-2": 7.0, "rpm": 150, ... }` |
| `state_update` | 反应器状态变化 | `{ "reactor_id": "Reactor-1", "state": "running", "phase_index": 0, "step_number": 2, ... }` |
| `step_progress` | Step 完成/Phase 启动等 | `{ "reactor_id": "Reactor-1", "event": "phase_started", ... }` |
| `recipe_downloaded` | 配方下载到反应器 | `{ "reactor_id": "Reactor-1", "recipe_id": "ECOLI_V1", "version": "1.0.0", "phases": [...] }` |
| `alarm` | 新报警触发 | `{ "id": 42, "severity": "warning", "message": "...", "batch_id": "..." }` |
| `heartbeat` | PLC 心跳 (1Hz) | `{ "pc": 1234, "alive": true }` |
| `cusum` | CUSUM 异常检测告警 | `[{ "channel": "temperature", "deviation": 2.3, "alarming": true }]` |
| `ai_suggestion` | AI 模块产生新建议 | `{ "id": "...", "suggestion_type": "feed_rate", "current_value": 5, "suggested_value": 7 }` |
| `soft_sensor` | 软测量推断结果 | `{ "biomass": 12.3, "substrate": 5.1, "product": 8.7 }` |
| `branch_evaluated` | DAG 配方分支判定 (`payload_version=2`) | `{ "reactor_id": "Reactor-1", "type": "branch_evaluated", "payload_version": 2, "batch_id": "...", "node_id": "...", "result": true }` |
| `loop_entered` | DAG 配方循环进入 (`payload_version=2`) | `{ "reactor_id": "Reactor-1", "type": "loop_entered", "payload_version": 2, "batch_id": "...", "node_id": "..." }` |
| `loop_iterated` | DAG 配方循环单次迭代 (`payload_version=2`) | `{ "reactor_id": "Reactor-1", "type": "loop_iterated", "payload_version": 2, "batch_id": "...", "node_id": "...", "iteration": 3 }` |
| `loop_exited` | DAG 配方循环退出 (`payload_version=2`) | `{ "reactor_id": "Reactor-1", "type": "loop_exited", "payload_version": 2, "batch_id": "...", "node_id": "...", "reason": "max_iterations \| condition_false" }` |
| `suggestion_new` | MQTT 上游写建议入库 | `{ "id": "...", "source": "...", "target_param": "...", "suggested_value": 7, "batch_id": "..." \| null }` |

> 说明: spec 草案曾列出 `calculated` channel,但当前 server 源码无 `broadcast('calculated', ...)` 调用,已从本表移除。OUR/kLa/mu 等软测算值通过 `soft_sensor` 推送。

## 4. 重连策略

推荐客户端实现:

```js
let retries = 0;
function connect() {
  const ws = new WebSocket(url);
  ws.onopen = () => { retries = 0; };
  ws.onclose = (e) => {
    if (e.code === 1008) {
      // 凭证无效,不要重连,跳转登录
      window.location.href = '/login';
      return;
    }
    if (e.code === 1000) return; // 正常关闭
    // 指数退避: 1s, 2s, 4s, 8s, 16s, 30s (上限)
    const delay = Math.min(30000, 1000 * Math.pow(2, retries++));
    setTimeout(connect, delay);
  };
}
```

## 5. 调试

```bash
# 安装 wscat
npm i -g wscat

# 1. 无凭证连接 (期望 close 1008)
wscat -c "ws://localhost:3001/ws"

# 2. 用 JWT 连接
TOKEN=$(curl -s -X POST http://localhost:3001/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | jq -r '.data.token')
wscat -c "ws://localhost:3001/ws?token=$TOKEN"

# 3. 用 API Key 连接
wscat -c "ws://localhost:3001/ws?api_key=ak_xxx.xxxxx"
```

## 6. 版本演进与兼容性

| 版本 | 时间 | 变化 |
|---|---|---|
| v1.0 | 2026-04 | 初始版本,广播模式,统一消息格式 |
| v2.0 (规划) | TBD | 支持订阅过滤(只接收指定 reactor_id 的频道) |
| v2.0 (规划) | TBD | 支持双向消息(client → server 命令) |

破坏性变更将提前 30 天在本文档和服务端启动日志中公告。
