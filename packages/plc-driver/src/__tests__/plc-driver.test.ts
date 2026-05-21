// ============================================================
// plc-driver 单元测试
// 测试地址解析、编解码、缩放、区域分组等纯函数逻辑
// 不依赖 node-snap7/modbus-serial native 模块
// ============================================================

import { describe, it, expect } from 'vitest';
import { parseAddr, byteLen, decode, encode, scale, unscale, groupByRegion, validateAddr } from '../utils';
import { prepareWrite } from '../write-helpers';
import type { PLCVariableMapping, PLCConnectionConfig } from '../types';

// ─── 地址解析 ───────────────────────────────────────────────

describe('parseAddr', () => {
  it('解析 VB 字节地址', () => {
    expect(parseAddr('VB400')).toEqual({ byte: 400 });
  });

  it('解析 VW 字地址', () => {
    expect(parseAddr('VW100')).toEqual({ byte: 100 });
  });

  it('解析 VD 双字地址', () => {
    expect(parseAddr('VD300')).toEqual({ byte: 300 });
  });

  it('解析 V 简写地址', () => {
    expect(parseAddr('V100')).toEqual({ byte: 100 });
  });

  it('解析 BOOL 位地址 V200.0', () => {
    expect(parseAddr('V200.0')).toEqual({ byte: 200, bit: 0 });
  });

  it('解析 BOOL 位地址 V200.7', () => {
    expect(parseAddr('V200.7')).toEqual({ byte: 200, bit: 7 });
  });

  // DB块格式
  it('解析 DB2.DBW4', () => {
    expect(parseAddr('DB2.DBW4')).toEqual({ db: 2, byte: 4 });
  });

  it('解析 DB2.DBB10', () => {
    expect(parseAddr('DB2.DBB10')).toEqual({ db: 2, byte: 10 });
  });

  it('解析 DB2.DBD100 (双字)', () => {
    expect(parseAddr('DB2.DBD100')).toEqual({ db: 2, byte: 100 });
  });

  it('解析 DB2.DBX0.3 (位地址)', () => {
    expect(parseAddr('DB2.DBX0.3')).toEqual({ db: 2, byte: 0, bit: 3 });
  });

  it('解析 DB1.DBW0', () => {
    expect(parseAddr('DB1.DBW0')).toEqual({ db: 1, byte: 0 });
  });

  // 短DB格式 (无DB号前缀，DB由连接配置决定)
  it('解析 DBW4 (短格式)', () => {
    expect(parseAddr('DBW4')).toEqual({ byte: 4 });
  });

  it('解析 DBB10 (短格式)', () => {
    expect(parseAddr('DBB10')).toEqual({ byte: 10 });
  });

  it('解析 DBD100 (短格式)', () => {
    expect(parseAddr('DBD100')).toEqual({ byte: 100 });
  });

  it('解析 DBX0.3 (短格式位地址)', () => {
    expect(parseAddr('DBX0.3')).toEqual({ byte: 0, bit: 3 });
  });

  it('无效地址抛出异常', () => {
    expect(() => parseAddr('Q0.0')).toThrow('无效地址');
    expect(() => parseAddr('')).toThrow('无效地址');
  });
});

// ─── 字节长度 ───────────────────────────────────────────────

describe('byteLen', () => {
  it('BOOL = 1 byte', () => { expect(byteLen('BOOL')).toBe(1); });
  it('INT16 = 2 bytes', () => { expect(byteLen('INT16')).toBe(2); });
  it('UINT16 = 2 bytes', () => { expect(byteLen('UINT16')).toBe(2); });
  it('INT32 = 4 bytes', () => { expect(byteLen('INT32')).toBe(4); });
  it('FLOAT32 = 4 bytes', () => { expect(byteLen('FLOAT32')).toBe(4); });
});

// ─── 编码/解码 ──────────────────────────────────────────────

