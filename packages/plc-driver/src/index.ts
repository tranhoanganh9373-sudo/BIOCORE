// ============================================================
// plc-driver — 多协议PLC通讯驱动 (v2 重写)
//
// 通讯库:
//   S7协议:     node-snap7  (基于Snap7 C库, 工业级, npm 2k+ stars)
//   Modbus RTU: modbus-serial (RTU/TCP双模, npm 周下载10万+)
//
// 双向心跳协议:
//   PC→PLC: 每秒向 VB400 写入递增计数器
//   PLC→PC: 每秒向 VB401 写入递增计数器 (PLC梯形图实现)
//   PC检测: VB401连续3秒不变 → emit('comm_loss') → 状态机→Held
//   PLC检测: VB400连续3秒不变 → 安全驻留(PLC内独立逻辑)
// ============================================================

import { S7Client } from 'node-snap7';
import ModbusRTU from 'modbus-serial';
import { EventEmitter } from 'events';

// 重导出类型和纯函数工具
export type {
  ProtocolType, PLCConnectionConfig, PLCConnectionStatus,
  PLCVariableMapping, ParsedAddress, ProcessSnapshot, IProtocolAdapter,
} from './types';
export {
  parseAddr, byteLen, decode, encode, scale, unscale, groupByRegion,
  validateAddr,
  type AddressGroup, type AddressValidation,
} from './utils';
export { VariableMappingManager } from './variable-mapping';

import type {
  PLCConnectionConfig, PLCConnectionStatus, PLCVariableMapping,
  ParsedAddress, ProcessSnapshot, IProtocolAdapter,
} from './types';
import {
  parseAddr, byteLen, decode, encode, scale, unscale, groupByRegion, validateAddr,
} from './utils';

// ─── Mock PLC 适配器 (MOCK_PLC=true 时使用, 内存级 mock) ────

export class MockPlcClient implements IProtocolAdapter {
  // key = `${db ?? 0}:${start}` → Buffer
  private store = new Map<string, Buffer>();

  connect(): Promise<void> { return Promise.resolve(); }
  disconnect(): Promise<void> { return Promise.resolve(); }
  isConnected(): boolean { return true; }

  readBytes(start: number, length: number, db?: number): Promise<Buffer> {
    const key = `${db ?? 0}:${start}`;
    const stored = this.store.get(key);
    if (stored) {
      const out = Buffer.alloc(length, 0);
      stored.copy(out, 0, 0, Math.min(stored.length, length));
      return Promise.resolve(out);
    }
    return Promise.resolve(Buffer.alloc(length, 0));
  }

  writeBytes(start: number, buffer: Buffer, db?: number): Promise<void> {
    const key = `${db ?? 0}:${start}`;
    this.store.set(key, Buffer.from(buffer));
    return Promise.resolve();
  }
}

// ─── Snap7 适配器 ───────────────────────────────────────────

class Snap7Adapter implements IProtocolAdapter {
  private client: S7Client;
  private cfg: PLCConnectionConfig;
  private ok = false;

  // S7-200 SMART: Area=0x84 (DB), WordLen=0x02 (Byte)
  // DB号可配置: 默认1(标准V区), 实际PLC可能用DB2等
  private readonly AREA = 0x84;
  private readonly DB: number;
  private readonly WORDLEN_BYTE = 0x02;

