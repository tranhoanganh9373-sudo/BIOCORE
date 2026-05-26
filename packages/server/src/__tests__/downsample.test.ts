// ============================================================
// SP-PLC-3 P3a.4 — lib/downsample minMaxAvgDownsample 算法单元测试 (5 项)
// 计划: docs/plans/SP-PLC-3-tag-cache-phase3a-plan.md  §1 Commit 4
// ============================================================
//
// 覆盖 (与 spec §1 Commit 4 "测试"):
//   1. 空数组 → []
//   2. 单值数组 → [{min=max=avg=v}]
//   3. 多值单桶 (targetPoints=1) → 整数组 {min, max, avg=sum/n}
//   4. 多值多桶 (targetPoints=2, [1,2,3,4]) → [{1-2 桶}, {3-4 桶}]
//   5. targetPoints >= length → 每桶 1 值 → min=max=avg
// ============================================================

import { describe, it, expect } from 'vitest';
import { minMaxAvgDownsample } from '../lib/downsample';

describe('SP-PLC-3 P3a.4 — minMaxAvgDownsample', () => {
  // 1. 空数组 → []
  it('空数组 → []', () => {
    expect(minMaxAvgDownsample([], 1)).toEqual([]);
    expect(minMaxAvgDownsample([], 5)).toEqual([]);
  });

  // 2. 单值数组 → [{min=max=avg=v}]
  it('单值数组 → [{min=max=avg=value}]', () => {
    expect(minMaxAvgDownsample([42], 1)).toEqual([{ min: 42, max: 42, avg: 42 }]);
  });

  // 3. 多值单桶 (targetPoints=1) → 整数组 min/max/avg
  it('多值单桶 (targetPoints=1) → {min: minOf, max: maxOf, avg: sum/n}', () => {
    const result = minMaxAvgDownsample([10, 5, 8, 3, 12], 1);
    expect(result).toHaveLength(1);
    expect(result[0].min).toBe(3);
    expect(result[0].max).toBe(12);
    expect(result[0].avg).toBe(38 / 5); // 7.6
  });

  // 4. 多值多桶 (targetPoints=2, [1,2,3,4]) → [{1-2 桶 min=1 max=2 avg=1.5}, {3-4 桶 min=3 max=4 avg=3.5}]
  it('多值多桶 ([1,2,3,4], 2) → [{min=1 max=2 avg=1.5}, {min=3 max=4 avg=3.5}]', () => {
    const result = minMaxAvgDownsample([1, 2, 3, 4], 2);
    expect(result).toEqual([
      { min: 1, max: 2, avg: 1.5 },
      { min: 3, max: 4, avg: 3.5 },
    ]);
  });

  // 5. targetPoints >= length → 每桶 1 值 → min=max=avg
  it('targetPoints >= length → 每桶 1 值 → min=max=avg', () => {
    // targetPoints == length
    expect(minMaxAvgDownsample([7, 9, 11], 3)).toEqual([
      { min: 7, max: 7, avg: 7 },
      { min: 9, max: 9, avg: 9 },
      { min: 11, max: 11, avg: 11 },
    ]);
    // targetPoints > length
    expect(minMaxAvgDownsample([7, 9], 5)).toEqual([
      { min: 7, max: 7, avg: 7 },
      { min: 9, max: 9, avg: 9 },
    ]);
  });
});
