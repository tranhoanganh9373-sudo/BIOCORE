// ============================================================
// 变量映射持久化管理 (SQLite)
// ============================================================

import type { PLCConnectionConfig, PLCVariableMapping } from './types';
import { validateAddr } from './utils';

export class VariableMappingManager {
  private db: any;

  constructor(db: any) {
    this.db = db;
    this.initTable();
    this.migrate();
  }

  private initTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plc_connections (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, protocol TEXT NOT NULL DEFAULT 's7',
        ip TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 102,
        rack INTEGER DEFAULT 0, slot INTEGER DEFAULT 1,
        s7_db INTEGER NOT NULL DEFAULT 1,
        serial_port TEXT, baudrate INTEGER DEFAULT 9600,
        parity TEXT DEFAULT 'even', slave_id INTEGER DEFAULT 1,
        heartbeat_write_address TEXT NOT NULL DEFAULT 'VB400',
        heartbeat_read_address TEXT NOT NULL DEFAULT 'VB401',
        heartbeat_timeout_ms INTEGER NOT NULL DEFAULT 3000,
        reconnect_interval_ms INTEGER NOT NULL DEFAULT 5000,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS plc_variable_mappings (
        id TEXT PRIMARY KEY, tag_name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '', plc_address TEXT NOT NULL,
        data_type TEXT NOT NULL, direction TEXT NOT NULL,
        scaling_enabled INTEGER NOT NULL DEFAULT 0,
        raw_min REAL DEFAULT 0, raw_max REAL DEFAULT 27648,
        eng_min REAL DEFAULT 0, eng_max REAL DEFAULT 100,
        eng_unit TEXT DEFAULT '', "group" TEXT DEFAULT '模拟量输入',
        poll_rate_ms INTEGER DEFAULT 1000, enabled INTEGER DEFAULT 1,
        connection_id TEXT NOT NULL,
        FOREIGN KEY (connection_id) REFERENCES plc_connections(id)
      );
    `);
  }

  // 数据库迁移: 为旧表添加缺失列
  private migrate(): void {
    try {
      // 检查 s7_db 列是否存在
      const cols = this.db.prepare("PRAGMA table_info(plc_connections)").all();
      const hasS7Db = cols.some((c: any) => c.name === 's7_db');
      if (!hasS7Db) {
        this.db.exec("ALTER TABLE plc_connections ADD COLUMN s7_db INTEGER NOT NULL DEFAULT 1");
      }
    } catch (e) {
      console.warn(`[VariableMappingManager] migrate() failed: ${(e as Error).message}`);
    }
  }

  getConnections(): PLCConnectionConfig[] {
    return this.db.prepare('SELECT * FROM plc_connections ORDER BY name').all();
  }

  upsertConnection(c: PLCConnectionConfig): void {
    this.db.prepare(`INSERT OR REPLACE INTO plc_connections
      (id,name,protocol,ip,port,rack,slot,s7_db,serial_port,baudrate,parity,slave_id,
       heartbeat_write_address,heartbeat_read_address,heartbeat_timeout_ms,
       reconnect_interval_ms,enabled,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
    `).run(c.id, c.name, c.protocol, c.ip, c.port, c.rack, c.slot,
      c.s7_db ?? 1, c.serial_port, c.baudrate, c.parity, c.slave_id,
      c.heartbeat_write_address, c.heartbeat_read_address,
      c.heartbeat_timeout_ms, c.reconnect_interval_ms, c.enabled ? 1 : 0);
  }

  deleteConnection(id: string): void {
    this.db.prepare('DELETE FROM plc_variable_mappings WHERE connection_id=?').run(id);
    this.db.prepare('DELETE FROM plc_connections WHERE id=?').run(id);
  }

  getVariables(connId?: string): PLCVariableMapping[] {
    return connId
      ? this.db.prepare('SELECT * FROM plc_variable_mappings WHERE connection_id=? ORDER BY "group",tag_name').all(connId)
      : this.db.prepare('SELECT * FROM plc_variable_mappings ORDER BY "group",tag_name').all();
  }

  upsertVariable(v: PLCVariableMapping): void {
    const addrCheck = validateAddr(v.plc_address, v.data_type);
    if (!addrCheck.valid) {
      throw new Error(`Invalid PLC address "${v.plc_address}": ${addrCheck.error}`);
    }
    // P1 修复: 校验 scale 参数合法性, 避免配置颠倒导致数值翻转
    if (v.scaling_enabled) {
      if (typeof v.raw_min !== 'number' || typeof v.raw_max !== 'number'
          || typeof v.eng_min !== 'number' || typeof v.eng_max !== 'number') {
        throw new Error(`变量 "${v.tag_name}" 启用缩放但 raw_min/raw_max/eng_min/eng_max 非数值`);
      }
      if (v.raw_min >= v.raw_max) {
        throw new Error(`变量 "${v.tag_name}" 配置错误: raw_min (${v.raw_min}) 必须 < raw_max (${v.raw_max})`);
      }
      if (v.eng_min >= v.eng_max) {
        throw new Error(`变量 "${v.tag_name}" 配置错误: eng_min (${v.eng_min}) 必须 < eng_max (${v.eng_max})`);
      }
    }
    // SP-PLC-3 P2.4 配套修复: 加 deadband_abs/_pct 到 INSERT OR REPLACE 列清单,
    // 否则 plc-config UI 编辑 (e.g. 改 poll_rate_ms) 触发 upsert 会把 P2.1
    // migration 040 加的 deadband 两列静默 reset 为默认 0 (清掉操作员配的死区).
    this.db.prepare(`INSERT OR REPLACE INTO plc_variable_mappings
      (id,tag_name,description,plc_address,data_type,direction,scaling_enabled,
       raw_min,raw_max,eng_min,eng_max,eng_unit,"group",poll_rate_ms,enabled,connection_id,
       deadband_abs,deadband_pct)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(v.id, v.tag_name, v.description, v.plc_address, v.data_type, v.direction,
      v.scaling_enabled ? 1 : 0, v.raw_min, v.raw_max, v.eng_min, v.eng_max,
      v.eng_unit, v.group, v.poll_rate_ms, v.enabled ? 1 : 0, v.connection_id,
      v.deadband_abs ?? 0, v.deadband_pct ?? 0);
  }

  deleteVariable(id: string): void {
    this.db.prepare('DELETE FROM plc_variable_mappings WHERE id=?').run(id);
  }

  exportToJSON() {
    return { connections: this.getConnections(), variables: this.getVariables() };
  }

  exportToCSV(): string {
    const vars = this.getVariables();
    const h = ['tag_name','description','plc_address','data_type','direction',
      'scaling_enabled','raw_min','raw_max','eng_min','eng_max','eng_unit','group',
      'poll_rate_ms','enabled','connection_id'];
    const rows = vars.map(v => h.map(k => {
      const val = (v as any)[k];
      return typeof val === 'string' && val.includes(',') ? `"${val}"` : val;
    }).join(','));
    return [h.join(','), ...rows].join('\n');
  }

  importFromJSON(data: { connections?: any[]; variables?: any[] }) {
    const errors: string[] = [];
    let imported = 0;
    this.db.transaction(() => {
      for (const c of data.connections || []) {
        try { this.upsertConnection(c); imported++; } catch (e) { errors.push(`${c.name}: ${e}`); }
      }
      for (const v of data.variables || []) {
        try { this.upsertVariable(v); imported++; } catch (e) { errors.push(`${v.tag_name}: ${e}`); }
      }
    })();
    return { imported, errors };
  }
}