  constructor(cfg: PLCConnectionConfig) {
    this.client = new S7Client();
    this.cfg = cfg;
    this.DB = cfg.s7_db ?? 1;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // S7-200 SMART 必须使用 ConnectionType=3 (Basic)
      this.client.SetConnectionType(3);
      this.client.ConnectTo(
        this.cfg.ip,
        this.cfg.rack ?? 0,
        this.cfg.slot ?? 1,
        (err: any) => {
          if (err) return reject(new Error(`S7连接失败 (${this.cfg.ip}): errCode=${err}`));
          this.ok = true;
          resolve();
        }
      );
    });
  }

  disconnect(): Promise<void> {
    this.ok = false;
    this.client.Disconnect();
    return Promise.resolve();
  }

  readBytes(start: number, length: number, db?: number): Promise<Buffer> {
    const dbNum = db ?? this.DB;
    return new Promise((resolve, reject) => {
      this.client.ReadArea(
        this.AREA, dbNum, start, length, this.WORDLEN_BYTE,
        (err: any, buf: Buffer) => {
          if (err) reject(new Error(`S7读取 DB${dbNum}.${start} 失败: errCode=${err}`));
          else resolve(buf);
        }
      );
    });
  }

  writeBytes(start: number, buffer: Buffer, db?: number): Promise<void> {
    const dbNum = db ?? this.DB;
    return new Promise((resolve, reject) => {
      this.client.WriteArea(
        this.AREA, dbNum, start, buffer.length, this.WORDLEN_BYTE, buffer,
        (err: any) => {
          if (err) reject(new Error(`S7写入 DB${dbNum}.${start} 失败: errCode=${err}`));
          else resolve();
        }
      );
    });
  }

  isConnected(): boolean { return this.ok && this.client.Connected(); }
}

// ─── Modbus 适配器 ──────────────────────────────────────────

class ModbusAdapter implements IProtocolAdapter {
  private client: ModbusRTU;
  private cfg: PLCConnectionConfig;
  private ok = false;

  constructor(cfg: PLCConnectionConfig) {
    this.client = new ModbusRTU();
    this.cfg = cfg;
  }

  async connect(): Promise<void> {
    if (this.cfg.protocol === 'modbus_rtu') {
      await this.client.connectRTUBuffered(this.cfg.serial_port || '/dev/ttyUSB0', {
        baudRate: this.cfg.baudrate || 9600,
        parity: this.cfg.parity || 'even',
        dataBits: 8, stopBits: 1,
      });
    } else {
      await this.client.connectTCP(this.cfg.ip, { port: this.cfg.port || 502 });
    }
    this.client.setID(this.cfg.slave_id || 1);
    this.client.setTimeout(3000);
    this.ok = true;
  }

  async disconnect(): Promise<void> {
    this.ok = false;
    return new Promise<void>((resolve) => {
      this.client.close(() => { resolve(); });
    });
  }

  async readBytes(start: number, length: number, _db?: number): Promise<Buffer> {
    const regCount = Math.ceil(length / 2);
    const result = await this.client.readHoldingRegisters(start, regCount);
    return Buffer.from(result.buffer);
  }

  async writeBytes(start: number, buffer: Buffer, _db?: number): Promise<void> {
    const regs: number[] = [];
    for (let i = 0; i < buffer.length; i += 2) {
      regs.push(buffer.readUInt16BE(i));
    }
    await this.client.writeRegisters(start, regs);
  }

  isConnected(): boolean { return this.ok; }
}

// ─── 统一连接管理器 (含双向心跳) ────────────────────────────

export class PLCConnectionManager extends EventEmitter {
  private adapter: IProtocolAdapter;
  private config: PLCConnectionConfig;
  private variables: PLCVariableMapping[] = [];

  // 双向心跳
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private pcCounter = 0;
  private lastPlcCounter = -1;
  private staleCount = 0;
  private _commAlive = false;
  private _connected = false;
  private reconnecting = false;
  private reconnectTimerHandle: ReturnType<typeof setTimeout> | null = null;

  // 统计
  private errCnt = 0;
  private okCnt = 0;
  private lastHbTime: Date | null = null;
  private latencyMs = 0;

  constructor(config: PLCConnectionConfig, adapter?: IProtocolAdapter) {
    super();
    this.config = config;
    this.adapter = adapter ?? (
      config.protocol === 's7'
        ? new Snap7Adapter(config)
        : new ModbusAdapter(config)
    );
  }

  // ── 连接 ──

