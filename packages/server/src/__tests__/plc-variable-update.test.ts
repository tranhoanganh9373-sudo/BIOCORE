// ============================================================
// plc-variable-update.test.ts — SP-PLC-3 P2.4 + P3a.3 TDD
// ============================================================
// 覆盖 plc-config-routes.ts PUT /plc/variables/:id:
//   1. PUT poll_rate_ms=100 → DB upsert + scheduler.removeVariable + addVariable
//   2. PUT poll_rate_ms 非法值 (e.g. 500) → 400, 不动 DB + scheduler
//   3. PUT 不存在 variable id → 404
//   4. PUT 不带 poll_rate_ms (partial update) → 200, 不动 scheduler
//   5. 并发 PUT 同 variable → 后写赢 + 各自 remove+add
//   ── SP-PLC-3 P3a.3 新增 (plan §1 Commit 3) ──
//   6. PUT poll_rate_ms 变化 → restart 不被调 (改走增量) + add 入参为 merged
//   7. PUT poll_rate_ms 变化 → removeVariable 入参为 variable id (按 id 删旧)
//   8. multi-reactor: 1 plc 绑 2 reactor → 2 个 scheduler 各 1×remove+1×add
//
// SP-PLC-3 P3a.3 路径变更: 原 mock 仅 spy .restart, 改后 mock 同时 spy
// .restart/.addVariable/.removeVariable, 路由不再调 restart.
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

/**
 * SP-PLC-3 P3a.3: full scheduler mock (restart + addVariable + removeVariable
 * 三 spy). 路由现走增量路径 (remove+add), restart 应不再被调.
 */
function makeSchedulerMock(): SchedulerRestartable & {
  restart: ReturnType<typeof vi.fn>;
  addVariable: ReturnType<typeof vi.fn>;
  removeVariable: ReturnType<typeof vi.fn>;
} {
  return {
    restart: vi.fn(),
    addVariable: vi.fn(),
    removeVariable: vi.fn(),
  };
}

function makeApp(opts: {
  user?: { user_id: string; role: string } | null;
  variables?: PLCVariableMapping[];
  /** plc_id → reactor_id list (binding 反查) */
  bindings?: Record<string, string[]>;
  /** reactor_id → scheduler mock (restart + add + remove spy) */
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
  it('PUT poll_rate_ms=100 → DB 写入 + scheduler 增量 (remove+add, 不 restart)', async () => {
    const schedMock = makeSchedulerMock();
    const schedulers = new Map<string, SchedulerRestartable>([['reactor_F01', schedMock]]);
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

    // SP-PLC-3 P3a.3: 走增量 — remove+add 各 1 次, restart 不再被调
    expect(schedMock.removeVariable).toHaveBeenCalledTimes(1);
    expect(schedMock.addVariable).toHaveBeenCalledTimes(1);
    expect(schedMock.restart).not.toHaveBeenCalled();

    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('plc_variable_update');
    expect(JSON.parse(audits[0].old_value).poll_rate_ms).toBe(1000);
    expect(JSON.parse(audits[0].new_value).poll_rate_ms).toBe(100);
  });
});

describe('PUT /api/v1/plc/variables/:id — Test 2: poll_rate_ms 非法值', () => {
  it('PUT poll_rate_ms=500 → 400, 不动 DB 不触发 scheduler', async () => {
    const schedMock = makeSchedulerMock();
    const schedulers = new Map<string, SchedulerRestartable>([['reactor_F01', schedMock]]);
    const { app, upsertSpy, audits } = makeApp({
      schedulers,
      bindings: { plc1: ['reactor_F01'] },
    });

    const res = await request(app).put('/api/v1/plc/variables/var1')
      .send({ poll_rate_ms: 500 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/poll_rate_ms/);
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(schedMock.removeVariable).not.toHaveBeenCalled();
    expect(schedMock.addVariable).not.toHaveBeenCalled();
    expect(schedMock.restart).not.toHaveBeenCalled();
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
    const schedMock = makeSchedulerMock();
    const schedulers = new Map<string, SchedulerRestartable>([['reactor_F01', schedMock]]);
    const { app, upsertSpy, audits } = makeApp({
      schedulers,
      bindings: { plc1: ['reactor_F01'] },
    });

    const res = await request(app).put('/api/v1/plc/variables/nonexistent_var')
      .send({ poll_rate_ms: 100 });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/不存在/);
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(schedMock.removeVariable).not.toHaveBeenCalled();
    expect(schedMock.addVariable).not.toHaveBeenCalled();
    expect(schedMock.restart).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });
});

