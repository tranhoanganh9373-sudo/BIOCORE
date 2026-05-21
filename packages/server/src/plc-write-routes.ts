// ============================================================
// plc-write-routes.ts — SP-PLC-2 受控 PLC 写入 + audit
// ============================================================
// Routes (mounted under /api/v1):
//   POST /plc/variables/:id/write   body: { value: number, confirmed: true }
//
// 行为:
//   1. 未登录 → 401
//   2. prepareWrite 校验 (confirmed / direction / address / connection) → 4xx + audit
//   3. 调注入的 performWrite(prep) 实际写 PLC → 成功/失败均落 audit_logs
// ============================================================

import type { Router } from 'express';
import type { PLCConnectionConfig, PLCVariableMapping, WriteSuccess } from './plc-bridge';
import { prepareWrite } from './plc-bridge';

export interface PlcWriteAuditEntry {
  user_id: string;
  action: string;
  target_type: string;
  target_id?: string;
  new_value?: string;
  ip_address?: string;
}

export interface PlcWriteDeps {
  getVariables: () => PLCVariableMapping[];
  getConnections: () => PLCConnectionConfig[];
  writeAuditLog: (entry: PlcWriteAuditEntry) => void;
  performWrite: (prep: WriteSuccess) => Promise<void>;
}

export function registerPlcWriteRoute(apiRouter: Router, deps: PlcWriteDeps): void {
  apiRouter.post('/plc/variables/:id/write', async (req, res) => {
    const user = (req as any).user;
    if (!user) {
      res.status(401).json({ success: false, error: '未认证' });
      return;
    }

    const prep = prepareWrite(req.params.id, req.body ?? {}, deps.getVariables(), deps.getConnections());

    if (!prep.ok) {
      deps.writeAuditLog({
        user_id: user.user_id,
        action: 'plc-write-rejected',
        target_type: 'plc_variable',
        target_id: req.params.id,
        new_value: JSON.stringify({ value: (req.body ?? {}).value, error: prep.error }),
        ip_address: req.ip,
      });
      res.status(prep.status).json({ success: false, error: prep.error });
      return;
    }

    try {
      await deps.performWrite(prep);
      deps.writeAuditLog({
        user_id: user.user_id,
        action: 'plc-write',
        target_type: 'plc_variable',
        target_id: prep.variable.id,
        new_value: JSON.stringify({
          tag: prep.variable.tag_name,
          address: prep.variable.plc_address,
          value: req.body.value,
          raw: prep.raw,
        }),
        ip_address: req.ip,
      });
      res.json({
        success: true,
        wrote: req.body.value,
        raw: prep.raw,
        address: prep.variable.plc_address,
      });
    } catch (e) {
      const msg = (e as Error).message;
      deps.writeAuditLog({
        user_id: user.user_id,
        action: 'plc-write-failed',
        target_type: 'plc_variable',
        target_id: prep.variable.id,
        new_value: JSON.stringify({ value: req.body.value, error: msg }),
        ip_address: req.ip,
      });
      res.status(500).json({ success: false, error: msg });
    }
  });
}
