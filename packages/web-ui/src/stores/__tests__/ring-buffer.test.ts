// ============================================================
// RingBuffer 单测 — SP-PLC-3 Patch B
// ============================================================
// 覆盖: 边界 (capacity<=0 / 空 / 单元素 / 未满 / 满 / wraparound),
// 语义 (toArray 时间顺序), 操作 (clear), 泛型 (string / number 各一).
// ============================================================

import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../ring-buffer';

describe('RingBuffer', () => {
  it('1. constructor capacity<=0 抛错', () => {
    expect(() => new RingBuffer<number>(0)).toThrow(/positive/);
    expect(() => new RingBuffer<number>(-1)).toThrow(/positive/);
    expect(() => new RingBuffer<number>(-100)).toThrow(/positive/);
  });

  it('2. 空 buffer: length=0, toArray=[]', () => {
    const buf = new RingBuffer<number>(5);
    expect(buf.length).toBe(0);
    expect(buf.toArray()).toEqual([]);
  });

  it('3. push 单元素: length=1, toArray=[item]', () => {
    const buf = new RingBuffer<number>(5);
    buf.push(42);
    expect(buf.length).toBe(1);
    expect(buf.toArray()).toEqual([42]);
  });

  it('4. push N < capacity → toArray 按顺序 [first..last]', () => {
    const buf = new RingBuffer<number>(10);
    [1, 2, 3, 4, 5].forEach((v) => buf.push(v));
    expect(buf.length).toBe(5);
    expect(buf.toArray()).toEqual([1, 2, 3, 4, 5]);
  });

  it('5. push 满 → length=capacity', () => {
    const buf = new RingBuffer<number>(3);
    [10, 20, 30].forEach((v) => buf.push(v));
    expect(buf.length).toBe(3);
    expect(buf.toArray()).toEqual([10, 20, 30]);
  });

  it('6. push 超 capacity → length=capacity 不增长, 最旧被覆盖', () => {
    const buf = new RingBuffer<number>(3);
    // push 5 个, capacity=3, 应保最新 3 个 [3, 4, 5]
    [1, 2, 3, 4, 5].forEach((v) => buf.push(v));
    expect(buf.length).toBe(3);
    expect(buf.toArray()).toEqual([3, 4, 5]);
  });

  it('7. push 超 2× capacity → toArray 仅返最新 capacity 个', () => {
    const buf = new RingBuffer<number>(4);
    // push 10 个, 应保最新 4 个 [7, 8, 9, 10]
    Array.from({ length: 10 }, (_, i) => i + 1).forEach((v) => buf.push(v));
    expect(buf.length).toBe(4);
    expect(buf.toArray()).toEqual([7, 8, 9, 10]);
  });

  it('8. wraparound 后 toArray 顺序正确 (最旧 → 最新)', () => {
    const buf = new RingBuffer<number>(5);
    // 先 push 5 个填满: [1,2,3,4,5], writeIdx=0
    [1, 2, 3, 4, 5].forEach((v) => buf.push(v));
    // 再 push 3 个跨头: 内部数组实际 [6,7,8,4,5], writeIdx=3
    // toArray 应返时间序 [4,5,6,7,8]
    [6, 7, 8].forEach((v) => buf.push(v));
    expect(buf.length).toBe(5);
    expect(buf.toArray()).toEqual([4, 5, 6, 7, 8]);

    // 再 push 7 个 (一共 push 15, 应保最新 5 个 [11..15])
    [9, 10, 11, 12, 13, 14, 15].forEach((v) => buf.push(v));
    expect(buf.toArray()).toEqual([11, 12, 13, 14, 15]);
  });

  it('9. clear 后 length=0, toArray=[], capacity 不变', () => {
    const buf = new RingBuffer<number>(3);
    [1, 2, 3, 4].forEach((v) => buf.push(v));
    expect(buf.length).toBe(3);
    buf.clear();
    expect(buf.length).toBe(0);
    expect(buf.toArray()).toEqual([]);
    expect(buf.capacity).toBe(3);
    // clear 后仍可继续 push
    buf.push(99);
    expect(buf.toArray()).toEqual([99]);
  });

  it('10. 泛型: RingBuffer<string> 与 RingBuffer<number> 各跑一次', () => {
    const sBuf = new RingBuffer<string>(3);
    sBuf.push('a');
    sBuf.push('b');
    sBuf.push('c');
    sBuf.push('d');
    expect(sBuf.toArray()).toEqual(['b', 'c', 'd']);

    const nBuf = new RingBuffer<number>(2);
    nBuf.push(1.1);
    nBuf.push(2.2);
    nBuf.push(3.3);
    expect(nBuf.toArray()).toEqual([2.2, 3.3]);
  });
});
