// ============================================================
// BIOCore 主服务器
// 串联: plc-driver + batch-engine + data-service
// 对外: REST API + WebSocket 实时推送
// ============================================================
//
// IMPORT CONVENTION (v1.8.0 bucket 2):
//   Always import from package barrels: `@biocore/<pkg>`.
//   Do NOT use deep imports of the form `../../<pkg>/src/<file>`.
//   Each cross-package symbol must travel through the package's
//   `src/index.ts` so the package boundary stays explicit and the
//   public surface is auditable. If a needed symbol is not on the
//   barrel, add it there — do not reach in. ESLint enforcement of
//   `no-restricted-imports` for this rule is tracked as a follow-up
//   (no ESLint config exists in this repo yet).
// ============================================================

// 必须在所有其它 import 前: 提前加载 .env, 让 plc-bridge 等模块 top-level
// 读取 process.env.MOCK_PLC 时拿到正确值 (修复 IL/RF 检测的 'PLC 未连接' 问题)
import './_env';

import http from 'http';
// v1.9.0 P2 bucket 1: WebSocketServer + connection auth + broadcast()
// extracted to ./ws-server. We keep the module-level `wss` and
// `broadcast` references so existing call sites (route handlers,
// wireReactorEvents, gracefulShutdown, /status) keep working unchanged.
import { createWsServer } from './ws-server';
import { createMqttPublisher } from './mqtt-publisher';
import { createMqttSubscriber } from './mqtt-subscriber';
// node-snap7 动态加载: Node v24 可能缺少编译后的 native binding
let S7Client: any;
try {
  S7Client = require('node-snap7').S7Client;
} catch {
  console.warn('[WARN] node-snap7 加载失败 (native binding 缺失), 仅支持 MOCK_PLC=true 模式');
  S7Client = class FakeS7Client { ConnectTo() { throw new Error('node-snap7 不可用'); } };
}
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve as pathResolve } from 'path';
import { v0DeprecationMw, API_V0_SUNSET } from './middlewares/deprecation';
import { authMiddleware, setAuthDb, hashApiKey, requireRole } from './middlewares/auth';
// traceMw moved into ./bootstrap (used in createApp's middleware stack).
import { v1ResponseWrapper } from './middlewares/response-wrapper';
// v1.9.0 P2 bucket 1.7: express app + middleware + apiRouter + swagger
// extracted to ./bootstrap. Swagger scan path is passed in so the
// JSDoc @openapi blocks in this file (and route-handler files) are
// still picked up byte-for-byte.
import { createApp } from './bootstrap';
import { ROOT_VERSION } from './version';
import { lttb } from './lttb';
import { registerBatchCompareRoutes } from './batch-compare-routes';
import { registerBatchSamplesRoutes } from './batch-samples-routes';
import { registerBatchExportRoutes } from './batch-export-routes';
import { registerCalibrationRoutes } from './calibration-routes';
import { registerPermissionRoutes } from './middlewares/permissions';
import { registerDoeRoutes } from './doe-routes';
import { registerKpiRoutes, computeAndStore as computeKpi } from './kpi-routes';
import { registerSpcRoutes } from './spc-routes';
import { registerRecipeRoutes } from './recipe-routes';
import { registerBatchRoutes } from './batch-routes';
import { registerReactorRoutes } from './reactor-routes';
import { registerAuthRoutes } from './auth-routes';
import { registerScadaRoutes } from './scada-routes';
import { registerFuxaViewsRoutes } from './fuxa-views-routes';
import { startScadaWriteDispatcher } from './engine/scada-write-dispatcher';
import { createPlcWriter } from './engine/plc-writer';
import { executeRecipePlcWrite } from './engine/recipe-plc-write';
import { registerAuditLogRoutes } from './audit-log-routes';
import { registerBackupRoutes } from './backup-routes';
// SP-FX-42: Alert notification system
import { registerAlertRoutes } from './alert-routes';
import { createBackupSchedulerFromEnv, BackupScheduler } from './services/backup-scheduler';
// SP-FX-28: Prometheus metrics
import { registerMetricsRoutes } from './metrics-routes';
import { metricsRegistry } from './services/metrics';
import { createMetricsMiddleware } from './middlewares/metrics-middleware';
import type { BatchControllerConfig } from '@biocore/batch-engine';
import {
  installCrashHandlers,
  MemoryWatchdog,
  MetricsCollector,
  writeDiagnosticDump,
} from '@biocore/runtime-guard';
import { AlertRouter, type ChannelDef, type Rule } from '@biocore/notifier';

// ─── Mini .env 加载 (无 dotenv 依赖) ────────────────────────
// 从项目根 .env 读取 KEY=VALUE 行,注入 process.env (已存在的不覆盖)
(function loadEnv() {
  const candidates = [
    pathResolve(process.cwd(), '.env'),
    pathResolve(process.cwd(), '../../.env'),
    pathResolve(__dirname, '../../../.env'),
  ];
  for (const p of candidates) {
    try {
      const text = readFileSync(p, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim();
        if (!(key in process.env)) process.env[key] = value;
      }
      console.log(`[${new Date().toISOString()}] [INFO] 已加载 .env: ${p}`);
      return;
    } catch { /* try next candidate */ }
  }
})();

// ─────────────────────────────────────────────────────────────────────────────
// Runtime Guard — BIOCore 加固 (Sprint 4 Track A, T22)
// crash handler + memory watchdog + metrics collector. 必须在业务逻辑前装上,
// 才能捕获后续 import (PLC native binding / SQLite / migrator) 的错误。
// 见: docs/superpowers/specs/2026-05-01-nodejs-hardening-design.md
// ─────────────────────────────────────────────────────────────────────────────
const RUNTIME_GUARD_DUMP_DIR = process.env.BIOCORE_DIAGNOSTIC_DUMP_DIR ?? './crashes';
const RUNTIME_GUARD_KEEP_LAST = Number(process.env.BIOCORE_DIAGNOSTIC_KEEP_LAST ?? 50);
const RUNTIME_GUARD_OOM_GRACE = Number(process.env.BIOCORE_OOM_GRACE_SAMPLES ?? 3);
const RUNTIME_GUARD_OOM_THRESHOLD_MB =
  process.env.BIOCORE_OOM_THRESHOLD_MB && process.env.BIOCORE_OOM_THRESHOLD_MB !== 'auto'
    ? Number(process.env.BIOCORE_OOM_THRESHOLD_MB)
    : undefined;  // undefined = MetricsCollector/MemoryWatchdog auto = RAM × 20%

export const metricsCollector = new MetricsCollector({
  serviceVersion: ROOT_VERSION,
  oomThresholdMb: RUNTIME_GUARD_OOM_THRESHOLD_MB,
});
metricsCollector.start();

// T40: forward-declared AlertRouter ref so the crash/OOM closures below
// (installed BEFORE sqlite is up) can fire notifier events once the router
// is constructed later in boot. Closures capture this `let` so swapping the
// reference at AlertRouter construction time becomes visible to them.
let alertRouterRef: AlertRouter | undefined;

export const memWd = new MemoryWatchdog({
  thresholdMb: RUNTIME_GUARD_OOM_THRESHOLD_MB,
  graceSamples: RUNTIME_GUARD_OOM_GRACE,
  onExceed: async (info) => {
    console.error('[runtime-guard] memory threshold exceeded', info);
    try {
      await writeDiagnosticDump(new Error('OOM threshold'), 'oom_threshold', {
        dir: RUNTIME_GUARD_DUMP_DIR,
        keepLast: RUNTIME_GUARD_KEEP_LAST,
        extra: info,
      });
    } catch (e) {
      console.error('[runtime-guard] dump on OOM failed:', e);
    }
    // T40: emit oom_threshold to AlertRouter (if up) so configured channels alert.
    if (alertRouterRef) {
      try {
        await alertRouterRef.emit('oom_threshold', {
          rss_mb: info.rss_mb,
          threshold_mb: info.threshold_mb,
          samples: info.samples,
        });
      } catch (e) {
        console.error('[notifier] emit oom_threshold failed:', e);
      }
    }
    if (process.env.NODE_ENV === 'production') {
      console.error('[runtime-guard] sending SIGTERM for supervisor restart');
      process.kill(process.pid, 'SIGTERM');
    } else {
      console.error('[runtime-guard] dev mode: 不自动重启 (需 NODE_ENV=production 才触发 SIGTERM)');
    }
  },
});
memWd.start();

installCrashHandlers({
  onCrash: async (err, type) => {
    console.error(`[runtime-guard] ${type}:`, err.message);
    try {
      await writeDiagnosticDump(err, type, {
        dir: RUNTIME_GUARD_DUMP_DIR,
        keepLast: RUNTIME_GUARD_KEEP_LAST,
      });
    } catch (e) {
      console.error('[runtime-guard] dump failed:', e);
    }
    // T40: emit uncaught_exception to AlertRouter (if up). Best-effort —
    // crash dump is the source of truth; notifier is a courtesy ping.
    if (alertRouterRef) {
      try {
        await alertRouterRef.emit('uncaught_exception', {
          message: err.message,
          stack: err.stack,
          code: (err as { code?: string }).code,
        });
      } catch {
        /* swallow — already crashing */
      }
    }
  },
});

console.log(`[runtime-guard] installed (oom_threshold_mb=${metricsCollector.snapshot().memory.oom_threshold_mb})`);
// ─────────────────────────────────────────────────────────────────────────────

// plc-driver utility functions + MOCK_PLC simulator + variable manager
// (v1.9.0 P2 bucket 1: extracted to ./plc-bridge — see that file for the
// documented plc-driver deep-import EXCEPTION). Importing this module also
// triggers the MOCK_PLC warning banner side-effect when MOCK_PLC=true.
import {
  parseAddr,
  byteLen,
  decode,
  scale,
  validateAddr,
  VariableMappingManager,
  MOCK_PLC,
  devPlcRead,
} from './plc-bridge';
import type { PLCConnectionConfig, PLCVariableMapping } from './plc-bridge';

// soft-sensor + experiment-optimizer (实际算法包)
// v1.9.0 P2 bucket 1: SoftSensorEngine/FeedAdvisor/RootCauseAnalyzer
// singletons + CUSUM per-batch registry are wired in ./ai-wiring.
import { BayesianOptimizer } from '@biocore/experiment-optimizer';
import {
  softSensorEngine,
  feedAdvisor,
  rootCauseAnalyzer,
  cusumDetectors,
  SoftSensorEngine, // class re-export for static trainLinearModel() helper
} from './ai-wiring';
import { registerCusumRoutes, initCusumBaselines, getDefaultBaselines } from './cusum-routes';
import { registerBatchIntelligenceRoutes } from './batch-intelligence-routes';
// v1.9.0 P2 bucket 1: AI suggestion engine boot lifecycle moved into
// ./scheduler (startSchedulers / stopSchedulers).
import { startSchedulers, stopSchedulers } from './scheduler';
import { registerAiReportRoutes, detectReportIntent } from './ai-report-routes';
import { createAdminHealthRouter } from './routes/admin-health';
import { createAdminMetricsRouter } from './routes/admin-metrics';
import { createAdminCrashesRouter } from './routes/admin-crashes';
import { EventStream, createEventsSseRouter } from './routes/events-sse';
import { createNotificationsRouter } from './routes/notifications';
import { listChannels as listNotifChannels, listRules as listNotifRules } from '@biocore/data-service';
// SP-FX-37: 生产健康检查端点
import { registerHealthRoutes } from './health-routes';
// SP-FX-43: Analytics Dashboard
import { registerAnalyticsRoutes } from './analytics-routes';
// SP-PLC-2: 受控 PLC 写入 + audit
import { registerPlcWriteRoute } from './plc-write-routes';

// JWT 认证
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import bcrypt from 'bcrypt';

const PORT = parseInt(process.env.PORT || '3001');
const DATA_DIR = process.env.DATA_DIR || './data';

// ─── SQLite 初始化 ─────────────────────────────────────────

import { SQLiteService, updateBatchCurrentNodeId, updateBatchLoopFrames } from '@biocore/data-service';
import { mkdirSync } from 'fs';
// v1.9.0 P2 bucket 1.6: migration / admin-init / jwt-guard / orphan-recovery
// boot helpers extracted to ./startup.
import {
  setupMigrations,
  ensureAdminAccount,
  assertJwtSecretSafe,
  runOrphanRecoveryScan,
  pickRecoveryPolicyFromEnv,
} from './startup';
import { assertProductionReady } from './production-guards';

mkdirSync(DATA_DIR, { recursive: true });
const sqlite = new SQLiteService(`${DATA_DIR}/biocore.db`);

// v1.7.3 H7: server.listen 必须等到 migrations 完成后再触发。
// setupMigrations 返回的 Promise 在 start() 中被 await; 失败时致命退出。
const migrationsReady: Promise<void> = setupMigrations(sqlite.getDatabase());

// 注入 sqlite 引用到 auth middleware (用于 API Key 验证)
// 注: 此处仅设引用, 不依赖 migrations; 真正的 API Key 校验发生在请求时,
// 那时 migrations 已 await 完成 (start() 中)。
setAuthDb(sqlite.getDatabase());

const varManager = new VariableMappingManager(sqlite.getDatabase());

// ─── InfluxDB 时序数据库 ────────────────────────────────────
import { InfluxDB, Point } from '@influxdata/influxdb-client';

const INFLUX_URL = process.env.INFLUX_URL || 'http://localhost:8086';
const INFLUX_TOKEN = process.env.INFLUX_TOKEN || '';
const INFLUX_ORG = process.env.INFLUX_ORG || 'BIOCore';
const INFLUX_BUCKET = process.env.INFLUX_BUCKET || 'BIOCore_Data';
// P1 修复: 启动时校验 bucket / org 名称只含安全字符, 防止 Flux 注入扩大面
if (!/^[a-zA-Z0-9_-]+$/.test(INFLUX_BUCKET)) {
  throw new Error(`INFLUX_BUCKET 含非法字符: ${INFLUX_BUCKET}`);
}
if (!/^[a-zA-Z0-9_-]+$/.test(INFLUX_ORG)) {
  throw new Error(`INFLUX_ORG 含非法字符: ${INFLUX_ORG}`);
}

const influxClient = INFLUX_TOKEN
  ? new InfluxDB({ url: INFLUX_URL, token: INFLUX_TOKEN })
  : null;
const influxWriteApi = influxClient
  ? influxClient.getWriteApi(INFLUX_ORG, INFLUX_BUCKET, 's')
  : null;
const influxQueryApi = influxClient
  ? influxClient.getQueryApi(INFLUX_ORG)
  : null;

if (influxClient) {
  console.log(`[${new Date().toISOString()}] [INFO] [Influx] 已连接 ${INFLUX_URL} org=${INFLUX_ORG} bucket=${INFLUX_BUCKET}`);
} else {
  console.warn(`[${new Date().toISOString()}] [WARN] [Influx] 未配置 INFLUX_TOKEN, 时序数据写入和查询均禁用`);
}

// v1.9.0 P2 bucket 1: reactor runtime (manager, collector ticks,
// wireReactorEvents, IL/RF metadata) extracted to ./reactor-wiring.
// reactorManager + reactorCollectorTimers are exported singletons; the
// collector / event-bridge functions are produced by createReactorWiring()
// once influx + autoCollectDoeResponses are available below.
import {
  reactorManager,
  reactorCollectorTimers,
  INTERLOCK_META,
  RUNNING_FAULT_META,
  createReactorWiring,
} from './reactor-wiring';
import { initAuditQueue, getAuditQueue } from './audit-queue';
// SP-FX-40: API rate limiting (零依赖 in-memory 固定窗口计数器)
import { rateLimit, defaultRateLimitConfig } from './middlewares/rate-limit';

// Phase模板步骤定义: 从数据库读取, 关联系统设置中的Phase模板配置
// 数据库用 PascalCase (Prepare/AddWater), 引擎用 snake_case (prepare/water_fill)
const PHASE_TYPE_TO_DB: Record<string, string> = {
  prepare: 'Prepare', water_fill: 'AddWater', manual_add: 'ManualAdd',
  heating: 'Heating', temp_control: 'TempControl', agitation: 'Agitation',
  feeding: 'Feeding', ph_control: 'PHControl', do_control: 'DOControl',
  aeration: 'Aeration', discharge: 'Discharge', fermentation: 'Fermentation',
  sip: 'SIP', cip: 'CIP',
};

function getTemplateStepsFromDB(phaseType: string): any[] | null {
  try {
    // 先用原始类型查, 再用映射后的 PascalCase 查
    const dbType = PHASE_TYPE_TO_DB[phaseType] || phaseType;
    let row: any = sqlite.getDatabase().prepare(
      'SELECT steps FROM phase_templates WHERE type = ? OR type = ?'
    ).get(phaseType, dbType);
    if (!row || !row.steps) return null;
    const steps = typeof row.steps === 'string' ? JSON.parse(row.steps) : row.steps;
    if (!Array.isArray(steps) || steps.length === 0) return null;

    // 转换 DB 格式 → 引擎格式
    // DB: { step_number, name, description, completion: { logic, conditions[] }, next_step }
    // 引擎: { step_number, name, description, actions, completion_condition: { type, ... } }
    return steps.map((s: any) => ({
      step_number: s.step_number,
      name: s.name || '',
      description: s.description || '',
      actions: s.actions || [],
      completion_condition: convertCompletion(s.completion),
    }));
  } catch (e) {
    console.warn('[getTemplateStepsFromDB] 读取模板失败:', (e as Error).message);
    return null; // 数据库异常回退硬编码
  }
}

/**
 * 转换 DB completion 格式 → 引擎 completion_condition 格式
 * DB:     { logic: "single"|"and"|"or", conditions: [{type, channel, value, duration_s}] }
 * 引擎:  { type: ">=" | "duration" | "and", channel?, value?, duration_s?, sub_conditions? }
 */
function convertCompletion(completion: any): any {
  if (!completion) return { type: 'duration', duration_s: 10 }; // 默认10秒
  const { logic, conditions } = completion;
  if (!conditions || !Array.isArray(conditions) || conditions.length === 0) {
    return { type: 'duration', duration_s: 10 };
  }

  // 单条件
  if (logic === 'single' || conditions.length === 1) {
    return convertSingleCondition(conditions[0]);
  }

  // 多条件 and/or
  return {
    type: logic === 'or' ? 'or' : 'and',
    sub_conditions: conditions.map(convertSingleCondition),
  };
}

function convertSingleCondition(c: any): any {
  if (!c) return { type: 'duration', duration_s: 10 };
  // 条件格式已经兼容引擎 (type, channel, value, duration_s, tolerance)
  const result: any = { type: c.type };
  if (c.channel) result.channel = c.channel;
  if (c.value !== undefined) result.value = c.value;
  if (c.duration_s !== undefined) result.duration_s = c.duration_s;
  if (c.tolerance !== undefined) result.tolerance = c.tolerance;
  return result;
}

// IL/RF 配置从数据库读取 (反应器优先, 缺失回退全局)
function getInterlockConfigsFromDB(reactorId?: string): any[] {
  try {
    const db = sqlite.getDatabase();
    const rows: any[] = reactorId
      ? db.prepare(`
          WITH merged AS (
            SELECT * FROM interlock_configs WHERE reactor_id = ? AND is_enabled = 1
            UNION ALL
            SELECT g.* FROM interlock_configs g
            WHERE g.reactor_id IS NULL AND g.is_enabled = 1
              AND NOT EXISTS (
                SELECT 1 FROM interlock_configs r
                WHERE r.id = g.id AND r.reactor_id = ?
              )
          )
          SELECT * FROM merged ORDER BY sort_order
        `).all(reactorId, reactorId)
      : db.prepare(
          'SELECT * FROM interlock_configs WHERE reactor_id IS NULL AND is_enabled = 1 ORDER BY sort_order'
        ).all();
    return rows.map((r: any) => ({
      ...r,
      plc_tags: typeof r.plc_tags === 'string' ? JSON.parse(r.plc_tags) : (r.plc_tags || []),
      condition: typeof r.condition === 'string' ? JSON.parse(r.condition) : (r.condition || {}),
    }));
  } catch {
    return []; // 表不存在时回退硬编码
  }
}