describe('encode/decode', () => {
  it('INT16 往返', () => {
    const encoded = encode(1234, 'INT16');
    expect(decode(encoded, 'INT16')).toBe(1234);
  });

  it('INT16 负数往返', () => {
    const encoded = encode(-500, 'INT16');
    expect(decode(encoded, 'INT16')).toBe(-500);
  });

  it('UINT16 往返', () => {
    const encoded = encode(50000, 'UINT16');
    expect(decode(encoded, 'UINT16')).toBe(50000);
  });

  it('INT32 往返', () => {
    const encoded = encode(100000, 'INT32');
    expect(decode(encoded, 'INT32')).toBe(100000);
  });

  it('FLOAT32 往返(精度到0.01)', () => {
    const encoded = encode(37.25, 'FLOAT32');
    const decoded = decode(encoded, 'FLOAT32');
    expect(decoded).toBeCloseTo(37.25, 2);
  });

  it('BOOL 编码 1', () => {
    const encoded = encode(1, 'BOOL');
    expect(encoded.readUInt8(0)).toBe(1);
  });

  it('BOOL 解码位0', () => {
    const buf = Buffer.from([0b00000101]); // bit0=1, bit2=1
    expect(decode(buf, 'BOOL', 0)).toBe(1);
    expect(decode(buf, 'BOOL', 1)).toBe(0);
    expect(decode(buf, 'BOOL', 2)).toBe(1);
    expect(decode(buf, 'BOOL', 7)).toBe(0);
  });
});

// ─── 缩放 ───────────────────────────────────────────────────

describe('scale / unscale', () => {
  // S7-200 SMART 4-20mA → 0~27648 → 工程值
  const tempVar = { raw_min: 0, raw_max: 27648, eng_min: 0, eng_max: 150 };

  it('原始值0 → 工程值0', () => {
    expect(scale(0, tempVar)).toBeCloseTo(0);
  });

  it('原始值27648 → 工程值150', () => {
    expect(scale(27648, tempVar)).toBeCloseTo(150);
  });

  it('原始值中间值 → 线性插值', () => {
    expect(scale(13824, tempVar)).toBeCloseTo(75);
  });

  it('unscale 逆运算', () => {
    expect(unscale(75, tempVar)).toBeCloseTo(13824);
  });

  it('scale+unscale 往返', () => {
    const raw = 20000;
    const eng = scale(raw, tempVar);
    const back = unscale(eng, tempVar);
    expect(back).toBeCloseTo(raw);
  });

  // pH: 0~14
  const phVar = { raw_min: 0, raw_max: 27648, eng_min: 0, eng_max: 14 };

  it('pH 缩放', () => {
    expect(scale(13824, phVar)).toBeCloseTo(7);
  });

  // 压力: -1~3 bar
  const pressVar = { raw_min: 0, raw_max: 27648, eng_min: -1, eng_max: 3 };

  it('压力缩放(含负值)', () => {
    expect(scale(0, pressVar)).toBeCloseTo(-1);
    expect(scale(27648, pressVar)).toBeCloseTo(3);
    expect(scale(6912, pressVar)).toBeCloseTo(0);
  });

  it('raw_min == raw_max 时返回原值', () => {
    const noScale = { raw_min: 0, raw_max: 0, eng_min: 0, eng_max: 100 };
    expect(scale(42, noScale)).toBe(42);
  });
});

// ─── 区域分组 ───────────────────────────────────────────────