  async connect(): Promise<void> {
    await this.adapter.connect();
    this._connected = true;
    this._commAlive = true;

    // H-2: Validate heartbeat addresses before starting heartbeat
    const writeAddrValid = validateAddr(this.config.heartbeat_write_address);
    if (!writeAddrValid.valid) {
      throw new Error(`心跳写地址无效 (${this.config.heartbeat_write_address}): ${writeAddrValid.error}`);
    }
    const readAddrValid = validateAddr(this.config.heartbeat_read_address);
    if (!readAddrValid.valid) {
      throw new Error(`心跳读地址无效 (${this.config.heartbeat_read_address}): ${readAddrValid.error}`);
    }

    this.startHeartbeat();
    this.emit('connected', { id: this.config.id, protocol: this.config.protocol });
  }

  async disconnect(): Promise<void> {
    this.stopHeartbeat();
    this.reconnecting = false;
    if (this.reconnectTimerHandle) {
      clearTimeout(this.reconnectTimerHandle);
      this.reconnectTimerHandle = null;
    }
    this._connected = false;
    this._commAlive = false;
    await this.adapter.disconnect();
    this.emit('disconnected', { id: this.config.id });
  }

  // ──────────────────────────────────────────────────────────
  // 双向心跳:
  //
  //   PC 每秒 → 写 VB400 (递增0~255)
  //   PC 每秒 ← 读 VB401 (PLC写入的递增值)
  //
  //   VB401 连续 N 秒不变 → comm_loss (N = timeout/1000)
  //   VB401 恢复变化     → comm_restored
  //
  //   PLC 端对称: 读 VB400, 不变 3 秒 → 安全驻留
  // ──────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    const intervalMs = 1000;
    const maxStale = Math.ceil((this.config.heartbeat_timeout_ms || 3000) / intervalMs);

