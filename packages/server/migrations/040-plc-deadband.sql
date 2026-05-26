-- SP-PLC-3 P2.1 (2026-05-26): per-tag deadband (abs OR pct, 0 = 关闭)
--
-- 加 2 列到 plc_variable_mappings: deadband_abs / deadband_pct
-- - deadband_abs (REAL, 绝对值阈值): |Δ| > abs 触发 change, 0 = 关闭
-- - deadband_pct (REAL, 百分比阈值): |Δ|/|prev| * 100 > pct 触发 change, 0 = 关闭
-- - 同时配 = OR 关系 (任一触发)
-- - 现有 rows DEFAULT 0 → 关闭 deadband, fallback 全局 deadband (TagCache.write
--   opts.deadband) — 完全不破 Phase 1 行为
--
-- 注意: plc_variable_mappings 表也由 plc-driver/src/variable-mapping.ts IF NOT
-- EXISTS DDL 建表 (兼容老库), 本 migration 在新部署时 idempotent 加列.
-- sqlite 不支持 ALTER ADD COLUMN IF NOT EXISTS, 但 migrator.ts 已对
-- "duplicate column name" 错误做幂等处理 (catch + warn + 跳过), 重跑安全.

ALTER TABLE plc_variable_mappings ADD COLUMN deadband_abs REAL NOT NULL DEFAULT 0;
ALTER TABLE plc_variable_mappings ADD COLUMN deadband_pct REAL NOT NULL DEFAULT 0;