describe('groupByRegion', () => {
  const makeVar = (addr: string, dt: string = 'INT16'): PLCVariableMapping => ({
    id: addr, tag_name: addr, description: '', plc_address: addr,
    data_type: dt as any, direction: 'READ', scaling_enabled: false,
    raw_min: 0, raw_max: 0, eng_min: 0, eng_max: 0,
    eng_unit: '', group: '', poll_rate_ms: 1000, enabled: true, connection_id: 'test',
  });

  it('相邻地址合并为一组', () => {
    const vars = [makeVar('VW100'), makeVar('VW102'), makeVar('VW104')];
    const groups = groupByRegion(vars);
    expect(groups).toHaveLength(1);
    expect(groups[0].startByte).toBe(100);
    expect(groups[0].length).toBe(6);
    expect(groups[0].vars).toHaveLength(3);
  });

  it('间隔>16字节拆分为两组', () => {
    const vars = [makeVar('VW100'), makeVar('VW200')];
    const groups = groupByRegion(vars);
    expect(groups).toHaveLength(2);
  });

  it('混合数据类型正确计算长度', () => {
    const vars = [
      makeVar('VW100', 'INT16'),
      makeVar('VD102', 'FLOAT32'),
    ];
    const groups = groupByRegion(vars);
    expect(groups).toHaveLength(1);
    expect(groups[0].length).toBe(6);
  });

  it('BOOL位地址正确分组', () => {
    const vars = [
      makeVar('V200.0', 'BOOL'),
      makeVar('V200.5', 'BOOL'),
    ];
    const groups = groupByRegion(vars);
    expect(groups).toHaveLength(1);
    expect(groups[0].startByte).toBe(200);
    expect(groups[0].length).toBe(1);
  });

  it('空数组返回空', () => {
    expect(groupByRegion([])).toHaveLength(0);
  });

  it('不同DB号拆分为不同组', () => {
    const vars = [
      makeVar('DB1.DBW0', 'INT16'),
      makeVar('DB2.DBW0', 'INT16'),
      makeVar('DB2.DBW2', 'INT16'),
    ];
    const groups = groupByRegion(vars);
    expect(groups).toHaveLength(2);
    // DB1 一组, DB2 一组
    const db1 = groups.find(g => g.db === 1);
    const db2 = groups.find(g => g.db === 2);
    expect(db1?.vars).toHaveLength(1);
    expect(db2?.vars).toHaveLength(2);
    expect(db2?.length).toBe(4); // DBW0(2) + DBW2(2)
  });

  it('V区和DB区分开分组', () => {
    const vars = [
      makeVar('VW100', 'INT16'),    // V区, db=undefined
      makeVar('DB2.DBW4', 'INT16'), // DB2
    ];
    const groups = groupByRegion(vars);
    expect(groups).toHaveLength(2);
  });
});

// ─── 地址校验 (安全关键) ────────────────────────────────────

describe('validateAddr', () => {
  // 合法地址
  it('DB2.DBW4 合法', () => { expect(validateAddr('DB2.DBW4').valid).toBe(true); });
  it('DB2.DBB10 合法', () => { expect(validateAddr('DB2.DBB10').valid).toBe(true); });
  it('DB2.DBD100 合法', () => { expect(validateAddr('DB2.DBD100').valid).toBe(true); });
  it('DB2.DBX0.3 合法', () => { expect(validateAddr('DB2.DBX0.3').valid).toBe(true); });
  it('DBW4 短格式合法', () => { expect(validateAddr('DBW4').valid).toBe(true); });
  it('VW100 合法', () => { expect(validateAddr('VW100').valid).toBe(true); });
  it('VB0 合法', () => { expect(validateAddr('VB0').valid).toBe(true); });
  it('V200.0 合法', () => { expect(validateAddr('V200.0').valid).toBe(true); });

  // 非法地址 — 必须被拒绝
  it('空字符串拒绝', () => { expect(validateAddr('').valid).toBe(false); });
  it('Q0.0 拒绝 (非V/DB区)', () => { expect(validateAddr('Q0.0').valid).toBe(false); });
  it('M100 拒绝', () => { expect(validateAddr('M100').valid).toBe(false); });
  it('I0.0 拒绝', () => { expect(validateAddr('I0.0').valid).toBe(false); });
  it('abc 拒绝', () => { expect(validateAddr('abc').valid).toBe(false); });
  it('12345 拒绝', () => { expect(validateAddr('12345').valid).toBe(false); });
  it('DB0.DBW4 拒绝 (DB0无效)', () => { expect(validateAddr('DB0.DBW4').valid).toBe(false); });
  it('VW99999 拒绝 (超范围)', () => { expect(validateAddr('VW99999').valid).toBe(false); });
  it('V200.8 拒绝 (位号>7)', () => { expect(validateAddr('V200.8').valid).toBe(false); });

  // 数据类型一致性
  it('BOOL + VW100 拒绝 (必须用位地址)', () => {
    expect(validateAddr('VW100', 'BOOL').valid).toBe(false);
  });
  it('BOOL + V200.0 合法', () => {
    expect(validateAddr('V200.0', 'BOOL').valid).toBe(true);
  });
  it('BOOL + DB2.DBX0.3 合法', () => {
    expect(validateAddr('DB2.DBX0.3', 'BOOL').valid).toBe(true);
  });
  it('INT16 + V200.0 拒绝 (非BOOL不能用位地址)', () => {
    expect(validateAddr('V200.0', 'INT16').valid).toBe(false);
  });
});

