// ============================================================
// plc-variable-update.test.ts — SP-PLC-3 P2.4 TDD
// ============================================================
// 覆盖 plc-config-routes.ts PUT /plc/variables/:id 5 路径:
//   1. PUT poll_rate_ms=100 → DB upsert spy + scheduler.restart spy
//   2. PUT poll_rate_ms 非法值 (e.g. 500) → 400, 不动 DB + scheduler
//   3. PUT 不存在 variable id → 404
//   4. PUT 不带 poll_rate_ms (partial update) → 200, 不触发 scheduler.restart
//   5. 并发 PUT 同 variable → 后写赢 + 各自触发 scheduler.restart
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerPlcConfigRoutes, type SchedulerRestartable } from '../plc-config-routes';
import type { PLCVariableMapping } from '@biocore/plc-driver';

const sampleVar = (overrides: Partial<PLCVariableMapping> = {}): PLCVariableMapping => ({
  id: 'var1', tag_name: 'TEMP_PV', description: '罐温',
  plc_address: 'VW100', data_type: 'INT16', direction: 'READ',
  scaling_enabled: true, raw_min: 0, raw_max: 27648,
  eng_min: 0, eng_max: 150, eng_unit: '°C',
  group: '模拟量输入', poll_rate_ms: 1000, enabled: true,
  connection_id: 'plc1',
  ...overrides,
});

function makeApp(opts: {
  user?: { user_id: string; role: string } | null;
  variables?: PLCVariableMapping[];
  /** plc_id → reactor_id list (binding 反查) */
  bindings?: Record<string, string[]>;
  /** reactor_id → scheduler mock (restart spy) */
  schedulers?: Map<string, SchedulerRestartable>;
  /** upsert 抛 (e.g. 验证失败) */
  upsertThrows?: Error;
}) {
  const variables = opts.variables ?? [sampleVar()];
  // 用 in-mem Map 模拟 DB upsert (并发 last-write-wins 行为)
  const varMap = new Map<string, PLCVariableMapping>(variables.map((v) => [v.id, v]));
  const upsertSpy = vi.fn((v: PLCVariableMapping) => {
    if (opts.upsertThrows) throw opts.upsertThrows;
    varMap.set(v.id, v);
  });
  const audits: any[] = [];
  const schedulers = opts.schedulers ?? new Map<string, SchedulerRestartable>();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (opts.user !== undefined) (req as any).user = opts.user;
    else (req as any).user = { user_id: 'u_admin', role: 'admin' };
    next();
  });
  const router = express.Router();
  registerPlcConfigRoutes(router, {
    getVariableById: (id) => varMap.get(id),
    upsertVariable: upsertSpy,
    pollingSchedulers: schedulers,
    getReactorIdsByPlcId: (plcId) => opts.bindings?.[plcId] ?? [],
    writeAuditLog: (e) => audits.push(e),
  });
  app.use('/api/v1', router);
  return { app, audits, upsertSpy, schedulers, varMap };
}

