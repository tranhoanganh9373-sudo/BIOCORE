// ============================================================
// bootstrap — Express app + middleware stack + apiRouter + swagger
// ============================================================
// Extracted from index.ts (v1.9.0 P2 bucket 1).
//
// Constructs the express app, mounts the cross-cutting middleware
// (CORS, JSON body, trace_id), builds the dual /api/v1 + /api router,
// wires the swagger-jsdoc spec (the JSDoc scan path is passed in by
// the caller so behaviorial parity with `apis: [__filename]` is kept
// — the JSDoc lives in index.ts and route-handler files), and finally
// returns the handles index.ts threads through the route registration
// + dual-mount step.
//
// CORS hardening (v1.7.3 H4) is preserved exactly:
//   - prod: ALLOWED_ORIGINS required, fail-fast on missing
//   - dev:  fallback to 'http://localhost:3000'
//   - never reflect arbitrary origin with credentials: true
// ============================================================

import express, { Router } from 'express';
import type { Express } from 'express';
import cors from 'cors';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';

import { traceMw } from './middlewares/trace';

export interface BootstrapHandles {
  app: Express;
  apiRouter: Router;
  swaggerSpec: object;
  authEnabled: boolean;
}

export interface BootstrapOptions {
  /**
   * 文件路径 (或 glob) 列表, swagger-jsdoc 用来扫描 `@openapi` JSDoc 注解.
   * 历史上仅传单个 `index.ts` (`apis: [__filename]`); v1.9.0 P2 把路由抽到
   * `*-routes.ts` 子文件后, 必须传 glob 数组 (如
   * `[__filename, path.resolve(__dirname, '*-routes.ts')]`) 否则子文件里的
   * `@openapi` 注解会被静默丢弃 — 这是 M5 Sprint 1 复盘发现的偏离 spec 的 bug.
   */
  swaggerScanPath: string | string[];
  /** v0 sunset date string used in /docs description and the deprecation header */
  apiV0Sunset: string;
}

/**
 * v1.7.3 H4: CORS resolver. ALLOWED_ORIGINS=comma,sep,list takes precedence;
 * otherwise prod hard-fails, dev falls back to http://localhost:3000.
 */
function resolveAllowedOrigins(): string | string[] {
  if (process.env.ALLOWED_ORIGINS) {
    return process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (process.env.NODE_ENV === 'production') {
    console.error('[CORS] FATAL: ALLOWED_ORIGINS env var is required in production. Set ALLOWED_ORIGINS=https://your.domain (comma-separated for multiple).');
    process.exit(1);
  }
  console.warn('[CORS] dev fallback origin = http://localhost:3000 (set ALLOWED_ORIGINS to override)');
  return 'http://localhost:3000';
}

export function createApp(opts: BootstrapOptions): BootstrapHandles {
  const { swaggerScanPath, apiV0Sunset } = opts;

  // ─── Express ───────────────────────────────────────────────
  const app: Express = express();
  const allowedOrigins = resolveAllowedOrigins();
  app.use(cors({
    origin: allowedOrigins,
    credentials: true,
    exposedHeaders: ['X-Trace-Id', 'Deprecation', 'Link'],
  }));
  app.use(express.json({ limit: '10mb' }));
  app.use(traceMw); // 所有路径注入 trace_id (含 v0/v1/非 /api 路径)

  // JWT 认证中间件: PUBLIC_PATHS 已迁移到 middlewares/auth.ts
  // (注意: 路径不再带 /api 前缀, 因为是 Router 内部路径)
  const authEnabled = process.env.AUTH_ENABLED !== 'false';

  // ─── API 路由器 (双挂载支持 /api/v1 + /api 兼容期) ────────────
  const apiRouter = Router();
  console.log(`[${new Date().toISOString()}] [INFO] [API] V0 兼容期截止日期: ${apiV0Sunset}`);

  // ─── Swagger / OpenAPI 文档 ──────────────────────────────────
  // swaggerScanPath comes from the caller (= index.ts __filename) so the
  // @openapi JSDoc blocks in route handlers are still picked up byte-for-byte
  // — moving the scan path silently here would empty the docs site.
  const swaggerSpec = swaggerJsdoc({
    definition: {
      openapi: '3.0.0',
      info: {
        title: 'BIOCore API',
        version: '1.0.0',
        description: `发酵罐控制平台 REST API.\n\n旧 \`/api/*\` 路径将于 ${apiV0Sunset} 停用,请使用 \`/api/v1/*\`.\n\n两种鉴权方式:\n- **JWT** (Authorization: Bearer xxx) — 给前端 UI 用\n- **API Key** (X-API-Key: ak_xxx.xxx) — 给 MES/外部系统用,优先级更高`,
      },
      servers: [
        { url: 'http://localhost:3001/api/v1', description: 'V1 (推荐)' },
        { url: 'http://localhost:3001/api', description: 'V0 (已废弃, 6 个月后停用)' },
      ],
      components: {
        securitySchemes: {
          ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
          Bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
        schemas: {
          UnifiedResponse: {
            type: 'object',
            properties: {
              code: { type: 'integer', example: 0, description: '0 = 成功, 4xx/5xx = 错误' },
              msg: { type: 'string', example: 'ok' },
              data: { description: '业务数据 (各端点不同)' },
              trace_id: { type: 'string', example: 'aa3029adbfdf68c5', description: '跨系统排错关联 ID' },
            },
          },
        },
      },
      security: [{ Bearer: [] }, { ApiKey: [] }],
    },
    apis: Array.isArray(swaggerScanPath) ? swaggerScanPath : [swaggerScanPath],
  });

  // /docs 公开 (无需鉴权), 已在 PUBLIC_PATHS 中
  apiRouter.get('/docs.json', (_req, res) => res.json(swaggerSpec));
  apiRouter.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customSiteTitle: 'BIOCore API Docs',
  }));

  return { app, apiRouter, swaggerSpec, authEnabled };
}