describe('PUT /api/v1/plc/variables/:id — Test 4: partial update 不带 poll_rate_ms', () => {
  it('PUT 仅改 description (无 poll_rate_ms) → 200 不动 scheduler', async () => {
    const schedMock = makeSchedulerMock();
    const schedulers = new Map<string, SchedulerRestartable>([['reactor_F01', schedMock]]);
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

    // 关键: 未变 poll_rate_ms, scheduler 任何方法都不应被调
    expect(schedMock.removeVariable).not.toHaveBeenCalled();
    expect(schedMock.addVariable).not.toHaveBeenCalled();
    expect(schedMock.restart).not.toHaveBeenCalled();
  });

  it('PUT poll_rate_ms = 旧值 → 200 不动 scheduler', async () => {
    const schedMock = makeSchedulerMock();
    const schedulers = new Map<string, SchedulerRestartable>([['reactor_F01', schedMock]]);
    const { app } = makeApp({
      schedulers,
      bindings: { plc1: ['reactor_F01'] },
    });

    const res = await request(app).put('/api/v1/plc/variables/var1')
      .send({ poll_rate_ms: 1000 }); // 旧值就是 1000

    expect(res.status).toBe(200);
    expect(schedMock.removeVariable).not.toHaveBeenCalled();
    expect(schedMock.addVariable).not.toHaveBeenCalled();
    expect(schedMock.restart).not.toHaveBeenCalled();
  });
});

describe('PUT /api/v1/plc/variables/:id — Test 5: 并发 PUT 同 variable', () => {
  it('两次并发 PUT (100 → 10000) → 后写赢 + 各自 remove+add (不 restart)', async () => {
    const schedMock = makeSchedulerMock();
    const schedulers = new Map<string, SchedulerRestartable>([['reactor_F01', schedMock]]);
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
    // SP-PLC-3 P3a.3: 两次都走增量, remove+add 各 2 次, restart 全程 0 次
    expect(schedMock.removeVariable).toHaveBeenCalledTimes(2);
    expect(schedMock.addVariable).toHaveBeenCalledTimes(2);
    expect(schedMock.restart).not.toHaveBeenCalled();

    // 最终 DB 状态: 是后写的那一个 (顺序不定, 但两值之一)
    const finalVar = varMap.get('var1');
    expect(finalVar).toBeDefined();
    expect([100, 10000]).toContain(finalVar!.poll_rate_ms);
  });
});

// ─── SP-PLC-3 P3a.3: 新增 3 tests (plan §1 Commit 3) ────────────────
// 核心断言: PUT poll_rate_ms 变化时, scheduler.restart 完全不被调,
// 改走 removeVariable(id) + addVariable(merged) 增量, 避免 1×poll_rate 空窗.