// ─── SP-PLC-2: prepareWrite ─────────────────────────────────

describe('prepareWrite (SP-PLC-2)', () => {
  const mkVar = (overrides: Partial<PLCVariableMapping> = {}): PLCVariableMapping => ({
    id: 'v1', tag_name: 'Temp_T1', description: '', plc_address: 'DB1.DBW4',
    data_type: 'INT16', direction: 'READWRITE', scaling_enabled: true,
    raw_min: 0, raw_max: 32767, eng_min: 0, eng_max: 100, eng_unit: '°C',
    group: '', poll_rate_ms: 1000, enabled: true, connection_id: 'c1',
    ...overrides,
  });
  const mkConn = (overrides: Partial<PLCConnectionConfig> = {}): PLCConnectionConfig => ({
    id: 'c1', name: 'F01-PLC', protocol: 's7', ip: '192.168.1.10', port: 102,
    enabled: true, s7_db: 1, rack: 0, slot: 1,
    heartbeat_write_address: 'VB400', heartbeat_read_address: 'VB401',
    heartbeat_timeout_ms: 5000, reconnect_interval_ms: 3000,
    ...overrides,
  });

  it('confirmed !== true → 400 confirmation required', () => {
    const r = prepareWrite('v1', { value: 1, confirmed: false }, [mkVar()], [mkConn()]);
    expect(r).toEqual({ ok: false, status: 400, error: 'confirmation required' });
  });

  it('value 非数字 → 400', () => {
    const r = prepareWrite('v1', { value: 'oops', confirmed: true } as any, [mkVar()], [mkConn()]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('variable 不存在 → 404', () => {
    const r = prepareWrite('missing', { value: 50, confirmed: true }, [mkVar()], [mkConn()]);
    expect(r).toEqual({ ok: false, status: 404, error: 'variable not found' });
  });

  it('direction=READ → 400 read-only tag', () => {
    const r = prepareWrite('v1', { value: 50, confirmed: true }, [mkVar({ direction: 'READ' })], [mkConn()]);
    expect(r).toEqual({ ok: false, status: 400, error: 'read-only tag' });
  });

  it('data_type=BOOL → 400 not yet supported', () => {
    const r = prepareWrite('v1', { value: 1, confirmed: true },
      [mkVar({ data_type: 'BOOL', plc_address: 'V200.0' })], [mkConn()]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/BOOL/);
  });

  it('地址非法 → 400 address invalid', () => {
    const r = prepareWrite('v1', { value: 50, confirmed: true },
      [mkVar({ plc_address: 'Q0.0' })], [mkConn()]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/address invalid/);
  });

  it('connection 不存在 → 404 connection not found', () => {
    const r = prepareWrite('v1', { value: 50, confirmed: true }, [mkVar()], []);
    expect(r).toEqual({ ok: false, status: 404, error: 'connection not found' });
  });

  it('成功: INT16 scaled → raw + buf 正确', () => {
    const r = prepareWrite('v1', { value: 50, confirmed: true }, [mkVar()], [mkConn()]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.raw).toBe(16384);
      expect(r.buf.length).toBe(2);
      expect(r.buf.readInt16BE(0)).toBe(16384);
      expect(r.db).toBe(1);
      expect(r.parsed.byte).toBe(4);
    }
  });

  it('成功: FLOAT32 scaling_disabled → raw=value, 4 bytes', () => {
    const v = mkVar({ data_type: 'FLOAT32', plc_address: 'DB1.DBD8', scaling_enabled: false });
    const r = prepareWrite('v1', { value: 3.14, confirmed: true }, [v], [mkConn()]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.raw).toBeCloseTo(3.14);
      expect(r.buf.length).toBe(4);
      expect(r.buf.readFloatBE(0)).toBeCloseTo(3.14);
    }
  });
});
