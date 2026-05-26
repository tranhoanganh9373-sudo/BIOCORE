// ============================================================
// batch-intelligence-routes.ts — 批次智能分析 API
// GET /batches/:id/similar — DTW 批次相似度匹配
// GET /batches/:id/envelope — 历史包络线 (均值±2σ)
// POST /alarms/:id/root-cause — 告警根因分析
// ============================================================

import type { Router } from 'express';
import type { SQLiteService } from '@biocore/data-service';
import { dtwDistanceV2 as dtwDistance, rankBySimilarity, buildEnvelope, checkEnvelope } from '@biocore/ai-analytics';
// SP-PLC-3 P2.5: downsampleValues 抽到 lib/downsample.ts 共享 (与 downsample-flusher 共用)
import { downsampleValues } from './lib/downsample';

const INFLUX_BUCKET = process.env.INFLUX_BUCKET || 'fermentation';
const MOCK_INFLUX = process.env.MOCK_PLC === 'true' || !process.env.INFLUX_URL;

const VALID_FIELDS = new Set([
  'temperature', 'pH', 'DO', 'pressure', 'airflow', 'rpm',
]);

// InfluxDB 查询辅助: 拉取单批次单字段时序数据
// 注: export 供 batch-compare-routes 等其它模块复用 (同一查询语义, 避免重复)
export async function fetchBatchTimeSeries(
  queryApi: any,
  batchId: string,
  field: string,
): Promise<{ time: number; value: number }[]> {
  if (!queryApi) return [];

  const flux = `
    from(bucket: "${INFLUX_BUCKET}")
      |> range(start: 0)
      |> filter(fn: (r) => r._measurement == "process_data")
      |> filter(fn: (r) => r.batch_id == "${batchId}")
      |> filter(fn: (r) => r._field == "${field}")
      |> sort(columns: ["_time"])
  `;

  const rows: { time: number; value: number }[] = [];
  await new Promise<void>((resolve, reject) => {
    queryApi.queryRows(flux, {
      next(row: any, tableMeta: any) {
        const obj = tableMeta.toObject(row);
        rows.push({ time: new Date(obj._time).getTime(), value: obj._value });
      },
      error(err: any) { reject(err); },
      complete() { resolve(); },
    });
  });

  return rows;
}

// SP-PLC-3 P2.5: 原 inline downsampleValues 已抽到 lib/downsample.ts 共享给
// downsample-flusher; 此处 import 见文件顶部.

// 生成模拟时序数据 (开发模式)
function mockTimeSeries(batchId: string, field: string): number[] {
  const len = 120; // 模拟2小时 (120分钟)
  const seed = batchId.split('').reduce((s, c) => s + c.charCodeAt(0), 0);
  const base: Record<string, number> = { temperature: 37, pH: 7.0, DO: 30, pressure: 0.5, airflow: 2, rpm: 200 };
  const noise: Record<string, number> = { temperature: 0.3, pH: 0.05, DO: 5, pressure: 0.02, airflow: 0.2, rpm: 10 };
  const b = base[field] ?? 25;
  const n = noise[field] ?? 1;

  return Array.from({ length: len }, (_, i) => {
    const rng = Math.sin(seed * 9301 + i * 49297 + 233280) * 0.5 + 0.5;
    return b + (rng - 0.5) * n * 2;
  });
}

/**
 * 注册批次智能分析路由
 */
