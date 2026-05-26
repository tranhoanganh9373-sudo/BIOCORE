// ============================================================
// influx-flusher — periodic process_data Point writer (1Hz default)
// ============================================================
// SP-PLC-3 Phase 1 Commit 3 (P3)
// 计划: docs/plans/SP-PLC-3-tag-cache-plan.md  §1 Commit 3
//
// 职责:
//   - setInterval(flushMs) 周期遍历所有 reactor, 从 TagCache 读 9 个固定
//     tag, 拼 measurement='process_data' Point 调 writePoint + 异步 flush.
//   - quality='bad' 的 tag skip 不入 Point (last-known-good 值不再写入
//     时序库, 避免污染历史). 全字段 bad → 不调 writePoint.
//   - influxWriteApi=null (开发模式无 Influx) → noop.
//
// 与旧 reactor-wiring inline 写入的兼容性:
//   - measurement 名 / tag 名 / field 名 / field 类型 与旧
//     reactor-wiring.ts:173-185 严格一致 (9 fields, all floatField). 历史
//     时序数据可直接 union, 不会破现有 InfluxQL/Flux 查询.
//   - rpm = VFD_ACTUAL_FREQ × 24 转换跟旧 `rpmRaw = rawPV['VFD_ACTUAL_FREQ'] * 24` 一致.
//   - 旧 collector 60s 一次 (setInterval(tick, 60000)). 本 flusher 1000ms
//     一次 → 60× 写入频率, 是 plan §1 Commit 3 明示的升级.
//
// 不做:
//   - retention / downsample (Influx 服务端配置)
//   - 批写 / pyfolio 风格压缩 (Phase 2)
// ============================================================

import { Point } from '@influxdata/influxdb-client';
import type { WriteApi } from '@influxdata/influxdb-client';
import type { TagCache } from './tag-cache';

export interface FlusherDeps {
  tagCache: TagCache;
  /** null 时整个 flusher noop (开发模式无 Influx). */
  influxWriteApi: WriteApi | null;
  /** 当前所有 reactorId 列表. 每 tick 重新调用 (支持动态 reactor 增删). */
  reactorIds: () => string[];
  /** 'idle' 或 batch_id (Influx tag 不接受 null, 必须 string). */
  getBatchId: (reactorId: string) => string;
  /** 默认 1000ms, 可被 env INFLUX_FLUSH_MS override. */
  flushMs?: number;
}

const DEFAULT_FLUSH_MS = 1000;

/**
 * tag → Influx field 映射 (9 字段, 与旧 reactor-wiring.ts:173-185 一致).
 * 顺序无关 (InfluxDB Point fields 是 set), 但保留旧顺序便于人工 diff.
 */
const INFLUX_FIELDS: ReadonlyArray<{ field: string; tag: string; transform?: (v: number) => number }> = [
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

const INFLUX_TAGS: readonly string[] = INFLUX_FIELDS.map((f) => f.tag);

/**
 * 启动 flusher. 返 stop function (清 interval). 重复 stop 安全.
 * influxWriteApi=null 时仍返合法 stop 函数 (但 interval 是个 noop tick).
 */
export function startInfluxFlusher(deps: FlusherDeps): () => void {
  const flushMs = deps.flushMs ?? readEnvInt('INFLUX_FLUSH_MS', DEFAULT_FLUSH_MS);

  const tick = (): void => {
    if (!deps.influxWriteApi) return; // 开发模式 noop

    let reactorIds: string[];
    try {
      reactorIds = deps.reactorIds();
    } catch (err) {
      console.error(
        `[${new Date().toISOString()}] [ERROR] [influx-flusher] reactorIds() threw:`,
        (err as Error).message,
      );
      return;
    }

    let anyPointWritten = false;

    for (const reactorId of reactorIds) {
      try {
        const entries = deps.tagCache.readMany(reactorId, INFLUX_TAGS as string[]);
        const point = new Point('process_data')
          .tag('reactor_id', reactorId)
          .tag('batch_id', deps.getBatchId(reactorId))
          .timestamp(new Date());

        let fieldCount = 0;
        for (const { field, tag, transform } of INFLUX_FIELDS) {
          const entry = entries[tag];
          if (!entry) continue;                  // cache miss → skip 字段
          if (entry.quality === 'bad') continue; // quality bad → skip 字段
          const value = transform ? transform(entry.value) : entry.value;
          point.floatField(field, value);
          fieldCount++;
        }

        // 全字段 bad / 全 miss → 不调 writePoint (空 Point 无意义)
        if (fieldCount === 0) continue;

        deps.influxWriteApi.writePoint(point);
        anyPointWritten = true;
      } catch (err) {
        // 单 reactor 失败不影响其它 reactor 本 tick
        console.error(
          `[${new Date().toISOString()}] [ERROR] [influx-flusher] reactor=${reactorId} tick failed:`,
          (err as Error).message,
        );
      }
    }

    // 仅在本 tick 真有 Point 写入时才 flush, 避免 noop tick 触发 client 网络 IO.
    if (!anyPointWritten) return;
    deps.influxWriteApi.flush().catch((e: any) =>
      console.error(
        `[${new Date().toISOString()}] [ERROR] [influx-flusher] flush failed:`,
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
  };
}

/** 读 env int, parse 失败 / 未设落 default. 不抛错. */
function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
