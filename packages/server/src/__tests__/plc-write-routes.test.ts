// ============================================================
// plc-write-routes.test.ts — SP-PLC-2 TDD
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerPlcWriteRoute } from '../plc-write-routes';
import type { PLCConnectionConfig, PLCVariableMapping, WriteSuccess } from '../plc-bridge';

const sampleVar = (overrides: Partial<PLCVariableMapping> = {}): PLCVariableMapping => ({
  id: 'var1', tag_name: 'Temp_T1', description: '', plc_address: 'DB1.DBW4',
  data_type: 'INT16', direction: 'READWRITE', scaling_enabled: true,
  raw_min: 0, raw_max: 32767, eng_min: 0, eng_max: 100, eng_unit: '°C',
  group: '', poll_rate_ms: 1000, enabled: true, connection_id: 'c1',
  ...overrides,
});

const sampleConn = (): PLCConnectionConfig => ({
  id: 'c1', name: 'F01-PLC', protocol: 's7', ip: '192.168.1.10', port: 102,
  enabled: true, s7_db: 1, rack: 0, slot: 1,
  heartbeat_write_address: 'VB400', heartbeat_read_address: 'VB401',
  heartbeat_timeout_ms: 5000, reconnect_interval_ms: 3000,
});

function makeApp(opts: {
  user?: { user_id: string; role: string } | null;
  variables?: PLCVariableMapping[];
  connections?: PLCConnectionConfig[];
  performWrite?: (prep: WriteSuccess) => Promise<void>;
}) {
  const audits: any[] = [];
  const performWrite = opts.performWrite ?? (() => Promise.resolve());
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (opts.user !== undefined) (req as any).user = opts.user;
    else (req as any).user = { user_id: 'u_admin', role: 'admin' };
    next();
  });
  const router = express.Router();
  registerPlcWriteRoute(router, {
    getVariables: () => opts.variables ?? [sampleVar()],
    getConnections: () => opts.connections ?? [sampleConn()],
    writeAuditLog: (e) => audits.push(e),
    performWrite,
  });
  app.use('/api/v1', router);
  return { app, audits };
}

describe('POST /api/v1/plc/variables/:id/write — auth', () => {
  it('未登录 → 401', async () => {
    const { app, audits } = makeApp({ user: null });
    const res = await request(app).post('/api/v1/plc/variables/var1/write')
      .send({ value: 50, confirmed: true });
    expect(res.status).toBe(401);
    expect(audits.length).toBe(0);
  });
});

describe('POST /plc/variables/:id/write — rejected + audit', () => {
  it('缺 confirmed → 400 + audit rejected', async () => {
    const { app, audits } = makeApp({});
    const res = await request(app).post('/api/v1/plc/variables/var1/write')
      .send({ value: 50 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/confirmation/);
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('plc-write-rejected');
    expect(audits[0].user_id).toBe('u_admin');
  });

  it('READ 标记 → 400 + audit rejected', async () => {
    const { app, audits } = makeApp({ variables: [sampleVar({ direction: 'READ' })] });
    const res = await request(app).post('/api/v1/plc/variables/var1/write')
      .send({ value: 50, confirmed: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/read-only/);
    expect(audits[0].action).toBe('plc-write-rejected');
  });

  it('variable 不存在 → 404 + audit rejected', async () => {
    const { app, audits } = makeApp({});
    const res = await request(app).post('/api/v1/plc/variables/nope/write')
      .send({ value: 50, confirmed: true });
    expect(res.status).toBe(404);
    expect(audits[0].action).toBe('plc-write-rejected');
  });
});

describe('POST /plc/variables/:id/write — success', () => {
  it('confirmed=true + READWRITE → 200 + audit + performWrite 调用一次', async () => {
    const performWrite = vi.fn().mockResolvedValue(undefined);
    const { app, audits } = makeApp({ performWrite });
    const res = await request(app).post('/api/v1/plc/variables/var1/write')
      .send({ value: 50, confirmed: true });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.wrote).toBe(50);
    expect(res.body.raw).toBe(16384);
    expect(performWrite).toHaveBeenCalledTimes(1);
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('plc-write');
    const newVal = JSON.parse(audits[0].new_value);
    expect(newVal.value).toBe(50);
    expect(newVal.raw).toBe(16384);
  });
});

describe('POST /plc/variables/:id/write — performWrite failure', () => {
  it('performWrite throws → 500 + audit failed', async () => {
    const performWrite = vi.fn().mockRejectedValue(new Error('S7连接失败: errCode=-2'));
    const { app, audits } = makeApp({ performWrite });
    const res = await request(app).post('/api/v1/plc/variables/var1/write')
      .send({ value: 50, confirmed: true });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/S7连接失败/);
    expect(audits[0].action).toBe('plc-write-failed');
  });
});