describe('PUT /api/v1/plc/variables/:id — Test 6 (P3a.3): restart 不被调 + add 入参 = merged', () => {
  it('PUT poll_rate_ms=10000 → restart 0 次, addVariable 入参含新 poll_rate', async () => {
    const schedMock = makeSchedulerMock();
    const schedulers = new Map<string, SchedulerRestartable>([['reactor_F01', schedMock]]);
    const { app } = makeApp({
      schedulers,
      bindings: { plc1: ['reactor_F01'] },
    });

    const res = await request(app).put('/api/v1/plc/variables/var1')
      .send({ poll_rate_ms: 10000 });

    expect(res.status).toBe(200);
    expect(res.body.data.poll_rate_ms).toBe(10000);

    // 核心: P3a.3 走增量, restart 绝不被调
    expect(schedMock.restart).not.toHaveBeenCalled();
    expect(schedMock.removeVariable).toHaveBeenCalledTimes(1);
    expect(schedMock.addVariable).toHaveBeenCalledTimes(1);

    // addVariable 入参是 merged variable (含新 poll_rate_ms + 旧字段保留)
    const addedVar = schedMock.addVariable.mock.calls[0][0];
    expect(addedVar.id).toBe('var1');
    expect(addedVar.poll_rate_ms).toBe(10000);
    expect(addedVar.tag_name).toBe('TEMP_PV'); // 旧字段保留
    expect(addedVar.plc_address).toBe('VW100'); // 旧字段保留
    expect(addedVar.connection_id).toBe('plc1');
  });
});

describe('PUT /api/v1/plc/variables/:id — Test 7 (P3a.3): removeVariable 入参 = variable id', () => {
  it('PUT poll_rate_ms 变化 → removeVariable 按 id 删旧', async () => {
    const schedMock = makeSchedulerMock();
    const schedulers = new Map<string, SchedulerRestartable>([['reactor_F01', schedMock]]);
    const { app } = makeApp({
      schedulers,
      bindings: { plc1: ['reactor_F01'] },
    });

    const res = await request(app).put('/api/v1/plc/variables/var1')
      .send({ poll_rate_ms: 100 });

    expect(res.status).toBe(200);
    expect(schedMock.removeVariable).toHaveBeenCalledTimes(1);
    // 删旧 = 按 variable id (字符串), 不是整 variable 对象
    expect(schedMock.removeVariable.mock.calls[0][0]).toBe('var1');

    // 调用顺序: 先 remove 后 add (upsert 语义, 防止同 id 重复)
    const removeOrder = schedMock.removeVariable.mock.invocationCallOrder[0];
    const addOrder = schedMock.addVariable.mock.invocationCallOrder[0];
    expect(removeOrder).toBeLessThan(addOrder);
  });
});

describe('PUT /api/v1/plc/variables/:id — Test 8 (P3a.3): multi-reactor 各自增量', () => {
  it('1 plc 绑 2 reactor → 2 个 scheduler 各 1×remove+1×add (0 restart)', async () => {
    const schedA = makeSchedulerMock();
    const schedB = makeSchedulerMock();
    const schedulers = new Map<string, SchedulerRestartable>([
      ['reactor_F01', schedA],
      ['reactor_F02', schedB],
    ]);
    const { app } = makeApp({
      schedulers,
      bindings: { plc1: ['reactor_F01', 'reactor_F02'] },
    });

    const res = await request(app).put('/api/v1/plc/variables/var1')
      .send({ poll_rate_ms: 100 });

    expect(res.status).toBe(200);
    expect(res.body.data.restartedReactors).toEqual(['reactor_F01', 'reactor_F02']);

    // 两 scheduler 各 1 次 remove + 1 次 add, 0 restart
    expect(schedA.removeVariable).toHaveBeenCalledTimes(1);
    expect(schedA.addVariable).toHaveBeenCalledTimes(1);
    expect(schedA.restart).not.toHaveBeenCalled();
    expect(schedB.removeVariable).toHaveBeenCalledTimes(1);
    expect(schedB.addVariable).toHaveBeenCalledTimes(1);
    expect(schedB.restart).not.toHaveBeenCalled();

    // 各自 addVariable 入参一致 (同 merged variable)
    expect(schedA.addVariable.mock.calls[0][0].poll_rate_ms).toBe(100);
    expect(schedB.addVariable.mock.calls[0][0].poll_rate_ms).toBe(100);
  });
});