describe('PUT /api/v1/plc/variables/:id — auth', () => {
  it('未登录 → 401', async () => {
    const { app, upsertSpy, audits } = makeApp({ user: null });
    const res = await request(app).put('/api/v1/plc/variables/var1')
      .send({ poll_rate_ms: 100 });
    expect(res.status).toBe(401);
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it('非 admin → 403', async () => {
    const { app, upsertSpy } = makeApp({
      user: { user_id: 'u_op', role: 'operator' },
    });
    const res = await request(app).put('/api/v1/plc/variables/var1')
      .send({ poll_rate_ms: 100 });
    expect(res.status).toBe(403);
    expect(upsertSpy).not.toHaveBeenCalled();
  });
});

describe('PUT /api/v1/plc/variables/:id — Test 1: 正常 poll_rate_ms 改动', () => {
  it('PUT poll_rate_ms=100 → DB 写入 + scheduler.restart 调用', async () => {
    const restartSpy = vi.fn();
    const schedulers = new Map<string, SchedulerRestartable>([
      ['reactor_F01', { restart: restartSpy }],
    ]);
    const { app, upsertSpy, audits } = makeApp({
      schedulers,
      bindings: { plc1: ['reactor_F01'] },
    });

    const res = await request(app).put('/api/v1/plc/variables/var1')
      .send({ poll_rate_ms: 100 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.poll_rate_ms).toBe(100);
    expect(res.body.data.restartedReactors).toEqual(['reactor_F01']);

    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy.mock.calls[0][0].poll_rate_ms).toBe(100);
    expect(upsertSpy.mock.calls[0][0].id).toBe('var1');
    // 旧字段保留 (merged)
    expect(upsertSpy.mock.calls[0][0].tag_name).toBe('TEMP_PV');

    expect(restartSpy).toHaveBeenCalledTimes(1);

    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('plc_variable_update');
    expect(JSON.parse(audits[0].old_value).poll_rate_ms).toBe(1000);
    expect(JSON.parse(audits[0].new_value).poll_rate_ms).toBe(100);
  });
});

describe('PUT /api/v1/plc/variables/:id — Test 2: poll_rate_ms 非法值', () => {
  it('PUT poll_rate_ms=500 → 400, 不动 DB 不触发 scheduler', async () => {
    const restartSpy = vi.fn();
    const schedulers = new Map<string, SchedulerRestartable>([
      ['reactor_F01', { restart: restartSpy }],
    ]);
    const { app, upsertSpy, audits } = makeApp({
      schedulers,
      bindings: { plc1: ['reactor_F01'] },
    });

    const res = await request(app).put('/api/v1/plc/variables/var1')
      .send({ poll_rate_ms: 500 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/poll_rate_ms/);
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(restartSpy).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it('PUT poll_rate_ms=0 → 400', async () => {
    const { app, upsertSpy } = makeApp({});
    const res = await request(app).put('/api/v1/plc/variables/var1')
      .send({ poll_rate_ms: 0 });
    expect(res.status).toBe(400);
    expect(upsertSpy).not.toHaveBeenCalled();
  });
});

describe('PUT /api/v1/plc/variables/:id — Test 3: 不存在 variable id', () => {
  it('PUT 不存在 id → 404', async () => {
    const restartSpy = vi.fn();
    const schedulers = new Map<string, SchedulerRestartable>([
      ['reactor_F01', { restart: restartSpy }],
    ]);
    const { app, upsertSpy, audits } = makeApp({
      schedulers,
      bindings: { plc1: ['reactor_F01'] },
    });

    const res = await request(app).put('/api/v1/plc/variables/nonexistent_var')
      .send({ poll_rate_ms: 100 });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/不存在/);
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(restartSpy).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });
});

describe('PUT /api/v1/plc/variables/:id — Test 4: partial update 不带 poll_rate_ms', () => {
  it('PUT 仅改 description (无 poll_rate_ms) → 200 不触发 scheduler.restart', async () => {
    const restartSpy = vi.fn();
    const schedulers = new Map<string, SchedulerRestartable>([
      ['reactor_F01', { restart: restartSpy }],
    ]);
    const { app, upsertSpy } = makeApp({
      schedulers,
      bindings: { plc1: ['reactor_F01'] },
    });

    const res = await request(app).put('/api/v1/plc/variables/var1')
      .send({ description: '罐温 (更新)' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // poll_rate_ms 不动 (merged 后仍为 1000)
    expect(res.body.data.poll_rate_ms).toBe(1000);
    expect(res.body.data.restartedReactors).toEqual([]);

    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy.mock.calls[0][0].description).toBe('罐温 (更新)');
    expect(upsertSpy.mock.calls[0][0].poll_rate_ms).toBe(1000);

    // 关键: 未变 poll_rate_ms, scheduler.restart 不应被调
    expect(restartSpy).not.toHaveBeenCalled();
  });

  it('PUT poll_rate_ms = 旧值 → 200 不触发 scheduler.restart', async () => {
    const restartSpy = vi.fn();
    const schedulers = new Map<string, SchedulerRestartable>([
      ['reactor_F01', { restart: restartSpy }],
    ]);
    const { app } = makeApp({
      schedulers,
      bindings: { plc1: ['reactor_F01'] },
    });

    const res = await request(app).put('/api/v1/plc/variables/var1')
      .send({ poll_rate_ms: 1000 }); // 旧值就是 1000

    expect(res.status).toBe(200);
    expect(restartSpy).not.toHaveBeenCalled();
  });
});

describe('PUT /api/v1/plc/variables/:id — Test 5: 并发 PUT 同 variable', () => {
  it('两次并发 PUT (100 → 10000) → 后写赢 + 各自触发 scheduler.restart', async () => {
    const restartSpy = vi.fn();
    const schedulers = new Map<string, SchedulerRestartable>([
      ['reactor_F01', { restart: restartSpy }],
    ]);
    const { app, upsertSpy, varMap } = makeApp({
      schedulers,
      bindings: { plc1: ['reactor_F01'] },
    });

    // 并发 fire 2 个 PUT
    const [res1, res2] = await Promise.all([
      request(app).put('/api/v1/plc/variables/var1').send({ poll_rate_ms: 100 }),
      request(app).put('/api/v1/plc/variables/var1').send({ poll_rate_ms: 10000 }),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // 两次 upsert 各一次 (并发非冲突, in-mem Map last-write-wins)
    expect(upsertSpy).toHaveBeenCalledTimes(2);
    // 两次 scheduler.restart 都被触发 (各自的 poll_rate 都变了)
    expect(restartSpy).toHaveBeenCalledTimes(2);

    // 最终 DB 状态: 是后写的那一个 (顺序不定, 但两值之一)
    const finalVar = varMap.get('var1');
    expect(finalVar).toBeDefined();
    expect([100, 10000]).toContain(finalVar!.poll_rate_ms);
  });
});