export function registerBatchIntelligenceRoutes(
  router: Router,
  sqlite: SQLiteService,
  influxQueryApi: any,
  rootCauseAnalyzer?: any,
): void {

  // GET /batches/:id/similar?field=temperature&top=5
  router.get('/batches/:id/similar', async (req, res) => {
    const { id } = req.params;
    const field = String(req.query.field || 'temperature');
    const top = Math.min(parseInt(String(req.query.top || '5'), 10), 20);

    if (!VALID_FIELDS.has(field)) {
      return res.status(400).json({ error: `无效字段, 可选: ${[...VALID_FIELDS].join(',')}` });
    }

    try {
      // 获取目标批次信息
      const targetBatch = sqlite.getBatch(id);
      if (!targetBatch) return res.status(404).json({ error: `批次 ${id} 不存在` });

      // 获取目标批次时序
      let targetData: number[];
      if (MOCK_INFLUX) {
        targetData = mockTimeSeries(id, field);
      } else {
        const rawData = await fetchBatchTimeSeries(influxQueryApi, id, field);
        targetData = downsampleValues(rawData);
      }

      if (targetData.length === 0) {
        return res.json({ target: id, field, similar: [], message: '目标批次无时序数据' });
      }

      // 获取同配方已完成批次
      const completedBatches = sqlite.getDatabase().prepare(
        `SELECT batch_id, recipe_id, started_at, ended_at
         FROM batches
         WHERE batch_id != ? AND status IN ('completed', 'complete')
         ORDER BY started_at DESC LIMIT 50`
      ).all(id) as any[];

      // 构建历史数据
      const historicals: { batchId: string; data: number[] }[] = [];
      for (const batch of completedBatches) {
        let data: number[];
        if (MOCK_INFLUX) {
          data = mockTimeSeries(batch.batch_id, field);
        } else {
          const rawData = await fetchBatchTimeSeries(influxQueryApi, batch.batch_id, field);
          data = downsampleValues(rawData);
        }
        if (data.length > 0) {
          historicals.push({ batchId: batch.batch_id, data });
        }
      }

      // DTW 排序
      const ranked = rankBySimilarity(targetData, historicals).slice(0, top);

      // 附加批次元数据
      const results = ranked.map(r => {
        const meta = completedBatches.find(b => b.batch_id === r.batchId);
        return {
          batch_id: r.batchId,
          distance: Number(r.distance.toFixed(2)),
          recipe_id: meta?.recipe_id,
          started_at: meta?.started_at,
          ended_at: meta?.ended_at,
        };
      });

      res.json({ target: id, field, similar: results });
    } catch (err: any) {
      res.status(500).json({ error: `DTW计算失败: ${err.message}` });
    }
  });

  // GET /batches/:id/envelope?field=temperature&sigma=2
  router.get('/batches/:id/envelope', async (req, res) => {
    const { id } = req.params;
    const field = String(req.query.field || 'temperature');
    const sigma = parseFloat(String(req.query.sigma || '2'));

    if (!VALID_FIELDS.has(field)) {
      return res.status(400).json({ error: `无效字段, 可选: ${[...VALID_FIELDS].join(',')}` });
    }

    try {
      const targetBatch = sqlite.getBatch(id);
      if (!targetBatch) return res.status(404).json({ error: `批次 ${id} 不存在` });

      // 获取同配方已完成批次
      const completedBatches = sqlite.getDatabase().prepare(
        `SELECT batch_id FROM batches
         WHERE batch_id != ? AND status IN ('completed', 'complete')
         ORDER BY started_at DESC LIMIT 20`
      ).all(id) as any[];

      // 收集历史时序
      const allSeries: number[][] = [];
      for (const batch of completedBatches) {
        let data: number[];
        if (MOCK_INFLUX) {
          data = mockTimeSeries(batch.batch_id, field);
        } else {
          const rawData = await fetchBatchTimeSeries(influxQueryApi, batch.batch_id, field);
          data = downsampleValues(rawData);
        }
        if (data.length > 0) allSeries.push(data);
      }

      if (allSeries.length === 0) {
        return res.json({ target: id, field, envelope: null, message: '无历史批次数据' });
      }

      // 构建包络线
      const envelope = buildEnvelope(allSeries);

      // 获取当前批次数据并检查
      let currentData: number[];
      if (MOCK_INFLUX) {
        currentData = mockTimeSeries(id, field);
      } else {
        const rawData = await fetchBatchTimeSeries(influxQueryApi, id, field);
        currentData = downsampleValues(rawData);
      }

      const check = checkEnvelope(currentData, envelope);

      res.json({
        target: id,
        field,
        sigma,
        historicalBatchCount: allSeries.length,
        envelope,
        currentBatch: {
          data: currentData,
          inBand: check.inBand,
          deviations: check.deviations,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: `包络线计算失败: ${err.message}` });
    }
  });

  // POST /alarms/:id/root-cause — 告警根因分析
  router.post('/alarms/:id/root-cause', async (req, res) => {
    if (!rootCauseAnalyzer) {
      return res.status(503).json({ error: '根因分析模块未加载' });
    }

    const { id } = req.params;

    try {
      // 从数据库获取告警信息
      const alarm = sqlite.getDatabase().prepare(
        'SELECT * FROM alarms WHERE id = ?'
      ).get(id) as any;

      if (!alarm) return res.status(404).json({ error: `告警 ${id} 不存在` });

      // 构建分析上下文
      const result = rootCauseAnalyzer.analyze({
        alarmType: alarm.alarm_code,
        severity: alarm.severity,
        channel: alarm.channel,
        pvAtTrigger: alarm.pv_at_trigger,
        svAtTrigger: alarm.sv_at_trigger,
        message: alarm.message,
      });

      res.json({
        alarm_id: id,
        alarm_code: alarm.alarm_code,
        ...result,
      });
    } catch (err: any) {
      res.status(500).json({ error: `根因分析失败: ${err.message}` });
    }
  });
}