    this.hbTimer = setInterval(async () => {
      try {
        const t0 = performance.now();

        // PC → PLC: 写递增值
        this.pcCounter = (this.pcCounter + 1) % 256;
        const wAddr = PLCConnectionManager.parseAddr(this.config.heartbeat_write_address);
        await this.adapter.writeBytes(wAddr.byte, Buffer.from([this.pcCounter]));

        // PLC → PC: 读PLC的递增值
        const rAddr = PLCConnectionManager.parseAddr(this.config.heartbeat_read_address);
        const buf = await this.adapter.readBytes(rAddr.byte, 1);

        this.latencyMs = Math.round(performance.now() - t0);
        const plcVal = buf.readUInt8(0);

        // 判活
        if (plcVal === this.lastPlcCounter) {
          this.staleCount++;
        } else {
          if (!this._commAlive && this.staleCount >= maxStale) {
            this._commAlive = true;
            this.emit('comm_restored', {
              id: this.config.id,
              downtime_s: this.staleCount,
            });
          }
          this.staleCount = 0;
          this._commAlive = true;
        }
        this.lastPlcCounter = plcVal;

        if (this.staleCount >= maxStale && this._commAlive) {
          this._commAlive = false;
          this.emit('comm_loss', {
            id: this.config.id,
            reason: `PLC心跳(${this.config.heartbeat_read_address})连续${this.staleCount}s未更新`,
          });
        }

        this.lastHbTime = new Date();
        this.okCnt++;
        this.emit('heartbeat', {
          pc: this.pcCounter, plc: plcVal,
          alive: this._commAlive, stale: this.staleCount,
        });

      } catch (err) {
        this.errCnt++;
        this.latencyMs = -1;
        if (this._commAlive) {
          this._commAlive = false;
          this.emit('comm_loss', {
            id: this.config.id,
            reason: `心跳异常: ${(err as Error).message}`,
          });
        }
        if (!this.reconnecting) this.tryReconnect();
      }
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
  }

  // 指数退避 reconnect: 最多 5 次尝试, delay = 2^attempt 秒 (上限 30s)
  // 超限 → emit('max_reconnect_exceeded') + 停止
  tryReconnect(): void {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.emit('reconnecting', { id: this.config.id });

    const MAX_ATTEMPTS = 5;
    let attempt = 0;

    const loop = async () => {
      if (!this.reconnecting) return;

      if (attempt >= MAX_ATTEMPTS) {
        this.reconnecting = false;
        this.reconnectTimerHandle = null;
        this.emit('max_reconnect_exceeded', { id: this.config.id, attempts: MAX_ATTEMPTS });
        return;
      }

      const delayMs = Math.min(1000 * Math.pow(2, attempt), 30_000);
      attempt++;

      this.reconnectTimerHandle = setTimeout(async () => {
        if (!this.reconnecting) return;
        try {
          await this.adapter.disconnect().catch(() => {});
          await this.adapter.connect();
          this._connected = true;
          this.reconnecting = false;
          this.reconnectTimerHandle = null;
          this.staleCount = 0;
          this.emit('reconnected', { id: this.config.id, attempts: attempt });
        } catch {
          if (!this.reconnecting) return;
          loop();
        }
      }, delayMs);
    };

    loop();
  }

  // ── 变量读写 ──

  setVariables(vars: PLCVariableMapping[]): void {
    this.variables = vars.filter(v => v.enabled);
  }

  /**
   * 读取所有可读变量，返回工程值映射。
   * 注意: 此方法不包含质量指标。如需每个变量的读取质量('good'/'bad')，
   * 请使用 readSnapshot() 方法。
   */
  async readAll(): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    const readable = this.variables.filter(v => v.direction !== 'WRITE');
    if (readable.length === 0) return result;

    // 按地址排序后尝试合并相邻区域批量读取
    const groups = PLCConnectionManager.groupByRegion(readable);

    for (const group of groups) {
      try {
        const buf = await this.adapter.readBytes(group.startByte, group.length, group.db);
        for (const v of group.vars) {
          const parsed = parseAddr(v.plc_address);
          const offset = parsed.byte - group.startByte;
          const len = byteLen(v.data_type);
          const slice = buf.subarray(offset, offset + len);
          const raw = decode(slice, v.data_type, parsed.bit);
          result[v.tag_name] = v.scaling_enabled ? scale(raw, v) : raw;
        }
        this.okCnt++;
      } catch {
        for (const v of group.vars) {
          try {
            const parsed = parseAddr(v.plc_address);
            const len = byteLen(v.data_type);
            const buf = await this.adapter.readBytes(parsed.byte, len, parsed.db);
            const raw = decode(buf, v.data_type, parsed.bit);
            result[v.tag_name] = v.scaling_enabled ? scale(raw, v) : raw;
          } catch { this.errCnt++; }
        }
      }
    }
    return result;
  }

  // 构建完整过程快照 (供 batch-engine / data-service 消费)
  async readSnapshot(): Promise<ProcessSnapshot> {
    const snapshot: ProcessSnapshot = {
      timestamp: new Date().toISOString(),
      connection_id: this.config.id,
      values: {},
      raw_values: {},
      quality: {},
    };

    const readable = this.variables.filter(v => v.direction !== 'WRITE');
    for (const v of readable) {
      try {
        const parsed = parseAddr(v.plc_address);
        const len = byteLen(v.data_type);
        const buf = await this.adapter.readBytes(parsed.byte, len, parsed.db);
        const raw = decode(buf, v.data_type, parsed.bit);
        snapshot.raw_values[v.tag_name] = raw;
        snapshot.values[v.tag_name] = v.scaling_enabled ? scale(raw, v) : raw;
        snapshot.quality[v.tag_name] = 'good';
      } catch {
        snapshot.quality[v.tag_name] = 'bad';
        this.errCnt++;
      }
    }
    return snapshot;
  }