// startReactorCollector / stopReactorCollector are now built by
// createReactorWiring() in ./reactor-wiring (v1.9.0 P2 bucket 1.5).

// ─── JWT 简易实现 ──────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'biocore-dev-secret-change-in-production';
const JWT_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24小时

function createJWT(payload: Record<string, any>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({
    ...payload,
    iat: Date.now(),
    exp: Date.now() + JWT_EXPIRY_MS,
  })).toString('base64url');
  const signature = createHash('sha256').update(`${header}.${body}.${JWT_SECRET}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verifyJWT(token: string): Record<string, any> | null {
  try {
    const [header, body, signature] = token.split('.');
    const expected = createHash('sha256').update(`${header}.${body}.${JWT_SECRET}`).digest('base64url');
    if (signature !== expected) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

// ─── Password hashing (v1.8.0 bucket 1) ────────────────────────
// bcrypt cost=12 — current OWASP-aligned default for 2025+.
// Old SHA-256 hashes (`salt:hash` format) are still accepted for verification
// and migrated on first successful login.
const BCRYPT_COST = 12;

/**
 * Hash a password with bcrypt cost=12.
 * Returns the bcrypt-formatted string (e.g. `$2b$12$<22-char salt><31-char hash>`).
 */
async function hashPasswordBcrypt(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

/**
 * Verify a password against a stored hash. Supports two formats:
 *  - bcrypt: starts with `$2`. Native `bcrypt.compare`.
 *  - legacy SHA-256: matches /^[a-f0-9]{32}:[a-f0-9]{64}$/. Recomputes & compares.
 *
 * If `legacy` is true on success, callers MUST migrate the user's
 * `password_hash` to the bcrypt format.
 */
async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<{ ok: boolean; legacy: boolean }> {
  if (typeof storedHash !== 'string' || storedHash.length === 0) {
    return { ok: false, legacy: false };
  }
  if (storedHash.startsWith('$2')) {
    try {
      const ok = await bcrypt.compare(password, storedHash);
      return { ok, legacy: false };
    } catch {
      return { ok: false, legacy: false };
    }
  }
  const m = /^([a-f0-9]{32}):([a-f0-9]{64})$/.exec(storedHash);
  if (!m) return { ok: false, legacy: false };
  const [, salt, expectedHex] = m;
  const computedHex = createHash('sha256').update(password + salt).digest('hex');
  if (computedHex.length !== expectedHex.length) return { ok: false, legacy: true };
  const ok = timingSafeEqual(
    Buffer.from(computedHex, 'hex'),
    Buffer.from(expectedHex, 'hex'),
  );
  return { ok, legacy: true };
}

export { hashPasswordBcrypt, verifyPassword };

// ensureAdminAccount 已迁至 ./startup (v1.9.0 P2 bucket 1.6)。

// ─── Express ───────────────────────────────────────────────
// v1.9.0 P2 bucket 1.7: express app + middleware + apiRouter + swagger
// constructed in ./bootstrap. We pass __filename + glob of *-routes.ts so
// swagger-jsdoc scans this file AND每个抽离后的子路由文件的 @openapi 注解
// (M5 Sprint 1 复盘: 子文件抽离后 spec 还在 single-file 时代, 8 个端点
// 的 JSDoc 注解曾被静默丢弃, 仅扫到 index.ts 残留的 /trends + /alarms +
// /batches/{id}/samples 三块; 修复后所有 *-routes.ts 注解都生效).
// ALLOWED_ORIGINS / dev fallback / prod fail-fast all live in
// resolveAllowedOrigins() inside bootstrap.
const { app, apiRouter, authEnabled: AUTH_ENABLED } = createApp({
  swaggerScanPath: [
    __filename,
    pathResolve(__dirname, '*-routes.ts'),
    pathResolve(__dirname, '*-routes.js'), // 编译产物 (运行时 dist/ 兜底)
  ],
  apiV0Sunset: API_V0_SUNSET,
});

registerBatchCompareRoutes(apiRouter, sqlite);
registerBatchSamplesRoutes(apiRouter, sqlite);
registerBatchExportRoutes(apiRouter, sqlite);
registerCalibrationRoutes(apiRouter, sqlite);
registerPermissionRoutes(apiRouter, sqlite.getDatabase());
registerDoeRoutes(apiRouter, sqlite);
registerKpiRoutes(apiRouter, sqlite);
registerSpcRoutes(apiRouter, sqlite);
registerCusumRoutes(apiRouter, cusumDetectors, sqlite);
registerBatchIntelligenceRoutes(apiRouter, sqlite, influxQueryApi, rootCauseAnalyzer);
registerAiReportRoutes(apiRouter, sqlite, influxQueryApi);
// route-handler-split: 配方 API 抽离到 ./recipe-routes
// parseRecipeRow / writeRecipeAudit 仍在本文件定义 (其它代码路径仍依赖),
// 通过 deps 注入而非 import 避免循环依赖。函数声明已提升, 引用安全。
registerRecipeRoutes(apiRouter, {
  sqlite,
  parseRecipeRow,
  writeRecipeAudit,
});
registerBatchRoutes(apiRouter, sqlite);
registerAuditLogRoutes(apiRouter, sqlite);
// SP-FX-20: backup / restore UI; SP-FX-39: scheduler dep 注入
const backupScheduler: BackupScheduler | null = createBackupSchedulerFromEnv(DATA_DIR);
registerBackupRoutes(apiRouter, { dataDir: DATA_DIR, scheduler: backupScheduler ?? undefined });
// route-handler-split: 认证 + 用户管理 抽离到 ./auth-routes
// createJWT/verifyPassword/hashPasswordBcrypt 仍在本文件 (test/scheduler 路径
// 复用), 通过 deps 注入。函数声明已提升, 引用安全。
registerAuthRoutes(apiRouter, {
  sqlite,
  createJWT,
  verifyPassword,
  hashPasswordBcrypt,
});

// T36: runtime-guard exposure (admin health endpoints).
// /liveness is in PUBLIC_PATHS (auth.ts) so docker healthcheck can probe it.
// / and /timeseries are admin-gated inside the router.
apiRouter.use('/admin/health', createAdminHealthRouter({
  metricsCollector,
  crashesDir: RUNTIME_GUARD_DUMP_DIR,
}));

// T37: Prometheus exposition. Default: public (Prometheus standard).
// Gate behind admin via BIOCORE_METRICS_REQUIRE_AUTH=true.
apiRouter.use('/admin/metrics', createAdminMetricsRouter({
  metricsCollector,
  requireAuth: process.env.BIOCORE_METRICS_REQUIRE_AUTH === 'true',
}));

// T38: runtime-guard diagnostic dump access. Admin only.
// list+read crash dumps written by writeDiagnosticDump() under RUNTIME_GUARD_DUMP_DIR.
apiRouter.use('/admin/crashes', createAdminCrashesRouter(RUNTIME_GUARD_DUMP_DIR));

// T39: SSE events stream for external IT systems (MES/SOC/log pipelines).
// Singleton — exposed for AlertRouter (T40) to call .publish() on notifier events.
export const eventStream = new EventStream(Number(process.env.BIOCORE_EVENT_BUFFER_SIZE ?? 1000));
apiRouter.use('/events', createEventsSseRouter(
  eventStream,
  Number(process.env.BIOCORE_SSE_MAX_CLIENTS ?? 100),
));

// T40: AlertRouter — global instance fed by runtime-guard hooks (crash + OOM)
// and admin /api/v1/notifications routes; on successful send it republishes to
// eventStream so SSE subscribers also see the event.
//
// Init timing: migrations IIFE above is fire-and-forget. listChannels/listRules
// query the notification_* tables created by migration 022. We wrap in try/catch
// inside helpers (or here) so a fresh DB pre-migration just yields empty maps.
function buildAlertChannels(db: Database.Database): Record<string, ChannelDef> {
  const out: Record<string, ChannelDef> = {};
  try {
    for (const c of listNotifChannels(db)) {
      if (c.enabled) {
        out[c.id] = { type: c.type, config: c.config as { webhook_url: string; secret?: string } };
      }
    }
  } catch (e) {
    // Pre-migration boot — tables may not exist yet. Empty map is correct.
    console.warn('[notifier] listChannels failed (probably pre-migration):', (e as Error).message);
  }
  return out;
}

function buildAlertRules(db: Database.Database): Rule[] {
  try {
    return listNotifRules(db).map(r => ({
      event_type: r.event_type as Rule['event_type'],
      channel_id: r.channel_id,
      enabled: r.enabled,
      min_severity: r.min_severity,
    }));
  } catch {
    return [];
  }
}

const NOTIFIER_THROTTLE_MS = Number(process.env.BIOCORE_NOTIFIER_THROTTLE_MIN ?? 5) * 60_000;
export const alertRouter = new AlertRouter({
  channels: buildAlertChannels(sqlite.getDatabase()),
  rules: buildAlertRules(sqlite.getDatabase()),
  throttleMs: NOTIFIER_THROTTLE_MS,
});

// onSent: forward successful (non-throttled) emits to SSE so external listeners
// see the same notifier traffic as the configured chat channels.
alertRouter.onSent = (type, payload) => {
  eventStream.publish(type, payload);
};

// Wire ref so the runtime-guard closures (installed before sqlite was up) can fire.
alertRouterRef = alertRouter;

console.log(`[notifier] AlertRouter ready (channels=${Object.keys(buildAlertChannels(sqlite.getDatabase())).length})`);

apiRouter.use('/notifications', createNotificationsRouter({
  db: sqlite.getDatabase(),
  alertRouter,
}));

// SP-FX-28: Prometheus metrics endpoint (admin only)
registerMetricsRoutes(apiRouter, metricsRegistry);
// SP-FX-43: Analytics Dashboard (admin only)
registerAnalyticsRoutes(apiRouter, sqlite.getDatabase());
// SP-FX-40: 全局 rate-limit (cors/json/traceMw 之后, auth 之前)
// 100 req/min per IP; /health /liveness /metrics 豁免
app.use(rateLimit(defaultRateLimitConfig));
// SP-FX-28: HTTP metrics middleware (全局拦截, 在挂载前注册)
app.use(createMetricsMiddleware(metricsRegistry));

// SP-FX-37: 健康检查端点 (PUBLIC — 在 PUBLIC_PATHS 已注册, 不需 auth)
// GET /api/v1/health/live  → 200 liveness
// GET /api/v1/health/ready → 200/503 readiness (DB ping)
registerHealthRoutes(apiRouter, {
  db: { ping: () => { sqlite.getDatabase().prepare('SELECT 1').get(); return true; } },
});

// 双挂载:
//   /api/v1/* — 新路径, 走 v1ResponseWrapper → authMiddleware → apiRouter
//   /api/*    — 旧路径, 加 deprecation header → authMiddleware → apiRouter (无 wrapper, 保持原格式)
// 6 个月后 (API_V0_SUNSET) 移除第二个 app.use 即可下线 v0 兼容
app.use('/api/v1', v1ResponseWrapper, authMiddleware, apiRouter);
app.use('/api', v0DeprecationMw, authMiddleware, apiRouter);

// v1.7.3: requireRole 已迁至 middlewares/auth.ts 并改为 spread-args 工厂,
// 旧版 (基于 ROLE_LEVELS 数值层级) 从未被调用, 已删除以避免与 import 冲突。

const server = http.createServer(app);

// ─── WebSocket ─────────────────────────────────────────────
// v1.9.0 P2 bucket 1: WSS + connection auth + broadcast() helper
// live in ./ws-server. Keep the local `wss` / `broadcast` aliases so
// downstream code (route handlers, wireReactorEvents, /status,
// gracefulShutdown) keeps working unchanged.
// MQTT Publisher (W2: BIOCore broadcast 镜像到 mosquitto)
// 环境变量:
//   MQTT_BROKER_URL=mqtt://localhost:1883  (默认)
//   MQTT_ENABLED=false                     可关闭
const mqttPublisher = createMqttPublisher({
  enabled: process.env.MQTT_ENABLED !== 'false',
});

const { wss, broadcast } = createWsServer({
  server,
  sqlite,
  verifyJWT,
  authEnabled: AUTH_ENABLED,
  mqttPublisher,
});

// M3 (Level 3): MQTT subscriber — 外部 HMI 写意图 → 建议缓冲区
// 订阅 biocore/commands/+ → 收到 write_intent → ai_suggestions 表 + audit + WS
// CLAUDE.md 第 7 节硬约束: 绝不直写 PLC, 必经人工确认
const mqttSubscriber = createMqttSubscriber({
  enabled: process.env.MQTT_ENABLED !== 'false',
  sqlite,
  broadcast,
});

// ─── 只读 S7 连接 (安全: 测试操作绝不写入PLC) ─────────────

const AREA_DB = 0x84;
const WORDLEN_BYTE = 0x02;

// 异步互斥锁 (替代 s7Busy 自旋锁, 修复竞态条件)
class AsyncMutex {
  private queue: (() => void)[] = [];
  private locked = false;
  async acquire(): Promise<void> {
    if (!this.locked) { this.locked = true; return; }
    return new Promise(resolve => this.queue.push(resolve));
  }
  release(): void {
    if (this.queue.length > 0) { this.queue.shift()!(); }
    else { this.locked = false; }
  }
}
const s7Mutex = new AsyncMutex();

async function readOnlyS7(conn: PLCConnectionConfig, byteStart: number, length: number, db: number): Promise<Buffer> {
  await s7Mutex.acquire();
  const client = new S7Client();
  try {
    client.SetConnectionType(3);
    await new Promise<void>((res, rej) => {
      client.ConnectTo(conn.ip, conn.rack ?? 0, conn.slot ?? 1, (err: any) =>
        err ? rej(new Error(`S7连接失败: errCode=${err}`)) : res()
      );
    });
    return await new Promise<Buffer>((res, rej) => {
      client.ReadArea(AREA_DB, db, byteStart, length, WORDLEN_BYTE, (err: any, data: Buffer) =>
        err ? rej(new Error(`S7读取失败: errCode=${err}`)) : res(data)
      );
    });
  } finally {
    client.Disconnect();
    s7Mutex.release();
  }
}

// ─── 心跳服务 ──────────────────────────────────────────────

interface HeartbeatState {
  client: typeof S7Client; timer: ReturnType<typeof setInterval>;
  counter: number; running: boolean; db: number; byteAddr: number;
  errors: number; lastOk: number;
}
const heartbeats = new Map<string, HeartbeatState>();

async function startHeartbeat(conn: PLCConnectionConfig): Promise<void> {
  if (heartbeats.has(conn.id) && heartbeats.get(conn.id)!.running) return;
  const addrValid = validateAddr(conn.heartbeat_write_address);
  if (!addrValid.valid) throw new Error(`心跳地址无效: ${addrValid.error}`);
  const parsed = parseAddr(conn.heartbeat_write_address);
  const db = parsed.db ?? conn.s7_db ?? 1;

  const client = new S7Client();
  client.SetConnectionType(3);
  await new Promise<void>((res, rej) => {
    client.ConnectTo(conn.ip, conn.rack ?? 0, conn.slot ?? 1, (err: any) =>
      err ? rej(new Error(`心跳连接失败: errCode=${err}`)) : res()
    );
  });

  const state: HeartbeatState = {
    client, timer: null as any, counter: 0, running: true,
    db, byteAddr: parsed.byte, errors: 0, lastOk: Date.now(),
  };

  state.timer = setInterval(() => {
    if (!state.running) return;
    const buf = Buffer.alloc(2);
    buf.writeUInt16BE(state.counter, 0);
    client.WriteArea(AREA_DB, state.db, state.byteAddr, 2, WORDLEN_BYTE, buf, (err: any) => {
      if (err) { state.errors++; if (state.errors > 10) stopHeartbeat(conn.id); }
      else { state.errors = 0; state.lastOk = Date.now(); }
    });
    state.counter = (state.counter + 1) % 65536;
    // connection_id lets the UI route per-reactor heartbeat by convention
    // (conn.id ↔ reactor.id 1:1); falls back to global on legacy clients.
    broadcast('heartbeat', { pc: state.counter, alive: state.errors === 0, connection_id: conn.id });
  }, 1000);

  heartbeats.set(conn.id, state);
  console.log(`[${new Date().toISOString()}] [INFO] [心跳] 启动: ${conn.name} → DB${db}.${conn.heartbeat_write_address}`);
}

function stopHeartbeat(id: string): void {
  const s = heartbeats.get(id);
  if (!s) return;
  s.running = false;
  clearInterval(s.timer);
  s.client.Disconnect();
  heartbeats.delete(id);
  console.log(`[${new Date().toISOString()}] [INFO] [心跳] 停止: ${id}`);
}

// ═══════════════════════════════════════════════════════════
// REST API
// ═══════════════════════════════════════════════════════════


// ── PLC 连接 CRUD ──

// SP-PLC-1: GET 列表附带 reactor_id (从 plc_reactor_bindings JOIN)
apiRouter.get('/plc/connections', (_req, res) => {
  const conns = varManager.getConnections();
  const bindings = sqlite.listPlcReactorBindings();
  const reactorByPlc = new Map<string, string>(bindings.map(b => [b.plc_id, b.reactor_id]));
  res.json(conns.map((c: any) => ({ ...c, reactor_id: reactorByPlc.get(c.id) ?? null })));
});

// SP-FX-47 F-04 (HIGH): PLC 拓扑写操作 admin only
// SP-PLC-1: 接受 reactor_id,同步写入 plc_reactor_bindings
apiRouter.post('/plc/connections', requireRole('admin'), (req, res) => {
  const { reactor_id, ...rest } = req.body ?? {};
  const conn = { id: crypto.randomUUID(), ...rest };
  varManager.upsertConnection(conn);
  if (reactor_id) {
    if (sqlite.getReactorConfig(reactor_id)) {
      sqlite.upsertPlcReactorBinding({ plc_id: conn.id, reactor_id, created_by: (req as any).user?.user_id });
    }
  }
  res.json({ ...conn, reactor_id: reactor_id ?? null });
});

apiRouter.put('/plc/connections/:id', requireRole('admin'), (req, res) => {
  const { reactor_id, ...rest } = req.body ?? {};
  varManager.upsertConnection({ ...rest, id: req.params.id });
  if (reactor_id === null || reactor_id === '') {
    sqlite.deletePlcReactorBinding(req.params.id);
  } else if (reactor_id) {
    if (!sqlite.getReactorConfig(reactor_id)) {
      return res.status(400).json({ error: `reactor_id '${reactor_id}' 不存在` });
    }
    sqlite.upsertPlcReactorBinding({ plc_id: req.params.id, reactor_id, created_by: (req as any).user?.user_id });
  }
  res.json({ success: true });
});

apiRouter.delete('/plc/connections/:id', requireRole('admin'), (req, res) => {
  stopHeartbeat(req.params.id);
  varManager.deleteConnection(req.params.id);
  sqlite.deletePlcReactorBinding(req.params.id);
  res.json({ success: true });
});

// SP-PLC-1: 独立 /api/v1/plc-reactor-bindings CRUD (供单独查询/管理)
apiRouter.get('/plc-reactor-bindings', (_req, res) => {
  res.json(sqlite.listPlcReactorBindings());
});

apiRouter.get('/plc-reactor-bindings/:plcId', (req, res) => {
  const b = sqlite.getPlcReactorBinding(req.params.plcId);
  if (!b) return res.status(404).json({ error: 'binding 不存在' });
  res.json(b);
});

apiRouter.put('/plc-reactor-bindings/:plcId', requireRole('admin'), (req, res) => {
  const { reactor_id } = req.body ?? {};
  if (!reactor_id) return res.status(400).json({ error: '缺少 reactor_id' });
  if (!sqlite.getReactorConfig(reactor_id)) return res.status(400).json({ error: `reactor_id '${reactor_id}' 不存在` });
  // 应用层警告: 该 reactor 已被其他 PLC 绑定
  const existing = sqlite.getPlcReactorBindingsByReactor(reactor_id).filter(b => b.plc_id !== req.params.plcId);
  sqlite.upsertPlcReactorBinding({ plc_id: req.params.plcId, reactor_id, created_by: (req as any).user?.user_id });
  res.json({ success: true, warnings: existing.length > 0 ? [`reactor '${reactor_id}' 已被其他 PLC 绑定: ${existing.map(e => e.plc_id).join(', ')}`] : [] });
});

apiRouter.delete('/plc-reactor-bindings/:plcId', requireRole('admin'), (req, res) => {
  const r = sqlite.deletePlcReactorBinding(req.params.plcId);
  if (!r.ok) return res.status(404).json({ error: 'binding 不存在' });
  res.status(204).end();
});

// ── PLC 连接测试 (只读) ──

apiRouter.post('/plc/connections/:id/test', async (req, res) => {
  const conns = varManager.getConnections();
  const conn = conns.find((c: any) => c.id === req.params.id);
  if (!conn) return res.json({ success: false, message: '连接不存在' });
  try {
    const parsed = parseAddr(conn.heartbeat_read_address);
    const db = parsed.db ?? conn.s7_db ?? 1;
    const buf = await readOnlyS7(conn as any, parsed.byte, 2, db);
    res.json({ success: true, message: `连接成功! DB${db}.${conn.heartbeat_read_address}=${buf.readUInt16BE(0)}` });
  } catch (e) {
    res.json({ success: false, message: `连接失败: ${(e as Error).message}` });
  }
});

// ── 心跳控制 ──

apiRouter.post('/plc/connections/:id/heartbeat/start', async (req, res) => {
  const conns = varManager.getConnections();
  const conn = conns.find((c: any) => c.id === req.params.id);
  if (!conn) return res.json({ success: false, message: '连接不存在' });
  try {
    await startHeartbeat(conn as any);
    res.json({ success: true, message: '心跳已启动' });
  } catch (e) { res.json({ success: false, message: (e as Error).message }); }
});

apiRouter.post('/plc/connections/:id/heartbeat/stop', (req, res) => {
  stopHeartbeat(req.params.id);
  res.json({ success: true, message: '心跳已停止' });
});

apiRouter.get('/plc/connections/:id/heartbeat/status', (req, res) => {
  const s = heartbeats.get(req.params.id);
  if (!s) return res.json({ running: false, counter: 0, errors: 0 });
  res.json({ running: s.running, counter: s.counter, errors: s.errors, lastOk: new Date(s.lastOk).toISOString() });
});

// ── PLC 变量 CRUD ──

apiRouter.get('/plc/variables', (req, res) => {
  res.json(varManager.getVariables(req.query.connection_id as string | undefined));
});

// SP-FX-47 F-04 (HIGH): PLC 变量写操作 admin only
apiRouter.post('/plc/variables', requireRole('admin'), (req, res) => {
  const v = { id: crypto.randomUUID(), ...req.body };
  const check = validateAddr(v.plc_address, v.data_type);
  if (!check.valid) return res.status(400).json({ error: `地址无效: ${check.error}` });
  varManager.upsertVariable(v);
  res.json(v);
});

apiRouter.put('/plc/variables/:id', requireRole('admin'), (req, res) => {
  varManager.upsertVariable({ ...req.body, id: req.params.id });
  res.json({ success: true });
});

apiRouter.delete('/plc/variables/:id', requireRole('admin'), (req, res) => {
  varManager.deleteVariable(req.params.id);
  res.json({ success: true });
});

apiRouter.put('/plc/variables', (req, res) => {
  const list: any[] = Array.isArray(req.body) ? req.body : [];
  const errors: string[] = [];
  for (const v of list) {
    try { varManager.upsertVariable(v); } catch (e) { errors.push(`${v.tag_name}: ${e}`); }
  }
  res.json({ updated: list.length - errors.length, errors });
});

// ── 变量测试读取 (只读) ──

apiRouter.post('/plc/variables/:id/test', async (req, res) => {
  const v = req.body;
  const check = validateAddr(v.plc_address, v.data_type);
  if (!check.valid) return res.json({ success: false, message: `地址无效: ${check.error}` });

  const conns = varManager.getConnections();
  const conn = conns.find((c: any) => c.id === v.connection_id);
  if (!conn) return res.json({ success: false, message: '未找到PLC连接' });

  try {
    const parsed = parseAddr(v.plc_address);
    const len = byteLen(v.data_type);
    const db = parsed.db ?? (conn as any).s7_db ?? 1;
    const buf = await readOnlyS7(conn as any, parsed.byte, len, db);
    const raw = decode(buf, v.data_type, parsed.bit);
    const eng = v.scaling_enabled ? scale(raw, v) : raw;
    res.json({ success: true, value: Math.round(eng * 100) / 100, raw, message: `${v.tag_name} = ${eng}` });
  } catch (e) { res.json({ success: false, message: (e as Error).message }); }
});

// SP-PLC-2: 受控 PLC 写入 — 需登录,confirmed:true gate,落 audit_logs
registerPlcWriteRoute(apiRouter, {
  getVariables: () => varManager.getVariables() as any,
  getConnections: () => varManager.getConnections() as any,
  writeAuditLog: (entry) => sqlite.writeAuditLog({
    user_id: entry.user_id,
    action: entry.action,
    target_type: entry.target_type,
    target_id: entry.target_id,
    new_value: entry.new_value,
    ip_address: entry.ip_address,
  }),
  performWrite: async (prep) => {
    const client = new (S7Client as any)();
    client.SetConnectionType(3);
    await new Promise<void>((resolve, reject) => {
      client.ConnectTo(prep.connection.ip, (prep.connection as any).rack ?? 0, (prep.connection as any).slot ?? 1, (err: any) => {
        if (err) reject(new Error(`S7连接失败: errCode=${err}`)); else resolve();
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        client.WriteArea(AREA_DB, prep.db, prep.parsed.byte, prep.buf.length, WORDLEN_BYTE, prep.buf, (err: any) => {
          if (err) reject(new Error(`S7写入 DB${prep.db}.${prep.parsed.byte} 失败: errCode=${err}`)); else resolve();
        });
      });
    } finally {
      client.Disconnect();
    }
  },
});

// ── 导入导出 ──

apiRouter.get('/plc/export/json', (_req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename=plc_config.json');
  res.json(varManager.exportToJSON());
});

apiRouter.get('/plc/export/csv', (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=plc_variables.csv');
  res.send('\uFEFF' + varManager.exportToCSV());
});

apiRouter.post('/plc/import/json', (req, res) => {
  res.json(varManager.importFromJSON(req.body));
});

// ── Phase 模板 API ──

function safeJSON(str: string | null | undefined, fallback: any = {}): any {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

apiRouter.get('/phase-templates', (_req, res) => {
  const rows = sqlite.getDatabase().prepare('SELECT * FROM phase_templates ORDER BY sort_order, type').all();
  res.json(rows.map((r: any) => ({
    ...r,
    default_params: safeJSON(r.default_params, {}),
    param_schema: safeJSON(r.param_schema, []),
    steps: safeJSON(r.steps, []),
    plc_mappings: safeJSON(r.plc_mappings, {}),
  })));
});

apiRouter.get('/phase-templates/:type', (req, res) => {
  const row: any = sqlite.getDatabase().prepare('SELECT * FROM phase_templates WHERE type = ?').get(req.params.type);
  if (!row) return res.status(404).json({ error: '模板不存在' });
  res.json({
    ...row,
    default_params: safeJSON(row.default_params, {}),
    param_schema: safeJSON(row.param_schema, []),
    steps: safeJSON(row.steps, []),
    plc_mappings: safeJSON(row.plc_mappings, {}),
  });
});

apiRouter.post('/phase-templates', (req, res) => {
  const t = req.body;
  sqlite.getDatabase().prepare(`INSERT OR REPLACE INTO phase_templates
    (type, label, icon, color, description, category, fixed_steps, default_params, param_schema, steps, plc_mappings, sort_order, is_system)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    t.type, t.label, t.icon || null, t.color || null, t.description || '',
    t.category || '自定义', t.fixed_steps ?? 0,
    JSON.stringify(t.default_params || {}),
    JSON.stringify(t.param_schema || []),
    JSON.stringify(t.steps || []),
    JSON.stringify(t.plc_mappings || {}),
    t.sort_order ?? 99, t.is_system ? 1 : 0,
  );
  res.json({ success: true });
});

