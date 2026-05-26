// ============================================================
// plc-driver 类型定义 (无 native 依赖)
// ============================================================

export type ProtocolType = 's7' | 'modbus_tcp' | 'modbus_rtu';

export interface PLCConnectionConfig {
  id: string;
  name: string;
  protocol: ProtocolType;
  ip: string;
  port: number;
  enabled: boolean;
  rack?: number;
  slot?: number;
  s7_db?: number;                       // S7-200 SMART DB号 (默认1=V区, 可设2等)
  serial_port?: string;
  baudrate?: number;
  parity?: 'none' | 'even' | 'odd';
  slave_id?: number;
  heartbeat_write_address: string;
  heartbeat_read_address: string;
  heartbeat_timeout_ms: number;
  reconnect_interval_ms: number;
}

export interface PLCConnectionStatus {
  connection_id: string;
  protocol: ProtocolType;
  connected: boolean;
  comm_alive: boolean;
  last_heartbeat: string | null;
  pc_counter: number;
  plc_counter_stale: number;
  error_count: number;
  packet_loss_rate: number;
  latency_ms: number;
}

export interface PLCVariableMapping {
  id: string;
  tag_name: string;
  description: string;
  plc_address: string;
  data_type: 'BOOL' | 'INT16' | 'INT32' | 'FLOAT32' | 'UINT16';
  direction: 'READ' | 'WRITE' | 'READWRITE';
  scaling_enabled: boolean;
  raw_min: number;
  raw_max: number;
  eng_min: number;
  eng_max: number;
  eng_unit: string;
  group: string;
  poll_rate_ms: number;
  enabled: boolean;
  connection_id: string;
  /** SP-PLC-3 P2.1 (migration 040): 绝对死区, 0 = 关闭 (回退全局 deadband). */
  deadband_abs?: number;
  /** SP-PLC-3 P2.1 (migration 040): 百分比死区 (单位 %), 0 = 关闭. */
  deadband_pct?: number;
}

export interface ParsedAddress {
  byte: number;
  bit?: number;   // 仅BOOL, 0~7
  db?: number;    // DB块号, 如 DB2.DBW4 → db=2
}

export interface ProcessSnapshot {
  timestamp: string;
  connection_id: string;
  values: Record<string, number>;
  raw_values: Record<string, number>;
  quality: Record<string, 'good' | 'bad' | 'uncertain'>;
}

// 协议适配器接口
export interface IProtocolAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  readBytes(start: number, length: number, db?: number): Promise<Buffer>;
  writeBytes(start: number, buffer: Buffer, db?: number): Promise<void>;
  isConnected(): boolean;
}