  // 读取失败 → log + 触发 reconnect + 返回 null (不崩 server)
  async readTag(tag: string): Promise<number | null> {
    const v = this.variables.find(x => x.tag_name === tag);
    if (!v) throw new Error(`变量 "${tag}" 未找到`);
    try {
      const parsed = parseAddr(v.plc_address);
      const buf = await this.adapter.readBytes(parsed.byte, byteLen(v.data_type), parsed.db);
      const raw = decode(buf, v.data_type, parsed.bit);
      return v.scaling_enabled ? scale(raw, v) : raw;
    } catch (err) {
      console.error(`[plc-driver] readTag "${tag}" 失败:`, (err as Error).message);
      this.errCnt++;
      this.tryReconnect();
      return null;
    }
  }

  // opts.confirmed===true 严格 gate: AI/自动化路径严禁直接调用
  async writeTag(tag: string, value: number, opts?: { confirmed?: boolean }): Promise<void> {
    if (opts?.confirmed !== true) {
      throw new Error(`writeTag "${tag}" 需要显式确认: 传入 opts.confirmed=true`);
    }
    const v = this.variables.find(x => x.tag_name === tag);
    if (!v) throw new Error(`变量 "${tag}" 未找到`);
    if (v.direction === 'READ') throw new Error(`变量 "${tag}" 为只读`);
    const raw = v.scaling_enabled ? unscale(value, v) : value;
    const parsed = parseAddr(v.plc_address);

    if (v.data_type === 'BOOL' && parsed.bit !== undefined) {
      // WARNING: BOOL write is a non-atomic read-modify-write operation.
      // Concurrent writes to other bits in the same byte may be lost.
      const buf = await this.adapter.readBytes(parsed.byte, 1, parsed.db);
      const current = buf.readUInt8(0);
      const updated = raw ? (current | (1 << parsed.bit)) : (current & ~(1 << parsed.bit));
      await this.adapter.writeBytes(parsed.byte, Buffer.from([updated]), parsed.db);

      // Read-back verification for production safety
      const verify = await this.adapter.readBytes(parsed.byte, 1, parsed.db);
      const actual = (verify.readUInt8(0) >> parsed.bit) & 1;
      const expected = raw ? 1 : 0;
      if (actual !== expected) {
        throw new Error(`BOOL write verification failed: ${tag} bit ${parsed.bit} expected=${expected} actual=${actual}`);
      }
    } else {
      await this.adapter.writeBytes(parsed.byte, encode(raw, v.data_type), parsed.db);
    }
  }

  // static 代理 — 委托给 utils.ts 纯函数
  static parseAddr = parseAddr;
  static byteLen = byteLen;
  static decode = decode;
  static encode = encode;
  static scale = scale;
  static unscale = unscale;
  static groupByRegion = groupByRegion;
  static validateAddr = validateAddr;

  getStatus(): PLCConnectionStatus {
    const tot = this.okCnt + this.errCnt;
    return {
      connection_id: this.config.id,
      protocol: this.config.protocol,
      connected: this._connected,
      comm_alive: this._commAlive,
      last_heartbeat: this.lastHbTime?.toISOString() ?? null,
      pc_counter: this.pcCounter,
      plc_counter_stale: this.staleCount,
      error_count: this.errCnt,
      packet_loss_rate: tot > 0 ? this.errCnt / tot : 0,
      latency_ms: this.latencyMs,
    };
  }

  isConnected(): boolean { return this._connected; }
  isCommAlive(): boolean { return this._commAlive; }

  getConfig(): PLCConnectionConfig { return this.config; }
  getVariableList(): PLCVariableMapping[] { return this.variables; }

  // 直接字节读取 (供 PollingScheduler 批量使用)
  readBytesRaw(start: number, length: number, db?: number): Promise<Buffer> {
    return this.adapter.readBytes(start, length, db);
  }
}

// ─── 工厂函数 ───────────────────────────────────────────────
// MOCK_PLC=true → MockPlcClient (开发/测试, 不需真 PLC)
// MOCK_PLC 未设/false → Snap7Adapter (真实 PLC)