apiRouter.put('/phase-templates/:type', (req, res) => {
  const t = req.body;
  sqlite.getDatabase().prepare(`UPDATE phase_templates SET
    label=?, icon=?, color=?, description=?, category=?, fixed_steps=?,
    default_params=?, param_schema=?, steps=?, plc_mappings=?, sort_order=?
    WHERE type=?
  `).run(
    t.label, t.icon || null, t.color || null, t.description || '',
    t.category || '自定义', t.fixed_steps ?? 0,
    JSON.stringify(t.default_params || {}),
    JSON.stringify(t.param_schema || []),
    JSON.stringify(t.steps || []),
    JSON.stringify(t.plc_mappings || {}),
    t.sort_order ?? 99, req.params.type,
  );
  res.json({ success: true });
});

apiRouter.delete('/phase-templates/:type', (req, res) => {
  // 调试阶段: 所有模板均可编辑/删除，待调试完成后锁定内置模板
  sqlite.getDatabase().prepare('DELETE FROM phase_templates WHERE type = ?').run(req.params.type);
  res.json({ success: true });
});

// 初始化/重置默认Phase模板
// ?force=true 强制清空重建
apiRouter.post('/phase-templates/init-defaults', (req, res) => {
  const force = req.query.force === 'true';
  if (force) {
    sqlite.getDatabase().prepare('DELETE FROM phase_templates').run();
  } else {
    const count = (sqlite.getDatabase().prepare('SELECT COUNT(*) as c FROM phase_templates').get() as any).c;
    if (count > 0) return res.json({ message: `已有${count}个模板, 加 ?force=true 强制重置` });
  }

  const defaults = [
    { type: 'Prepare',       label: '准备',     category: '系统操作', color: 'gray',    icon: 'Settings2',      description: '阀门归位、传感器自检、称重清零、VFD检查', fixed_steps: 5, sort_order: 1 },
    { type: 'AddWater',      label: '加水',     category: '系统操作', color: 'blue',    icon: 'Droplets',       description: '加入RO水/培养基底液至目标重量', fixed_steps: 4, sort_order: 2 },
    { type: 'ManualAdd',     label: '人工加料', category: '系统操作', color: 'amber',   icon: 'Hand',           description: '等待操作员手动添加培养基组分或菌种', fixed_steps: 4, sort_order: 3 },
    { type: 'Discharge',     label: '出料',     category: '系统操作', color: 'slate',   icon: 'ArrowDownToLine', description: '降温→停搅拌→泄压→排料→关阀', fixed_steps: 5, sort_order: 4 },
    { type: 'Heating',       label: '加热',     category: '温控',     color: 'orange',  icon: 'Thermometer',    description: '升温至目标温度并稳定', fixed_steps: 4, sort_order: 10 },
    { type: 'TempControl',   label: '控温',     category: '温控',     color: 'orange',  icon: 'ThermometerSun', description: '温度维持或切换至新设定值', fixed_steps: 3, sort_order: 11 },
    { type: 'Agitation',     label: '搅拌',     category: '过程控制', color: 'teal',    icon: 'RotateCw',       description: '启动搅拌至目标转速', fixed_steps: 3, sort_order: 20 },
    { type: 'Feeding',       label: '补料',     category: '过程控制', color: 'green',   icon: 'Pipette',        description: '蠕动泵补料(恒速/指数)', fixed_steps: 3, sort_order: 21 },
    { type: 'PHControl',     label: 'pH调节',   category: '过程控制', color: 'purple',  icon: 'FlaskConical',   description: 'pH闭环控制(补酸/补碱)', fixed_steps: 3, sort_order: 22 },
    { type: 'DOControl',     label: 'DO调节',   category: '过程控制', color: 'cyan',    icon: 'Wind',           description: '溶氧控制(4种策略)', fixed_steps: 3, sort_order: 23 },
    { type: 'Aeration',      label: '通气',     category: '过程控制', color: 'sky',     icon: 'CloudRain',      description: '空气流量调节', fixed_steps: 3, sort_order: 24 },
    { type: 'Fermentation',  label: '发酵',     category: '发酵主体', color: 'emerald', icon: 'Dna',            description: '发酵主体阶段(温度+pH+DO+补料综合)', fixed_steps: 3, sort_order: 30 },
    { type: 'SIP',           label: '就地灭菌', category: '清洗灭菌', color: 'red',     icon: 'Flame',          description: 'SIP灭菌: 升温→保温F₀积分→冷却', fixed_steps: 4, sort_order: 40 },
    { type: 'CIP',           label: '就地清洗', category: '清洗灭菌', color: 'indigo',  icon: 'Waves',          description: 'CIP五步清洗: 预冲→碱洗→中冲→酸洗→终冲', fixed_steps: 5, sort_order: 41 },
  ];

  const stmt = sqlite.getDatabase().prepare(`INSERT OR REPLACE INTO phase_templates
    (type, label, category, color, icon, description, fixed_steps, default_params, param_schema, steps, plc_mappings, sort_order, is_system)
    VALUES (?, ?, ?, ?, ?, ?, ?, '{}', '[]', '[]', '{}', ?, 1)
  `);
  for (const d of defaults) {
    stmt.run(d.type, d.label, d.category, d.color, d.icon, d.description, d.fixed_steps, d.sort_order);
  }
  res.json({ success: true, count: defaults.length });
});

// ── 计算参数公式配置 API ──

import { validateExpression, AVAILABLE_VARS } from '@biocore/data-service';

