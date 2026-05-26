// ============================================================
// SQLiteService — 业务数据库完整实现
// 基于 05_数据库Schema详设.md 的全部表定义
// ============================================================

import Database from 'better-sqlite3';

export class SQLiteService {
  private db: Database.Database;

  /**
   * Ownership semantics:
   * - string path: SQLiteService creates, owns, and configures the Database instance.
   * - Database instance: caller owns lifecycle; SQLiteService only enables foreign_keys = ON
   *   for CASCADE delete semantics to work consistently in tests and production.
   */
  constructor(dbOrPath: string | Database.Database = './data/biocore.db') {
    if (typeof dbOrPath === 'string') {
      this.db = new Database(dbOrPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('busy_timeout = 5000');      // 多连接等锁 5s 重试, 避免 SQLITE_BUSY
      this.db.pragma('synchronous = NORMAL');     // WAL 下推荐, 比 FULL 快且仍崩溃安全
      this.db.pragma('cache_size = -64000');      // 64MB 页缓存 (负值=KB)
      this.db.pragma('temp_store = MEMORY');      // 临时表/索引走内存
      this.db.pragma('mmap_size = 268435456');    // 256MB mmap, 读密集型加速
    } else {
      this.db = dbOrPath;
    }
    // Enable foreign keys for CASCADE semantics (applies to both paths)
    this.db.pragma('foreign_keys = ON');
    // 注: 不再调用 initSchema(). schema 创建/演化已由 packages/server/migrations/
    // 下的 .sql 文件管理, 由 packages/server/src/migrator.ts 在 server 启动时执行.
  }

  /** @deprecated schema 已迁移到 packages/server/migrations/, 此方法保留为空仅为向前兼容 */
  private initSchema(): void {
    // schema 由 packages/server/src/migrator.ts 在 server 启动时执行 migration 文件创建
    // 历史 SQL 内容: 见 packages/server/migrations/001-baseline-schema.sql
  }

  // ─── 批次 CRUD ──────────────────────────────────────────────

  createBatch(batch: {
    batch_id: string; recipe_id: string; recipe_version: string;
    reactor_id?: string; organism?: string; operator_id: string; total_phases: number;
  }): void {
    this.db.prepare(`
      INSERT INTO batches (batch_id, recipe_id, recipe_version, reactor_id, organism, operator_id, total_phases)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(batch.batch_id, batch.recipe_id, batch.recipe_version,
      batch.reactor_id || 'F01', batch.organism || null, batch.operator_id, batch.total_phases);
  }

  // 安全: 白名单限制可更新的列名，防止 SQL 注入
  private static BATCH_UPDATABLE = new Set([
    'current_state', 'current_phase_index', 'current_phase_id', 'current_phase_type',
    'current_step_number', 'total_phases', 'state_snapshot', 'hold_reason',
    'stop_trigger', 'outcome', 'summary_text', 'notes', 'started_at', 'ended_at',
  ]);

  updateBatch(batchId: string, updates: Record<string, any>): void {
    const keys = Object.keys(updates).filter(k => SQLiteService.BATCH_UPDATABLE.has(k));
    if (keys.length === 0) return;
    const sets = keys.map(k => `"${k}" = ?`).join(', ');
    this.db.prepare(`UPDATE batches SET ${sets} WHERE batch_id = ?`).run(...keys.map(k => updates[k]), batchId);
  }

  getBatch(batchId: string): any {
    return this.db.prepare('SELECT * FROM batches WHERE batch_id = ?').get(batchId);
  }

  listBatches(limit = 50, offset = 0, reactorId?: string): any[] {
    // M2.3: 可选 reactor_id 过滤 (供多反应器对比的批次下拉用)
    if (reactorId) {
      return this.db.prepare(
        'SELECT * FROM batches WHERE reactor_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
      ).all(reactorId, limit, offset);
    }
    return this.db.prepare('SELECT * FROM batches ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
  }

  // ─── 状态流转日志 ──────────────────────────────────────────

  writeStateTransition(entry: {
    batch_id: string; from_state: string; to_state: string;
    event: string; triggered_by: string; phase_id?: string;
    step_number?: number; context?: any;
  }): void {
    this.db.prepare(`
      INSERT INTO state_transitions (batch_id, from_state, to_state, event, triggered_by, phase_id, step_number, context)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entry.batch_id, entry.from_state, entry.to_state, entry.event,
      entry.triggered_by, entry.phase_id || null, entry.step_number ?? null,
      entry.context ? JSON.stringify(entry.context) : null);
  }

  getStateTransitions(batchId: string): any[] {
    return this.db.prepare('SELECT * FROM state_transitions WHERE batch_id = ? ORDER BY timestamp').all(batchId);
  }

  // ─── 审计日志 ──────────────────────────────────────────────

  writeAuditLog(log: {
    user_id: string; action: string; target_type: string;
    batch_id?: string; target_id?: string; old_value?: string;
    new_value?: string; reason?: string; ip_address?: string;
    trace_id?: string;
    // T15: target_kind disambiguates the semantics of target_id
    // (e.g. 'phase_index' vs 'node_id' vs 'recipe_id').
    target_kind?: 'phase_index' | 'node_id' | 'recipe_id' | 'batch_id' | 'user_id' | 'channel_id';
  }): void {
    this.db.prepare(`
      INSERT INTO audit_logs (batch_id, user_id, action, target_type, target_id, old_value, new_value, reason, ip_address, trace_id, target_kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(log.batch_id || null, log.user_id, log.action, log.target_type,
      log.target_id || null, log.old_value || null, log.new_value || null,
      log.reason || null, log.ip_address || null, log.trace_id || null,
      log.target_kind || null);
  }

  getAuditLogs(batchId?: string, limit = 100): any[] {
    if (batchId) {
      return this.db.prepare('SELECT * FROM audit_logs WHERE batch_id = ? ORDER BY timestamp DESC LIMIT ?').all(batchId, limit);
    }
    return this.db.prepare('SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT ?').all(limit);
  }

  // ─── 报警 ─────────────────────────────────────────────────

  createAlarm(alarm: {
    batch_id?: string; alarm_code: string; severity: string;
    source: string; message: string; channel?: string;
    pv_at_trigger?: number; sv_at_trigger?: number;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO alarms (batch_id, alarm_code, severity, source, message, channel, pv_at_trigger, sv_at_trigger)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(alarm.batch_id || null, alarm.alarm_code, alarm.severity,
      alarm.source, alarm.message, alarm.channel || null,
      alarm.pv_at_trigger ?? null, alarm.sv_at_trigger ?? null);
    return result.lastInsertRowid as number;
  }

  acknowledgeAlarm(id: number, userId: string): void {
    this.db.prepare(`UPDATE alarms SET acknowledged_at = datetime('now'), acknowledged_by = ? WHERE id = ?`).run(userId, id);
  }

  getUnacknowledgedAlarms(batchId?: string): any[] {
    if (batchId) {
      return this.db.prepare('SELECT * FROM alarms WHERE batch_id = ? AND acknowledged_at IS NULL ORDER BY triggered_at DESC').all(batchId);
    }
    return this.db.prepare('SELECT * FROM alarms WHERE acknowledged_at IS NULL ORDER BY triggered_at DESC').all();
  }

  private buildAlarmHistoryWhere(filter: {
    batch_id?: string; severity?: string; ack?: 'all' | 'ack' | 'unack';
    since?: string; until?: string; category?: 'all' | 'cusum' | 'operational';
  }): { whereSql: string; params: any[] } {
    const where: string[] = [];
    const params: any[] = [];
    if (filter.batch_id) { where.push('batch_id = ?'); params.push(filter.batch_id); }
    if (filter.severity) { where.push('severity = ?'); params.push(filter.severity); }
    if (filter.ack === 'ack') where.push('acknowledged_at IS NOT NULL');
    if (filter.ack === 'unack') where.push('acknowledged_at IS NULL');
    if (filter.since) { where.push('triggered_at >= ?'); params.push(filter.since); }
    if (filter.until) { where.push('triggered_at <= ?'); params.push(filter.until); }
    // CUSUM 分类: source='cusum_anomaly' OR source LIKE 'ai:%' OR alarm_code LIKE 'CUSUM_%'
    const cusumClause = "(source = 'cusum_anomaly' OR source LIKE 'ai:%' OR alarm_code LIKE 'CUSUM_%')";
    if (filter.category === 'cusum') where.push(cusumClause);
    else if (filter.category === 'operational') where.push(`NOT ${cusumClause}`);
    return { whereSql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
  }

  listAlarmHistory(filter: {
    batch_id?: string; reactor_id?: string; severity?: string; ack?: 'all' | 'ack' | 'unack';
    since?: string; until?: string; limit?: number; offset?: number;
    category?: 'all' | 'cusum' | 'operational';
  } = {}): any[] {
    const { whereSql, params } = this.buildAlarmHistoryWhere(filter);
    const limit = Math.min(filter.limit ?? 500, 2000);
    const offset = filter.offset ?? 0;
    // LEFT JOIN batches 取 reactor_id (alarms 自身无此列)
    const reactorFilter = filter.reactor_id ? (whereSql ? ' AND b.reactor_id = ?' : 'WHERE b.reactor_id = ?') : '';
    const allParams = filter.reactor_id ? [...params, filter.reactor_id] : params;
    return this.db.prepare(`
      SELECT a.*, b.reactor_id AS reactor_id
      FROM alarms a
      LEFT JOIN batches b ON b.batch_id = a.batch_id
      ${whereSql.replace(/\b(batch_id|severity|source|alarm_code|acknowledged_at|triggered_at)\b/g, 'a.$1')}${reactorFilter}
      ORDER BY a.triggered_at DESC LIMIT ? OFFSET ?
    `).all(...allParams, limit, offset);
  }

  // ─── 报警定义 (alarm_definitions) — 用户可配置 ───────────
  listAlarmDefinitions(filter: { owner?: string; severity?: string; enabled?: boolean } = {}): any[] {
    const where: string[] = [];
    const params: any[] = [];
    if (filter.owner !== undefined) {
      if (filter.owner === '' || filter.owner === null) { where.push('owner IS NULL'); }
      else { where.push('owner = ?'); params.push(filter.owner); }
    }
    if (filter.severity) { where.push('severity = ?'); params.push(filter.severity); }
    if (filter.enabled !== undefined) { where.push('enabled = ?'); params.push(filter.enabled ? 1 : 0); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    return this.db.prepare(`SELECT * FROM alarm_definitions ${whereSql} ORDER BY severity DESC, code ASC`).all(...params);
  }

  getAlarmDefinition(id: number): any | null {
    return this.db.prepare('SELECT * FROM alarm_definitions WHERE id = ?').get(id) || null;
  }

  createAlarmDefinition(d: {
    code: string; name: string; owner?: string | null; severity: string;
    message_template: string; channel?: string | null; enabled?: boolean;
    threshold_high?: number | null; threshold_low?: number | null; hysteresis?: number | null;
    ack_required?: boolean; category?: string | null; notes?: string | null;
  }): number {
    const r = this.db.prepare(`
      INSERT INTO alarm_definitions
        (code, name, owner, severity, message_template, channel, enabled, threshold_high, threshold_low, hysteresis, ack_required, category, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      d.code, d.name, d.owner ?? null, d.severity, d.message_template,
      d.channel ?? null, d.enabled === false ? 0 : 1,
      d.threshold_high ?? null, d.threshold_low ?? null, d.hysteresis ?? null,
      d.ack_required === false ? 0 : 1, d.category ?? null, d.notes ?? null,
    );
    return r.lastInsertRowid as number;
  }

  updateAlarmDefinition(id: number, patch: Partial<{
    code: string; name: string; owner: string | null; severity: string;
    message_template: string; channel: string | null; enabled: boolean;
    threshold_high: number | null; threshold_low: number | null; hysteresis: number | null;
    ack_required: boolean; category: string | null; notes: string | null;
  }>): boolean {
    const allowed: (keyof typeof patch)[] = [
      'code', 'name', 'owner', 'severity', 'message_template', 'channel',
      'enabled', 'threshold_high', 'threshold_low', 'hysteresis',
      'ack_required', 'category', 'notes',
    ];
    const sets: string[] = [];
    const vals: any[] = [];
    for (const k of allowed) {
      if (k in patch) {
        sets.push(`${k} = ?`);
        const v = (patch as any)[k];
        vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
      }
    }
    if (sets.length === 0) return false;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    const r = this.db.prepare(`UPDATE alarm_definitions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return r.changes > 0;
  }

  deleteAlarmDefinition(id: number): boolean {
    return this.db.prepare('DELETE FROM alarm_definitions WHERE id = ?').run(id).changes > 0;
  }

  countAlarmHistory(filter: {
    batch_id?: string; reactor_id?: string; severity?: string; ack?: 'all' | 'ack' | 'unack';
    since?: string; until?: string; category?: 'all' | 'cusum' | 'operational';
  } = {}): number {
    const { whereSql, params } = this.buildAlarmHistoryWhere(filter);
    const reactorFilter = filter.reactor_id ? (whereSql ? ' AND b.reactor_id = ?' : 'WHERE b.reactor_id = ?') : '';
    const allParams = filter.reactor_id ? [...params, filter.reactor_id] : params;
    const sql = `SELECT COUNT(*) AS n FROM alarms a LEFT JOIN batches b ON b.batch_id = a.batch_id ${whereSql.replace(/\b(batch_id|severity|source|alarm_code|acknowledged_at|triggered_at)\b/g, 'a.$1')}${reactorFilter}`;
    const row = this.db.prepare(sql).get(...allParams) as any;
    return row?.n ?? 0;
  }

  // ─── Phase/Step 日志 ──────────────────────────────────────

  writePhaseLog(log: {
    batch_id: string; phase_index: number; phase_id: string; phase_type: string;
    total_steps: number; entry_snapshot?: any;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO phase_logs (batch_id, phase_index, phase_id, phase_type, total_steps, entry_snapshot)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(log.batch_id, log.phase_index, log.phase_id, log.phase_type,
      log.total_steps, log.entry_snapshot ? JSON.stringify(log.entry_snapshot) : null);
    return result.lastInsertRowid as number;
  }

  completePhaseLog(id: number, result: string, completedSteps: number, exitSnapshot?: any): void {
    this.db.prepare(`
      UPDATE phase_logs SET ended_at = datetime('now'), elapsed_sec = (julianday(datetime('now')) - julianday(started_at)) * 86400,
      result = ?, completed_steps = ?, exit_snapshot = ? WHERE id = ?
    `).run(result, completedSteps, exitSnapshot ? JSON.stringify(exitSnapshot) : null, id);
  }

  writeStepLog(log: {
    batch_id: string; phase_index: number; phase_id: string; phase_type: string;
    step_number: number; step_name: string; elapsed_sec: number; result: string;
    condition_actual?: number; entry_snapshot?: any; exit_snapshot?: any;
  }): void {
    this.db.prepare(`
      INSERT INTO step_logs (batch_id, phase_index, phase_id, phase_type, step_number, step_name,
        started_at, ended_at, elapsed_sec, result, condition_actual, entry_snapshot, exit_snapshot)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-' || ? || ' seconds'), datetime('now'), ?, ?, ?, ?, ?)
    `).run(log.batch_id, log.phase_index, log.phase_id, log.phase_type,
      log.step_number, log.step_name, Math.round(log.elapsed_sec), log.elapsed_sec,
      log.result, log.condition_actual ?? null,
      log.entry_snapshot ? JSON.stringify(log.entry_snapshot) : null,
      log.exit_snapshot ? JSON.stringify(log.exit_snapshot) : null);
  }

  getPhaseLogs(batchId: string): any[] {
    return this.db.prepare('SELECT * FROM phase_logs WHERE batch_id = ? ORDER BY phase_index').all(batchId);
  }

  getStepLogs(batchId: string, phaseIndex?: number): any[] {
    if (phaseIndex !== undefined) {
      return this.db.prepare('SELECT * FROM step_logs WHERE batch_id = ? AND phase_index = ? ORDER BY step_number').all(batchId, phaseIndex);
    }
    return this.db.prepare('SELECT * FROM step_logs WHERE batch_id = ? ORDER BY phase_index, step_number').all(batchId);
  }

  // ─── 通讯事件 ─────────────────────────────────────────────

  writeCommEvent(event: {
    batch_id?: string; connection_id: string; event_type: string;
    reason?: string; pc_counter?: number; plc_counter?: number;
    downtime_s?: number; auto_held?: boolean;
  }): void {
    this.db.prepare(`
      INSERT INTO comm_events (batch_id, connection_id, event_type, reason, pc_counter, plc_counter, downtime_s, auto_held)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(event.batch_id || null, event.connection_id, event.event_type,
      event.reason || null, event.pc_counter ?? null, event.plc_counter ?? null,
      event.downtime_s ?? null, event.auto_held ? 1 : 0);
  }

  // ─── 离线取样 ─────────────────────────────────────────────

  addOfflineSample(sample: {
    batch_id: string; sample_time: string; sampled_by: string;
    od600?: number; dcw_g_L?: number; glucose_g_L?: number;
    acetate_g_L?: number; product_titer?: number; product_unit?: string;
    // M2.4 新增字段 (migration 004)
    lactate_g_L?: number; biomass_g_L?: number; cell_viability_pct?: number; ethanol_g_L?: number;
    extra_analytes?: any; notes?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO offline_samples (batch_id, sample_time, sampled_by, od600, dcw_g_L, glucose_g_L,
        acetate_g_L, product_titer, product_unit,
        lactate_g_L, biomass_g_L, cell_viability_pct, ethanol_g_L,
        extra_analytes, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sample.batch_id, sample.sample_time, sample.sampled_by,
      sample.od600 ?? null, sample.dcw_g_L ?? null, sample.glucose_g_L ?? null,
      sample.acetate_g_L ?? null, sample.product_titer ?? null, sample.product_unit || null,
      sample.lactate_g_L ?? null, sample.biomass_g_L ?? null,
      sample.cell_viability_pct ?? null, sample.ethanol_g_L ?? null,
      sample.extra_analytes ? JSON.stringify(sample.extra_analytes) : null,
      sample.notes || null);
  }

  getOfflineSamples(batchId: string): any[] {
    return this.db.prepare('SELECT * FROM offline_samples WHERE batch_id = ? ORDER BY sample_time').all(batchId);
  }

  // ─── AI建议缓冲区 ────────────────────────────────────────

  createSuggestion(s: {
    batch_id: string; suggestion_type: string; source_module: string;
    target_param: string; current_value?: number; suggested_value?: number;
    suggested_value_raw?: string | null;
    confidence?: number; reasoning?: string; expires_at?: string;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO ai_suggestions (batch_id, suggestion_type, source_module, target_param,
        current_value, suggested_value, suggested_value_raw, confidence, reasoning, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(s.batch_id, s.suggestion_type, s.source_module, s.target_param,
      s.current_value ?? null, s.suggested_value ?? null, s.suggested_value_raw ?? null,
      s.confidence ?? null, s.reasoning || null, s.expires_at || null);
    return result.lastInsertRowid as number;
  }

  acceptSuggestion(id: number, userId: string): void {
    this.db.prepare(`
      UPDATE ai_suggestions SET status = 'accepted', decided_by = ?, decided_at = datetime('now')
      WHERE id = ? AND status = 'pending'
    `).run(userId, id);
  }

  rejectSuggestion(id: number, userId: string): void {
    this.db.prepare(`
      UPDATE ai_suggestions SET status = 'rejected', decided_by = ?, decided_at = datetime('now')
      WHERE id = ? AND status = 'pending'
    `).run(userId, id);
  }

  expirePendingSuggestions(batchId: string): void {
    this.db.prepare(`
      UPDATE ai_suggestions SET status = 'expired', decided_at = datetime('now')
      WHERE batch_id = ? AND status = 'pending'
    `).run(batchId);
  }

  getPendingSuggestions(batchId?: string): any[] {
    if (batchId) {
      return this.db.prepare(
        "SELECT * FROM ai_suggestions WHERE batch_id = ? AND status = 'pending' ORDER BY created_at DESC"
      ).all(batchId);
    }
    return this.db.prepare(
      "SELECT * FROM ai_suggestions WHERE status = 'pending' ORDER BY created_at DESC"
    ).all();
  }

  setDispatchPending(id: number): void {
    this.db.prepare(`
      UPDATE ai_suggestions SET dispatch_status='pending_dispatch'
      WHERE id=? AND suggestion_type='widget_button' AND source_module='scada'
    `).run(id);
  }

  claimPendingDispatches(limit: number): any[] {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT * FROM ai_suggestions
        WHERE dispatch_status='pending_dispatch'
        ORDER BY id LIMIT ?
      `).all(limit) as any[];
      if (rows.length === 0) return [];
      const ids = rows.map((r: any) => r.id);
      const placeholders = ids.map(() => '?').join(',');
      this.db.prepare(`UPDATE ai_suggestions SET dispatch_status='dispatching' WHERE id IN (${placeholders})`).run(...ids);
      return rows;
    })();
  }

  markDispatched(id: number): void {
    this.db.prepare(`
      UPDATE ai_suggestions
      SET dispatch_status='dispatched', dispatched_at=datetime('now'), dispatch_error=NULL
      WHERE id=?
    `).run(id);
  }

  markDispatchFailed(id: number, err: string): void {
    this.db.prepare(`UPDATE ai_suggestions SET dispatch_status='failed', dispatch_error=? WHERE id=?`).run(err, id);
  }

  incrementDispatchRetry(id: number): void {
    this.db.prepare(`
      UPDATE ai_suggestions
      SET dispatch_status='pending_dispatch', dispatch_retry_count=dispatch_retry_count+1
      WHERE id=?
    `).run(id);
  }

  rollbackInProgressDispatches(): void {
    this.db.prepare(`UPDATE ai_suggestions SET dispatch_status='pending_dispatch' WHERE dispatch_status='dispatching'`).run();
  }

  retryFailedDispatch(id: number): boolean {
    const r = this.db.prepare(`
      UPDATE ai_suggestions
      SET dispatch_status='pending_dispatch', dispatch_retry_count=0, dispatch_error=NULL
      WHERE id=? AND dispatch_status='failed'
    `).run(id);
    return r.changes > 0;
  }

  // ─── SP-PLC-3 P3c.3: ws_message_queue (reliable queue for critical WS) ───
  //
  // 复用上方 ai_suggestions dispatch_status state machine 的 6-method 模板
  // (claimPending / markDelivered / markFailed / incrementRetry /
  // rollbackInProgress + enqueue 入口). dispatcher 见
  // packages/server/src/engine/ws-message-queue.ts.
  //
  // 不变量:
  //   - status ∈ {'pending','dispatching','delivered','failed'}
  //   - 入队 status='pending' retry_count=0; dispatcher claim 把 batch 改
  //     'dispatching' (transaction 内); send 成功 → 'delivered' + delivered_at;
  //     send 失败 → incrementRetry 回 'pending' (retry_count++); 达上限 →
  //     'failed' (terminal, 不再 claim).
  //   - server 启动期 rollbackInProgressWsMessages() 把崩溃前残留的
  //     'dispatching' 复位为 'pending' (与 scada-write-dispatcher 同模式).

  /** 入队一条 critical WS 消息. payload 自动 JSON.stringify. 返回新 row id. */
  enqueueWsMessage(entry: { client_id: string; channel: string; payload: any }): number {
    const result = this.db.prepare(`
      INSERT INTO ws_message_queue (client_id, channel, payload, status, retry_count)
      VALUES (?, ?, ?, 'pending', 0)
    `).run(entry.client_id, entry.channel, JSON.stringify(entry.payload));
    return Number(result.lastInsertRowid);
  }

  /**
   * 原子声明一批 pending 消息: 取 limit 行最早入队 row, 状态改 'dispatching'
   * 返回原始行 (含 payload 原 TEXT, caller JSON.parse). transaction 包住保证
   * 多 dispatcher 实例并发不会重复取走 (与 claimPendingDispatches 一致).
   */
  claimPendingWsMessages(limit: number): any[] {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT id, client_id, channel, payload, retry_count
        FROM ws_message_queue
        WHERE status='pending'
        ORDER BY created_at ASC, id ASC
        LIMIT ?
      `).all(limit) as any[];
      if (rows.length === 0) return [];
      const ids = rows.map((r: any) => r.id);
      const placeholders = ids.map(() => '?').join(',');
      this.db.prepare(`UPDATE ws_message_queue SET status='dispatching' WHERE id IN (${placeholders})`).run(...ids);
      return rows;
    })();
  }

  /** 标记送达 + 写 delivered_at + 清 last_error (P3c.3 send 成功立即调; P3c.4 改 ack 触发). */
  markWsMessageDelivered(id: number): void {
    this.db.prepare(`
      UPDATE ws_message_queue
      SET status='delivered', delivered_at=datetime('now'), last_error=NULL
      WHERE id=?
    `).run(id);
  }

  /** 递增 retry_count 并复位 status='pending' 让下轮 tick 重取. 写入 last_error. */
  incrementWsMessageRetry(id: number, err: string): void {
    this.db.prepare(`
      UPDATE ws_message_queue
      SET status='pending', retry_count=retry_count+1, last_error=?
      WHERE id=?
    `).run(err, id);
  }

  /** 终态 failed (不再 claim). 写入 last_error. dispatcher 判 retry_count >= max 时调. */
  markWsMessageFailed(id: number, err: string): void {
    this.db.prepare(`UPDATE ws_message_queue SET status='failed', last_error=? WHERE id=?`).run(err, id);
  }

  /** server 启动期复位 'dispatching' → 'pending' (上次崩溃前未完成的批). */
  rollbackInProgressWsMessages(): void {
    this.db.prepare(`UPDATE ws_message_queue SET status='pending' WHERE status='dispatching'`).run();
  }

  getPendingSuggestionsBySource(batchId?: string, sourceModule?: string): any[] {
    const clauses: string[] = ["status = 'pending'"];
    const params: any[] = [];
    if (batchId) { clauses.push('batch_id = ?'); params.push(batchId); }
    if (sourceModule) { clauses.push('source_module = ?'); params.push(sourceModule); }
    const sql = `SELECT * FROM ai_suggestions WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT 100`;
    return this.db.prepare(sql).all(...params);
  }

  // ─── 配方 ─────────────────────────────────────────────────

  createRecipe(recipe: {
    recipe_id: string; version: string; name: string; author: string;
    target_organism?: string; vessel_config: any;
    phases?: any[];                 // 老 v1 线性 phases 数组
    dag?: any;                      // 新 v2 DAG 对象 (RecipeDAG)
    dag_schema_version?: number;    // 1 = 老线性, 2 = 新 DAG
    is_template?: number;           // 0 / 1 (M3.3)
    parent_template_id?: string;
    parent_version?: string;        // 自动设置 (M3.1)
    created_by: string;
  }): void {
    // 序列化策略:
    //   - dag_schema_version=2 + dag 字段 → 写 DAG JSON 到 phases 列, dag_schema_version=2
    //   - 否则 → 写老 phases 数组到 phases 列, dag_schema_version=1
    const schemaVer = recipe.dag_schema_version ?? (recipe.dag ? 2 : 1);
    const phasesJson = schemaVer === 2 && recipe.dag
      ? JSON.stringify(recipe.dag)
      : JSON.stringify(recipe.phases || []);

    // 自动算 parent_version: 当前已有最新版本的 version (M3.1)
    let parentVersion = recipe.parent_version;
    if (parentVersion === undefined) {
      const prev: any = this.db.prepare(
        'SELECT version FROM recipes WHERE recipe_id = ? ORDER BY created_at DESC LIMIT 1'
      ).get(recipe.recipe_id);
      if (prev) parentVersion = prev.version;
    }

    this.db.prepare(`
      INSERT INTO recipes
        (recipe_id, version, name, author, target_organism, vessel_config, phases, created_by,
         dag_schema_version, is_template, parent_template_id, parent_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      recipe.recipe_id, recipe.version, recipe.name, recipe.author,
      recipe.target_organism || null, JSON.stringify(recipe.vessel_config),
      phasesJson, recipe.created_by,
      schemaVer,
      recipe.is_template ?? 0,
      recipe.parent_template_id || null,
      parentVersion || null,
    );
  }

  approveRecipe(recipeId: string, version: string, approvedBy: string): void {
    // M3.2: 只能从 pending_approval 批准 (更严格)
    // 注意: 通过 UPDATE WHERE status IN (draft, pending_approval) 保持向后兼容
    this.db.prepare(`
      UPDATE recipes SET status = 'approved', approved_by = ?, approved_at = datetime('now'),
        rejection_reason = NULL
      WHERE recipe_id = ? AND version = ? AND status IN ('draft','pending_approval')
    `).run(approvedBy, recipeId, version);
  }

  // M3.2: 提交审核
  submitForReview(recipeId: string, version: string): void {
    this.db.prepare(`
      UPDATE recipes SET status = 'pending_approval', rejection_reason = NULL
      WHERE recipe_id = ? AND version = ? AND status = 'draft'
    `).run(recipeId, version);
  }

  // M3.2: 拒绝 (写 rejection_reason + 回到 draft)
  rejectRecipe(recipeId: string, version: string, reason: string): void {
    if (!reason || !reason.trim()) throw new Error('拒绝必须带原因');
    this.db.prepare(`
      UPDATE recipes SET status = 'draft', rejection_reason = ?
      WHERE recipe_id = ? AND version = ? AND status = 'pending_approval'
    `).run(reason, recipeId, version);
  }

  // M3.2: 审核队列 (全部 pending_approval 记录)
  listPendingApprovals(): any[] {
    return this.db.prepare(`
      SELECT recipe_id, version, name, author, created_at, created_by, parent_version, dag_schema_version
      FROM recipes
      WHERE status = 'pending_approval' AND is_template = 0
      ORDER BY created_at DESC
    `).all();
  }

  countPendingApprovals(): number {
    const row: any = this.db.prepare(
      "SELECT COUNT(*) AS cnt FROM recipes WHERE status = 'pending_approval' AND is_template = 0"
    ).get();
    return row?.cnt ?? 0;
  }

  // ── 配方废弃流程 ──

  // 提交废弃申请 (draft/approved → pending_deprecation)
  submitForDeprecation(recipeId: string, version: string): void {
    this.db.prepare(`
      UPDATE recipes SET status = 'pending_deprecation',
        pre_deprecation_status = status, rejection_reason = NULL
      WHERE recipe_id = ? AND version = ? AND status IN ('draft','approved')
    `).run(recipeId, version);
  }

  // 批准废弃 (pending_deprecation → deprecated)
  approveDeprecation(recipeId: string, version: string, approvedBy: string): void {
    this.db.prepare(`
      UPDATE recipes SET status = 'deprecated', approved_by = ?, approved_at = datetime('now'),
        pre_deprecation_status = NULL
      WHERE recipe_id = ? AND version = ? AND status = 'pending_deprecation'
    `).run(approvedBy, recipeId, version);
  }

  // 拒绝废弃 (回到 pre_deprecation_status)
  rejectDeprecation(recipeId: string, version: string, reason: string): void {
    if (!reason || !reason.trim()) throw new Error('拒绝必须带原因');
    this.db.prepare(`
      UPDATE recipes SET status = pre_deprecation_status,
        rejection_reason = ?, pre_deprecation_status = NULL
      WHERE recipe_id = ? AND version = ? AND status = 'pending_deprecation'
    `).run(reason, recipeId, version);
  }

  // 从废弃恢复到草稿
  restoreDeprecated(recipeId: string, version: string): void {
    this.db.prepare(`
      UPDATE recipes SET status = 'draft', rejection_reason = NULL
      WHERE recipe_id = ? AND version = ? AND status = 'deprecated'
    `).run(recipeId, version);
  }

  // 统一审核列表 (pending_approval + pending_deprecation)
  listPendingReview(): any[] {
    return this.db.prepare(`
      SELECT recipe_id, version, name, author, created_at, created_by,
             parent_version, dag_schema_version, status, pre_deprecation_status
      FROM recipes
      WHERE status IN ('pending_approval','pending_deprecation') AND is_template = 0
      ORDER BY created_at DESC
    `).all();
  }

  getRecipe(recipeId: string, version?: string): any {
    if (version) {
      return this.db.prepare('SELECT * FROM recipes WHERE recipe_id = ? AND version = ?').get(recipeId, version);
    }
    return this.db.prepare("SELECT * FROM recipes WHERE recipe_id = ? AND status = 'approved' ORDER BY version DESC LIMIT 1").get(recipeId);
  }

  listRecipes(status?: string, opts: { isTemplate?: boolean } = {}): any[] {
    // M3.3: 默认排除模板 (列表页只显示真正的配方)
    // 想拿模板要显式 isTemplate=true
    const where: string[] = [];
    const params: any[] = [];
    if (opts.isTemplate === true) {
      where.push('is_template = 1');
    } else if (opts.isTemplate === false) {
      where.push('is_template = 0');
    }
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    const sql = where.length > 0
      ? `SELECT * FROM recipes WHERE ${where.join(' AND ')} ORDER BY recipe_id, version DESC`
      : 'SELECT * FROM recipes ORDER BY recipe_id, version DESC';
    return this.db.prepare(sql).all(...params);
  }

  // M3.1: 列出某个 recipe_id 的所有版本(含 draft / approved / archived 全部)
  listRecipeVersions(recipeId: string): any[] {
    return this.db.prepare(
      `SELECT recipe_id, version, status, created_at, created_by, parent_version, dag_schema_version, name
       FROM recipes
       WHERE recipe_id = ?
       ORDER BY created_at DESC`
    ).all(recipeId);
  }

  // M3.1: 抓两个版本完整数据用于 diff
  getRecipeForDiff(recipeId: string, v1: string, v2: string): { v1: any; v2: any } | null {
    const r1: any = this.db.prepare('SELECT * FROM recipes WHERE recipe_id = ? AND version = ?').get(recipeId, v1);
    const r2: any = this.db.prepare('SELECT * FROM recipes WHERE recipe_id = ? AND version = ?').get(recipeId, v2);
    if (!r1 || !r2) return null;
    return { v1: r1, v2: r2 };
  }

  // M3.3: 把指定 recipe@version 复制为新的模板行
  // 新行: recipe_id 改为 TPL-{srcId}, version=1.0.0, is_template=1, status='approved' (模板始终可用)
  saveAsTemplate(srcRecipeId: string, srcVersion: string, createdBy: string): { template_id: string; version: string } {
    const src: any = this.db.prepare(
      'SELECT * FROM recipes WHERE recipe_id = ? AND version = ?'
    ).get(srcRecipeId, srcVersion);
    if (!src) throw new Error(`源配方不存在: ${srcRecipeId}@${srcVersion}`);

    // 模板 ID 加 TPL- 前缀, 同一源不允许重复模板, 用 timestamp 后缀避免冲突
    const templateId = `TPL-${srcRecipeId}-${Date.now()}`;
    const templateVersion = '1.0.0';

    this.db.prepare(`
      INSERT INTO recipes
        (recipe_id, version, name, author, target_organism, vessel_config, phases, metadata,
         status, created_by, dag_schema_version, is_template, parent_template_id, parent_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, 1, NULL, NULL)
    `).run(
      templateId, templateVersion,
      `${src.name}(模板)`,
      src.author, src.target_organism,
      src.vessel_config, src.phases, src.metadata,
      createdBy,
      src.dag_schema_version ?? 1,
    );
    return { template_id: templateId, version: templateVersion };
  }

  // M3.3: 从模板创建一个新的实例配方
  // newRecipeId 由调用方决定 (避免命名冲突), parent_template_id 指向源
  instantiateTemplate(templateId: string, templateVersion: string, newRecipeId: string, newName: string, createdBy: string): void {
    const tpl: any = this.db.prepare(
      'SELECT * FROM recipes WHERE recipe_id = ? AND version = ? AND is_template = 1'
    ).get(templateId, templateVersion);
    if (!tpl) throw new Error(`模板不存在: ${templateId}@${templateVersion}`);

    this.db.prepare(`
      INSERT INTO recipes
        (recipe_id, version, name, author, target_organism, vessel_config, phases, metadata,
         status, created_by, dag_schema_version, is_template, parent_template_id, parent_version)
      VALUES (?, '1.0.0', ?, ?, ?, ?, ?, ?, 'draft', ?, ?, 0, ?, NULL)
    `).run(
      newRecipeId, newName, createdBy, tpl.target_organism,
      tpl.vessel_config, tpl.phases, tpl.metadata,
      createdBy,
      tpl.dag_schema_version ?? 1,
      templateId,
    );
  }

  // ─── 校准 ─────────────────────────────────────────────────

  addCalibration(cal: {
    channel: string; sensor_type: string; calibrated_by: string;
    cal_point_low_raw?: number; cal_point_low_eng?: number;
    cal_point_high_raw?: number; cal_point_high_eng?: number;
    do_zero_offset?: number; do_slope?: number; do_barometric_mbar?: number;
    expires_at?: string; notes?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO calibrations (channel, sensor_type, calibrated_by,
        cal_point_low_raw, cal_point_low_eng, cal_point_high_raw, cal_point_high_eng,
        do_zero_offset, do_slope, do_barometric_mbar, expires_at, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(cal.channel, cal.sensor_type, cal.calibrated_by,
      cal.cal_point_low_raw ?? null, cal.cal_point_low_eng ?? null,
      cal.cal_point_high_raw ?? null, cal.cal_point_high_eng ?? null,
      cal.do_zero_offset ?? null, cal.do_slope ?? null, cal.do_barometric_mbar ?? null,
      cal.expires_at || null, cal.notes || null);
  }

  getLatestCalibration(channel: string): any {
    return this.db.prepare('SELECT * FROM calibrations WHERE channel = ? ORDER BY calibrated_at DESC LIMIT 1').get(channel);
  }

  // ─── 反应器/设备配置 ────────────────────────────────────────

  // M2.5: 设备类型枚举 (应用层校验, 因 SQLite ALTER 无法加 CHECK 约束)
  static readonly REACTOR_CATEGORIES: readonly string[] = ['fermenter', 'bioreactor', 'centrifuge', 'purification', 'mixer', 'other'];

  listReactorConfigs(): any[] {
    return this.db.prepare('SELECT * FROM reactor_configs ORDER BY sort_order, reactor_id').all();
  }

  getReactorConfig(reactorId: string): any {
    return this.db.prepare('SELECT * FROM reactor_configs WHERE reactor_id = ?').get(reactorId);
  }

  upsertReactorConfig(config: {
    reactor_id: string; name: string; description?: string;
    vessel_volume_L?: number; plc_connection_id?: string; plc_protocol?: string;
    plc_ip?: string; plc_port?: number; plc_rack?: number; plc_slot?: number;
    heartbeat_write?: string; heartbeat_read?: string;
    enabled?: number; sort_order?: number;
    category?: string;
  }): void {
    // M2.5: category 白名单校验 (非法值回退 fermenter)
    const category = config.category && SQLiteService.REACTOR_CATEGORIES.includes(config.category)
      ? config.category
      : 'fermenter';
    this.db.prepare(`INSERT OR REPLACE INTO reactor_configs
      (reactor_id, name, description, vessel_volume_L, plc_connection_id, plc_protocol,
       plc_ip, plc_port, plc_rack, plc_slot, heartbeat_write, heartbeat_read,
       enabled, sort_order, category, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      config.reactor_id, config.name, config.description || '',
      config.vessel_volume_L ?? 5, config.plc_connection_id || null,
      config.plc_protocol || 's7', config.plc_ip || '192.168.2.1',
      config.plc_port ?? 102, config.plc_rack ?? 0, config.plc_slot ?? 1,
      config.heartbeat_write || 'VB400', config.heartbeat_read || 'VB401',
      config.enabled ?? 1, config.sort_order ?? 0,
      category,
    );
  }

  deleteReactorConfig(reactorId: string): void {
    this.db.prepare('DELETE FROM reactor_configs WHERE reactor_id = ?').run(reactorId);
  }

  // ─── SP-RG-4: Phase Instance CRUD ────────────────────────
  // Middle layer between phase_templates (class) and reactor_configs (unit).
  // One class can be bound to one reactor many times via distinct instances.

  listPhaseInstances(opts?: { reactor_id?: string; phase_class?: string }): PhaseInstanceRow[] {
    const where: string[] = [];
    const binds: unknown[] = [];
    if (opts?.reactor_id)  { where.push('reactor_id = ?');  binds.push(opts.reactor_id); }
    if (opts?.phase_class) { where.push('phase_class = ?'); binds.push(opts.phase_class); }
    const sql = `SELECT * FROM phase_instances${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
    return this.db.prepare(sql).all(...binds) as PhaseInstanceRow[];
  }

  getPhaseInstance(instanceId: string): PhaseInstanceRow | undefined {
    return this.db.prepare('SELECT * FROM phase_instances WHERE instance_id = ?').get(instanceId) as PhaseInstanceRow | undefined;
  }

  createPhaseInstance(inst: {
    instance_id: string;
    phase_class: string;
    reactor_id: string;
    label?: string | null;
    params_override?: Record<string, unknown>;
    notes?: string;
    created_by?: string;
  }): void {
    this.db.prepare(`INSERT INTO phase_instances
      (instance_id, phase_class, reactor_id, label, params_override, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      inst.instance_id,
      inst.phase_class,
      inst.reactor_id,
      inst.label ?? null,
      JSON.stringify(inst.params_override ?? {}),
      inst.notes ?? '',
      inst.created_by ?? 'unknown',
    );
  }

  updatePhaseInstance(instanceId: string, patch: {
    phase_class?: string;
    reactor_id?: string;
    label?: string | null;
    params_override?: Record<string, unknown>;
    notes?: string;
  }): { ok: boolean } {
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (patch.phase_class !== undefined)     { sets.push('phase_class = ?');     binds.push(patch.phase_class); }
    if (patch.reactor_id !== undefined)      { sets.push('reactor_id = ?');      binds.push(patch.reactor_id); }
    if (patch.label !== undefined)           { sets.push('label = ?');           binds.push(patch.label); }
    if (patch.params_override !== undefined) { sets.push('params_override = ?'); binds.push(JSON.stringify(patch.params_override)); }
    if (patch.notes !== undefined)           { sets.push('notes = ?');           binds.push(patch.notes); }
    if (sets.length === 0) return { ok: true };
    binds.push(instanceId);
    const info = this.db.prepare(`UPDATE phase_instances SET ${sets.join(', ')} WHERE instance_id = ?`).run(...binds);
    return { ok: info.changes > 0 };
  }

  deletePhaseInstance(instanceId: string): { ok: boolean } {
    const info = this.db.prepare('DELETE FROM phase_instances WHERE instance_id = ?').run(instanceId);
    return { ok: info.changes > 0 };
  }

  // ─── SP-PLC-1: plc_reactor_bindings CRUD ─────────────────
  // 一个 unit 一个 PLC 的 1:1 绑定 (PK=plc_id),应用层警告不强约束。

  listPlcReactorBindings(): PlcReactorBindingRow[] {
    return this.db.prepare('SELECT * FROM plc_reactor_bindings').all() as PlcReactorBindingRow[];
  }

  getPlcReactorBinding(plcId: string): PlcReactorBindingRow | undefined {
    return this.db.prepare('SELECT * FROM plc_reactor_bindings WHERE plc_id = ?').get(plcId) as PlcReactorBindingRow | undefined;
  }

  /** 通过 reactor_id 反查绑定的 PLC ID 列表(可多个,UI 警告但不阻) */
  getPlcReactorBindingsByReactor(reactorId: string): PlcReactorBindingRow[] {
    return this.db.prepare('SELECT * FROM plc_reactor_bindings WHERE reactor_id = ?').all(reactorId) as PlcReactorBindingRow[];
  }

  /** Upsert: plc_id 存在则替换 reactor_id,不存在则插入 */
  upsertPlcReactorBinding(b: { plc_id: string; reactor_id: string; created_by?: string }): void {
    this.db.prepare(`INSERT INTO plc_reactor_bindings (plc_id, reactor_id, created_by)
      VALUES (?, ?, ?)
      ON CONFLICT(plc_id) DO UPDATE SET reactor_id = excluded.reactor_id
    `).run(b.plc_id, b.reactor_id, b.created_by ?? 'unknown');
  }

  deletePlcReactorBinding(plcId: string): { ok: boolean } {
    const info = this.db.prepare('DELETE FROM plc_reactor_bindings WHERE plc_id = ?').run(plcId);
    return { ok: info.changes > 0 };
  }

  // ─── DoE 研究 CRUD ───────────────────────────────────────

  createDoeStudy(study: {
    study_id: string;
    name: string;
    description?: string;
    base_recipe_id?: string;
    base_recipe_version?: string;
    design_type: string;
    factors: any[];
    responses: any[];
    created_by: string;
  }): void {
    this.db.prepare(`
      INSERT INTO doe_studies
        (study_id, name, description, base_recipe_id, base_recipe_version,
         design_type, factors, responses, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)
    `).run(
      study.study_id, study.name, study.description || null,
      study.base_recipe_id || null, study.base_recipe_version || null,
      study.design_type,
      JSON.stringify(study.factors),
      JSON.stringify(study.responses),
      study.created_by,
    );
  }

  listDoeStudies(): any[] {
    const rows = this.db.prepare(`
      SELECT s.*, COUNT(r.run_id) AS run_count,
        SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) AS completed_count
      FROM doe_studies s
      LEFT JOIN doe_runs r ON r.study_id = s.study_id
      GROUP BY s.study_id
      ORDER BY s.created_at DESC
    `).all();
    return rows.map((r: any) => ({
      ...r,
      factors: JSON.parse(r.factors || '[]'),
      responses: JSON.parse(r.responses || '[]'),
    }));
  }

  getDoeStudy(studyId: string): any {
    const row: any = this.db.prepare('SELECT * FROM doe_studies WHERE study_id = ?').get(studyId);
    if (!row) return null;
    return {
      ...row,
      factors: JSON.parse(row.factors || '[]'),
      responses: JSON.parse(row.responses || '[]'),
    };
  }

  updateDoeStudyStatus(studyId: string, status: string): void {
    this.db.prepare(
      "UPDATE doe_studies SET status = ?, updated_at = datetime('now') WHERE study_id = ?"
    ).run(status, studyId);
  }

  updateDoeStudy(studyId: string, patch: { name?: string; description?: string; factors?: any[]; responses?: any[]; design_type?: string; base_recipe_id?: string; base_recipe_version?: string }): void {
    const sets: string[] = [];
    const params: any[] = [];
    if (patch.name !== undefined)               { sets.push('name = ?');               params.push(patch.name); }
    if (patch.description !== undefined)        { sets.push('description = ?');        params.push(patch.description); }
    if (patch.design_type !== undefined)        { sets.push('design_type = ?');        params.push(patch.design_type); }
    if (patch.factors !== undefined)            { sets.push('factors = ?');            params.push(JSON.stringify(patch.factors)); }
    if (patch.responses !== undefined)          { sets.push('responses = ?');          params.push(JSON.stringify(patch.responses)); }
    if (patch.base_recipe_id !== undefined)     { sets.push('base_recipe_id = ?');     params.push(patch.base_recipe_id); }
    if (patch.base_recipe_version !== undefined){ sets.push('base_recipe_version = ?');params.push(patch.base_recipe_version); }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    params.push(studyId);
    this.db.prepare(`UPDATE doe_studies SET ${sets.join(', ')} WHERE study_id = ?`).run(...params);
  }

  deleteDoeStudy(studyId: string): void {
    // runs 级联删除 (ON DELETE CASCADE)
    this.db.prepare('DELETE FROM doe_studies WHERE study_id = ?').run(studyId);
  }

  // ─── DoE 运行 CRUD ───────────────────────────────────────

  replaceDoeRuns(studyId: string, rows: { run_index: number; factor_values: any }[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM doe_runs WHERE study_id = ?').run(studyId);
      const ins = this.db.prepare(`
        INSERT INTO doe_runs (run_id, study_id, run_index, factor_values, status)
        VALUES (?, ?, ?, ?, 'pending')
      `);
      for (const r of rows) {
        ins.run(
          `${studyId}-${r.run_index}`,
          studyId,
          r.run_index,
          JSON.stringify(r.factor_values),
        );
      }
    });
    tx();
    this.updateDoeStudyStatus(studyId, 'designed');
  }

  listDoeRuns(studyId: string): any[] {
    const rows = this.db.prepare(
      'SELECT * FROM doe_runs WHERE study_id = ? ORDER BY run_index ASC'
    ).all(studyId);
    return rows.map((r: any) => ({
      ...r,
      factor_values: JSON.parse(r.factor_values || '{}'),
      response_values: r.response_values ? JSON.parse(r.response_values) : null,
    }));
  }

  getDoeRun(studyId: string, runIndex: number): any {
    const row: any = this.db.prepare(
      'SELECT * FROM doe_runs WHERE study_id = ? AND run_index = ?'
    ).get(studyId, runIndex);
    if (!row) return null;
    return {
      ...row,
      factor_values: JSON.parse(row.factor_values || '{}'),
      response_values: row.response_values ? JSON.parse(row.response_values) : null,
    };
  }

  updateDoeRunRecipe(studyId: string, runIndex: number, recipeId: string, recipeVersion: string): void {
    this.db.prepare(`
      UPDATE doe_runs
      SET recipe_id = ?, recipe_version = ?, status = 'recipe_generated'
      WHERE study_id = ? AND run_index = ?
    `).run(recipeId, recipeVersion, studyId, runIndex);
  }

  bindDoeRunBatch(studyId: string, runIndex: number, batchId: string): void {
    this.db.prepare(`
      UPDATE doe_runs
      SET batch_id = ?, status = 'running', started_at = datetime('now')
      WHERE study_id = ? AND run_index = ?
    `).run(batchId, studyId, runIndex);
  }

  setDoeRunResponse(studyId: string, runIndex: number, responses: Record<string, number>, notes?: string): void {
    this.db.prepare(`
      UPDATE doe_runs
      SET response_values = ?, status = 'completed', completed_at = datetime('now'),
          notes = COALESCE(?, notes)
      WHERE study_id = ? AND run_index = ?
    `).run(JSON.stringify(responses), notes || null, studyId, runIndex);
  }

  // ─── SCADA 项目 ───────────────────────────────────────────
  listScadaProjects(): ScadaProjectMeta[] {
    return this.db.prepare(
      'SELECT project_id, name, description, created_by, created_at, updated_at FROM scada_projects ORDER BY updated_at DESC'
    ).all() as ScadaProjectMeta[];
  }

  getScadaProject(projectId: string): ScadaProjectMeta | null {
    const row = this.db.prepare(
      'SELECT project_id, name, description, created_by, created_at, updated_at FROM scada_projects WHERE project_id = ?'
    ).get(projectId) as ScadaProjectMeta | undefined;
    return row || null;
  }

  createScadaProject(p: { project_id: string; name: string; description?: string | null; created_by?: string | null }): void {
    this.db.prepare(
      'INSERT INTO scada_projects (project_id, name, description, created_by) VALUES (?, ?, ?, ?)'
    ).run(p.project_id, p.name, p.description ?? null, p.created_by ?? null);
  }

  updateScadaProject(projectId: string, patch: Partial<{ name: string; description: string | null }>): boolean {
    const sets: string[] = [];
    const vals: any[] = [];
    if (patch.name !== undefined) { sets.push('name = ?'); vals.push(patch.name); }
    if (patch.description !== undefined) { sets.push('description = ?'); vals.push(patch.description); }
    if (sets.length === 0) return false;
    sets.push("updated_at = datetime('now')");
    vals.push(projectId);
    const r = this.db.prepare(`UPDATE scada_projects SET ${sets.join(', ')} WHERE project_id = ?`).run(...vals);
    return r.changes > 0;
  }

  deleteScadaProject(projectId: string): { deleted_views: number } {
    const tx = this.db.transaction(() => {
      const viewCount = (this.db.prepare('SELECT COUNT(*) AS n FROM scada_views WHERE project_id = ?').get(projectId) as { n: number }).n;
      this.db.prepare('DELETE FROM scada_projects WHERE project_id = ?').run(projectId);
      return { deleted_views: viewCount };
    });
    return tx();
  }

  // ─── SCADA 视图 ───────────────────────────────────────────

  // sort 白名单: 防止 SQL 注入
  private static SCADA_VIEW_SORT_MAP: Record<string, string> = {
    name_asc: 'name ASC',
    name_desc: 'name DESC',
    mtime_asc: 'updated_at ASC',
    mtime_desc: 'updated_at DESC',
  };

  // SP-FX-FF.36: list endpoint 同时返回 items (parsed),供 cards-view 卡片
  // 渲染 widget bbox 缩略图 (无 svgcontent 时的回退预览)。
  listScadaViewsByProject(projectId: string): ScadaView[];
  listScadaViewsByProject(projectId: string, opts: { limit: number; offset: number; q?: string; sort?: string }): { views: ScadaView[]; total: number };
  listScadaViewsByProject(
    projectId: string,
    opts?: { limit: number; offset: number; q?: string; sort?: string },
  ): ScadaView[] | { views: ScadaView[]; total: number } {
    const BASE_SELECT = `SELECT view_id, project_id, name, reactor_id, display_order, width, height, background, is_svg, is_template, items_json, updated_at, owner_id, acl
       FROM scada_views`;

    const parseRow = (row: ScadaViewMeta & { items_json: string }): ScadaView => {
      const { items_json, ...meta } = row;
      let items: Record<string, unknown> = {};
      try { items = JSON.parse(items_json); } catch { items = {}; }
      return { ...meta, items };
    };

    if (!opts) {
      const sql = `${BASE_SELECT} WHERE project_id = ? ORDER BY display_order ASC, name ASC`;
      const rows = this.db.prepare(sql).all(projectId) as (ScadaViewMeta & { items_json: string })[];
      return rows.map(parseRow);
    }

    const { limit, offset, q, sort } = opts;
    const orderBy = SQLiteService.SCADA_VIEW_SORT_MAP[sort ?? ''] ?? 'display_order ASC, name ASC';
    const binds: unknown[] = [projectId];

    let where = 'WHERE project_id = ?';
    if (q && q.trim()) {
      where += ' AND name LIKE ?';
      binds.push(`%${q.trim()}%`);
    }

    const countSql = `SELECT COUNT(*) AS cnt FROM scada_views ${where}`;
    const total = (this.db.prepare(countSql).get(...binds) as { cnt: number }).cnt;

    const dataSql = `${BASE_SELECT} ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(dataSql).all(...binds, limit, offset) as (ScadaViewMeta & { items_json: string })[];
    return { views: rows.map(parseRow), total };
  }

  listScadaViewsByReactor(reactorId: string): ScadaViewMeta[] {
    return this.db.prepare(
      `SELECT view_id, project_id, name, reactor_id, display_order, width, height, background, is_svg, is_template, updated_at, owner_id, acl
       FROM scada_views WHERE reactor_id = ? OR reactor_id IS NULL ORDER BY display_order ASC, name ASC`
    ).all(reactorId) as ScadaViewMeta[];
  }

  getScadaView(viewId: string): ScadaView | null {
    const row = this.db.prepare(
      `SELECT view_id, project_id, name, reactor_id, display_order, width, height, background, is_svg, is_template, items_json, updated_at, owner_id, acl
       FROM scada_views WHERE view_id = ?`
    ).get(viewId) as (ScadaViewMeta & { items_json: string }) | undefined;
    if (!row) return null;
    const { items_json, ...meta } = row;
    let items: Record<string, any> = {};
    try { items = JSON.parse(items_json); } catch { items = {}; }
    return { ...meta, items };
  }

  createScadaView(v: {
    view_id: string; project_id: string; name: string;
    reactor_id?: string | null;
    width?: number; height?: number; background?: string;
    display_order?: number;
    items?: Record<string, any>;
    is_template?: number;
    owner_id?: string | null;
  }): void {
    this.db.prepare(
      `INSERT INTO scada_views (view_id, project_id, name, reactor_id, display_order, width, height, background, items_json, is_template, owner_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      v.view_id, v.project_id, v.name,
      v.reactor_id ?? null,
      v.display_order ?? 0,
      v.width ?? 1280,
      v.height ?? 720,
      v.background ?? '#ffffff',
      JSON.stringify(v.items ?? {}),
      v.is_template ?? 0,
      v.owner_id ?? null,
    );
  }

  updateScadaView(viewId: string, patch: {
    name?: string;
    reactor_id?: string | null;
    display_order?: number;
    width?: number; height?: number; background?: string;
    items?: Record<string, any>;
    is_template?: number;
    expected_updated_at?: string | null;
  }):
    | { ok: true; updated_at: string }
    | { ok: false; conflict: true; current_updated_at: string }
    | { ok: false; conflict: false; not_found: true }
  {
    const cur = this.db.prepare('SELECT updated_at FROM scada_views WHERE view_id = ?').get(viewId) as { updated_at: string } | undefined;
    if (!cur) return { ok: false, conflict: false, not_found: true };
    if (patch.expected_updated_at && patch.expected_updated_at !== cur.updated_at) {
      return { ok: false, conflict: true, current_updated_at: cur.updated_at };
    }
    const sets: string[] = [];
    const vals: any[] = [];
    if (patch.name !== undefined)          { sets.push('name = ?');           vals.push(patch.name); }
    if (patch.reactor_id !== undefined)    { sets.push('reactor_id = ?');     vals.push(patch.reactor_id); }
    if (patch.display_order !== undefined) { sets.push('display_order = ?');  vals.push(patch.display_order); }
    if (patch.width !== undefined)         { sets.push('width = ?');          vals.push(patch.width); }
    if (patch.height !== undefined)        { sets.push('height = ?');         vals.push(patch.height); }
    if (patch.background !== undefined)    { sets.push('background = ?');     vals.push(patch.background); }
    if (patch.items !== undefined)         { sets.push('items_json = ?');     vals.push(JSON.stringify(patch.items)); }
    if (patch.is_template !== undefined)   { sets.push('is_template = ?');    vals.push(patch.is_template); }
    sets.push("updated_at = datetime('now')");
    vals.push(viewId);
    this.db.prepare(`UPDATE scada_views SET ${sets.join(', ')} WHERE view_id = ?`).run(...vals);
    const after = this.db.prepare('SELECT updated_at FROM scada_views WHERE view_id = ?').get(viewId) as { updated_at: string };
    return { ok: true, updated_at: after.updated_at };
  }

  reorderScadaViews(projectId: string, orderedViewIds: string[]):
    | { ok: true; count: number }
    | { ok: false; code: 'project_not_found' | 'view_not_in_project' }
  {
    const project = this.db.prepare('SELECT 1 FROM scada_projects WHERE project_id = ?').get(projectId);
    if (!project) return { ok: false, code: 'project_not_found' };
    const checkStmt = this.db.prepare('SELECT 1 FROM scada_views WHERE view_id = ? AND project_id = ?');
    for (const id of orderedViewIds) {
      if (!checkStmt.get(id, projectId)) return { ok: false, code: 'view_not_in_project' };
    }
    const updateStmt = this.db.prepare(
      "UPDATE scada_views SET display_order = ?, updated_at = datetime('now') WHERE view_id = ? AND project_id = ?"
    );
    const tx = this.db.transaction((ids: string[]) => {
      for (let i = 0; i < ids.length; i++) {
        updateStmt.run(i, ids[i], projectId);
      }
    });
    tx(orderedViewIds);
    return { ok: true, count: orderedViewIds.length };
  }

  listScadaTemplates(projectId: string): ScadaViewMeta[] {
    return this.db.prepare(
      `SELECT view_id, project_id, name, reactor_id, display_order, width, height, background, is_svg, is_template, updated_at, owner_id, acl
       FROM scada_views WHERE project_id = ? AND is_template = 1
       ORDER BY display_order ASC, name ASC`
    ).all(projectId) as ScadaViewMeta[];
  }

  cloneScadaView(sourceViewId: string, newViewId: string, newName: string, projectId: string): void {
    const src = this.getScadaView(sourceViewId);
    if (!src) throw new Error('clone_source_not_found');
    this.createScadaView({
      view_id: newViewId,
      project_id: projectId,
      name: newName,
      reactor_id: src.reactor_id,
      width: src.width,
      height: src.height,
      background: src.background,
      items: src.items,
      is_template: 0,
    });
  }

  deleteScadaView(viewId: string): boolean {
    const r = this.db.prepare('DELETE FROM scada_views WHERE view_id = ?').run(viewId);
    return r.changes > 0;
  }

  // ─── scada_views ACL (SP-FX-24) ────────────────────────────

  updateScadaViewAcl(viewId: string, acl: ScadaViewAcl): void {
    this.db.prepare(
      `UPDATE scada_views SET acl = ? WHERE view_id = ?`,
    ).run(JSON.stringify(acl), viewId);
  }

  updateScadaViewOwner(viewId: string, newOwnerId: string): void {
    this.db.prepare(
      `UPDATE scada_views SET owner_id = ? WHERE view_id = ?`,
    ).run(newOwnerId, viewId);
  }

  // ─── 工具 ─────────────────────────────────────────────────

  getDatabase(): Database.Database { return this.db; }

  close(): void { this.db.close(); }

  // ─── fuxa_views (SP-FX-1) ──────────────────────────────────
  createFuxaView(v: {
    id: string;
    name: string;
    type?: string;
    payload: string;
    width: number;
    height: number;
    parent_view_id?: string | null;
    is_template?: number;
    created_by?: string | null;
  }): void {
    this.db.prepare(
      `INSERT INTO fuxa_views
        (id, name, type, payload, width, height, parent_view_id, is_template, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      v.id,
      v.name,
      v.type ?? 'svg',
      v.payload,
      v.width,
      v.height,
      v.parent_view_id ?? null,
      v.is_template ?? 0,
      v.created_by ?? null,
      v.created_by ?? null,
    );
  }

  getFuxaView(id: string): FuxaViewRow | null {
    return (
      this.db.prepare(`SELECT * FROM fuxa_views WHERE id = ?`).get(id) as
        | FuxaViewRow
        | undefined
    ) ?? null;
  }

  listFuxaViews(opts: { isTemplate?: boolean } = {}): FuxaViewRow[] {
    if (opts.isTemplate === true) {
      return this.db
        .prepare(`SELECT * FROM fuxa_views WHERE is_template = 1 ORDER BY updated_at DESC`)
        .all() as FuxaViewRow[];
    }
    if (opts.isTemplate === false) {
      return this.db
        .prepare(`SELECT * FROM fuxa_views WHERE is_template = 0 ORDER BY updated_at DESC`)
        .all() as FuxaViewRow[];
    }
    return this.db
      .prepare(`SELECT * FROM fuxa_views ORDER BY updated_at DESC`)
      .all() as FuxaViewRow[];
  }

  /**
   * Returns true if the row was updated; false on optimistic-lock conflict
   * (no rows matched the expected version). Pass `force=true` to bypass.
   */
  updateFuxaView(
    id: string,
    patch: {
      expectedVersion: number;
      name?: string;
      type?: string;
      payload?: string;
      width?: number;
      height?: number;
      parent_view_id?: string | null;
      is_template?: number;
      updated_by?: string | null;
      force?: boolean;
    },
  ): boolean {
    const sets: string[] = [];
    const args: any[] = [];
    if (patch.name !== undefined)            { sets.push(`name = ?`); args.push(patch.name); }
    if (patch.type !== undefined)            { sets.push(`type = ?`); args.push(patch.type); }
    if (patch.payload !== undefined)         { sets.push(`payload = ?`); args.push(patch.payload); }
    if (patch.width !== undefined)           { sets.push(`width = ?`); args.push(patch.width); }
    if (patch.height !== undefined)          { sets.push(`height = ?`); args.push(patch.height); }
    if (patch.parent_view_id !== undefined)  { sets.push(`parent_view_id = ?`); args.push(patch.parent_view_id); }
    if (patch.is_template !== undefined)     { sets.push(`is_template = ?`); args.push(patch.is_template); }
    if (patch.updated_by !== undefined)      { sets.push(`updated_by = ?`); args.push(patch.updated_by); }
    sets.push(`version = version + 1`);
    sets.push(`updated_at = datetime('now')`);
    const where = patch.force
      ? `WHERE id = ?`
      : `WHERE id = ? AND version = ?`;
    args.push(id);
    if (!patch.force) args.push(patch.expectedVersion);
    const stmt = this.db.prepare(`UPDATE fuxa_views SET ${sets.join(', ')} ${where}`);
    const info = stmt.run(...args);
    return info.changes > 0;
  }

  deleteFuxaView(id: string): void {
    this.db.prepare(`DELETE FROM fuxa_views WHERE id = ?`).run(id);
  }

  /**
   * Copies the row with new id and " Copy" suffixed name. version resets to 1.
   * parent_view_id is preserved.
   */
  duplicateFuxaView(
    sourceId: string,
    opts: { newId: string; userId?: string | null },
  ): string {
    const src = this.getFuxaView(sourceId);
    if (!src) throw new Error(`fuxa_view ${sourceId} not found`);
    this.createFuxaView({
      id: opts.newId,
      name: `${src.name} Copy`,
      type: src.type,
      payload: src.payload,
      width: src.width,
      height: src.height,
      parent_view_id: src.parent_view_id,
      is_template: src.is_template,
      created_by: opts.userId ?? null,
    });
    return opts.newId;
  }
}

// ─── Notification system (T35) ───────────────────────────────
// Module-level CRUD helpers for notification_channels / notification_rules
// (created by migration 022-notification-tables.sql).
// Keep these as standalone functions so @biocore/notifier and admin routes
// can import them without instantiating a full SQLiteService.

export interface NotificationChannel {
  id: string;
  type: 'feishu' | 'dingtalk' | 'telegram' | 'webhook';
  config: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
}

export interface NotificationRule {
  id: number;
  event_type: string;
  channel_id: string;
  enabled: boolean;
  min_severity: 'info' | 'warn' | 'critical';
}

export function listChannels(db: Database.Database): NotificationChannel[] {
  return (db.prepare('SELECT * FROM notification_channels ORDER BY created_at DESC').all() as Array<{
    id: string;
    type: string;
    config: string;
    enabled: number;
    created_at: string;
  }>).map(r => ({
    id: r.id,
    type: r.type as NotificationChannel['type'],
    config: JSON.parse(r.config),
    enabled: r.enabled === 1,
    created_at: r.created_at,
  }));
}

export function upsertChannel(db: Database.Database, ch: Omit<NotificationChannel, 'created_at'>): void {
  db.prepare(`
    INSERT INTO notification_channels(id, type, config, enabled) VALUES(?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type,
      config = excluded.config,
      enabled = excluded.enabled
  `).run(ch.id, ch.type, JSON.stringify(ch.config), ch.enabled ? 1 : 0);
}

export function deleteChannel(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM notification_channels WHERE id = ?').run(id);
}

export function listRules(db: Database.Database): NotificationRule[] {
  return (db.prepare('SELECT * FROM notification_rules ORDER BY id').all() as Array<{
    id: number;
    event_type: string;
    channel_id: string;
    enabled: number;
    min_severity: string;
  }>).map(r => ({
    id: r.id,
    event_type: r.event_type,
    channel_id: r.channel_id,
    enabled: r.enabled === 1,
    min_severity: r.min_severity as NotificationRule['min_severity'],
  }));
}

export function setRules(db: Database.Database, rules: Array<Omit<NotificationRule, 'id'>>): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM notification_rules').run();
    const stmt = db.prepare(`
      INSERT INTO notification_rules(event_type, channel_id, enabled, min_severity)
      VALUES(?, ?, ?, ?)
    `);
    for (const r of rules) {
      stmt.run(r.event_type, r.channel_id, r.enabled ? 1 : 0, r.min_severity);
    }
  });
  tx();
}

// ─── B1.1 DAG runtime — current_node_id persistence (T12) ────
// Persist/read the DAG node currently being executed so a crashed
// batch can be resumed via BatchController.resumeBatch().
// Column added by migration 023.

export function updateBatchCurrentNodeId(
  db: Database.Database,
  batchId: string,
  nodeId: string | null,
): void {
  db.prepare('UPDATE batches SET current_node_id = ? WHERE batch_id = ?').run(nodeId, batchId);
}

export function getBatchCurrentNodeId(
  db: Database.Database,
  batchId: string,
): string | null {
  const row = db
    .prepare('SELECT current_node_id FROM batches WHERE batch_id = ?')
    .get(batchId) as { current_node_id: string | null } | undefined;
  return row?.current_node_id ?? null;
}

// ─── B1.2 Loop frames persistence (migration 024) ─────────────
// JSON.stringify(LoopFrame[]) on write; getBatchLoopFrames parses with
// try/catch + shape validation and returns null on NULL/corrupt JSON
// (callers degrade gracefully to "no active loop").

export function updateBatchLoopFrames(
  db: Database.Database,
  batchId: string,
  framesJson: string | null,
): void {
  db.prepare('UPDATE batches SET current_loop_frames = ? WHERE batch_id = ?').run(framesJson, batchId);
}

/**
 * Persisted shape of a LoopFrame as written by `updateBatchLoopFrames`.
 * Mirrors batch-engine's LoopFrame interface — kept here so data-service
 * does not need to import @biocore/batch-engine (one-way dep direction).
 */
export interface PersistedLoopFrame {
  loopNodeId: string;
  iteration: number;
  exitExpression?: string;
  maxIterations?: number;
  startedAt?: number;
  maxDurationMs?: number;
}

export function getBatchLoopFrames(
  db: Database.Database,
  batchId: string,
): PersistedLoopFrame[] | null {
  const row = db
    .prepare('SELECT current_loop_frames FROM batches WHERE batch_id = ?')
    .get(batchId) as { current_loop_frames: string | null } | undefined;
  if (!row?.current_loop_frames) return null;
  try {
    const parsed = JSON.parse(row.current_loop_frames);
    if (!Array.isArray(parsed)) return null;
    // 形状校验: 每帧至少需含 loopNodeId(string) + iteration(number)
    for (const f of parsed) {
      if (!f || typeof f.loopNodeId !== 'string' || typeof f.iteration !== 'number') {
        return null;
      }
    }
    return parsed as PersistedLoopFrame[];
  } catch {
    return null; // corrupt JSON: degraded but safe (resume with empty stack)
  }
}

// v1.7.2 — boot-time crash recovery helpers
//
// When the server (re)starts and SQLite has rows with current_state ∈
// {running, held, paused}, those represent batches whose engines died with
// the previous process. We do NOT auto-resume — that would silently restart
// fermentations after an unattended outage, which is unsafe (PVs could have
// drifted, alarms may have been missed). Instead, surface them to the
// operator by marking each as 'held' with a recovery reason, so they appear
// in the UI's hold queue for explicit resume/abort decisions.

export interface OrphanBatchRow {
  batch_id: string;
  recipe_id: string;
  recipe_version: string;
  reactor_id: string;
  current_state: string;
  current_node_id: string | null;
  current_phase_index: number | null;
  /** B1.2: JSON-encoded LoopFrame[] or null when no active loop. */
  current_loop_frames: string | null;
}

export function getOrphanBatches(db: Database.Database): OrphanBatchRow[] {
  return db.prepare(`
    SELECT batch_id, recipe_id, recipe_version, reactor_id,
           current_state, current_node_id, current_phase_index, current_loop_frames
    FROM batches
    WHERE current_state IN ('running','held','paused')
    ORDER BY started_at DESC
  `).all() as OrphanBatchRow[];
}

export function markBatchHeldForRecovery(
  db: Database.Database,
  batchId: string,
  reason: string,
): void {
  db.prepare(
    "UPDATE batches SET current_state = 'held', hold_reason = ? WHERE batch_id = ?",
  ).run(reason, batchId);
}

// v1.9.0 P2 bucket 2 — boot-time RecoveryPolicy may choose to abort an orphan
// batch outright rather than hold it for operator review. We map abort to
// current_state='stopped' + stop_trigger='cmd_stop' because the schema's CHECK
// constraint only allows {'cmd_stop','safety_estop'} for stop_trigger, and
// 'cmd_stop' is the closest semantic fit (operator-initiated, not a safety event).
// The actual recovery context is preserved in `notes` (appended, not overwritten)
// so the row keeps its prior history.
export function markBatchAborted(
  db: Database.Database,
  batchId: string,
  reason: string,
): void {
  db.prepare(
    "UPDATE batches SET current_state = 'stopped', stop_trigger = 'cmd_stop', notes = COALESCE(notes, '') || ? WHERE batch_id = ?",
  ).run(`\nrecovery_abort: ${reason}`, batchId);
}

// ─── SCADA 类型 ───────────────────────────────────────────
export interface ScadaProjectMeta {
  project_id: string;
  name: string;
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScadaViewMeta {
  view_id: string;
  project_id: string;
  name: string;
  reactor_id: string | null;
  display_order: number;
  width: number;
  height: number;
  background: string;
  is_svg: number;
  is_template: number;
  updated_at: string;
  owner_id: string | null;
  acl: string; // JSON: { users: string[], roles: string[] }
}

export interface ScadaView extends ScadaViewMeta {
  items: Record<string, any>;
}

export interface ScadaViewAcl {
  users: string[];
  roles: string[];
}

export const SCADA_ITEMS_MAX_BYTES = 500 * 1024;

export interface FuxaViewRow {
  id: string;
  name: string;
  type: string;
  payload: string;                    // FuxaView JSON
  width: number;
  height: number;
  parent_view_id: string | null;
  is_template: number;                // 0 | 1
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

// SP-RG-4: phase_instances row shape (params_override is JSON-encoded string;
// caller is responsible for JSON.parse).
export interface PhaseInstanceRow {
  instance_id: string;
  phase_class: string;
  reactor_id: string;
  label: string | null;
  params_override: string;
  notes: string;
  created_at: string;
  created_by: string;
}

// SP-PLC-1: PLC ↔ Reactor 1:1 binding row.
export interface PlcReactorBindingRow {
  plc_id: string;
  reactor_id: string;
  created_at: string;
  created_by: string;
}