export function createPlcDriver(config: PLCConnectionConfig): PLCConnectionManager {
  if (process.env.MOCK_PLC === 'true') {
    return new PLCConnectionManager(config, new MockPlcClient());
  }
  return new PLCConnectionManager(config);
}

// ─── 轮询调度器 ────────────────────────────────────────────
// 按变量的 poll_rate_ms 分组轮询，构建快照，发射事件
// 使用方式:
//   const scheduler = new PollingScheduler(plcManager);
//   scheduler.on('snapshot', (snap: ProcessSnapshot) => broadcast(snap));
//   scheduler.start();

export class PollingScheduler extends EventEmitter {
  private mgr: PLCConnectionManager;
  private timers: Map<number, ReturnType<typeof setInterval>> = new Map();
  private running = false;
  // SP-PLC-3 P3a.3: 内部 vars 维护 + 增量 add/remove API.
  // - null = 尚未初始化, start() 时 lazy snapshot from mgr.getVariableList()
  //   (保持 P2 caller 兼容: index.ts:3754 仍是 mgr.setVariables 全量模式).
  // - 非 null = 用 instance vars 当事实源, add/remove/setVariables 修改它.
  // 任一 mutator 调用都置 _dirty=true, 下次 tick 内 regroupByRate 重 group;
  // 不停现有 timer (避免 P2.4 restart 的 1×poll_rate 空窗).
  private vars: PLCVariableMapping[] | null = null;
  private groupedByRate: Map<number, PLCVariableMapping[]> = new Map();
  private _dirty = false;

  constructor(mgr: PLCConnectionManager) {
    super();
    this.mgr = mgr;
  }

  /** SP-PLC-3 P3a.3: 显式覆盖 instance vars (snapshot 全量). 切到 instance 模式. */
  setVariables(vars: PLCVariableMapping[]): void {
    this.vars = [...vars];
    this._dirty = true;
  }

  /** SP-PLC-3 P3a.3: 增量加单 variable, 下次 tick 自动包含 (不重启 timer). */
  addVariable(v: PLCVariableMapping): void {
    if (this.vars === null) {
      // lazy 初始化: 先 snapshot mgr 当前 vars (保持已存在变量), 再 push 新值
      this.vars = [...this.mgr.getVariableList()];
    }
    this.vars.push(v);
    this._dirty = true;
  }

  /** SP-PLC-3 P3a.3: 增量删 variable (按 id), 下次 tick 自动跳过 (不重启 timer). */
  removeVariable(id: string): void {
    if (this.vars === null) {
      this.vars = [...this.mgr.getVariableList()];
    }
    this.vars = this.vars.filter((v) => v.id !== id);
    this._dirty = true;
  }

  /** 当前生效的 vars (优先 instance, 否则 mgr). 仅 readable + enabled. */
  private getEffectiveVars(): PLCVariableMapping[] {
    const src = this.vars ?? this.mgr.getVariableList();
    return src.filter((v) => v.direction !== 'WRITE' && v.enabled);
  }

  /** 按 rate 重 group (instance state). dirty flag 清零. 新 rate 启 timer. */
  private regroupByRate(): void {
    const next = new Map<number, PLCVariableMapping[]>();
    for (const v of this.getEffectiveVars()) {
      const rate = v.poll_rate_ms || 1000;
      if (!next.has(rate)) next.set(rate, []);
      next.get(rate)!.push(v);
    }
    this.groupedByRate = next;
    this._dirty = false;
    // 新出现的 rate 需补 timer (不停现有 timer; 老 rate 留空 timer 无害,
    // tick 内 if (vars.length === 0) return 跳过 emit).
    if (this.running) {
      for (const rate of next.keys()) {
        if (!this.timers.has(rate)) {
          this.startTimerForRate(rate);
        }
      }
    }
  }

