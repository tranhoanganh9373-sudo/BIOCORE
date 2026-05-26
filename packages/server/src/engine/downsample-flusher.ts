// ============================================================
// downsample-flusher — InfluxDB 分级采样 (SP-PLC-3 P2.5)
// ============================================================
//
// 计划: docs/plans/SP-PLC-3-tag-cache-phase2-plan.md  §1 Commit 5
//
// 职责:
//   - subscribe TagCache 收 9 字段的 dirty changes, 缓存到 reactor:tag
//     维度的累积 buffer.
//   - 每 DOWNSAMPLE_FLUSH_MS (默认 10000ms) tick 一次, 把每 reactor
//     每字段窗口内的 N 个值用 meanDownsample(values, 1) 压成 1 个均值,
//     拼 Point(measurement='process_data_downsampled', 同 reactor_id +
//     batch_id tag), 写入独立的 downsampled bucket.
//   - influxDownsampleApi=null (未配置 INFLUX_DOWNSAMPLED_BUCKET) → noop.
//     仍 subscribe TagCache + 维护 buffer + clear 防泄漏, 但不调 writePoint.
//
// 与主 flusher (influx-flusher.ts) 的差异:
//   - 写入频率: 主 1Hz raw bucket; 本 0.1Hz (10s tick) downsampled bucket.
//   - 写入策略: 主用 lastChanged 判定 skip 未变 tag; 本累计 10s 内全部
//     dirty 值取均值, 即使中间无变化也不写 (buffer 空 → skip).
//   - measurement 名: 主 'process_data'; 本 'process_data_downsampled'
//     (Influx 同 bucket 内 measurement 隔离, 但通常配独立 bucket 做
//     retention policy 区分 — raw 短期 / downsampled 长期).
//
// 算法 (Spec §1 Commit 5 Q(iv) 默认 = mean):
//   - meanDownsample(values, 1): 全窗口算术平均, 写 1 个 Point per
//     field per reactor per 10s.
//   - 备选 LTTB 在 targetPoints<=2 时退化到首尾两点, 不适合 "压成 1 个
//     代表值" 场景, 故选 mean. 详见 lib/downsample.ts JSDoc.
//
// SP-PLC-3 P3a.4: 加 DOWNSAMPLE_ALGORITHM env 切换:
//   - 'mean' (默认, 行为完全 = Phase 2): 1 字段 per tag.
//   - 'minmaxavg': 每 tag 写 3 字段 (_min/_max/_avg), 适合监控/告警
//     dashboard 需要保留窗口极值的场景. InfluxDB 写入量是 mean 模式 3 倍.
// ============================================================

import { Point } from '@influxdata/influxdb-client';
import type { WriteApi } from '@influxdata/influxdb-client';
import type { TagCache, CacheChange } from './tag-cache';
import { meanDownsample, minMaxAvgDownsample } from '../lib/downsample';

/** 单 reactor:tag 的 10s 窗口累积. */
interface FieldAccum {
  values: number[];
}

export interface DownsampleFlusherDeps {
  tagCache: TagCache;
  /** null 时整个 flusher noop (未配置 INFLUX_DOWNSAMPLED_BUCKET). */
  influxDownsampleApi: WriteApi | null;
  /** 当前所有 reactorId 列表. 每 tick 重新调 (支持动态 reactor 增删). */
  reactorIds: () => string[];
  /** 'idle' 或 batch_id (Influx tag 不接受 null, 必须 string). */
  getBatchId: (reactorId: string) => string;
  /** 默认 10000ms, 可被 env DOWNSAMPLE_FLUSH_MS override. */
  flushMs?: number;
}

const DEFAULT_FLUSH_MS = 10000;

/**
 * tag → Influx field 映射 (9 字段, 与 influx-flusher.ts INFLUX_FIELDS 完全一致,
 * 保证 raw bucket 与 downsampled bucket 字段命名 1:1 对应, 前端跨 bucket 查询
 * 可无缝切换). 顺序无关 (InfluxDB Point fields 是 set), 保留旧顺序便于人工 diff.
 */
const DOWNSAMPLE_FIELDS: ReadonlyArray<{ field: string; tag: string; transform?: (v: number) => number }> = [
  { field: 'temperature', tag: 'TEMP_PV' },
  { field: 'jacket_temp', tag: 'JACKET_PV' },
  { field: 'pH', tag: 'PH_PV' },
  { field: 'DO', tag: 'DO_PV' },
  { field: 'pressure', tag: 'PRESSURE_PV' },
  { field: 'airflow', tag: 'AIRFLOW_PV' },
  { field: 'weight', tag: 'WEIGHT_PV' },
  { field: 'rpm', tag: 'VFD_ACTUAL_FREQ', transform: (v) => v * 24 },
  { field: 'vfd_current', tag: 'VFD_CURRENT' },
];

/** 9 字段 PLC tag set, 用于 subscribe 过滤. */
const DOWNSAMPLE_TAG_SET = new Set<string>(DOWNSAMPLE_FIELDS.map((f) => f.tag));

/**
 * 启动 downsample-flusher. 返 stop function (清 interval + unsubscribe + clear accum).
 * 重复调用 stop 安全.
 *
 * 注意: subscribe 与 setInterval 都在 启动期 立即生效, 即使
 * influxDownsampleApi=null 也维持订阅 + 周期 clear accum 防内存泄漏 —
 * 但跳过 writePoint 调用避免 Influx 客户端 IO.
 */
