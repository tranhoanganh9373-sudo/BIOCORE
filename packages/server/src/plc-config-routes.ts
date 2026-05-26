// ============================================================
// plc-config-routes.ts — SP-PLC-3 P2.4 PLC 变量动态配置 + scheduler 热生效
// ============================================================
// Routes (mounted under /api/v1):
//   PUT /plc/variables/:id   body: { poll_rate_ms?: number, ...其它字段 }
//
// 行为 (plan §1 Commit 4):
//   1. 未登录 → 401; 非 admin → 403 (复用 admin-only 入口语义, 与旧 inline 等价)
//   2. body.poll_rate_ms 仅允许 100 / 1000 / 10000 (Q(vi) 3 档) → 否则 400
//   3. variable 不存在 → 404
//   4. varManager.upsertVariable 写 DB (保留旧 inline endpoint 行为)
//   5. 找 variable.connection_id 绑定的所有 reactor, 调
//      pollingSchedulers.get(reactorId)?.restart() 让新 poll_rate_ms 热生效
//   6. audit_logs 落 plc_variable_update 行
// ============================================================
//
// 注: 本路由覆盖 index.ts 旧 inline PUT (line 944-947). 旧 inline 不做 scheduler
// 热生效, 也无 audit. 新路由保留 admin-only 入口语义不变.

import type { Router, Request, Response } from 'express';
import type { PLCVariableMapping } from '@biocore/plc-driver';

/** poll_rate_ms 仅允许的 3 档 (plan §1 Commit 4 Q(vi)) */
const ALLOWED_POLL_RATES = [100, 1000, 10000] as const;

export interface PlcConfigAuditEntry {
  user_id: string;
  action: string;
  target_type: string;
  target_id?: string;
  old_value?: string;
  new_value?: string;
  ip_address?: string;
}

/** scheduler 接口的最小子集 (避免 import 整个 plc-driver 主 entry, 见 index.ts:3262 注) */
export interface SchedulerRestartable {
  restart(): void;
}

export interface PlcConfigDeps {
  /** 查变量 (按 id) */
  getVariableById: (id: string) => PLCVariableMapping | undefined;
  /** 写变量 (upsert 全字段) */
  upsertVariable: (v: PLCVariableMapping) => void;
  /** reactor_id → scheduler 实例; PUT 后按 connection_id 反查 reactor 调 restart */
  pollingSchedulers: Map<string, SchedulerRestartable>;
  /** plc_id → 绑定的 reactor_id 列表 (1 个 plc 可被 1 个 reactor 绑定, 但接口返列表保险) */
  getReactorIdsByPlcId: (plcId: string) => string[];
  /** 审计落库 */
  writeAuditLog: (entry: PlcConfigAuditEntry) => void;
}

export function registerPlcConfigRoutes(apiRouter: Router, deps: PlcConfigDeps): void {
  apiRouter.put('/plc/variables/:id', async (req: Request, res: Response) => {
    const user = (req as any).user;
    if (!user) {
      res.status(401).json({ success: false, error: '未认证' });
      return;
    }
    // admin-only (与旧 inline PUT 等价, plan §1 Commit 4 未要求扩 engineer)
    if (user.role !== 'admin') {
      res.status(403).json({ success: false, error: 'Forbidden: requires role admin' });
      return;
    }

    const { id } = req.params;
    const body = (req.body ?? {}) as Partial<PLCVariableMapping>;

    // 校验 poll_rate_ms (仅当字段出现时校验, 不出现 = partial update 不动)
    if (body.poll_rate_ms !== undefined) {
      if (!ALLOWED_POLL_RATES.includes(body.poll_rate_ms as 100 | 1000 | 10000)) {
        res.status(400).json({
          success: false,
          error: `poll_rate_ms 必须为 ${ALLOWED_POLL_RATES.join('/')} 之一`,
        });
        return;
      }
    }

    const existing = deps.getVariableById(id);
    if (!existing) {
      res.status(404).json({ success: false, error: 'variable 不存在' });
      return;
    }

    // partial update: 旧字段为底, body 字段覆盖, id 强制锁
    const merged: PLCVariableMapping = { ...existing, ...body, id };

    try {
      deps.upsertVariable(merged);
    } catch (e) {
      res.status(400).json({ success: false, error: (e as Error).message });
      return;
    }

    // poll_rate_ms 变化时热重启对应 reactor 的 scheduler
    const pollChanged =
      body.poll_rate_ms !== undefined && body.poll_rate_ms !== existing.poll_rate_ms;
    const restartedReactors: string[] = [];
    if (pollChanged) {
      const reactorIds = deps.getReactorIdsByPlcId(existing.connection_id);
      for (const reactorId of reactorIds) {
        const scheduler = deps.pollingSchedulers.get(reactorId);
        if (scheduler) {
          scheduler.restart();
          restartedReactors.push(reactorId);
        }
      }
    }

    deps.writeAuditLog({
      user_id: user.user_id,
      action: 'plc_variable_update',
      target_type: 'plc_variable',
      target_id: id,
      old_value: JSON.stringify({ poll_rate_ms: existing.poll_rate_ms }),
      new_value: JSON.stringify({
        poll_rate_ms: merged.poll_rate_ms,
        restartedReactors,
      }),
      ip_address: req.ip,
    });

    res.json({
      success: true,
      data: { id, poll_rate_ms: merged.poll_rate_ms, restartedReactors },
    });
  });
}