  /** 启动单个 rate 的 setInterval timer; 闭包仅捕获 rate, vars 每 tick 从 groupedByRate 读最新. */
  private startTimerForRate(rateMs: number): void {
    const timer = setInterval(async () => {
      if (!this.running) return;
      // dirty 优先 regroup (下次 tick 时机即生效, 不停现有 timer)
      if (this._dirty) this.regroupByRate();
      const vars = this.groupedByRate.get(rateMs);
      if (!vars || vars.length === 0) return; // 空 rate 跳过 emit (e.g. 全删后空闲)
      try {
        const snapshot = await this.pollGroup(vars);
        this.emit('snapshot', snapshot);
      } catch (err) {
        this.emit('error', err);
      }
    }, rateMs);
    this.timers.set(rateMs, timer);
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    // 初始 group + 启每 rate 一 timer (闭包仅捕 rate, vars 从 groupedByRate 实时读)
    this.regroupByRate();
    for (const rate of this.groupedByRate.keys()) {
      this.startTimerForRate(rate);
    }

    this.emit('started', { groupCount: this.groupedByRate.size });
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
    this.emit('stopped');
  }

  // H-3: Restart polling after variable list changes
  // SP-PLC-3 P3a.3: 仍保留 restart() (向后兼容 + 紧急回退路径), 但 plc-config-routes
  // 默认走 remove+add 增量路径避免 1×poll_rate 空窗.
  restart(): void {
    this.stop();
    this.start();
  }

  private async pollGroup(vars: PLCVariableMapping[]): Promise<ProcessSnapshot> {
    const snapshot: ProcessSnapshot = {
      timestamp: new Date().toISOString(),
      connection_id: this.mgr.getConfig().id,
      values: {},
      raw_values: {},
      quality: {},
    };

    const groups = groupByRegion(vars);
    for (const group of groups) {
      try {
        const buf = await this.mgr.readBytesRaw(group.startByte, group.length, group.db);
        for (const v of group.vars) {
          const parsed = parseAddr(v.plc_address);
          const offset = parsed.byte - group.startByte;
          const len = byteLen(v.data_type);
          const slice = buf.subarray(offset, offset + len);
          const raw = decode(slice, v.data_type, parsed.bit);
          snapshot.raw_values[v.tag_name] = raw;
          snapshot.values[v.tag_name] = v.scaling_enabled ? scale(raw, v) : raw;
          snapshot.quality[v.tag_name] = 'good';
        }
      } catch {
        for (const v of group.vars) {
          snapshot.quality[v.tag_name] = 'bad';
        }
      }
    }
    return snapshot;
  }

  isRunning(): boolean { return this.running; }
}

// ─── VFD 变频器 Modbus RTU 客户端 ──────────────────────────

export class VFDModbusClient {
  private client: ModbusRTU;
  private port: string;
  private baud: number;
  private slaveId: number;

  constructor(port: string, baud = 9600, slaveId = 1) {
    this.client = new ModbusRTU();
    this.port = port;
    this.baud = baud;
    this.slaveId = slaveId;
  }

  async connect(): Promise<void> {
    await this.client.connectRTUBuffered(this.port, {
      baudRate: this.baud, parity: 'even', dataBits: 8, stopBits: 1,
    });
    this.client.setID(this.slaveId);
    this.client.setTimeout(1000);
  }

  async setFrequency(hz: number): Promise<void> {
    await this.client.writeRegister(0x2000, Math.round(hz * 100));
  }

  async readFrequency(): Promise<number> {
    const r = await this.client.readHoldingRegisters(0x2001, 1);
    return r.data[0] / 100;
  }

  async readCurrent(): Promise<number> {
    const r = await this.client.readHoldingRegisters(0x2002, 1);
    return r.data[0] / 100;
  }

  async readFaultCode(): Promise<number> {
    const r = await this.client.readHoldingRegisters(0x2003, 1);
    return r.data[0];
  }

  async disconnect(): Promise<void> {
    this.client.close(() => {});
  }
}
