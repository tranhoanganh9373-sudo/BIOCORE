// ============================================================
// recipe-routes.ts — 配方 (recipes) REST API
// ============================================================
// Extracted from index.ts (route-handler-split, post v1.12.0).
// Behavior preserving — no functional changes; same routes, same payloads,
// same audit, same WS broadcasts.
//
// Routes (mounted under /api/v1):
//   GET    /recipes/pending-approvals        — 审核队列 (legacy)
//   GET    /recipes/pending-review           — 统一审核列表
//   GET    /recipes                          — 列表 (status / is_template 过滤)
//   GET    /recipes/:id                      — 单个 (默认最新或 ?version=)
//   POST   /recipes                          — 创建
//   GET    /recipes/:id/versions             — 版本列表 (M3.1)
//   GET    /recipes/:id/diff                 — deep-diff 两版本 (M3.1)
//   POST   /recipes/:id/save-as-template     — 另存为模板 (M3.3)
//   POST   /recipes/from-template/:tplId     — 从模板实例化 (M3.3)
//   POST   /recipes/:id/submit-for-review    — draft → pending_approval (M3.2)
//   POST   /recipes/:id/reject               — pending_approval → draft (M3.2)
//   POST   /recipes/:id/submit-for-deprecation
//   POST   /recipes/:id/approve-deprecation
//   POST   /recipes/:id/reject-deprecation
//   POST   /recipes/:id/restore
//   POST   /recipes/validate-expression       — DAG branch 表达式校验 (M3.8)
//   POST   /recipes/:id/approve              — pending_approval → approved (admin)
//   POST   /recipes/:id/status               — 状态切换 (admin)
//   DELETE /recipes/:id                      — 删除 (FK 检查)
//
// Dependencies are injected via `deps` so the file stays free of
// module-level singletons / circular imports.
// ============================================================

import type { Router, Request } from 'express';
import type { SQLiteService } from '@biocore/data-service';
import { diff as deepDiff } from 'deep-diff';
import { requireRole } from './middlewares/auth';

export interface RecipeRoutesDeps {
  sqlite: SQLiteService;
  parseRecipeRow: (row: any) => any;
  writeRecipeAudit: (
    req: Request,
    action:
      | 'recipe_submit_review'
      | 'recipe_approve'
      | 'recipe_reject'
      | 'recipe_save_as_template'
      | 'recipe_instantiate_template',
    recipeId: string,
    version: string,
    reason?: string,
    extra?: Record<string, unknown>,
  ) => void;
}

