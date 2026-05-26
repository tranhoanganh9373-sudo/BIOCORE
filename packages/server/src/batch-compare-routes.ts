// ============================================================
// batch-compare-routes.ts — 批次统计对比 API (F1+F8)
// GET /batches/compare?batch_ids=A,B,C&fields=temperature,pH
// 从 InfluxDB 拉全量数据 → 计算统计 (箱线图用)
// ============================================================

import type { Router } from 'express';
import type { SQLiteService } from '@biocore/data-service';
import { computeFieldStats, type FieldStats } from './stats-utils';
import { fetchBatchTimeSeries } from './batch-intelligence-routes';

// 开发模式: InfluxDB 未部署时使用模拟统计
const MOCK_INFLUX = process.env.MOCK_PLC === 'true' || !process.env.INFLUX_URL;

const VALID_FIELDS = new Set([
  'temperature', 'jacket_temp', 'pH', 'DO', 'pressure',
  'airflow', 'weight', 'rpm', 'vfd_current', 'feed',
]);

interface BatchCompareResult {
  batch_id: string;
  recipe_id?: string;
  recipe_name?: string;
  started_at?: string;
  ended_at?: string;
  duration_h?: number;
  stats: Record<string, FieldStats | null>;
}

/**
 * 注册批次对比路由
 * @param router Express Router (apiRouter)
 * @param sqlite SQLiteService 实例
 * @param influxQueryApi InfluxDB QueryApi 实例 (生产模式下用于拉取时序; 未配置时单字段 stats 退化为 null, 不抛错)
 */
export function registerBatchCompareRoutes(
  router: Router,
  sqlite: SQLiteService,
  influxQueryApi: any,
): void {

  // GET /batches/compare?batch_ids=A,B,C&fields=temperature,pH
  router.get('/batches/compare', async (req, res) => {
    const rawIds = (req.query.batch_ids as string || '').split(',').map(s => s.trim()).filter(Boolean);
    const rawFields = (req.query.fields as string || '').split(',').map(s => s.trim()).filter(Boolean);

    if (rawIds.length === 0) return res.status(400).json({ error: '缺少 batch_ids 参数' });
    if (rawIds.length > 10) return res.status(400).json({ error: '最多同时对比 10 个批次' });
    if (rawFields.length === 0) return res.status(400).json({ error: '缺少 fields 参数' });

    const fields = rawFields.filter(f => VALID_FIELDS.has(f));
    if (fields.length === 0) return res.status(400).json({ error: `无有效字段, 可选: ${[...VALID_FIELDS].join(',')}` });

    try {
      const results: BatchCompareResult[] = [];

      for (const batchId of rawIds) {
        // 从 SQLite 取批次元数据
        const batchRow: any = sqlite.getDatabase().prepare(
          'SELECT batch_id, recipe_id, reactor_id, current_state, started_at, ended_at FROM batches WHERE batch_id = ?'
        ).get(batchId);
        if (!batchRow) {
          results.push({ batch_id: batchId, stats: {} });
          continue;
        }

        // 从 SQLite recipes 拿名称
        const recipeRow: any = sqlite.getDatabase().prepare(
          'SELECT name FROM recipes WHERE recipe_id = ? LIMIT 1'
        ).get(batchRow.recipe_id);

        // 计算时长
        let durationH: number | undefined;
        if (batchRow.started_at && batchRow.ended_at) {
          durationH = (new Date(batchRow.ended_at).getTime() - new Date(batchRow.started_at).getTime()) / 3600000;
        }

        // 从 InfluxDB 或模拟数据获取时序统计
        const stats: Record<string, FieldStats | null> = {};

        if (MOCK_INFLUX) {
          // 开发模式: 生成模拟统计数据 (基于种子使每个批次有可重复的差异)
          const seed = hashCode(batchId);
          for (const field of fields) {
            const base = fieldBaseValue(field);
            const n = 200 + (seed % 300);
            const mockValues = Array.from({ length: n }, (_, i) => {
              return base + (Math.sin(i / 20 + seed) * base * 0.1) + (seededRandom(seed + i) - 0.5) * base * 0.05;
            });
            stats[field] = computeFieldStats(mockValues);
          }
        } else {
          // 真实 InfluxDB 查询: 复用 batch-intelligence-routes 的 fetchBatchTimeSeries
          // 异常守卫: queryApi 缺失或单 field 查询失败仅该 field 退化为 null, 不污染其它 field 也不让 500 冒上来
          for (const field of fields) {
            try {
              const rawData = await fetchBatchTimeSeries(influxQueryApi, batchId, field);
              const values = rawData.map(r => r.value);
              stats[field] = computeFieldStats(values);
            } catch (fieldErr) {
              console.warn(
                `[batch-compare] InfluxDB 查询失败 batch=${batchId} field=${field}: ${(fieldErr as Error).message}`,
              );
              stats[field] = null;
            }
          }
        }

        results.push({
          batch_id: batchRow.batch_id,
          recipe_id: batchRow.recipe_id,
          recipe_name: recipeRow?.name,
          started_at: batchRow.started_at,
          ended_at: batchRow.ended_at,
          duration_h: durationH,
          stats,
        });
      }

      res.json({ batches: results, fields });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
}

// ── 辅助 ──

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function seededRandom(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

function fieldBaseValue(field: string): number {
  const bases: Record<string, number> = {
    temperature: 37, jacket_temp: 38, pH: 7, DO: 30, pressure: 0.5,
    airflow: 2, weight: 3, rpm: 300, vfd_current: 2, feed: 5,
  };
  return bases[field] ?? 10;
}
