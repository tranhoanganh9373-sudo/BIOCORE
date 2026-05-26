-- SP-PLC-3 P3c.3 (2026-05-26): reliable queue for critical WS channels
--
-- 复用 ai_suggestions dispatch_status state machine 模式 (claim/markDelivered/
-- markFailed/incrementRetry/rollbackInProgress), 仅 critical channel
-- (alarm / state_update / recipe_downloaded) 走本表, pv_realtime 仍 best-effort
-- (5Hz 全 queue 会爆 sqlite, plan §1 Commit 3 决策 + Open Q (ii) 推荐 A).
--
-- 字段:
--   id           - PK, dispatcher 引用
--   client_id    - 目标 ws client (P3c.2 connection 期注入的 UUID)
--   channel      - critical channel 名 ('alarm' | 'state_update' | 'recipe_downloaded')
--   payload      - JSON.stringify 后存; dispatcher tick 反序列化再 ws.send
--   status       - pending | dispatching | delivered | failed
--   retry_count  - 重试计数, >= maxRetries (默认 3) → markFailed
--   last_error   - 最近一次错误描述 (e.g. 'client offline' / ws.send 异常)
--   created_at   - 入队时间
--   delivered_at - 送达时间 (P3c.3 简化: send 成功立即写入; P3c.4 改为 ack 触发)
--
-- 索引:
--   idx_ws_queue_status (status, created_at) — dispatcher claimPending ORDER BY created_at
--   idx_ws_queue_client (client_id, status)  — 调试 / metrics 按 client 维度查
--
-- 注: sqlite migrator 已对 "duplicate column / table exists" 错误幂等处理,
-- 重跑安全 (CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS ws_message_queue (
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

CREATE INDEX IF NOT EXISTS idx_ws_queue_status ON ws_message_queue(status, created_at);
CREATE INDEX IF NOT EXISTS idx_ws_queue_client ON ws_message_queue(client_id, status);