export function registerRecipeRoutes(
  apiRouter: Router,
  deps: RecipeRoutesDeps,
): void {
  const { sqlite, parseRecipeRow, writeRecipeAudit } = deps;

  // M3.2: 审核队列 — 必须放在 /:id 动态路由之前, 否则会被 /:id 拦截
  /**
   * @openapi
   * /recipes/pending-approvals:
   *   get:
   *     summary: 列出待审核的配方 (M3.2)
   *     tags: [Recipes]
   *     responses:
   *       200: { description: pending_approval 配方列表 }
   */
  apiRouter.get('/recipes/pending-approvals', (_req, res) => {
    res.json(sqlite.listPendingApprovals());
  });

  // 统一审核列表 (pending_approval + pending_deprecation)
  apiRouter.get('/recipes/pending-review', (_req, res) => {
    res.json(sqlite.listPendingReview());
  });

  /**
   * @openapi
   * /recipes:
   *   get:
   *     summary: 列出配方 (M5 spec 5.10)
   *     tags: [Recipes]
   *     parameters:
   *       - in: query
   *         name: status
   *         schema: { type: string, enum: [draft, pending_approval, approved, pending_deprecation, deprecated] }
   *         description: 按 status 精确过滤; 留空 = 所有 status
   *       - in: query
   *         name: is_template
   *         schema: { type: string, enum: ['true', '1', 'all'] }
   *         description: |
   *           M3.3 模板过滤:
   *           - 缺省 → 只返回非模板配方
   *           - `true` / `1` → 只返回模板
   *           - `all` → 全部 (含模板和配方)
   *     responses:
   *       200:
   *         description: 配方列表 (按建库顺序)
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 type: object
   *                 properties:
   *                   recipe_id: { type: string }
   *                   version: { type: string }
   *                   status: { type: string }
   *                   is_template: { type: boolean }
   *                   created_at: { type: string, format: date-time }
   *                   metadata: { type: object }
   */
  apiRouter.get('/recipes', (req, res) => {
    const status = req.query.status as string | undefined;
    // M3.3: is_template 过滤
    // 默认 (undefined) → 只返回非模板配方
    // 'true' / '1' → 只返回模板
    // 'all' → 全部 (含模板和配方)
    const isTplRaw = (req.query.is_template as string | undefined)?.toLowerCase();
    let isTemplateFilter: boolean | undefined;
    if (isTplRaw === 'true' || isTplRaw === '1') isTemplateFilter = true;
    else if (isTplRaw === 'all') isTemplateFilter = undefined;
    else isTemplateFilter = false;
    const rows = sqlite.listRecipes(status, { isTemplate: isTemplateFilter });
    res.json(rows.map(parseRecipeRow));
  });

  apiRouter.get('/recipes/:id', (req, res) => {
    const version = req.query.version as string | undefined;
    const recipe = sqlite.getRecipe(req.params.id, version);
    if (!recipe) return res.status(404).json({ error: '配方不存在' });
    res.json(parseRecipeRow(recipe));
  });

  apiRouter.post('/recipes', (req, res) => {
    try {
      // 将execution_mode存入metadata JSON
      const body = { ...req.body };
      const meta = body.metadata ? (typeof body.metadata === 'string' ? JSON.parse(body.metadata) : body.metadata) : {};
      if (body.execution_mode) {
        meta.execution_mode = body.execution_mode;
        delete body.execution_mode;
      }
      body.metadata = meta;
      // createRecipe不接受metadata参数, 需要手动处理
      sqlite.createRecipe(body);
      // 如果有metadata中的execution_mode, 补写
      if (meta.execution_mode) {
        sqlite.getDatabase().prepare('UPDATE recipes SET metadata = ? WHERE recipe_id = ? AND version = ?')
          .run(JSON.stringify(meta), body.recipe_id, body.version);
      }
      res.json({ success: true });
    } catch (e) {
      console.error(`[${new Date().toISOString()}] [ERROR] Recipe creation failed: ${(e as Error).message}`);
      res.status(400).json({ error: '配方创建失败，请检查输入参数' });
    }
  });

  // M3.1: 列出某 recipe_id 的所有版本
  /**
   * @openapi
   * /recipes/{id}/versions:
   *   get:
   *     summary: 列出指定 recipe_id 的所有版本(M3.1 版本血缘)
   *     tags: [Recipes]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: 版本列表 (按 created_at DESC)
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 type: object
   *                 properties:
   *                   recipe_id: { type: string }
   *                   version: { type: string }
   *                   status: { type: string }
   *                   created_at: { type: string, format: date-time }
   *                   created_by: { type: string }
   *                   parent_version: { type: string, nullable: true }
   *                   dag_schema_version: { type: integer }
   */
  apiRouter.get('/recipes/:id/versions', (req, res) => {
    const versions = sqlite.listRecipeVersions(req.params.id);
    res.json(versions);
  });

  // M3.1: 比较两个版本的差异
  /**
   * @openapi
   * /recipes/{id}/diff:
   *   get:
   *     summary: 比较同一 recipe_id 的两个版本(M3.1 deep-diff)
   *     tags: [Recipes]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *       - in: query
   *         name: v1
   *         required: true
   *         schema: { type: string, example: "1.0.0" }
   *       - in: query
   *         name: v2
   *         required: true
   *         schema: { type: string, example: "1.1.0" }
   *     responses:
   *       200:
   *         description: 字段差异列表
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 v1: { type: object }
   *                 v2: { type: object }
   *                 diff:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       kind: { type: string, enum: [E, N, D, A], description: "E=Edited, N=New, D=Deleted, A=Array" }
   *                       path: { type: array, items: { type: string } }
   *                       lhs: {}
   *                       rhs: {}
   *       404: { description: 任一版本不存在 }
   */
  apiRouter.get('/recipes/:id/diff', (req, res) => {
    const v1 = String(req.query.v1 || '');
    const v2 = String(req.query.v2 || '');
    if (!v1 || !v2) return res.status(400).json({ error: '需要 v1 和 v2 参数' });
    const data = sqlite.getRecipeForDiff(req.params.id, v1, v2);
    if (!data) return res.status(404).json({ error: '配方版本不存在' });

    // 用 deep-diff 比对解析后的 recipe (含 phases / dag 字段)
    const r1 = parseRecipeRow(data.v1);
    const r2 = parseRecipeRow(data.v2);
    // 只比对业务字段, 排除时间戳/审批人等元数据
    const project = (r: any) => ({
      name: r.name,
      target_organism: r.target_organism,
      vessel_config: r.vessel_config,
      phases: r.phases,
      dag: r.dag,
      metadata: r.metadata,
    });
    const result = deepDiff(project(r1), project(r2)) || [];
    res.json({
      v1: { version: r1.version, status: r1.status, created_at: r1.created_at },
      v2: { version: r2.version, status: r2.status, created_at: r2.created_at },
      diff: result,
    });
  });

  // M3.3: 把指定 recipe@version 另存为模板
  /**
   * @openapi
   * /recipes/{id}/save-as-template:
   *   post:
   *     summary: 把指定 recipe@version 复制为模板 (M3.3)
   *     tags: [Recipes]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [version]
   *             properties:
   *               version: { type: string, example: "1.0.0" }
   *     responses:
   *       200:
   *         description: 模板创建成功
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success: { type: boolean }
   *                 template_id: { type: string, example: "TPL-ECOLI_V1-1762345..." }
   *                 version: { type: string, example: "1.0.0" }
   */
  apiRouter.post('/recipes/:id/save-as-template', (req: any, res) => {
    try {
      const version = req.body?.version;
      if (!version) return res.status(400).json({ error: '缺少 version' });
      const result = sqlite.saveAsTemplate(req.params.id, version, req.user?.user_id || 'admin-001');
      writeRecipeAudit(req, 'recipe_save_as_template', req.params.id, version, undefined, {
        template_id: (result as any)?.template_id,
      });
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // M3.3: 从模板创建新配方
  /**
   * @openapi
   * /recipes/from-template/{templateId}:
   *   post:
   *     summary: 从模板创建一个新的配方实例 (M3.3)
   *     tags: [Recipes]
   *     parameters:
   *       - in: path
   *         name: templateId
   *         required: true
   *         schema: { type: string, example: "TPL-ECOLI_V1-..." }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [recipe_id, name]
   *             properties:
   *               recipe_id: { type: string, example: "ECOLI_RUN_42" }
   *               name: { type: string, example: "E.coli #42" }
   *               template_version: { type: string, default: "1.0.0" }
   *     responses:
   *       200: { description: 实例化成功 }
   *       400: { description: 缺少 recipe_id 或 name }
   */
  apiRouter.post('/recipes/from-template/:templateId', (req: any, res) => {
    try {
      const { recipe_id, name } = req.body || {};
      const templateVersion = req.body?.template_version || '1.0.0';
      if (!recipe_id || !name) return res.status(400).json({ error: '缺少 recipe_id 或 name' });
      sqlite.instantiateTemplate(
        req.params.templateId,
        templateVersion,
        recipe_id,
        name,
        req.user?.user_id || 'admin-001',
      );
      writeRecipeAudit(req, 'recipe_instantiate_template', recipe_id, '1.0.0', undefined, {
        template_id: req.params.templateId,
        template_version: templateVersion,
        name,
      });
      res.json({ success: true, recipe_id });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // M3.2: 提交审核 (draft → pending_approval)
  /**
   * @openapi
   * /recipes/{id}/submit-for-review:
   *   post:
   *     summary: 提交配方进入审核队列 (draft → pending_approval) (M3.2)
   *     tags: [Recipes]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [version]
   *             properties:
   *               version: { type: string }
   *     responses:
   *       200: { description: 成功 }
   *       400: { description: 状态不是 draft }
   */
  apiRouter.post('/recipes/:id/submit-for-review', (req, res) => {
    const { version } = req.body || {};
    if (!version) return res.status(400).json({ error: '缺少 version' });
    const existing = sqlite.getDatabase().prepare(
      'SELECT status FROM recipes WHERE recipe_id = ? AND version = ?'
    ).get(req.params.id, version) as any;
    if (!existing) return res.status(404).json({ error: '配方版本不存在' });
    if (existing.status !== 'draft') {
      return res.status(400).json({ error: `仅 draft 状态可提交审核, 当前为 ${existing.status}` });
    }
    sqlite.submitForReview(req.params.id, version);
    writeRecipeAudit(req as any, 'recipe_submit_review', req.params.id, version);
    res.json({ success: true });
  });

  // M3.2: 拒绝 (pending_approval → draft + 记录理由)
  /**
   * @openapi
   * /recipes/{id}/reject:
   *   post:
   *     summary: 拒绝审核 (pending_approval → draft, 记录 rejection_reason) (M3.2)
   *     tags: [Recipes]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [version, reason]
   *             properties:
   *               version: { type: string }
   *               reason: { type: string, description: "必填, 拒绝原因将写入 rejection_reason 并审计" }
   *     responses:
   *       200: { description: 成功 }
   *       400: { description: 缺少 reason 或状态不是 pending_approval }
   */
  apiRouter.post('/recipes/:id/reject', (req, res) => {
    const { version, reason } = req.body || {};
    if (!version) return res.status(400).json({ error: '缺少 version' });
    if (!reason || !reason.trim()) return res.status(400).json({ error: '必须提供拒绝原因' });
    const existing = sqlite.getDatabase().prepare(
      'SELECT status FROM recipes WHERE recipe_id = ? AND version = ?'
    ).get(req.params.id, version) as any;
    if (!existing) return res.status(404).json({ error: '配方版本不存在' });
    if (existing.status !== 'pending_approval') {
      return res.status(400).json({ error: `仅 pending_approval 状态可拒绝, 当前为 ${existing.status}` });
    }
    try {
      sqlite.rejectRecipe(req.params.id, version, reason);
      writeRecipeAudit(req as any, 'recipe_reject', req.params.id, version, reason);
      res.json({ success: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // ── 配方废弃流程 ──

  // 提交废弃申请 (draft/approved → pending_deprecation)
  apiRouter.post('/recipes/:id/submit-for-deprecation', (req, res) => {
    const { version } = req.body || {};
    if (!version) return res.status(400).json({ error: '缺少 version' });
    const existing = sqlite.getDatabase().prepare(
      'SELECT status FROM recipes WHERE recipe_id = ? AND version = ?'
    ).get(req.params.id, version) as any;
    if (!existing) return res.status(404).json({ error: '配方版本不存在' });
    if (!['draft', 'approved'].includes(existing.status)) {
      return res.status(400).json({ error: `仅 draft/approved 状态可提交废弃, 当前为 ${existing.status}` });
    }
    sqlite.submitForDeprecation(req.params.id, version);
    res.json({ success: true });
  });

  // 批准废弃 (pending_deprecation → deprecated)
  apiRouter.post('/recipes/:id/approve-deprecation', (req, res) => {
    const { version } = req.body || {};
    if (!version) return res.status(400).json({ error: '缺少 version' });
    const existing = sqlite.getDatabase().prepare(
      'SELECT status FROM recipes WHERE recipe_id = ? AND version = ?'
    ).get(req.params.id, version) as any;
    if (!existing) return res.status(404).json({ error: '配方版本不存在' });
    if (existing.status !== 'pending_deprecation') {
      return res.status(400).json({ error: `仅 pending_deprecation 状态可批准废弃, 当前为 ${existing.status}` });
    }
    const userId = (req as any).user?.user_id || 'admin-001';
    sqlite.approveDeprecation(req.params.id, version, userId);
    res.json({ success: true });
  });

  // 拒绝废弃 (回到 pre_deprecation_status)
  apiRouter.post('/recipes/:id/reject-deprecation', (req, res) => {
    const { version, reason } = req.body || {};
    if (!version) return res.status(400).json({ error: '缺少 version' });
    if (!reason || !reason.trim()) return res.status(400).json({ error: '必须提供拒绝原因' });
    const existing = sqlite.getDatabase().prepare(
      'SELECT status FROM recipes WHERE recipe_id = ? AND version = ?'
    ).get(req.params.id, version) as any;
    if (!existing) return res.status(404).json({ error: '配方版本不存在' });
    if (existing.status !== 'pending_deprecation') {
      return res.status(400).json({ error: `仅 pending_deprecation 状态可拒绝废弃, 当前为 ${existing.status}` });
    }
    try {
      sqlite.rejectDeprecation(req.params.id, version, reason);
      res.json({ success: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // 从废弃恢复到草稿
  apiRouter.post('/recipes/:id/restore', (req, res) => {
    const { version } = req.body || {};
    if (!version) return res.status(400).json({ error: '缺少 version' });
    const existing = sqlite.getDatabase().prepare(
      'SELECT status FROM recipes WHERE recipe_id = ? AND version = ?'
    ).get(req.params.id, version) as any;
    if (!existing) return res.status(404).json({ error: '配方版本不存在' });
    if (existing.status !== 'deprecated') {
      return res.status(400).json({ error: `仅 deprecated 状态可恢复, 当前为 ${existing.status}` });
    }
    sqlite.restoreDeprecated(req.params.id, version);
    res.json({ success: true });
  });

  // M3.8: 条件表达式校验 (前端 BranchNode 实时调用)
  /**
   * @openapi
   * /recipes/validate-expression:
   *   post:
   *     summary: 校验 DAG branch 节点的条件表达式 (M3.8)
   *     tags: [Recipes]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [expression]
   *             properties:
   *               expression: { type: string, example: "OD600 > 5 && temperature >= 37" }
   *     responses:
   *       200:
   *         description: 校验结果
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 valid: { type: boolean }
   *                 error: { type: string, nullable: true }
   *                 usedFields:
   *                   type: array
   *                   items: { type: string }
   *                 ast: { type: object }
   */
  apiRouter.post('/recipes/validate-expression', (req, res) => {
    try {
      const { parseExpression } = require('../../batch-engine/src/condition-evaluator');
      const expression = String(req.body?.expression || '');
      const result = parseExpression(expression);
      if (result.ok) {
        res.json({ valid: true, ast: result.ast, usedFields: result.usedFields });
      } else {
        res.json({ valid: false, error: result.error });
      }
    } catch (e) {
      res.status(500).json({ valid: false, error: (e as Error).message });
    }
  });

  // 审批/锁定配方 (M3.2 加严: 仅 pending_approval 可以)
  /**
   * @openapi
   * /recipes/{id}/approve:
   *   post:
   *     summary: 批准配方 (pending_approval → approved) (M3.2 增强)
   *     tags: [Recipes]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [version]
   *             properties:
   *               version: { type: string }
   *               approved_by: { type: string, description: "M3.2 加入的审批人记录" }
   *     responses:
   *       200: { description: 批准成功 }
   */
  apiRouter.post('/recipes/:id/approve', requireRole('admin'), (req, res) => {
    sqlite.approveRecipe(req.params.id, req.body.version, req.body.approved_by || 'admin-001');
    writeRecipeAudit(req as any, 'recipe_approve', req.params.id, req.body.version, undefined, {
      approved_by: req.body.approved_by || 'admin-001',
    });
    res.json({ success: true });
  });

  // 锁定/解锁配方 (draft↔approved↔archived)
  apiRouter.post('/recipes/:id/status', requireRole('admin'), (req, res) => {
    const { version, status } = req.body;
    if (!['draft', 'approved', 'archived', 'superseded', 'deprecated', 'pending_deprecation'].includes(status)) {
      return res.status(400).json({ error: '无效状态' });
    }
    sqlite.getDatabase().prepare(
      'UPDATE recipes SET status = ? WHERE recipe_id = ? AND version = ?'
    ).run(status, req.params.id, version);
    res.json({ success: true });
  });

  // 删除配方（先检查关联批次和 DoE 研究）
  apiRouter.delete('/recipes/:id', (req, res) => {
    const version = req.query.version as string | undefined;
    const db = sqlite.getDatabase();
    const recipeId = req.params.id;

    // 检查关联批次
    const batchCount = version
      ? (db.prepare('SELECT COUNT(*) as cnt FROM batches WHERE recipe_id = ? AND recipe_version = ?').get(recipeId, version) as any)?.cnt ?? 0
      : (db.prepare('SELECT COUNT(*) as cnt FROM batches WHERE recipe_id = ?').get(recipeId) as any)?.cnt ?? 0;
    if (batchCount > 0) {
      return res.status(409).json({
        error: `无法删除：该配方已关联 ${batchCount} 个批次记录，请先删除相关批次`,
        code: 'FK_BATCHES',
        batchCount,
      });
    }

    // 检查关联 DoE 研究
    try {
      const doeCount = version
        ? (db.prepare('SELECT COUNT(*) as cnt FROM doe_studies WHERE base_recipe_id = ? AND base_recipe_version = ?').get(recipeId, version) as any)?.cnt ?? 0
        : (db.prepare('SELECT COUNT(*) as cnt FROM doe_studies WHERE base_recipe_id = ?').get(recipeId) as any)?.cnt ?? 0;
      if (doeCount > 0) {
        return res.status(409).json({
          error: `无法删除：该配方被 ${doeCount} 个 DoE 研究引用，请先删除相关研究`,
          code: 'FK_DOE',
          doeCount,
        });
      }
    } catch { /* doe_studies 表可能不存在，忽略 */ }

    try {
      if (version) {
        db.prepare('DELETE FROM recipes WHERE recipe_id = ? AND version = ?').run(recipeId, version);
      } else {
        db.prepare('DELETE FROM recipes WHERE recipe_id = ?').run(recipeId);
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(409).json({
        error: `删除失败：${err.message ?? '存在关联数据'}`,
        code: 'FK_UNKNOWN',
      });
    }
  });
}
