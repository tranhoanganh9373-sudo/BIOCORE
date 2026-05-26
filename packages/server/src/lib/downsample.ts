// ============================================================
// lib/downsample.ts — 时序数据降采样共享算法 (SP-PLC-3 P2.5)
// ============================================================
//
// 此前 `downsampleValues` 内联在 batch-intelligence-routes.ts:54
// (LTTB wrapper, 用于前端图表压点); P2.5 起 downsample-flusher 也需要
// 降采样, 因此抽出到独立 lib, 让两者共享.
//
// 提供两个算法:
//   - downsampleValues : LTTB (Largest-Triangle-Three-Buckets), 保留视觉
//     极值/拐点. 用于前端图表压点 (~200 点). 与原 batch-intelligence-routes
//     实现 0 行为差异 (本文件仅做 import + re-export 包装).
//   - meanDownsample   : 简单分桶取均值. 用于 downsample-flusher 写
//     downsampled InfluxDB bucket (Spec §1 Commit 5 Q(iv) 默认: mean).
//     LTTB 在 targetPoints<=2 时退化到首尾两点, 不适合 "10s 窗口压成 1 个
//     均值" 场景, 故另引入此 mean 算法.
// ============================================================

import { lttb } from '../lttb';

/**
 * 把 `data` 按 LTTB 压到 `targetPoints` 个值. 保留极值/拐点形状, 适合
 * 前端图表压点. 行为与 batch-intelligence-routes.ts 原内联实现完全一致.
 *
 * 边界 (继承 lttb.ts):
 *   - targetPoints >= data.length → 返原数组的 value 序列
 *   - targetPoints <= 2 → 返首尾 2 个 value
 *
 * @param data - 时序点数组, 每项含 time + value.
 * @param targetPoints - 目标点数 (默认 200).
 */
export function downsampleValues(
  data: { time: number; value: number }[],
  targetPoints = 200,
): number[] {
  if (data.length <= targetPoints) return data.map((d) => d.value);
  const sampled = lttb(
    data,
    targetPoints,
    (d) => d.time,
    (d) => d.value,
  );
  return sampled.map((d) => d.value);
}

/**
 * 把 `values` 按时间窗口均匀分成 `targetPoints` 桶, 每桶取算术平均.
 * 用于 downsample-flusher: 把 10s 窗口内的 N 个采样值压成 1 个均值
 * 写入 downsampled bucket.
 *
 * 边界:
 *   - values.length === 0 → 返 []
 *   - targetPoints <= 0   → 返 []
 *   - targetPoints >= values.length → 返原数组 (每点自成一桶)
 *
 * 不做加权 / 不剔异常值 (downstream 已用 deadband 过滤无变化点, 噪声
 * 单纯取均值即可).
 *
 * @param values - 原始数值序列 (时间先后顺序).
 * @param targetPoints - 目标点数 (默认 1 = 全窗口 1 个均值).
 */
export function meanDownsample(values: number[], targetPoints = 1): number[] {
  if (values.length === 0 || targetPoints <= 0) return [];
  if (targetPoints >= values.length) return [...values];

  const out: number[] = [];
  const bucketSize = values.length / targetPoints;
  for (let i = 0; i < targetPoints; i++) {
    const lo = Math.floor(i * bucketSize);
    const hi = Math.floor((i + 1) * bucketSize);
    const end = Math.min(hi, values.length);
    let sum = 0;
    let count = 0;
    for (let j = lo; j < end; j++) {
      sum += values[j];
      count++;
    }
    if (count > 0) out.push(sum / count);
  }
  return out;
}

/**
 * SP-PLC-3 P3a.4: min/max/avg 分桶聚合.
 *
 * 与 meanDownsample 单值不同, 此算法每桶返回 {min, max, avg} 3 元组,
 * 适用于监控/告警/SPC 场景需要保留窗口极值的 dashboard (例如某 10s 窗口
 * 内 pH 瞬时尖峰若仅取均值会被洗掉, 而 min/max 能保留并触发告警).
 *
 * 等距分桶: 与 meanDownsample 同一桶切分规则
 * (`bucketSize = values.length / targetPoints`,
 * 边界 `Math.floor(i * bucketSize) ~ Math.floor((i+1) * bucketSize)`),
 * 保证两算法对相同 input 切相同的桶, 仅聚合方式不同.
 *
 * 边界:
 *   - values.length === 0 → []
 *   - targetPoints <= 0 → []
 *   - targetPoints >= values.length → 每桶 1 值 → {min=max=avg=value}
 *   - 单值数组 → [{min=max=avg=value}]
 *
 * 不做加权 / 不剔异常值 (与 meanDownsample 对齐).
 *
 * @param values - 原始数值序列 (时间先后顺序).
 * @param targetPoints - 目标点数 (默认 1 = 全窗口 1 个聚合三元组).
 */
export interface MinMaxAvgPoint {
  min: number;
  max: number;
  avg: number;
}

export function minMaxAvgDownsample(
  values: number[],
  targetPoints = 1,
): MinMaxAvgPoint[] {
  if (values.length === 0 || targetPoints <= 0) return [];
  if (targetPoints >= values.length) {
    return values.map((v) => ({ min: v, max: v, avg: v }));
  }

  const out: MinMaxAvgPoint[] = [];
  const bucketSize = values.length / targetPoints;
  for (let i = 0; i < targetPoints; i++) {
    const lo = Math.floor(i * bucketSize);
    const hi = Math.floor((i + 1) * bucketSize);
    const end = Math.min(hi, values.length);
    if (lo >= end) continue; // 空桶 skip (理论上不发生, 防御性)
    let min = values[lo];
    let max = values[lo];
    let sum = 0;
    let count = 0;
    for (let j = lo; j < end; j++) {
      const v = values[j];
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      count++;
    }
    out.push({ min, max, avg: sum / count });
  }
  return out;
}