export function startDownsampleFlusher(deps: DownsampleFlusherDeps): () => void {
  const flushMs = deps.flushMs ?? readEnvInt('DOWNSAMPLE_FLUSH_MS', DEFAULT_FLUSH_MS);
  // SP-PLC-3 P3a.4: 启动期 once 读取 algorithm (避免每 tick 重读 process.env).
  // 默认 'mean' = Phase 2 行为 (1 字段 per tag); 'minmaxavg' = 3 字段 per tag.
  // 任何非法值 (非两者之一) fallback 'mean', 不抛.
  const algorithm: 'mean' | 'minmaxavg' =
    (process.env.DOWNSAMPLE_ALGORITHM ?? 'mean').toLowerCase() === 'minmaxavg'
      ? 'minmaxavg'
      : 'mean';

  // 累积 buffer: key = `${reactorId}:${tag}`, value = 窗口内 quality=good 的值数组.
  // 闭包 scope: stop 后随闭包 GC, 多 flusher 实例隔离.
  const accum: Map<string, FieldAccum> = new Map();

  // 订阅 TagCache 收 dirty changes. 仅保留 9 个 downsample 目标 tag 的 quality=good 值.
  const subId = deps.tagCache.subscribe({
    reactorId: '*',
    tags: '*',
    callback: (changes: CacheChange[]) => {
      for (const c of changes) {
        if (!DOWNSAMPLE_TAG_SET.has(c.tag)) continue; // 非 9 字段 → skip
        if (c.entry.quality !== 'good') continue; // 仅累计良值
        const key = `${c.reactorId}:${c.tag}`;
        let buf = accum.get(key);
        if (!buf) {
          buf = { values: [] };
          accum.set(key, buf);
        }
        buf.values.push(c.entry.value);
      }
    },
  });

  const tick = (): void => {
    let reactorIds: string[];
    try {
      reactorIds = deps.reactorIds();
    } catch (err) {
      console.error(
        `[${new Date().toISOString()}] [ERROR] [downsample-flusher] reactorIds() threw:`,
        (err as Error).message,
      );
      // accum 不 clear (下 tick 继续累积), 与主 flusher 失败行为对齐.
      return;
    }

    // 即使 influxDownsampleApi=null 也必须遍历 accum 做 reset, 否则 buffer 无限增长.
    // 但不调 writePoint / flush (开发模式 noop 路径).
    const noWrite = !deps.influxDownsampleApi;

    let anyPointWritten = false;
    for (const reactorId of reactorIds) {
      try {
        const batchId = deps.getBatchId(reactorId);
        const point = new Point('process_data_downsampled')
          .tag('reactor_id', reactorId)
          .tag('batch_id', batchId)
          .timestamp(new Date());

        let fieldCount = 0;
        for (const { field, tag, transform } of DOWNSAMPLE_FIELDS) {
          const key = `${reactorId}:${tag}`;
          const buf = accum.get(key);
          if (!buf || buf.values.length === 0) continue;
          if (algorithm === 'minmaxavg') {
            // SP-PLC-3 P3a.4: 写 3 字段 per tag (_min/_max/_avg).
            // 边界 (length=0) 已上 skip; minMaxAvgDownsample(values, 1) → [{min,max,avg}].
            const agg = minMaxAvgDownsample(buf.values, 1);
            if (agg.length > 0) {
              const { min, max, avg } = agg[0];
              point.floatField(`${field}_min`, transform ? transform(min) : min);
              point.floatField(`${field}_max`, transform ? transform(max) : max);
              point.floatField(`${field}_avg`, transform ? transform(avg) : avg);
              fieldCount += 3;
            }
          } else {
            // 默认 'mean' = Phase 2 行为, 1 字段 per tag.
            // meanDownsample(values, 1) → [mean]. 边界 (length=0) 已上 skip.
            const downsampled = meanDownsample(buf.values, 1);
            if (downsampled.length > 0) {
              const value = transform ? transform(downsampled[0]) : downsampled[0];
              point.floatField(field, value);
              fieldCount++;
            }
          }
          // reset buffer (无论是否 noWrite, 都清以避免内存泄漏).
          accum.set(key, { values: [] });
        }

        if (noWrite || fieldCount === 0) continue;

        deps.influxDownsampleApi!.writePoint(point);
        anyPointWritten = true;
      } catch (err) {
        // 单 reactor 失败不影响其它 reactor 本 tick
        console.error(
          `[${new Date().toISOString()}] [ERROR] [downsample-flusher] reactor=${reactorId} tick failed:`,
          (err as Error).message,
        );
      }
    }

    if (!anyPointWritten) return;
    deps.influxDownsampleApi!.flush().catch((e: any) =>
      console.error(
        `[${new Date().toISOString()}] [ERROR] [downsample-flusher] flush failed:`,
        e?.message || e,
      ),
    );
  };

  const interval = setInterval(tick, flushMs);

  let stopped = false;
  return function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    deps.tagCache.unsubscribe(subId);
    accum.clear();
  };
}

/** 读 env int, parse 失败 / 未设落 default. 不抛错. */
function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