/** GET /formula-configs — 列出所有公式 */
apiRouter.get('/formula-configs', (_req, res) => {
  try {
    const rows = sqlite.getDatabase().prepare('SELECT * FROM formula_configs ORDER BY id').all();
    res.json(rows.map((r: any) => ({
      ...r,
      coefficients: safeJSON(r.coefficients, {}),
      input_vars: safeJSON(r.input_vars, []),
    })));
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

/** GET /formula-configs/:id — 单个公式 */
apiRouter.get('/formula-configs/:id', (req, res) => {
  try {
    const row: any = sqlite.getDatabase().prepare('SELECT * FROM formula_configs WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: '公式不存在' });
    res.json({ ...row, coefficients: safeJSON(row.coefficients, {}), input_vars: safeJSON(row.input_vars, []) });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

/** PUT /formula-configs/:id — 更新公式系数或表达式 */
apiRouter.put('/formula-configs/:id', (req, res) => {
  try {
    const { coefficients, expression, formula_type, is_enabled } = req.body || {};
    const sets: string[] = [];
    const params: any[] = [];
    if (coefficients !== undefined) { sets.push('coefficients = ?'); params.push(JSON.stringify(coefficients)); }
    if (expression !== undefined) { sets.push('expression = ?'); params.push(expression); }
    if (formula_type !== undefined) { sets.push('formula_type = ?'); params.push(formula_type); }
    if (is_enabled !== undefined) { sets.push('is_enabled = ?'); params.push(is_enabled ? 1 : 0); }
    if (sets.length === 0) return res.status(400).json({ error: '无修改内容' });
    sets.push("updated_at = datetime('now')");
    params.push(req.params.id);
    sqlite.getDatabase().prepare(`UPDATE formula_configs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

/** POST /formula-configs/:id/reset — 恢复默认 */
apiRouter.post('/formula-configs/:id/reset', (req, res) => {
  try {
    // 重新执行 migration 中的 INSERT OR REPLACE
    const defaults: Record<string, { coefficients: any }> = {
      kLa: { coefficients: { C: 0.026, a: 0.4, b: 0.5, tankArea: 0.02, rpmRef: 200, pvMultiplier: 0.1 } },
      OUR: { coefficients: { DOStar: 100 } },
      mu: { coefficients: { windowSize: 5 } },
      F0: { coefficients: { Tref: 121, z: 10, threshold: 100 } },
      Vs: { coefficients: { tankArea: 0.02 } },
      PV: { coefficients: { rpmRef: 200, multiplier: 0.1 } },
      cumFeed: { coefficients: { pumpChannel: 'P02', intervalSec: 60 } },
      cumBase: { coefficients: { pumpChannel: 'P01', intervalSec: 60 } },
      cumAcid: { coefficients: { pumpChannel: 'P04', intervalSec: 60 } },
      O2total: { coefficients: {} },
      Vliquid: { coefficients: { initialVolume: 5.0, density: 1.0 } },
      CER: { coefficients: { CO2_in: 0.04, estimateFromRQ: true, defaultRQ: 1.0 } },
      RQ: { coefficients: {} },
      OTR: { coefficients: { DOStar: 100, CStar: 0.21 } },
      qp: { coefficients: { productField: 'product_titer', biomassField: 'OD600', OD_to_DCW: 0.3 } },
      Yxs: { coefficients: { biomassField: 'OD600', substrateField: 'glucose_g_L', OD_to_DCW: 0.3 } },
      Yps: { coefficients: { productField: 'product_titer', substrateField: 'glucose_g_L' } },
    };
    const d = defaults[req.params.id];
    if (!d) return res.status(404).json({ error: '无默认值' });
    sqlite.getDatabase().prepare(
      `UPDATE formula_configs SET coefficients = ?, formula_type = 'parametric', expression = NULL, updated_at = datetime('now') WHERE id = ?`
    ).run(JSON.stringify(d.coefficients), req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

/** POST /formula-configs/validate — 验证自定义表达式 */
apiRouter.post('/formula-configs/validate', (req, res) => {
  const { expression } = req.body || {};
  if (!expression) return res.status(400).json({ error: '缺少 expression' });
  const err = validateExpression(expression, AVAILABLE_VARS);
  res.json({ valid: err === null, error: err, available_vars: AVAILABLE_VARS });
});

// ── IL/RF 连锁故障配置 API ──

/** GET /interlock-configs — 列出 IL+RF 配置
 *    ?reactor_id=<id>  返回该罐的 (覆盖 ∪ 全局未覆盖) 合并视图, 每行附 is_override 标识
 *    无参数            返回全局默认 (reactor_id IS NULL) 列表
 */
apiRouter.get('/interlock-configs', (req, res) => {
  try {
    const rid = (req.query.reactor_id as string) || '';
    const db = sqlite.getDatabase();
    let rows: any[];
    if (rid) {
      // 合并视图: 反应器覆盖优先, 未覆盖回退全局
      rows = db.prepare(`
        WITH merged AS (
          SELECT *, 1 AS is_override FROM interlock_configs WHERE reactor_id = ?
          UNION ALL
          SELECT g.*, 0 AS is_override FROM interlock_configs g
          WHERE g.reactor_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM interlock_configs r
              WHERE r.id = g.id AND r.reactor_id = ?
            )
        )
        SELECT * FROM merged ORDER BY sort_order
      `).all(rid, rid);
    } else {
      rows = db.prepare(
        "SELECT *, 0 AS is_override FROM interlock_configs WHERE reactor_id IS NULL ORDER BY sort_order"
      ).all();
    }
    res.json(rows.map((r: any) => ({ ...r, plc_tags: safeJSON(r.plc_tags, []), condition: safeJSON(r.condition, {}) })));
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

/** GET /interlock-configs/:id?reactor_id=<id>
 *  优先返回该罐覆盖, 若无则返回全局默认
 */
apiRouter.get('/interlock-configs/:id', (req, res) => {
  try {
    const rid = (req.query.reactor_id as string) || '';
    const db = sqlite.getDatabase();
    let row: any;
    if (rid) {
      row = db.prepare('SELECT * FROM interlock_configs WHERE id = ? AND reactor_id = ?').get(req.params.id, rid);
    }
    if (!row) {
      row = db.prepare('SELECT * FROM interlock_configs WHERE id = ? AND reactor_id IS NULL').get(req.params.id);
    }
    if (!row) return res.status(404).json({ error: '不存在' });
    res.json({ ...row, plc_tags: safeJSON(row.plc_tags, []), condition: safeJSON(row.condition, {}) });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

/** PUT /interlock-configs/:id?reactor_id=<id>
 *  - 无 reactor_id: 改全局默认 (reactor_id IS NULL 那行)
 *  - 有 reactor_id: upsert 该罐覆盖 (从全局默认派生缺失字段)
 */
apiRouter.put('/interlock-configs/:id', (req, res) => {
  try {
    const b = req.body || {};
    const rid = (req.query.reactor_id as string) || '';
    const db = sqlite.getDatabase();

    if (rid) {
      // 反应器覆盖 upsert
      const existing: any = db.prepare(
        'SELECT * FROM interlock_configs WHERE id = ? AND reactor_id = ?'
      ).get(req.params.id, rid);
      const base: any = existing || db.prepare(
        'SELECT * FROM interlock_configs WHERE id = ? AND reactor_id IS NULL'
      ).get(req.params.id);
      if (!base) return res.status(404).json({ error: '不存在全局默认或覆盖' });

      const merged = {
        id: req.params.id,
        reactor_id: rid,
        category: base.category,
        name: b.name ?? base.name,
        description: b.description ?? base.description,
        check_type: base.check_type,
        plc_tags: b.plc_tags !== undefined ? JSON.stringify(b.plc_tags) : base.plc_tags,
        condition: b.condition !== undefined ? JSON.stringify(b.condition) : base.condition,
        duration_sec: b.duration_sec ?? base.duration_sec,
        severity: b.severity ?? base.severity,
        hold_action: b.hold_action ?? base.hold_action,
        display_name: b.display_name ?? base.display_name,
        is_enabled: b.is_enabled !== undefined ? (b.is_enabled ? 1 : 0) : base.is_enabled,
        is_system: 0,
        sort_order: base.sort_order,
      };
      db.prepare(`
        INSERT INTO interlock_configs (id, reactor_id, category, name, description, check_type, plc_tags, condition,
            duration_sec, severity, hold_action, display_name, is_enabled, is_system, sort_order, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT (id, IFNULL(reactor_id, '__global__')) DO UPDATE SET
          name=excluded.name, description=excluded.description,
          plc_tags=excluded.plc_tags, condition=excluded.condition,
          duration_sec=excluded.duration_sec, severity=excluded.severity,
          hold_action=excluded.hold_action, display_name=excluded.display_name,
          is_enabled=excluded.is_enabled, updated_at=datetime('now')
      `).run(merged.id, merged.reactor_id, merged.category, merged.name, merged.description, merged.check_type,
        merged.plc_tags, merged.condition, merged.duration_sec, merged.severity, merged.hold_action,
        merged.display_name, merged.is_enabled, merged.is_system, merged.sort_order);
      return res.json({ success: true, override: true });
    }

    // 全局默认更新 (reactor_id IS NULL)
    const sets: string[] = [];
    const params: any[] = [];
    if (b.name !== undefined)        { sets.push('name = ?'); params.push(b.name); }
    if (b.description !== undefined) { sets.push('description = ?'); params.push(b.description); }
    if (b.display_name !== undefined){ sets.push('display_name = ?'); params.push(b.display_name); }
    if (b.plc_tags !== undefined)    { sets.push('plc_tags = ?'); params.push(JSON.stringify(b.plc_tags)); }
    if (b.condition !== undefined)   { sets.push('condition = ?'); params.push(JSON.stringify(b.condition)); }
    if (b.duration_sec !== undefined){ sets.push('duration_sec = ?'); params.push(b.duration_sec); }
    if (b.severity !== undefined)    { sets.push('severity = ?'); params.push(b.severity); }
    if (b.hold_action !== undefined) { sets.push('hold_action = ?'); params.push(b.hold_action); }
    if (b.is_enabled !== undefined)  { sets.push('is_enabled = ?'); params.push(b.is_enabled ? 1 : 0); }
    if (sets.length === 0) return res.status(400).json({ error: '无修改内容' });
    sets.push("updated_at = datetime('now')");
    params.push(req.params.id);
    db.prepare(`UPDATE interlock_configs SET ${sets.join(', ')} WHERE id = ? AND reactor_id IS NULL`).run(...params);
    res.json({ success: true, override: false });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

/** POST /interlock-configs — 新增自定义检测项 (reactor_id 可选, 缺省=全局) */
apiRouter.post('/interlock-configs', (req, res) => {
  try {
    const b = req.body || {};
    if (!b.id || !b.category || !b.name) return res.status(400).json({ error: '缺少 id, category, name' });
    sqlite.getDatabase().prepare(`
      INSERT INTO interlock_configs (id, reactor_id, category, name, description, check_type, plc_tags, condition, duration_sec, severity, hold_action, display_name, is_enabled, is_system, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)
    `).run(
      b.id, b.reactor_id || null, b.category, b.name, b.description || '',
      b.check_type || 'tag_compare',
      JSON.stringify(b.plc_tags || []),
      JSON.stringify(b.condition || {}),
      b.duration_sec || 0,
      b.severity || 'warning',
      b.hold_action || null,
      b.display_name || null,
      b.sort_order || 99,
    );
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

/** DELETE /interlock-configs/:id?reactor_id=<id>
 *  - 有 reactor_id: 删除该罐覆盖 (回退到全局默认)
 *  - 无 reactor_id: 删除全局自定义项 (系统内置不可删)
 */
apiRouter.delete('/interlock-configs/:id', (req, res) => {
  try {
    const rid = (req.query.reactor_id as string) || '';
    const db = sqlite.getDatabase();
    if (rid) {
      const r: any = db.prepare('DELETE FROM interlock_configs WHERE id = ? AND reactor_id = ?').run(req.params.id, rid);
      return res.json({ success: true, deleted: r.changes });
    }
    const row: any = db.prepare('SELECT is_system FROM interlock_configs WHERE id = ? AND reactor_id IS NULL').get(req.params.id);
    if (row?.is_system) return res.status(400).json({ error: '系统内置检测项不可删除，可禁用' });
    db.prepare('DELETE FROM interlock_configs WHERE id = ? AND reactor_id IS NULL').run(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// ── 系统级配置 (面包屑等元数据) ──

const CATEGORY_ZH: Record<string, string> = {
  fermenter: '研发', bioreactor: '生物反应', centrifuge: '离心',
  purification: '纯化', mixer: '混合', other: '其他',
};

function deriveReactorGroupName(): string | null {
  try {
    const rows: any[] = sqlite.getDatabase().prepare(
      'SELECT vessel_volume_L, category FROM reactor_configs WHERE enabled = 1'
    ).all();
    if (rows.length === 0) return null;
    const volCount: Record<string, number> = {};
    const catCount: Record<string, number> = {};
    rows.forEach(r => {
      const v = String(r.vessel_volume_L ?? 5);
      const c = String(r.category || 'fermenter');
      volCount[v] = (volCount[v] || 0) + 1;
      catCount[c] = (catCount[c] || 0) + 1;
    });
    const modeVol = Object.entries(volCount).sort((a, b) => b[1] - a[1])[0][0];
    const modeCat = Object.entries(catCount).sort((a, b) => b[1] - a[1])[0][0];
    return `${modeVol}L ${CATEGORY_ZH[modeCat] || modeCat}罐组 · ${rows.length}台`;
  } catch { return null; }
}

function readSystemConfig(): Record<string, string | null> {
  try {
    const rows: any[] = sqlite.getDatabase().prepare(
      'SELECT key, value FROM system_config'
    ).all();
    const out: Record<string, string | null> = {};
    rows.forEach(r => { out[r.key] = r.value; });
    return out;
  } catch { return {}; }
}

/** GET /system-config — 面包屑等系统元数据 (db > env > 推导/硬编码) */
apiRouter.get('/system-config', (_req, res) => {
  try {
    const db = readSystemConfig();
    const derived = deriveReactorGroupName();
    res.json({
      facility_name: db.facility_name || process.env.FACILITY_NAME || '生产车间',
      line_name: db.line_name || process.env.LINE_NAME || '发酵产线 #1',
      reactor_group_name: db.reactor_group_name || derived || '反应器组未配置',
      _meta: {
        facility_source: db.facility_name ? 'db' : (process.env.FACILITY_NAME ? 'env' : 'default'),
        line_source: db.line_name ? 'db' : (process.env.LINE_NAME ? 'env' : 'default'),
        reactor_group_source: db.reactor_group_name ? 'db' : (derived ? 'derived' : 'default'),
      },
    });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

/** PUT /system-config — 批量更新 (body: { key1: value1, key2: value2 }) */
apiRouter.put('/system-config', (req, res) => {
  try {
    const ALLOWED = new Set(['facility_name', 'line_name', 'reactor_group_name']);
    const updates = req.body || {};
    const stmt = sqlite.getDatabase().prepare(
      "UPDATE system_config SET value = ?, updated_at = datetime('now') WHERE key = ?"
    );
    let count = 0;
    Object.entries(updates).forEach(([k, v]) => {
      if (!ALLOWED.has(k)) return;
      const val = (v === '' || v == null) ? null : String(v);
      stmt.run(val, k);
      count++;
    });
    res.json({ success: true, updated: count });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// ── 配方 API ──

// M3.5: DAG 兼容层
import { dagToLinear, isLinearDag, type RecipeDAG } from './recipe-dag';

// 解析SQLite中JSON字符串字段
function parseRecipeRow(row: any) {
  if (!row) return null;
  const vc = typeof row.vessel_config === 'string' ? JSON.parse(row.vessel_config) : row.vessel_config;
  const meta = row.metadata && typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});

  // M3.5: 根据 dag_schema_version 决定如何解析 phases 列
  // - schema=1 (老线性配方): phases 列存的是 PhaseConfig[]
  // - schema=2 (新 DAG 配方): phases 列存的是 RecipeDAG, 需要还原为 dag 字段, 同时 phases 字段做兼容
  const schemaVer = (row.dag_schema_version ?? 1) as number;
  const rawPhases = typeof row.phases === 'string' ? JSON.parse(row.phases) : row.phases;

  let phases: any[] = [];
  let dag: RecipeDAG | null = null;

  if (schemaVer >= 2 && rawPhases && rawPhases.schema_version === 2) {
    // v2: rawPhases 是 RecipeDAG
    dag = rawPhases as RecipeDAG;
    // 老编辑器兼容: 如果是纯线性 DAG, 自动转回 phases 数组
    if (isLinearDag(dag)) {
      try { phases = dagToLinear(dag); } catch { phases = []; }
    }
  } else {
    // v1: rawPhases 是 PhaseConfig[]
    phases = Array.isArray(rawPhases) ? rawPhases : [];
  }

  return {
    ...row,
    vessel_config: vc,
    vessel: vc, // Recipe 类型兼容: vessel 和 vessel_config 都指向同一个对象
    phases,
    dag,
    dag_schema_version: schemaVer,
    metadata: meta,
    execution_mode: meta?.execution_mode || 'free', // 从 metadata 中提取执行模式
    // M3.5 v2 字段透传
    is_template: row.is_template ?? 0,
    parent_template_id: row.parent_template_id ?? null,
    parent_version: row.parent_version ?? null,
    rejection_reason: row.rejection_reason ?? null,
  };
}


// ─────────────────────────────────────────────────────────────
// ── DoE 双向对接 API (参照 DASware design) ──
// ─────────────────────────────────────────────────────────────

import {
  generateDesignMatrix,
  fitResponseModel,
  findOptimum,
  paretoChart,
  generateOrthogonalDesign,
  generateUniformDesign,
  rangeAnalysis,
  orthogonalAnova,
  multipleRegression,
  quadraticSurfaceRegression,
  evaluateDesign,
} from '@biocore/experiment-optimizer';
import type {
  DoEFactor,
  DesignType,
  ModelType,
  ObservationPoint,
  ExperimentResult,
  RegressionPoint,
  DOEFactor as OrthDOEFactor,
} from '@biocore/experiment-optimizer';

// 工具: 按 path (如 "HEAT_01.target_temp_C") 注入到配方 phase.params
function injectFactorIntoPhases(phases: any[], path: string | undefined, value: number): any[] {
  if (!path || !path.includes('.')) return phases; // path 未定义或格式无效, 跳过注入
  const [phaseIdPart, ...rest] = path.split('.');
  const paramPath = rest.join('.');
  return phases.map(p => {
    if (p.phase_id !== phaseIdPart && p.type !== phaseIdPart) return p;
    const params = structuredClone(p.params || {});
    // 支持嵌套: a.b.c
    const segs = paramPath.split('.');
    let cur = params;
    for (let i = 0; i < segs.length - 1; i++) {
      if (!(segs[i] in cur)) cur[segs[i]] = {};
      cur = cur[segs[i]];
    }
    cur[segs[segs.length - 1]] = value;
    return { ...p, params };
  });
}

// ─── DO 策略 DOE 模板 (4 种策略 × 各 4 因素) ────────────

const DOE_DO_STRATEGY_TEMPLATES: Record<string, {
  name: string; description: string; design_type: string;
  factors: { name: string; path: string; min: number; max: number; levels?: number[] }[];
  responses: { name: string; source: string; goal: string }[];
}> = {
  active_O2: {
    name: 'DO 策略一: 主动调氧优化',
    description: '优化级联 PID 的 DO 设定值、搅拌上限、通气上限和温度。适合 E.coli/酵母高密度好氧发酵。',
    design_type: 'orthogonal',
    factors: [
      { name: 'DO_sv', path: 'Fermentation.controls.DO.sv', min: 20, max: 40, levels: [20, 30, 40] },
      { name: 'RPM_max', path: 'Fermentation.cascade_level1.range_rpm.1', min: 800, max: 1200, levels: [800, 1000, 1200] },
      { name: 'Air_max', path: 'Fermentation.cascade_level2.range_NL_min.1', min: 15, max: 30, levels: [15, 20, 30] },
      { name: 'Temp', path: 'Fermentation.controls.temperature.sv', min: 34, max: 40, levels: [34, 37, 40] },
    ],
    responses: [
      { name: 'titer', source: 'offline_samples.product_titer', goal: 'max' },
      { name: 'OUR_max', source: 'calculated_params.OUR', goal: 'max' },
      { name: 'acetate', source: 'offline_samples.acetate_g_L', goal: 'min' },
      { name: 'kLa', source: 'calculated_params.kLa', goal: 'max' },
    ],
  },
  active_feed: {
    name: 'DO 策略二: DO-stat 补料优化',
    description: 'DO 闭环控制补料速率，搅拌/通气固定。优化 DO 设定、固定搅拌、固定通气和补料上限。天然防溢流。',
    design_type: 'orthogonal',
    factors: [
      { name: 'DO_sv', path: 'Fermentation.controls.DO.sv', min: 20, max: 40, levels: [20, 30, 40] },
      { name: 'RPM_fixed', path: 'Fermentation.agitation_fixed_rpm', min: 500, max: 900, levels: [500, 700, 900] },
      { name: 'Air_fixed', path: 'Fermentation.airflow_fixed_NL_min', min: 5, max: 20, levels: [5, 10, 20] },
      { name: 'Feed_max', path: 'Fermentation.feed_max_mL_h', min: 10, max: 30, levels: [10, 20, 30] },
    ],
    responses: [
      { name: 'titer', source: 'offline_samples.product_titer', goal: 'max' },
      { name: 'acetate_max', source: 'offline_samples.acetate_g_L', goal: 'min' },
      { name: 'V_feed', source: 'calculated_params.V_feed', goal: 'max' },
      { name: 'mu_max', source: 'calculated_params.mu', goal: 'max' },
    ],
  },
  constant_O2: {
    name: 'DO 策略三: 恒定氧气供给优化',
    description: '搅拌/通气固定，DO 自然浮动。适合 kLa 标定、微需氧发酵、菌株耗氧特性表征。',
    design_type: 'orthogonal',
    factors: [
      { name: 'RPM_fixed', path: 'Fermentation.agitation_fixed_rpm', min: 300, max: 900, levels: [300, 600, 900] },
      { name: 'Air_fixed', path: 'Fermentation.airflow_fixed_NL_min', min: 5, max: 20, levels: [5, 10, 20] },
      { name: 'Feed_rate', path: 'Feeding.rate_mL_h', min: 5, max: 20, levels: [5, 10, 20] },
      { name: 'Temp', path: 'Fermentation.controls.temperature.sv', min: 30, max: 42, levels: [30, 37, 42] },
    ],
    responses: [
      { name: 'DO_min', source: 'process_data.DO', goal: 'max' },
      { name: 'titer', source: 'offline_samples.product_titer', goal: 'max' },
      { name: 'kLa', source: 'calculated_params.kLa', goal: 'max' },
      { name: 'OD600_max', source: 'offline_samples.OD600', goal: 'max' },
    ],
  },
  constant_feed: {
    name: 'DO 策略四: 恒定补料速度优化',
    description: '全开环模式，补料按预设曲线执行。适合 DOE 实验、工艺对标、批次一致性验证。可重复性优先。',
    design_type: 'orthogonal',
    factors: [
      { name: 'mu_set', path: 'Feeding.mu_set', min: 0.10, max: 0.20, levels: [0.10, 0.15, 0.20] },
      { name: 'F0', path: 'Feeding.F0_mL_h', min: 1.0, max: 4.0, levels: [1.0, 2.0, 4.0] },
      { name: 'RPM_fixed', path: 'Fermentation.agitation_fixed_rpm', min: 400, max: 800, levels: [400, 600, 800] },
      { name: 'Feed_conc', path: 'Feeding.concentration_g_L', min: 200, max: 600, levels: [200, 400, 600] },
    ],
    responses: [
      { name: 'titer', source: 'offline_samples.product_titer', goal: 'max' },
      { name: 'yield', source: 'batch_kpis.yield_g', goal: 'max' },
      { name: 'acetate', source: 'offline_samples.acetate_g_L', goal: 'min' },
      { name: 'cycle_time', source: 'batch_kpis.cycle_time_h', goal: 'min' },
    ],
  },
};

/** GET /doe/templates/do-strategies — 列出 4 种 DO 策略 DOE 模板 */
apiRouter.get('/doe/templates/do-strategies', (_req, res) => {
  const list = Object.entries(DOE_DO_STRATEGY_TEMPLATES).map(([key, t]) => ({
    key,
    name: t.name,
    description: t.description,
    design_type: t.design_type,
    factor_count: t.factors.length,
    response_count: t.responses.length,
    estimated_runs: 9, // L9(3^4)
  }));
  res.json(list);
});

/**
 * POST /doe/templates/do-strategies/:key/create — 从模板一键创建 DOE 研究
 * Body 可选: { base_recipe_id, base_recipe_version }
 */
apiRouter.post('/doe/templates/do-strategies/:key/create', (req: any, res) => {
  try {
    const key = req.params.key;
    const tmpl = DOE_DO_STRATEGY_TEMPLATES[key];
    if (!tmpl) return res.status(404).json({ error: `未知策略模板: ${key}` });

    const body = req.body || {};
    const study_id = `DOE-DO-${key.toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
    sqlite.createDoeStudy({
      study_id,
      name: tmpl.name,
      description: tmpl.description,
      base_recipe_id: body.base_recipe_id || null,
      base_recipe_version: body.base_recipe_version || null,
      design_type: tmpl.design_type,
      factors: tmpl.factors,
      responses: tmpl.responses,
      created_by: req.user?.user_id || 'admin-001',
    });

    // 自动生成设计矩阵
    const orthFactors = tmpl.factors.map(f => ({
      name: f.name,
      levels: f.levels || [f.min, (f.min + f.max) / 2, f.max],
    }));
    const design = generateOrthogonalDesign(orthFactors);
    sqlite.replaceDoeRuns(study_id, design.runs.map(r => ({
      run_index: r.runIndex,
      factor_values: r.factorValues,
    })));

    const factorNames = tmpl.factors.map(f => f.name);
    const diagnostics = evaluateDesign(factorNames, design.runs.map(r => ({ factor_values: r.factorValues })));

    sqlite.updateDoeStudyStatus(study_id, 'designed');

    res.json({
      success: true,
      study_id,
      name: tmpl.name,
      run_count: design.runs.length,
      diagnostics,
    });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// GET /doe/studies — 列表
apiRouter.get('/doe/studies', (_req, res) => {
  res.json(sqlite.listDoeStudies());
});

// POST /doe/studies — 创建
apiRouter.post('/doe/studies', (req: any, res) => {
  try {
    const body = req.body || {};
    if (!body.name || !body.design_type) {
      return res.status(400).json({ error: '缺少 name 或 design_type' });
    }
    const study_id = body.study_id || `DOE-${Date.now().toString(36).toUpperCase()}`;
    sqlite.createDoeStudy({
      study_id,
      name: body.name,
      description: body.description,
      base_recipe_id: body.base_recipe_id,
      base_recipe_version: body.base_recipe_version,
      design_type: body.design_type,
      factors: body.factors || [],
      responses: body.responses || [],
      created_by: req.user?.user_id || 'admin-001',
    });
    res.json({ success: true, study_id });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// GET /doe/studies/:id — 详情
apiRouter.get('/doe/studies/:id', (req, res) => {
  const study = sqlite.getDoeStudy(req.params.id);
  if (!study) return res.status(404).json({ error: '研究不存在' });
  const runs = sqlite.listDoeRuns(req.params.id);
  res.json({ ...study, runs });
});

// PATCH /doe/studies/:id — 更新基本信息
apiRouter.patch('/doe/studies/:id', (req, res) => {
  try {
    sqlite.updateDoeStudy(req.params.id, req.body || {});
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// DELETE /doe/studies/:id
apiRouter.delete('/doe/studies/:id', (req, res) => {
  sqlite.deleteDoeStudy(req.params.id);
  res.json({ success: true });
});

// POST /doe/studies/:id/generate-design — 根据 factors + design_type 生成设计矩阵, 写入 doe_runs
apiRouter.post('/doe/studies/:id/generate-design', (req, res) => {
  try {
    const study = sqlite.getDoeStudy(req.params.id);
    if (!study) return res.status(404).json({ error: '研究不存在' });
    const factors: DoEFactor[] = study.factors;
    if (factors.length === 0) return res.status(400).json({ error: '未定义因子' });

    const opts = req.body || {};
    let runs: { run_index: number; factor_values: Record<string, number> }[] = [];

    if (study.design_type === 'orthogonal') {
      // 正交设计: 需要因素定义 levels 数组
      const orthFactors: OrthDOEFactor[] = factors.map(f => ({
        name: f.name,
        levels: f.levels
          ? (Array.isArray(f.levels) ? f.levels : [f.min, (f.min + f.max) / 2, f.max])
          : [f.min, (f.min + f.max) / 2, f.max],
      }));
      const design = generateOrthogonalDesign(orthFactors, opts.arrayName);
      runs = design.runs.map(r => ({ run_index: r.runIndex, factor_values: r.factorValues }));
    } else if (study.design_type === 'uniform') {
      // 均匀设计: 连续因素映射
      const uniformFactors = factors.map(f => ({ name: f.name, min: f.min, max: f.max }));
      const design = generateUniformDesign(uniformFactors, opts.tableName);
      runs = design.runs.map(r => ({ run_index: r.runIndex, factor_values: r.factorValues }));
    } else {
      // full_factorial / ccd / latin_hypercube / plackett_burman / box_behnken
      const matrix = generateDesignMatrix(
        study.design_type as DesignType,
        factors,
        { n: opts.n, centerReps: opts.centerReps, alpha: opts.alpha },
      );
      runs = matrix.map(r => ({ run_index: r.run_index, factor_values: r.factor_values }));
    }

    sqlite.replaceDoeRuns(req.params.id, runs);

    // 设计诊断
    const factorNames = factors.map(f => f.name);
    const diagnostics = evaluateDesign(factorNames, runs);

    res.json({ success: true, run_count: runs.length, runs, diagnostics });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// POST /doe/studies/:id/materialize — 把每个 run 转成一个子配方 (从 base_recipe 克隆 + 注入因子值)
apiRouter.post('/doe/studies/:id/materialize', (req: any, res) => {
  try {
    const study = sqlite.getDoeStudy(req.params.id);
    if (!study) return res.status(404).json({ error: '研究不存在' });
    if (!study.base_recipe_id || !study.base_recipe_version) {
      return res.status(400).json({ error: '未关联基础配方 (base_recipe)' });
    }
    const baseRow = sqlite.getRecipe(study.base_recipe_id, study.base_recipe_version);
    if (!baseRow) return res.status(400).json({ error: '基础配方不存在' });
    const baseRecipe = parseRecipeRow(baseRow);
    const runs = sqlite.listDoeRuns(req.params.id);
    if (runs.length === 0) return res.status(400).json({ error: '未生成设计矩阵, 请先调用 /generate-design' });

    const factors: DoEFactor[] = study.factors;
    // 校验因素 path 必填
    const missingPath = factors.filter((f: any) => !f.path || !f.path.includes('.'));
    if (missingPath.length > 0) {
      return res.status(400).json({ error: `因素 ${missingPath.map((f: any) => f.name).join(', ')} 缺少配方参数路径(path), 请在设计页填写 (格式: phase_id.param_key)` });
    }
    const createdBy = req.user?.user_id || 'admin-001';
    const results: any[] = [];

    for (const run of runs) {
      // 注入因子值到 phases 拷贝
      let phases = structuredClone(baseRecipe.phases || []);
      for (const f of factors) {
        const v = (run.factor_values as any)[f.name];
        if (v === undefined) continue;
        phases = injectFactorIntoPhases(phases, f.path, v);
      }
      const childId = `${baseRecipe.recipe_id}_DOE_${req.params.id}_${run.run_index}`;
      const childVersion = '1.0.0';
      try {
        sqlite.createRecipe({
          recipe_id: childId,
          version: childVersion,
          name: `${baseRecipe.name} [DoE ${req.params.id} #${run.run_index}]`,
          author: baseRecipe.author,
          target_organism: baseRecipe.target_organism,
          vessel_config: baseRecipe.vessel_config,
          phases,
          dag_schema_version: 1,
          is_template: 0,
          parent_template_id: undefined,
          parent_version: baseRecipe.version,
          created_by: createdBy,
        });
        sqlite.updateDoeRunRecipe(req.params.id, run.run_index, childId, childVersion);
        results.push({ run_index: run.run_index, recipe_id: childId, status: 'ok' });
      } catch (e) {
        results.push({ run_index: run.run_index, status: 'error', error: (e as Error).message });
      }
    }
    sqlite.updateDoeStudyStatus(req.params.id, 'running');
    res.json({ success: true, results });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// POST /doe/studies/:id/runs/:runIdx/bind-batch — 绑定批次 (手动, 批次启动后由前端调用)
apiRouter.post('/doe/studies/:id/runs/:runIdx/bind-batch', (req, res) => {
  try {
    const { batch_id } = req.body || {};
    if (!batch_id) return res.status(400).json({ error: '缺少 batch_id' });
    sqlite.bindDoeRunBatch(req.params.id, parseInt(req.params.runIdx, 10), batch_id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// POST /doe/studies/:id/runs/:runIdx/response — 回填响应变量 (手动或自动)
apiRouter.post('/doe/studies/:id/runs/:runIdx/response', (req, res) => {
  try {
    const { responses, notes } = req.body || {};
    if (!responses || typeof responses !== 'object') {
      return res.status(400).json({ error: '缺少 responses 对象' });
    }
    sqlite.setDoeRunResponse(req.params.id, parseInt(req.params.runIdx, 10), responses, notes);
    // 若全部完成, 自动把 study 标记为 completed
    const runs = sqlite.listDoeRuns(req.params.id);
    if (runs.length > 0 && runs.every(r => r.status === 'completed')) {
      sqlite.updateDoeStudyStatus(req.params.id, 'completed');
    }
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// GET /doe/studies/:id/model — 拟合响应面模型 + ANOVA + Pareto + 最优点
apiRouter.get('/doe/studies/:id/model', (req, res) => {
  try {
    const study = sqlite.getDoeStudy(req.params.id);
    if (!study) return res.status(404).json({ error: '研究不存在' });
    const runs = sqlite.listDoeRuns(req.params.id);
    const factors: DoEFactor[] = study.factors;
    const responses = study.responses as { name: string; goal: 'max' | 'min' }[];
    if (factors.length === 0 || responses.length === 0) {
      return res.status(400).json({ error: '研究因子或响应未定义' });
    }

    const completedRuns = runs.filter(r => r.status === 'completed' && r.response_values);

    // 按 design_type 选择分析方法
    if (study.design_type === 'orthogonal') {
      // ── 正交设计: 极差分析 + ANOVA ──
      const orthFactors: OrthDOEFactor[] = factors.map(f => ({
        name: f.name,
        levels: f.levels
          ? (Array.isArray(f.levels) ? f.levels : [f.min, (f.min + f.max) / 2, f.max])
          : [f.min, (f.min + f.max) / 2, f.max],
      }));

      // 构造正交设计对象 (重建)
      const design = generateOrthogonalDesign(orthFactors);
      const perResponse: any[] = [];

      for (const resp of responses) {
        const results: ExperimentResult[] = completedRuns
          .filter(r => r.response_values![resp.name] != null)
          .map(r => ({ runIndex: r.run_index, response: r.response_values![resp.name] as number }));

        if (results.length === 0) { perResponse.push({ response: resp.name, error: '无已完成的观测值' }); continue; }

        const goal = resp.goal === 'min' ? 'minimize' : 'maximize';
        const range = rangeAnalysis(design, results, orthFactors, goal as any);
        const anova = orthogonalAnova(design, results, orthFactors);
        perResponse.push({
          response: resp.name, goal: resp.goal || 'max',
          analysis_type: 'orthogonal',
          rangeAnalysis: range,
          anova,
        });
      }
      return res.json({ study_id: req.params.id, design_type: 'orthogonal', responses: perResponse });

    } else if (study.design_type === 'uniform') {
      // ── 均匀设计: 多元回归 ──
      const perResponse: any[] = [];
      for (const resp of responses) {
        const points: RegressionPoint[] = completedRuns
          .filter(r => r.response_values![resp.name] != null)
          .map(r => ({ x: r.factor_values, y: r.response_values![resp.name] as number }));
        if (points.length === 0) { perResponse.push({ response: resp.name, error: '无已完成的观测值' }); continue; }

        const xNames = factors.map(f => f.name);
        // 先尝试二阶响应曲面, 数据不足降级为多元线性
        let regression = quadraticSurfaceRegression(points, xNames);
        let regType = 'quadratic';
        if (!regression) { regression = multipleRegression(points, xNames); regType = 'linear'; }
        if (!regression) { perResponse.push({ response: resp.name, error: '回归失败 (数据不足)' }); continue; }

        perResponse.push({
          response: resp.name, goal: resp.goal || 'max',
          analysis_type: 'regression', regression_type: regType,
          regression,
        });
      }
      return res.json({ study_id: req.params.id, design_type: 'uniform', responses: perResponse });

    } else {
      // ── 其他设计: RSM (fitResponseModel) ──
      const modelType = (req.query.model as ModelType) || 'quadratic';
      const perResponse: any[] = [];
      for (const resp of responses) {
        const points: ObservationPoint[] = completedRuns
          .filter(r => r.response_values![resp.name] != null)
          .map(r => ({ factor_values: r.factor_values, response: r.response_values![resp.name] as number }));
        if (points.length === 0) { perResponse.push({ response: resp.name, error: '无已完成的观测值' }); continue; }

        const model = fitResponseModel(points, factors, modelType);
        if (!model) { perResponse.push({ response: resp.name, error: '模型拟合失败 (可能样本不足)' }); continue; }

        const pareto = paretoChart(model);
        const optimum = findOptimum(model, factors, resp.goal || 'max');
        perResponse.push({ response: resp.name, goal: resp.goal || 'max', analysis_type: 'rsm', model, pareto, optimum });
      }
      return res.json({ study_id: req.params.id, design_type: study.design_type, model_type: modelType, responses: perResponse });
    }
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// GET /doe/studies/:id/contour — 等高线图数据 (RSM 网格预测)
apiRouter.get('/doe/studies/:id/contour', (req, res) => {
  try {
    const study = sqlite.getDoeStudy(req.params.id);
    if (!study) return res.status(404).json({ error: '研究不存在' });
    const runs = sqlite.listDoeRuns(req.params.id);
    const factors: DoEFactor[] = study.factors;
    const responseName = req.query.response as string;
    const factorX = req.query.factorX as string;
    const factorY = req.query.factorY as string;
    const gridSize = parseInt(req.query.grid as string || '20', 10);

    if (!responseName || !factorX || !factorY) return res.status(400).json({ error: '缺少 response, factorX, factorY' });

    // 拟合模型
    const completedRuns = runs.filter(r => r.status === 'completed' && r.response_values);
    const points: ObservationPoint[] = completedRuns
      .filter(r => r.response_values![responseName] != null)
      .map(r => ({ factor_values: r.factor_values, response: r.response_values![responseName] as number }));
    if (points.length < 3) return res.status(400).json({ error: '数据不足' });

    const model = fitResponseModel(points, factors, 'quadratic');
    if (!model) return res.status(400).json({ error: '模型拟合失败' });

    // 网格预测
    const fX = factors.find(f => f.name === factorX);
    const fY = factors.find(f => f.name === factorY);
    if (!fX || !fY) return res.status(400).json({ error: '因素不存在' });

    const xVals: number[] = [], yVals: number[] = [];
    for (let i = 0; i < gridSize; i++) {
      xVals.push(fX.min + (fX.max - fX.min) * i / (gridSize - 1));
      yVals.push(fY.min + (fY.max - fY.min) * i / (gridSize - 1));
    }

    // 其余因素固定在中心
    const fixedVals: Record<string, number> = {};
    for (const f of factors) {
      if (f.name !== factorX && f.name !== factorY) fixedVals[f.name] = (f.min + f.max) / 2;
    }

    const allBeta = [model.intercept, ...model.terms.map(t => t.coefficient)];
    const z: number[][] = [];
    for (const yv of yVals) {
      const row: number[] = [];
      for (const xv of xVals) {
        const fv: Record<string, number> = { ...fixedVals, [factorX]: xv, [factorY]: yv };
        // 编码 → [-1,1]
        const coded = factors.map(f => {
          const mid = (f.min + f.max) / 2, half = (f.max - f.min) / 2;
          return half === 0 ? 0 : (fv[f.name] - mid) / half;
        });
        // 扩展特征
        const features = [1, ...coded];
        for (let i = 0; i < coded.length; i++) for (let j = i + 1; j < coded.length; j++) features.push(coded[i] * coded[j]);
        for (let i = 0; i < coded.length; i++) features.push(coded[i] * coded[i]);
        let pred = 0;
        for (let i = 0; i < features.length && i < allBeta.length; i++) pred += features[i] * allBeta[i];
        row.push(Math.round(pred * 1000) / 1000);
      }
      z.push(row);
    }

    res.json({ factorX, factorY, response: responseName, x: xVals, y: yVals, z });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ── DOE 自动响应收集 (断点1修复) ──

/** 从 batch 数据自动提取 DOE 响应值 */
function autoCollectDoeResponses(db: any, studyId: string, runIndex: number): Record<string, number> | null {
  const study = sqlite.getDoeStudy(studyId);
  if (!study) return null;
  const runs = sqlite.listDoeRuns(studyId);
  const run = runs.find(r => r.run_index === runIndex);
  if (!run || !run.batch_id) return null;

  const batchId = run.batch_id;
  const responses: Record<string, number> = {};

  for (const resp of (study.responses as { name: string; source?: string; goal: string }[])) {
    const source = resp.source || '';
    const [table, field] = source.split('.');
    if (!table || !field) continue;

    try {
      if (table === 'offline_samples') {
        const row: any = db.prepare(
          `SELECT ${field} as val FROM offline_samples WHERE batch_id = ? AND ${field} IS NOT NULL ORDER BY sample_time DESC LIMIT 1`
        ).get(batchId);
        if (row?.val != null) responses[resp.name] = row.val;
      } else if (table === 'batch_kpis') {
        const row: any = db.prepare(
          `SELECT ${field} as val FROM batch_kpis WHERE batch_id = ?`
        ).get(batchId);
        if (row?.val != null) responses[resp.name] = row.val;
      }
      // InfluxDB 源 (calculated_params / process_data) 暂不支持自动收集
    } catch { /* 字段不存在等，跳过 */ }
  }

  return Object.keys(responses).length > 0 ? responses : null;
}

/** POST /doe/studies/:id/runs/:runIdx/auto-collect — 自动从 batch 数据收集响应 */
apiRouter.post('/doe/studies/:id/runs/:runIdx/auto-collect', (req, res) => {
  try {
    const db = sqlite.getDatabase();
    const responses = autoCollectDoeResponses(db, req.params.id, parseInt(req.params.runIdx, 10));
    if (!responses) return res.status(400).json({ error: '无法自动收集: 批次未绑定或无数据' });

    sqlite.setDoeRunResponse(req.params.id, parseInt(req.params.runIdx, 10), responses);
    // 检查是否全部完成
    const runs = sqlite.listDoeRuns(req.params.id);
    if (runs.length > 0 && runs.every(r => r.status === 'completed')) {
      sqlite.updateDoeStudyStatus(req.params.id, 'completed');
    }
    res.json({ success: true, collected: responses });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** POST /doe/studies/:id/auto-collect-all — 批量自动收集所有已绑定批次的响应 */
apiRouter.post('/doe/studies/:id/auto-collect-all', (req, res) => {
  try {
    const db = sqlite.getDatabase();
    const runs = sqlite.listDoeRuns(req.params.id);
    const results: any[] = [];

    for (const run of runs) {
      if (run.status === 'completed') { results.push({ run_index: run.run_index, status: 'already_completed' }); continue; }
      if (!run.batch_id) { results.push({ run_index: run.run_index, status: 'no_batch' }); continue; }

      const responses = autoCollectDoeResponses(db, req.params.id, run.run_index);
      if (responses && Object.keys(responses).length > 0) {
        sqlite.setDoeRunResponse(req.params.id, run.run_index, responses);
        results.push({ run_index: run.run_index, status: 'collected', responses });
      } else {
        results.push({ run_index: run.run_index, status: 'no_data' });
      }
    }

    // 检查是否全部完成
    const updatedRuns = sqlite.listDoeRuns(req.params.id);
    if (updatedRuns.length > 0 && updatedRuns.every(r => r.status === 'completed')) {
      sqlite.updateDoeStudyStatus(req.params.id, 'completed');
    }

    const collected = results.filter(r => r.status === 'collected').length;
    res.json({ success: true, total: runs.length, collected, results });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ── DOE 最优配方生成 (断点3修复) ──

/** POST /doe/studies/:id/create-optimal-recipe — 服务端生成最优配方 + 回链 */
apiRouter.post('/doe/studies/:id/create-optimal-recipe', (req: any, res) => {
  try {
    const study = sqlite.getDoeStudy(req.params.id);
    if (!study) return res.status(404).json({ error: '研究不存在' });
    if (!study.base_recipe_id || !study.base_recipe_version) {
      return res.status(400).json({ error: '未关联基础配方' });
    }

    const { response_name, optimum_factor_values, predicted_response } = req.body || {};
    if (!response_name || !optimum_factor_values) {
      return res.status(400).json({ error: '缺少 response_name 或 optimum_factor_values' });
    }

    // 验证因素值在范围内
    const factors: DoEFactor[] = study.factors;
    for (const f of factors) {
      const v = optimum_factor_values[f.name];
      if (v === undefined) continue;
      if (v < f.min || v > f.max) {
        return res.status(400).json({ error: `因素 ${f.name} 值 ${v} 超出范围 [${f.min}, ${f.max}]` });
      }
    }

    // 获取基础配方
    const baseRow = sqlite.getRecipe(study.base_recipe_id, study.base_recipe_version);
    if (!baseRow) return res.status(400).json({ error: '基础配方不存在' });
    const baseRecipe = parseRecipeRow(baseRow);

    // 注入最优因素值
    let phases = structuredClone(baseRecipe.phases || []);
    for (const f of factors) {
      const v = optimum_factor_values[f.name];
      if (v === undefined) continue;
      phases = injectFactorIntoPhases(phases, f.path, v);
    }

    // 创建最优配方
    const recipeId = `${study.base_recipe_id}_DOE_OPT_${req.params.id}_${response_name}`;
    const recipeVersion = '1.0.0';
    const createdBy = req.user?.user_id || 'admin-001';

    try {
      sqlite.createRecipe({
        recipe_id: recipeId,
        version: recipeVersion,
        name: `${baseRecipe.name} [DoE ${req.params.id} 最优-${response_name}]`,
        author: baseRecipe.author,
        target_organism: baseRecipe.target_organism,
        vessel_config: baseRecipe.vessel_config,
        phases,
        dag_schema_version: 1,
        is_template: 0,
        parent_template_id: undefined,
        parent_version: baseRecipe.version,
        created_by: createdBy,
      });
    } catch (e) {
      // 配方已存在则更新
      if ((e as Error).message?.includes('UNIQUE')) {
        return res.status(400).json({ error: '最优配方已存在, 请先删除旧版本' });
      }
      throw e;
    }

    // 回链到 DOE 研究
    const db = sqlite.getDatabase();
    db.prepare(`
      UPDATE doe_studies SET
        optimal_recipe_id = ?, optimal_recipe_version = ?,
        optimal_response = ?, optimal_predicted = ?,
        status = CASE WHEN status != 'archived' THEN 'completed' ELSE status END,
        updated_at = datetime('now')
      WHERE study_id = ?
    `).run(recipeId, recipeVersion, response_name, predicted_response ?? null, req.params.id);

    res.json({
      success: true,
      recipe_id: recipeId,
      recipe_version: recipeVersion,
      optimal_factor_values: optimum_factor_values,
      predicted_response,
    });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ── 批次 API ──
// route-handler-split: 已抽离到 ./batch-routes (仅只读路由)。
// 批次状态变更 (start/stop/hold) 走反应器路由 (reactor-scoped)。
// 取样/报告/导出/摘要在各自 *-routes.ts 中。

// ── 报警 API ──

/**
 * @openapi
 * /alarms:
 *   get:
 *     summary: 列出报警
 *     tags: [Alarms]
 *     responses:
 *       200:
 *         description: 报警列表 (含未确认状态)
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/UnifiedResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id: { type: integer }
 *                           batch_id: { type: string, nullable: true }
 *                           alarm_code: { type: string }
 *                           severity: { type: string, enum: [info, warning, critical, emergency] }
 *                           message: { type: string }
 *                           triggered_at: { type: string, format: date-time }
 *                           acknowledged_at: { type: string, format: date-time, nullable: true }
 */
apiRouter.get('/alarms', (req, res) => {
  res.json(sqlite.getUnacknowledgedAlarms(req.query.batch_id as string | undefined));
});

// 报警历史: 默认仅操作性 (排除 CUSUM); category=cusum 切换到 CUSUM 提示历史
apiRouter.get('/alarms/history', (req, res) => {
  const q = req.query;
  const filter = {
    batch_id: (q.batch_id as string) || undefined,
    reactor_id: (q.reactor_id as string) || undefined,
    severity: (q.severity as string) || undefined,
    ack: (q.ack as 'all' | 'ack' | 'unack') || 'all',
    since: (q.since as string) || undefined,
    until: (q.until as string) || undefined,
    category: (q.category as 'all' | 'cusum' | 'operational') || 'operational',
    limit: q.limit ? parseInt(q.limit as string) : 500,
    offset: q.offset ? parseInt(q.offset as string) : 0,
  };
  const items = sqlite.listAlarmHistory(filter);
  const total = sqlite.countAlarmHistory(filter);
  res.json({ items, total, limit: filter.limit, offset: filter.offset });
});

// CUSUM 提示历史: source='cusum_anomaly' OR source LIKE 'ai:%' OR alarm_code LIKE 'CUSUM_%'
apiRouter.get('/cusum/history', (req, res) => {
  const q = req.query;
  const filter = {
    batch_id: (q.batch_id as string) || undefined,
    reactor_id: (q.reactor_id as string) || undefined,
    severity: (q.severity as string) || undefined,
    ack: (q.ack as 'all' | 'ack' | 'unack') || 'all',
    since: (q.since as string) || undefined,
    until: (q.until as string) || undefined,
    category: 'cusum' as const,
    limit: q.limit ? parseInt(q.limit as string) : 500,
    offset: q.offset ? parseInt(q.offset as string) : 0,
  };
  const items = sqlite.listAlarmHistory(filter);
  const total = sqlite.countAlarmHistory(filter);
  res.json({ items, total, limit: filter.limit, offset: filter.offset });
});

apiRouter.post('/alarms/:id/acknowledge', (req, res) => {
  sqlite.acknowledgeAlarm(parseInt(req.params.id), req.body.user_id || 'admin-001');
  res.json({ success: true });
});

// ── 报警定义 (用户可配置: 归属/分级/内容/标签) ──
apiRouter.get('/alarm-configs', (req, res) => {
  const q = req.query;
  const filter: any = {};
  if ('owner' in q) filter.owner = (q.owner as string) || null;
  if (q.severity) filter.severity = q.severity as string;
  if ('enabled' in q) filter.enabled = q.enabled === 'true' || q.enabled === '1';
  res.json({ items: sqlite.listAlarmDefinitions(filter) });
});

apiRouter.get('/alarm-configs/:id', (req, res) => {
  const row = sqlite.getAlarmDefinition(parseInt(req.params.id));
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

apiRouter.post('/alarm-configs', (req, res) => {
  const b = req.body || {};
  if (!b.code || !b.name || !b.severity || !b.message_template) {
    return res.status(400).json({ error: '必填: code, name, severity, message_template' });
  }
  try {
    const id = sqlite.createAlarmDefinition(b);
    res.json({ success: true, id });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || String(e) });
  }
});

apiRouter.put('/alarm-configs/:id', (req, res) => {
  const ok = sqlite.updateAlarmDefinition(parseInt(req.params.id), req.body || {});
  if (!ok) return res.status(404).json({ error: 'not found or no changes' });
  res.json({ success: true });
});

apiRouter.delete('/alarm-configs/:id', (req, res) => {
  const ok = sqlite.deleteAlarmDefinition(parseInt(req.params.id));
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ success: true });
});

// ── 审计日志 ──

// M3.10 辅助: 后端 recipe 工作流审计写入
// 前端 useAudit 负责记录操作人+原因(交互产物);后端负责记录 user_id/ip/trace(系统产物),
// 确保 MES 通过 API Key 直连时也有审计留痕。两条记录通过 trace_id 关联。
function writeRecipeAudit(
  req: any,
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
) {
  try {
    sqlite.writeAuditLog({
      user_id: req.user?.user_id || 'system',
      action,
      target_type: 'recipe',
      target_id: `${recipeId}@${version}`,
      new_value: JSON.stringify({ version, ...(extra || {}) }),
      reason: reason || undefined,
      ip_address: req.ip || req.socket?.remoteAddress || undefined,
      trace_id: req.trace_id,
    });
  } catch (e) {
    console.warn('[writeRecipeAudit] 审计写入失败:', (e as Error).message);
  }
}


// ── API Key 管理 (供 MES 等外部系统调用 biocore) ──

apiRouter.get('/api-keys', (req: any, res) => {
  try {
    const rows = sqlite.getDatabase().prepare(`
      SELECT key_id, name, scopes, created_by, created_at, last_used_at, revoked
      FROM api_keys
      WHERE created_by = ?
      ORDER BY created_at DESC
    `).all(req.user?.user_id || 'admin-001');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

apiRouter.post('/api-keys', (req: any, res) => {
  const { name, scopes } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: '缺少 name (key 描述)' });
  }
  try {
    // 生成 keyId + rawKey + salt + hash
    const keyId = 'ak_' + randomBytes(8).toString('hex');
    const rawSecret = randomBytes(32).toString('base64url');
    const salt = randomBytes(16).toString('hex');
    const hash = hashApiKey(rawSecret, salt);
    const fullKey = `${keyId}.${rawSecret}`;
    const scopesStr = (scopes && typeof scopes === 'string') ? scopes : 'read:* write:*';

    sqlite.getDatabase().prepare(`
      INSERT INTO api_keys (key_id, key_hash, salt, name, scopes, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(keyId, hash, salt, name.trim(), scopesStr, req.user?.user_id || 'admin-001');

    // 唯一一次返回 raw key, 提示客户端立即保存
    res.json({
      keyId,
      rawKey: fullKey,
      name: name.trim(),
      scopes: scopesStr,
      warning: '此 raw key 只显示一次, 关闭后无法找回, 请立即复制保存',
    });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

apiRouter.delete('/api-keys/:id', (req: any, res) => {
  try {
    const result = sqlite.getDatabase().prepare(
      'UPDATE api_keys SET revoked = 1 WHERE key_id = ? AND created_by = ?'
    ).run(req.params.id, req.user?.user_id || 'admin-001');
    if (result.changes === 0) return res.status(404).json({ error: 'API Key 不存在或无权限' });
    res.json({ success: true, key_id: req.params.id });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

apiRouter.post('/api-keys/:id/rotate', (req: any, res) => {
  try {
    const oldKey: any = sqlite.getDatabase().prepare(
      'SELECT name, scopes FROM api_keys WHERE key_id = ? AND created_by = ? AND revoked = 0'
    ).get(req.params.id, req.user?.user_id || 'admin-001');
    if (!oldKey) return res.status(404).json({ error: 'API Key 不存在或已撤销' });

    // 撤销旧 key
    sqlite.getDatabase().prepare('UPDATE api_keys SET revoked = 1 WHERE key_id = ?').run(req.params.id);

    // 创建新 key (复用旧的 name 和 scopes)
    const keyId = 'ak_' + randomBytes(8).toString('hex');
    const rawSecret = randomBytes(32).toString('base64url');
    const salt = randomBytes(16).toString('hex');
    const hash = hashApiKey(rawSecret, salt);
    const fullKey = `${keyId}.${rawSecret}`;

    sqlite.getDatabase().prepare(`
      INSERT INTO api_keys (key_id, key_hash, salt, name, scopes, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(keyId, hash, salt, oldKey.name, oldKey.scopes, req.user?.user_id || 'admin-001');

    res.json({
      keyId,
      rawKey: fullKey,
      name: oldKey.name,
      scopes: oldKey.scopes,
      rotated_from: req.params.id,
      warning: '此 raw key 只显示一次, 旧 key 已撤销',
    });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

apiRouter.get('/api-keys/:id/usage', (req: any, res) => {
  try {
    const row: any = sqlite.getDatabase().prepare(
      'SELECT key_id, name, last_used_at, created_at, revoked FROM api_keys WHERE key_id = ? AND created_by = ?'
    ).get(req.params.id, req.user?.user_id || 'admin-001');
    if (!row) return res.status(404).json({ error: 'API Key 不存在' });

    // 最近 100 条由该 API Key 触发的审计记录
    const audits = sqlite.getDatabase().prepare(`
      SELECT id, action, target_type, target_id, timestamp
      FROM audit_logs
      WHERE user_id = ?
      ORDER BY timestamp DESC
      LIMIT 100
    `).all(`apikey:${req.params.id}`);

    res.json({ ...row, recent_audits: audits });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// ── 离线取样 ──

/**
 * @openapi
 * /batches/{id}/samples:
 *   get:
 *     summary: 查询批次离线取样记录
 *     tags: [OfflineSamples]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: batch_id
 *     responses:
 *       200: { description: 按 sample_time 升序的样本列表 }
 *   post:
 *     summary: 新增离线取样记录
 *     tags: [OfflineSamples]
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
 *             required: [sample_time, sampled_by]
 *             properties:
 *               sample_time:      { type: string, format: date-time, example: "2026-04-08T10:30:00Z" }
 *               sampled_by:       { type: string, example: "alice" }
 *               od600:            { type: number, example: 12.4 }
 *               dcw_g_L:          { type: number, example: 8.2, description: "干重 (dry cell weight)" }
 *               glucose_g_L:      { type: number, example: 2.1 }
 *               acetate_g_L:      { type: number, example: 0.5 }
 *               product_titer:    { type: number, example: 32 }
 *               product_unit:     { type: string, example: "mg/L" }
 *               lactate_g_L:      { type: number, example: 0.3, description: "M2.4 新增: 乳酸浓度" }
 *               biomass_g_L:      { type: number, example: 24.1, description: "M2.4 新增: 湿重生物量 (与 dcw_g_L 干重区分)" }
 *               cell_viability_pct: { type: number, example: 93.5, description: "M2.4 新增: 细胞活性百分比 0-100" }
 *               ethanol_g_L:      { type: number, example: 1.2, description: "M2.4 新增: 乙醇浓度" }
 *               notes:            { type: string }
 *     responses:
 *       200: { description: 添加成功 }
 */
apiRouter.get('/batches/:id/samples', (req, res) => {
  res.json(sqlite.getOfflineSamples(req.params.id));
});

apiRouter.post('/batches/:id/samples', (req, res) => {
  sqlite.addOfflineSample({ ...req.body, batch_id: req.params.id });
  res.json({ success: true });
});

// ── 校准 ──

apiRouter.get('/calibrations/:channel', (req, res) => {
  res.json(sqlite.getLatestCalibration(req.params.channel) || null);
});

apiRouter.post('/calibrations', (req, res) => {
  sqlite.addCalibration(req.body);
  res.json({ success: true });
});

// ── AI API ──

// Check Ollama status
apiRouter.get('/ai/status', async (_req, res) => {
  try {
    const resp = await fetch('http://localhost:11434/api/tags');
    if (!resp.ok) throw new Error('Ollama not responding');
    const data: any = await resp.json();
    res.json({ available: true, models: (data.models || []).map((m: any) => m.name) });
  } catch {
    res.json({ available: false, models: [], message: 'Ollama未运行。请执行: ollama serve' });
  }
});

// Chat with LLM
apiRouter.post('/ai/chat', async (req, res) => {
  const { message, history, messages, model } = req.body;
  // 兼容两种格式: { message, history } 或 { messages }
  let chatMessages = messages;
  if (!chatMessages && message) {
    chatMessages = [
      ...(history || []),
      { role: 'user', content: message },
    ];
  }
  if (!chatMessages || chatMessages.length === 0) {
    return res.status(400).json({ error: '缺少消息内容' });
  }
  try {
    const resp = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model || 'gemma4', messages: chatMessages, stream: false }),
      signal: AbortSignal.timeout(120000),
    });
    if (!resp.ok) throw new Error(`Ollama error: ${resp.status}`);
    const data: any = await resp.json();
    const content = data.message?.content || '';
    // 返回多种字段兼容前端
    res.json({ reply: content, response: content, content, message: content });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// NL to Flux query
apiRouter.post('/ai/nl-to-flux', async (req, res) => {
  const { question, batchId } = req.body;
  const systemPrompt = `You are a InfluxDB Flux query generator for BIOCore fermentation system.
Database: bucket "fermentation", measurements: process_data (fields: temperature, pH, DO, pressure, airflow, weight, rpm), calculated_params (fields: OUR, kLa, mu).
Tags: batch_id, reactor_id.
Convert the user's natural language question into a valid Flux query. Return ONLY the Flux query, no explanation.
${batchId ? `Current batch: ${batchId}` : ''}`;

  try {
    const resp = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemma4',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: question },
        ],
        stream: false,
      }),
    });
    if (!resp.ok) throw new Error('Ollama error');
    const data: any = await resp.json();
    const flux = data.message?.content || '';
    res.json({ flux, question });
  } catch (e) {
    res.json({ flux: '', question, error: (e as Error).message });
  }
});

// ── 批次报表导出 ──

// Export batch report as JSON (full data package)
apiRouter.get('/batches/:id/report', (req, res) => {
  const batch = sqlite.getBatch(req.params.id);
  if (!batch) return res.status(404).json({ error: '批次不存在' });

  const transitions = sqlite.getStateTransitions(req.params.id);
  const phases = sqlite.getPhaseLogs(req.params.id);
  const steps = sqlite.getStepLogs(req.params.id);
  const alarms = sqlite.getDatabase().prepare(
    'SELECT * FROM alarms WHERE batch_id = ? ORDER BY triggered_at'
  ).all(req.params.id);
  const samples = sqlite.getOfflineSamples(req.params.id);
  const auditLogs = sqlite.getAuditLogs(req.params.id);

  // Parse JSON fields in batch
  const parsedBatch = {
    ...batch,
    state_snapshot: batch.state_snapshot ? JSON.parse(batch.state_snapshot) : null,
  };

  res.json({
    batch: parsedBatch,
    transitions,
    phases,
    steps,
    alarms,
    samples,
    auditLogs,
    generated_at: new Date().toISOString(),
  });
});

// Export batch as CSV
apiRouter.get('/batches/:id/export/csv', (req, res) => {
  const batch = sqlite.getBatch(req.params.id);
  if (!batch) return res.status(404).json({ error: '批次不存在' });

  const steps = sqlite.getStepLogs(req.params.id);
  const headers = ['phase_id','phase_type','step_number','step_name','started_at','ended_at','elapsed_sec','result'];
  const rows = steps.map((s: any) => headers.map(h => String(s[h] ?? '')).join(','));
  const csv = '\uFEFF' + [headers.join(','), ...rows].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=batch_${req.params.id}.csv`);
  res.send(csv);
});

// Generate AI summary for a completed batch
apiRouter.post('/batches/:id/generate-summary', async (req, res) => {
  const batch = sqlite.getBatch(req.params.id);
  if (!batch) return res.status(404).json({ error: '批次不存在' });

  const phases = sqlite.getPhaseLogs(req.params.id);
  const alarms = sqlite.getDatabase().prepare(
    'SELECT * FROM alarms WHERE batch_id = ? ORDER BY triggered_at'
  ).all(req.params.id);

  const prompt = `请为以下发酵批次生成200-500字的中文结构化摘要：
批次号: ${batch.batch_id}
配方: ${batch.recipe_id} v${batch.recipe_version}
菌种: ${batch.organism || '未指定'}
状态: ${batch.current_state}
结果: ${batch.outcome || '进行中'}
Phase数: ${phases.length}
报警数: ${alarms.length}
${batch.notes ? '备注: ' + batch.notes : ''}

请从以下维度总结：1.培养概况 2.关键工艺事件 3.异常与处理 4.结论建议`;

  try {
    const resp = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemma4', prompt, stream: false }),
    });
    if (!resp.ok) throw new Error('Ollama未运行');
    const data: any = await resp.json();
    const summary = data.response || '';

    // Save summary to batch
    sqlite.updateBatch(req.params.id, { summary_text: summary });

    res.json({ summary });
  } catch (e) {
    res.json({ summary: '', error: (e as Error).message });
  }
});

// ── 软测量 API ──

apiRouter.get('/soft-sensor/models', (_req, res) => {
  res.json(softSensorEngine.listModels());
});

apiRouter.post('/soft-sensor/predict', (req, res) => {
  const { modelId, features } = req.body;
  if (!modelId || !features) return res.status(400).json({ error: '缺少modelId或features' });
  try {
    const result = softSensorEngine.predict(modelId, features);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

apiRouter.post('/soft-sensor/train', (req, res) => {
  const { target, features, featureNames, trainingData, modelId: reqModelId } = req.body;
  const resolvedFeatures: string[] = featureNames || (typeof features === 'string' ? features.split(',').map((f: string) => f.trim()) : features);
  if (!target || !resolvedFeatures || resolvedFeatures.length === 0) {
    return res.status(400).json({ error: '缺少 target 或 features' });
  }
  const id = reqModelId || `model_${target}_${Date.now()}`;
  try {
    // 若未提供训练数据，从已完成批次生成合成训练数据
    let data = trainingData;
    if (!data || data.length < 3) {
      // 生成合成训练数据 (基于典型发酵参数范围)
      const syntheticCount = 50;
      data = [];
      for (let i = 0; i < syntheticCount; i++) {
        const row: Record<string, number> = {};
        // 典型特征范围
        const temp = 30 + Math.random() * 10; // 30-40°C
        const pH = 6.0 + Math.random() * 2.0; // 6-8
        const DO = 10 + Math.random() * 80; // 10-90%
        const rpm = 100 + Math.random() * 400; // 100-500
        if (resolvedFeatures.includes('temperature')) row.temperature = temp;
        if (resolvedFeatures.includes('pH')) row.pH = pH;
        if (resolvedFeatures.includes('DO')) row.DO = DO;
        if (resolvedFeatures.includes('rpm')) row.rpm = rpm;
        // 目标变量 (模拟非线性关系 + 噪声)
        if (target === 'OD600') {
          row[target] = 0.5 + 0.02 * temp + 0.3 * (pH - 7) * (pH - 7) * -1 + 0.005 * DO + 0.001 * rpm + (Math.random() - 0.5) * 0.3;
        } else if (target === 'glucose') {
          row[target] = 20 - 0.3 * temp + 0.1 * DO - 0.005 * rpm + (Math.random() - 0.5) * 2;
        } else {
          row[target] = 5 + 0.1 * temp + 0.05 * DO + (Math.random() - 0.5) * 1;
        }
        data.push(row);
      }
    }

    const model = SoftSensorEngine.trainLinearModel(target, resolvedFeatures, data);
    model.id = id;
    model.name = `${target}_model`;
    softSensorEngine.registerModel(model);
    // 设置特征范围用于外推检测
    const ranges: Record<string, [number, number]> = {};
    for (const f of resolvedFeatures) {
      const vals = data.map((d: any) => d[f] ?? 0);
      ranges[f] = [Math.min(...vals), Math.max(...vals)];
    }
    softSensorEngine.setFeatureRanges(id, ranges);
    res.json({
      success: true,
      id,
      r_squared: model.r_squared,
      coefficients: model.coefficients,
      intercept: model.intercept,
      trainingSamples: data.length,
      features: resolvedFeatures,
      status: model.r_squared >= 0.5 ? 'active' : 'inactive',
      message: model.r_squared >= 0.5 ? '模型训练成功' : '模型R²偏低，建议增加训练数据或调整特征',
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

apiRouter.delete('/soft-sensor/models/:id', (req, res) => {
  softSensorEngine.removeModel(req.params.id);
  res.json({ success: true });
});

// ── 补料建议 API ──

apiRouter.post('/soft-sensor/feed-recommend', (req, res) => {
  try {
    const result = feedAdvisor.recommend(req.body);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: `补料建议计算失败: ${err.message}` });
  }
});

// ── 根因分析 API ──

apiRouter.post('/root-cause/analyze', (req, res) => {
  const { alarmCode, alarmTime, paramHistory, paramNames, normalRanges } = req.body;
  if (!alarmCode) return res.status(400).json({ error: '缺少alarmCode' });
  try {
    const result = rootCauseAnalyzer.analyze({
      alarmCode,
      alarmTime: alarmTime ? new Date(alarmTime) : new Date(),
      paramHistory: paramHistory || {},
      paramNames: paramNames || Object.keys(paramHistory || {}),
      normalRanges: normalRanges || {},
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── 补料建议 API ──

apiRouter.post('/feed-advisor/recommend', (req, res) => {
  const p = req.body;
  try {
    const result = feedAdvisor.recommend({
      currentOD: p.currentOD ?? 1,
      currentGlucose: p.currentGlucose ?? 0.5,
      targetMu: p.targetMu ?? 0.15,
      muMax: p.muMax ?? 0.5,
      Ks: p.Ks ?? 0.05,
      Yxs: p.Yxs ?? 0.45,
      currentFeedRate: p.currentFeedRate ?? 0,
      feedConcentration: p.feedConcentration ?? 500,
      liquidVolume: p.liquidVolume ?? 5,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── 实验优化 API ──

apiRouter.get('/experiment/history', (_req, res) => {
  // 返回所有批次的终点指标用于优化
  const batches = sqlite.listBatches(100, 0);
  res.json(batches.map((b: any) => ({
    batch_id: b.batch_id, recipe_id: b.recipe_id,
    outcome: b.outcome, notes: b.notes,
  })));
});

apiRouter.post('/experiment/recommend', (req, res) => {
  const { bounds, history } = req.body;
  if (!bounds || bounds.length === 0) return res.status(400).json({ error: '缺少参数范围定义(bounds)' });

  try {
    const optimizer = new BayesianOptimizer(bounds);

    // 加载历史数据
    if (history && history.length > 0) {
      optimizer.loadHistory(history.map((h: any) => ({
        params: h.params,
        outcome: h.outcome,
      })));
    }

    if (!history || history.length < 3) {
      // 数据不足，返回中心点+随机探索
      const suggested: Record<string, number> = {};
      for (const b of bounds) {
        suggested[b.name] = b.min + Math.random() * (b.max - b.min);
        if (b.step) suggested[b.name] = Math.round(suggested[b.name] / b.step) * b.step;
      }
      return res.json({
        suggestedParams: suggested,
        expectedImprovement: 0,
        confidence: 0.1,
        message: `历史数据不足(${history?.length || 0}条), 需要至少3条才能启动贝叶斯优化, 当前为随机探索`,
        best: optimizer.getBest(),
      });
    }

    // 贝叶斯优化推荐
    const result = optimizer.recommend();
    const recommended = result.suggestedParams;
    const best = optimizer.getBest();
    // 对齐step精度
    for (const b of bounds) {
      if (b.step && recommended[b.name] !== undefined) {
        recommended[b.name] = Math.round(recommended[b.name] / b.step) * b.step;
      }
    }

    res.json({
      suggestedParams: recommended,
      expectedImprovement: best ? (best.outcome * 0.1) : 0,
      confidence: Math.min(0.95, 0.3 + history.length * 0.05),
      message: `基于${history.length}条历史数据的贝叶斯优化(GP+UCB)推荐`,
      best: best ? { params: best.params, outcome: best.outcome } : null,
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── 设备配置 API (反应器组态管理) ──

// M2.5: 合法的 category 枚举值 (与 sqlite-service 的白名单保持一致)
const VALID_REACTOR_CATEGORIES = new Set(['fermenter', 'bioreactor', 'centrifuge', 'purification', 'mixer', 'other']);

apiRouter.get('/reactor-configs', (_req, res) => {
  res.json(sqlite.listReactorConfigs());
});

apiRouter.get('/reactor-configs/:id', (req, res) => {
  const config = sqlite.getReactorConfig(req.params.id);
  if (!config) return res.status(404).json({ error: '设备不存在' });
  res.json(config);
});

apiRouter.post('/reactor-configs', (req, res) => {
  const { reactor_id, name, category } = req.body;
  if (!reactor_id || !name) return res.status(400).json({ error: '缺少reactor_id或name' });
  // 校验ID格式: 仅限英文字母、数字、下划线、短横线，1~20字符
  if (!/^[A-Za-z0-9_-]{1,20}$/.test(reactor_id)) return res.status(400).json({ error: 'reactor_id仅限英文字母、数字、下划线、短横线，1~20字符' });
  // M2.5: 校验 category (可选, 缺省 sqlite-service 回退 fermenter)
  if (category !== undefined && !VALID_REACTOR_CATEGORIES.has(category)) {
    return res.status(400).json({ error: `非法 category, 合法值: ${[...VALID_REACTOR_CATEGORIES].join('/')}` });
  }
  const existing = sqlite.getReactorConfig(reactor_id);
  if (existing) return res.status(409).json({ error: `${reactor_id}已存在` });
  sqlite.upsertReactorConfig(req.body);
  res.json({ success: true, reactor_id });
});

apiRouter.put('/reactor-configs/:id', (req, res) => {
  const existing = sqlite.getReactorConfig(req.params.id);
  if (!existing) return res.status(404).json({ error: '设备不存在' });
  // M2.5: 如果 body 携带 category, 校验其合法性
  if (req.body.category !== undefined && !VALID_REACTOR_CATEGORIES.has(req.body.category)) {
    return res.status(400).json({ error: `非法 category, 合法值: ${[...VALID_REACTOR_CATEGORIES].join('/')}` });
  }
  sqlite.upsertReactorConfig({ ...existing, ...req.body, reactor_id: req.params.id });
  res.json({ success: true });
});

apiRouter.delete('/reactor-configs/:id', (req, res) => {
  sqlite.deleteReactorConfig(req.params.id);
  res.json({ success: true });
});

// 初始化默认设备: 如果reactor_configs为空,写入F01
apiRouter.post('/reactor-configs/init-defaults', (_req, res) => {
  const existing = sqlite.listReactorConfigs();
  if (existing.length > 0) return res.json({ message: `已有${existing.length}个设备配置` });
  sqlite.upsertReactorConfig({
    reactor_id: 'F01', name: '5L研发罐 #1', description: '默认发酵罐',
    vessel_volume_L: 5, plc_protocol: 's7', plc_ip: '192.168.2.1', plc_port: 102,
    enabled: 1, sort_order: 0,
  });
  res.json({ success: true, count: 1 });
});


// ── SP-RG-4: Phase Instance API (phase_instances 中间层) ──
// 一个 phase class 可绑定到同一 reactor 多次,每次产生独立 instance。

const PHASE_INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

function parseInstanceParams(row: any): any {
  if (!row) return row;
  try { return { ...row, params_override: JSON.parse(row.params_override ?? '{}') }; }
  catch { return { ...row, params_override: {} }; }
}

apiRouter.get('/phase-instances', (req, res) => {
  const reactor = req.query.reactor as string | undefined;
  const phaseClass = req.query.phase_class as string | undefined;
  const rows = sqlite.listPhaseInstances({ reactor_id: reactor, phase_class: phaseClass });
  res.json(rows.map(parseInstanceParams));
});

apiRouter.get('/phase-instances/:id', (req, res) => {
  const row = sqlite.getPhaseInstance(req.params.id);
  if (!row) return res.status(404).json({ error: 'phase instance 不存在' });
  res.json(parseInstanceParams(row));
});

apiRouter.post('/phase-instances', (req, res) => {
  const { instance_id, phase_class, reactor_id, label, params_override, notes } = req.body ?? {};
  if (!instance_id || !phase_class || !reactor_id) {
    return res.status(400).json({ error: '缺少 instance_id / phase_class / reactor_id' });
  }
  if (!PHASE_INSTANCE_ID_PATTERN.test(instance_id)) {
    return res.status(400).json({ error: 'instance_id 仅限英数字下划线短横线 1~40 字符' });
  }
  if (sqlite.getPhaseInstance(instance_id)) {
    return res.status(409).json({ error: `${instance_id} 已存在` });
  }
  const tpl: any = sqlite.getDatabase().prepare('SELECT type FROM phase_templates WHERE type = ?').get(phase_class);
  if (!tpl) return res.status(400).json({ error: `phase_class '${phase_class}' 不存在` });
  if (!sqlite.getReactorConfig(reactor_id)) return res.status(400).json({ error: `reactor_id '${reactor_id}' 不存在` });
  try {
    sqlite.createPhaseInstance({
      instance_id, phase_class, reactor_id,
      label: label ?? null,
      params_override: params_override ?? {},
      notes: notes ?? '',
      created_by: (req as any).user?.user_id ?? 'unknown',
    });
    const row = sqlite.getPhaseInstance(instance_id);
    res.status(201).json(parseInstanceParams(row));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

apiRouter.put('/phase-instances/:id', (req, res) => {
  const existing = sqlite.getPhaseInstance(req.params.id);
  if (!existing) return res.status(404).json({ error: 'phase instance 不存在' });
  const { phase_class, reactor_id, label, params_override, notes } = req.body ?? {};
  if (phase_class !== undefined) {
    const tpl: any = sqlite.getDatabase().prepare('SELECT type FROM phase_templates WHERE type = ?').get(phase_class);
    if (!tpl) return res.status(400).json({ error: `phase_class '${phase_class}' 不存在` });
  }
  if (reactor_id !== undefined && !sqlite.getReactorConfig(reactor_id)) {
    return res.status(400).json({ error: `reactor_id '${reactor_id}' 不存在` });
  }
  sqlite.updatePhaseInstance(req.params.id, { phase_class, reactor_id, label, params_override, notes });
  res.json(parseInstanceParams(sqlite.getPhaseInstance(req.params.id)));
});

apiRouter.delete('/phase-instances/:id', (req, res) => {
  const r = sqlite.deletePhaseInstance(req.params.id);
  if (!r.ok) return res.status(404).json({ error: 'phase instance 不存在' });
  res.status(204).end();
});


// ── AI建议 API (ai_suggestions表) ──

apiRouter.get('/ai/suggestions', (req, res) => {
  const status = req.query.status as string || 'pending';
  const batchId = req.query.batch_id as string | undefined;
  const source = req.query.source_module as string | undefined;
  if (status === 'pending') {
    // 先过期已超时的建议
    sqlite.expirePendingSuggestions(batchId || '');
    return res.json(sqlite.getPendingSuggestionsBySource(batchId, source));
  }
  const clauses: string[] = ['status = ?'];
  const params: any[] = [status];
  if (batchId) { clauses.push('batch_id = ?'); params.push(batchId); }
  if (source) { clauses.push('source_module = ?'); params.push(source); }
  const sql = `SELECT * FROM ai_suggestions WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT 50`;
  return res.json(sqlite.getDatabase().prepare(sql).all(...params));
});

// SP-FX-47 F-01 (CRITICAL): operator/admin only — viewer 不可触发 dispatcher 写 PLC
apiRouter.post('/ai/suggestions/:id/accept', requireRole('operator', 'admin'), (req: any, res) => {
  try {
    sqlite.acceptSuggestion(parseInt(req.params.id), req.user?.user_id || 'admin-001');
    sqlite.setDispatchPending(parseInt(req.params.id));
    sqlite.writeAuditLog({
      user_id: req.user?.user_id || 'admin-001',
      action: 'ai_suggestion_accept',
      target_type: 'ai_suggestion',
      target_id: req.params.id,
      ip_address: req.ip || req.socket?.remoteAddress || null,
      trace_id: req.trace_id,
    });
    // SP-FX-28: write_intent accept 计数
    metricsRegistry.counter('write_intent_total', 'WriteIntent accept/reject count').inc({ result: 'accept' });
    // 广播建议被采纳事件
    broadcast('ai_suggestion', { id: parseInt(req.params.id), action: 'accepted' });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// SP-FX-47 F-01 (CRITICAL): operator/admin only
apiRouter.post('/ai/suggestions/:id/reject', requireRole('operator', 'admin'), (req: any, res) => {
  try {
    sqlite.rejectSuggestion(parseInt(req.params.id), req.user?.user_id || 'admin-001');
    sqlite.writeAuditLog({
      user_id: req.user?.user_id || 'admin-001',
      action: 'ai_suggestion_reject',
      target_type: 'ai_suggestion',
      target_id: req.params.id,
      ip_address: req.ip || req.socket?.remoteAddress || null,
      trace_id: req.trace_id,
    });
    // SP-FX-28: write_intent reject 计数
    metricsRegistry.counter('write_intent_total', 'WriteIntent accept/reject count').inc({ result: 'reject' });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// Manual retry for failed SCADA dispatches: resets dispatch_status='failed' → 'pending_dispatch'
// (retry_count reset to 0) so dispatcher picks it up again on next tick.
// SP-FX-47 F-01 (CRITICAL): operator/admin only
apiRouter.post('/ai/suggestions/:id/retry-dispatch', requireRole('operator', 'admin'), (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    const ok = sqlite.retryFailedDispatch(id);
    if (!ok) return res.status(409).json({ error: 'suggestion not in failed dispatch state' });
    sqlite.writeAuditLog({
      user_id: req.user?.user_id || 'admin-001',
      action: 'ai_suggestion_dispatch_retry',
      target_type: 'ai_suggestion',
      target_id: req.params.id,
      ip_address: req.ip || req.socket?.remoteAddress || null,
      trace_id: req.trace_id,
    });
    broadcast('ai_suggestion', { id, action: 'dispatch_retry', source_module: 'scada' });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ── AI配置 API ──

apiRouter.get('/settings/ai', (_req, res) => {
  try {
    const row: any = sqlite.getDatabase().prepare(
      "SELECT value FROM settings WHERE key = 'ai_config'"
    ).get();
    res.json(row ? JSON.parse(row.value) : {
      ollama_url: 'http://localhost:11434',
      model: 'gemma4',
      cloud_api_key: '',
      cloud_provider: 'anthropic',
    });
  } catch {
    res.json({ ollama_url: 'http://localhost:11434', model: 'gemma4', cloud_api_key: '', cloud_provider: 'anthropic' });
  }
});

apiRouter.put('/settings/ai', (req, res) => {
  const db = sqlite.getDatabase();
  // 确保settings表存在
  db.prepare(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('ai_config', ?, datetime('now'))`)
    .run(JSON.stringify(req.body));
  res.json({ success: true });
});

// ── 数据维护 API ──

apiRouter.get('/settings/data-maintenance', (_req, res) => {
  try {
    const db = sqlite.getDatabase();
    db.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`).run();
    const row: any = db.prepare("SELECT value FROM settings WHERE key = 'data_maintenance'").get();
    res.json(row ? JSON.parse(row.value) : {
      auto_backup: false, backup_interval_h: 24, retention_days: 365, log_cleanup_days: 90,
    });
  } catch {
    res.json({ auto_backup: false, backup_interval_h: 24, retention_days: 365, log_cleanup_days: 90 });
  }
});

apiRouter.put('/settings/data-maintenance', (req, res) => {
  const db = sqlite.getDatabase();
  db.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`).run();
  db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('data_maintenance', ?, datetime('now'))`)
    .run(JSON.stringify(req.body));
  res.json({ success: true });
});

apiRouter.post('/settings/data-maintenance/backup', (_req, res) => {
  try {
    const backupPath = `${DATA_DIR}/backups`;
    mkdirSync(backupPath, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destFile = `${backupPath}/biocore_${timestamp}.db`;
    sqlite.getDatabase().backup(destFile);
    res.json({ success: true, path: destFile, timestamp });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

apiRouter.post('/settings/data-maintenance/cleanup', (req, res) => {
  const { days } = req.body;
  const cutoff = new Date(Date.now() - (days || 90) * 86400000).toISOString();
  const db = sqlite.getDatabase();
  // 清理旧的state_transitions和step_logs (保留batches和audit_logs)
  const r1 = db.prepare('DELETE FROM state_transitions WHERE timestamp < ? AND batch_id IN (SELECT batch_id FROM batches WHERE current_state IN (\'complete\',\'stopped\'))').run(cutoff);
  const r2 = db.prepare('DELETE FROM step_logs WHERE started_at < ? AND batch_id IN (SELECT batch_id FROM batches WHERE current_state IN (\'complete\',\'stopped\'))').run(cutoff);
  res.json({ success: true, transitions_deleted: r1.changes, steps_deleted: r2.changes });
});

// ── WebSocket 广播集成 (状态变更/报警/步骤进度) ──
// v1.9.0 P2 bucket 1.5: wireReactorEvents + startReactorCollector +
// stopReactorCollector are produced by createReactorWiring() in
// ./reactor-wiring. Construction happens here (after sqlite, influx
// and the locally-defined autoCollectDoeResponses are all in scope).

// v1.9.0 P2 bucket 3: init audit micro-queue before wiring reactor events
// so that listener call sites can immediately use getAuditQueue().
initAuditQueue(sqlite);

const {
  startReactorCollector,
  stopReactorCollector,
  wireReactorEvents,
} = createReactorWiring({
  sqlite,
  influxWriteApi,
  broadcast,
  autoCollectDoeResponses,
});

// route-handler-split (post v1.12.0): single buildReactorConfig factory
// shared by /reactors POST, /reactors/:id/download-recipe, and the
// runOrphanRecoveryScan hook in startup.ts. Previously the same config
// literal was inlined 3 times — now they all delegate to this one helper.
function buildReactorConfig(reactorId: string): BatchControllerConfig {
  return {
    plcRead: async (tag: string) => {
      if (MOCK_PLC) return devPlcRead(tag);
      // 真实 PLC 读取 (待硬件就绪时通过 plc-driver 实现)
      throw new Error(`PLC 未连接, 无法读取 ${tag}. 请设置 MOCK_PLC=true 进行开发演示, 或配置真实 PLC 连接.`);
    },
    plcWrite: async (tag: string, value: number) => {
      // Recipe-step driven writes; bypasses SCADA suggestion buffer (recipe is pre-approved).
      // MOCK_PLC=true → MockPlcWriter (in-mem); real → S7/Modbus via createPlcWriter.
      await executeRecipePlcWrite({ mappingManager: varManager, writerFactory: createPlcWriter }, tag, value);
    },
    pollIntervalMs: 1000,
    getTemplateSteps: getTemplateStepsFromDB,
    getInterlockConfigs: () => getInterlockConfigsFromDB(reactorId),
    // B1.1 (currentNodeId) + B1.2 (loop frames) crash-recovery persistence.
    // Both callbacks are fire-and-forget — failure to persist must not crash
    // the controller; sqlite errors surface elsewhere.
    persist: {
      updateCurrentNodeId: (id, nodeId) => updateBatchCurrentNodeId(sqlite.getDatabase(), id, nodeId),
      updateLoopFrames: (id, json) => updateBatchLoopFrames(sqlite.getDatabase(), id, json),
    },
  };
}

// route-handler-split: register /reactors/* routes from ./reactor-routes
registerReactorRoutes(apiRouter, {
  sqlite,
  parseRecipeRow,
  buildReactorConfig,
  wireReactorEvents,
  broadcast,
});

// SCADA 项目 + 视图 REST API (broadcast 已在作用域内)
registerScadaRoutes(apiRouter, { sqlite, broadcast });
registerFuxaViewsRoutes(apiRouter, { sqlite });
// SP-FX-42: 告警通知系统
registerAlertRoutes(apiRouter, { db: sqlite.getDatabase() as any });

// ── 趋势历史数据 (InfluxDB) ──

// 允许查询的字段白名单 (防 Flux 注入)
const TREND_FIELDS = new Set([
  'temperature', 'jacket_temp', 'pH', 'DO', 'pressure',
  'airflow', 'weight', 'rpm', 'vfd_current',
]);
// M2.3: 放宽到 1-10 位数字, 支持 -86400s / -604800s 等 Sprint 2 自定义秒数
const TREND_RANGE_RE = /^-\d{1,10}[smhdw]$|^now\(\)$/;

// GET /api/trends?reactor_id=Reactor-1&fields=temperature,pH,DO&start=-1h&stop=now()
/**
 * @openapi
 * /trends:
 *   get:
 *     summary: 查询时序历史数据 (从 InfluxDB)
 *     tags: [Trends]
 *     parameters:
 *       - in: query
 *         name: reactor_id
 *         required: true
 *         schema: { type: string, example: "Reactor-1" }
 *       - in: query
 *         name: fields
 *         schema: { type: string, default: "temperature,pH,DO" }
 *         description: 逗号分隔字段, 仅允许白名单 (temperature/jacket_temp/pH/DO/pressure/airflow/weight/rpm/vfd_current)
 *       - in: query
 *         name: start
 *         schema: { type: string, default: "-1h", example: "-24h" }
 *         description: Flux 时间范围, 格式 -<数字>[smhdw] 或 now()
 *       - in: query
 *         name: stop
 *         schema: { type: string, default: "now()" }
 *       - in: query
 *         name: max_points
 *         schema: { type: integer, default: 500, minimum: 0, maximum: 5000 }
 *         description: LTTB 下采样目标点数 (M2.1)。默认 500; 0 = 禁用下采样; 超过 5000 会被截断。多字段时对每个字段单独跑 LTTB 后按时间戳 union。
 *       - in: query
 *         name: batch_id
 *         schema: { type: string, example: "B-20260408-001" }
 *         description: |
 *           可选。按 InfluxDB tag `batch_id` 过滤。提供时自动用 `range(start: 0)` 拿全量历史, 忽略 start/stop。
 *           仅允许字符 `[A-Za-z0-9_-]`, 其它字符会被剥离。
 *           注意:2026-04 前的历史数据可能将 downloaded recipe_id 错记为 batch_id (collector bug 已修复), 该过滤对修复后的新数据可靠。
 *     responses:
 *       200:
 *         description: 时序数据点列表 (按时间升序)
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/UnifiedResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         reactor_id: { type: string }
 *                         fields: { type: array, items: { type: string } }
 *                         start: { type: string }
 *                         stop: { type: string }
 *                         count: { type: integer }
 *                         data:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               _time: { type: string, format: date-time }
 *                               temperature: { type: number }
 *                               pH: { type: number }
 *                               DO: { type: number }
 *       400: { description: 缺少 reactor_id 或字段非法 }
 *       503: { description: InfluxDB 未配置 }
 */
apiRouter.get('/trends', async (req: any, res) => {
  if (!influxQueryApi) return res.status(503).json({ error: 'InfluxDB 未配置, 无法查询历史数据' });

  const reactorId = String(req.query.reactor_id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!reactorId) return res.status(400).json({ error: '缺少 reactor_id' });

  const rawFields = String(req.query.fields || 'temperature,pH,DO').split(',').map(s => s.trim());
  const fields = rawFields.filter(f => TREND_FIELDS.has(f));
  if (fields.length === 0) return res.status(400).json({ error: '没有合法字段' });

  let start = String(req.query.start || '-1h');
  let stop = String(req.query.stop || 'now()');
  if (!TREND_RANGE_RE.test(start)) start = '-1h';
  if (!TREND_RANGE_RE.test(stop)) stop = 'now()';

  // M2.1: max_points 参数, clamp [0, 5000], 默认 500, 0 = 不下采样
  let maxPoints = parseInt(String(req.query.max_points ?? '500'), 10);
  if (isNaN(maxPoints) || maxPoints < 0) maxPoints = 500;
  if (maxPoints > 5000) maxPoints = 5000;

  // M2.2: batch_id 过滤 (可选), 只允许 [A-Za-z0-9_-]
  const batchIdRaw = String(req.query.batch_id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const batchId = batchIdRaw || null;

  // M2.2: 提供 batch_id 时用 range(start: 0) 拿全量历史 (忽略 start/stop)
  const rangeClause = batchId ? 'range(start: 0)' : `range(start: ${start}, stop: ${stop})`;
  const batchIdFilter = batchId ? `|> filter(fn: (r) => r.batch_id == "${batchId}")` : '';

  const fieldFilter = fields.map(f => `r._field == "${f}"`).join(' or ');
  const flux = `
    from(bucket: "${INFLUX_BUCKET}")
      |> ${rangeClause}
      |> filter(fn: (r) => r._measurement == "process_data")
      |> filter(fn: (r) => r.reactor_id == "${reactorId}")
      ${batchIdFilter}
      |> filter(fn: (r) => ${fieldFilter})
      |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
      |> sort(columns: ["_time"])
  `;

  try {
    const rawRows: any[] = [];
    await new Promise<void>((resolve, reject) => {
      influxQueryApi!.queryRows(flux, {
        next(row, tableMeta) { rawRows.push(tableMeta.toObject(row)); },
        error(err) { reject(err); },
        complete() { resolve(); },
      });
    });

    // M2.1 LTTB 下采样: 给每个字段单独跑 LTTB, 然后按时间戳 union 合并
    let outRows = rawRows;
    if (maxPoints > 0 && rawRows.length > maxPoints) {
      const tsToRow = new Map<number, any>();
      for (const f of fields) {
        // 提取该字段非空的行
        const fieldRows = rawRows
          .map(r => ({ t: new Date(r._time).getTime(), v: r[f] }))
          .filter(p => p.v !== null && p.v !== undefined && !isNaN(p.v));
        if (fieldRows.length === 0) continue;
        // 该字段如果点数 ≤ maxPoints, 全保留; 否则跑 LTTB
        const sampled = fieldRows.length > maxPoints
          ? lttb(fieldRows, maxPoints, p => p.t, p => p.v)
          : fieldRows;
        // union 到 tsToRow
        for (const p of sampled) {
          if (!tsToRow.has(p.t)) tsToRow.set(p.t, { _time: new Date(p.t).toISOString() });
          tsToRow.get(p.t)![f] = p.v;
        }
      }
      // 按时间排序
      outRows = [...tsToRow.values()].sort((a, b) => new Date(a._time).getTime() - new Date(b._time).getTime());
    }

    res.json({
      reactor_id: reactorId,
      batch_id: batchId,
      fields,
      start: batchId ? '0' : start,
      stop: batchId ? 'now()' : stop,
      max_points: maxPoints,
      count: outRows.length,
      raw_count: rawRows.length,
      data: outRows,
    });
  } catch (e: any) {
    console.error('[Influx query] error:', e?.message || e);
    res.status(500).json({ error: e?.message || 'InfluxDB 查询失败' });
  }
});

// ── 状态 ──

apiRouter.get('/status', (_req, res) => {
  res.json({
    version: ROOT_VERSION,
    uptime: process.uptime(),
    ws_clients: wss.clients.size,
    heartbeats: [...heartbeats.entries()].map(([id, s]) => ({
      id, running: s.running, counter: s.counter, errors: s.errors,
    })),
  });
});

// ═══════════════════════════════════════════════════════════
// 启动
// ═══════════════════════════════════════════════════════════

// P0 修复: 同时处理 SIGINT (Ctrl+C) 和 SIGTERM (docker stop / k8s 优雅关闭)
let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[${new Date().toISOString()}] [INFO] [Server] 收到 ${signal}, 优雅关闭中...`);

  // 10 秒强制退出兜底
  const forceTimer = setTimeout(() => {
    console.error(`[${new Date().toISOString()}] [ERROR] [Server] 优雅关闭超时, 强制退出`);
    process.exit(1);
  }, 10000);
  forceTimer.unref();

  try {
    // 1. 停接受新 HTTP 连接
    server.close();
    // 2. 关闭所有 WS 客户端
    wss.clients.forEach(ws => { try { ws.close(1001, 'Server shutting down'); } catch {} });
    // 3. 停心跳 + 采集定时器
    for (const [id] of heartbeats) stopHeartbeat(id);
    for (const [id] of reactorCollectorTimers) stopReactorCollector(id);
    // 4. 清理所有反应器 (调用 destroy, 卸载监听器 + 停定时器)
    for (const r of reactorManager.listReactors()) {
      try { reactorManager.removeReactor(r.id); } catch (e) {
        console.error(`[Shutdown] 反应器 ${r.id} 清理失败:`, (e as Error).message);
      }
    }
    // 5. 停止后台调度器 (AI 建议引擎等)
    stopSchedulers();
    // SP-FX-39: 停止 backup scheduler
    try { backupScheduler?.stop(); } catch { /* ignore */ }
    // 6. Flush + close InfluxDB
    if (influxWriteApi) {
      try { await influxWriteApi.close(); } catch { /* ignore */ }
    }
    // v1.9.0 P2 bucket 3: drain any pending audit-queue rows before closing SQLite
    const _auditDrained = getAuditQueue().flushSync();
    if (_auditDrained) console.log('[AUDIT] flushed ' + _auditDrained + ' pending rows on shutdown');
    // 6. 关闭 SQLite (确保 WAL 同步)
    sqlite.close();
    // 7. 停 runtime-guard timers (T23: metricsCollector + memWd)
    try { metricsCollector.stop(); } catch { /* ignore */ }
    try { memWd.stop(); } catch { /* ignore */ }
    clearTimeout(forceTimer);
    console.log(`[${new Date().toISOString()}] [INFO] [Server] 已优雅关闭`);
    process.exit(0);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] [ERROR] [Server] 优雅关闭出错:`, (e as Error).message);
    process.exit(1);
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// v1.7.3 H7: 必须等 migrations 完成才能 server.listen, 防止启动时
// 处理请求却撞上未迁移的 schema (e.g. 缺列 / 缺表)。
async function start(): Promise<void> {
  await migrationsReady;
  // v1.8.0 bucket 1: admin init is async (bcrypt). Run after migrations
  // but before listen so the default admin row is in place when requests arrive.
  await ensureAdminAccount({ db: sqlite.getDatabase(), hashPasswordBcrypt });
  // 生产环境启动期 fail-fast: MOCK_PLC=true / admin 默认密码仍在用 → 拒启动。
  // 失败时抛错, start() 链路 reject → unhandled rejection 自然退出。
  await assertProductionReady({
    nodeEnv: process.env.NODE_ENV,
    mockPlc: process.env.MOCK_PLC === 'true',
    sqlite,
  });
  // v1.8.0 bucket 1: JWT_SECRET production guard.
  assertJwtSecretSafe();
  const scadaDispatcherHandle = startScadaWriteDispatcher({
    sqlite,
    broadcast,
    writerFactory: createPlcWriter,
    mappingManager: varManager,
  });
  process.on('SIGTERM', () => scadaDispatcherHandle.stop());
  process.on('SIGINT', () => scadaDispatcherHandle.stop());
  server.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║         BIOCore Server v${ROOT_VERSION}                ║
  ║         http://localhost:${PORT}               ║
  ║         WebSocket: ws://localhost:${PORT}/ws    ║
  ╠══════════════════════════════════════════════╣
  ║  SQLite:   ${DATA_DIR}/biocore.db              ║
  ║  安全模式: 测试只读, 地址校验                ║
  ╚══════════════════════════════════════════════╝
  `);

  // v1.7.2 + v1.9.0 P2 bucket 2 + v1.12.0 F2-AUTO: boot-time crash-recovery scan.
  // Default behavior = always-hold (preserves v1.7.2 safety). Operators can opt
  // into conservativeShortOutagePolicy via env: BIOCORE_RECOVERY_POLICY=conservative.
  // When the policy returns 'auto_resume' we now actually restart the engine
  // instead of falling back to hold (F2-AUTO). The reactor runtime
  // (manager + buildReactorConfig + wireReactorEvents) is injected so startup.ts
  // stays free of plc-bridge / reactor-wiring imports.
  runOrphanRecoveryScan({
    db: sqlite.getDatabase(),
    sqlite: {
      writeAuditLog: (e) => sqlite.writeAuditLog(e),
      getRecipe: (id, version) => sqlite.getRecipe(id, version),
      getReactorConfig: (id) => sqlite.getReactorConfig(id),
      parseRecipeRow: (row) => parseRecipeRow(row),
    },
    policy: pickRecoveryPolicyFromEnv(process.env.BIOCORE_RECOVERY_POLICY),
    reactorRuntime: {
      reactorManager,
      // route-handler-split: shared with /reactors POST + download-recipe
      // (MOCK_PLC swap + DB-backed template-step / interlock-config providers).
      buildReactorConfig,
      wireReactorEvents,
    },
  });

  // 自动注册所有 enabled 反应器 (启动后 reactor_configs 中标记启用但未由 orphan
  // recovery 注册的, 在此补齐). 避免每次手动 POST /api/reactors.
  try {
    const configured = sqlite.listReactorConfigs();
    for (const cfg of configured) {
      if (!cfg.enabled || cfg.enabled === 0) continue;
      if (reactorManager.getReactor(cfg.reactor_id)) continue;
      // try/catch 防止重复注册或其它边缘错误
      try {
        reactorManager.addReactor(cfg.reactor_id, buildReactorConfig(cfg.reactor_id));
        wireReactorEvents(cfg.reactor_id);
        console.log(`[BOOT] 自动注册反应器 ${cfg.reactor_id}`);
      } catch (e) {
        // 已注册 (orphan recovery 已处理) 或其它错误 — 静默跳过
        if (!/already/i.test((e as Error).message)) {
          console.warn(`[BOOT] 反应器 ${cfg.reactor_id} 注册失败: ${(e as Error).message}`);
        }
      }
    }
  } catch (e) {
    console.warn(`[BOOT] 自动注册扫描异常: ${(e as Error).message}`);
  }

  // 启动后台调度器 (AI 建议生成引擎等)
  startSchedulers({
    sqlite,
    feedAdvisor,
    softSensorEngine,
    cusumDetectors,
    broadcast,
    getRunningBatches: () => {
      const running: Array<{ batchId: string; reactorId: string; pv: Record<string, number> }> = [];
      for (const info of reactorManager.listReactors()) {
        const ctrl = reactorManager.getReactor(info.id);
        if (ctrl && ctrl.currentState === 'running' && ctrl.currentBatchId) {
          running.push({
            batchId: ctrl.currentBatchId,
            reactorId: info.id,
            pv: {
              temperature: devPlcRead('TEMP_PV'),
              pH: devPlcRead('PH_PV'),
              DO: devPlcRead('DO_PV'),
              pressure: devPlcRead('PRESSURE_PV'),
              rpm: devPlcRead('VFD_ACTUAL_FREQ') * 24,
            },
          });
        }
      }
      return running;
    },
  });
  });
  // SP-FX-39: 启动 backup scheduler (仅当 BACKUP_INTERVAL_HOURS 已设置)
  backupScheduler?.start();
}

start().catch((e) => {
  console.error('[BOOT] 启动失败:', e);
  process.exit(1);
});

export { app, server, wss, broadcast, sqlite, reactorManager };
