// ============================================================
// RingBuffer<T> — 定容环形缓冲, write O(1) 不 alloc
// ============================================================
//
// SP-PLC-3 Phase 1 follow-up Patch B (2026-05-26):
// realtime-store trendBuffer 改用此类, 消除 5Hz pv_realtime 写入触发的
// 5 × 3600 number 数组 spread + slice (audit Finding 1 估 14 MB/s alloc
// @ 10 reactor × 5 Hz). 改写后 write 端零分配 (覆盖固定 Array slot);
// 读端按需 `toArray()` 一次性物化 plain array (chart re-render 触发频率
// 远低于 5 Hz, 净 alloc 字节降幅 ~99%).
//
// 语义不变: 时间顺序由 push 决定, 满后覆盖最旧 (FIFO drop-oldest).
// `toArray()` 返按时间顺序 (最旧 → 最新) 的 plain array, 与原裸数组等价
// 让上游消费者 (Recharts/ECharts 等 prop 类型为 number[] 的组件) 无破坏迁移.
// ============================================================

export class RingBuffer<T> {
  /** 固定 capacity 容器, 长度恒为 `capacity` (空 slot 用 undefined 占位). */
  private buf: T[];
  /** 下次 push 写入的位置 (0-indexed, mod capacity). 满后该位置即"最旧". */
  private writeIdx = 0;
  /** 当前有效元素数 (push 累计, 上限 capacity). */
  private _length = 0;

  constructor(public readonly capacity: number) {
    if (capacity <= 0) {
      throw new Error('RingBuffer capacity must be positive');
    }
    this.buf = new Array(capacity);
  }

  /** O(1) push, 不 alloc (内部数组覆盖). 满后覆盖最旧元素. */
  push(item: T): void {
    this.buf[this.writeIdx] = item;
    this.writeIdx = (this.writeIdx + 1) % this.capacity;
    if (this._length < this.capacity) {
      this._length++;
    }
  }

  /** 当前有效长度 (≤ capacity). */
  get length(): number {
    return this._length;
  }

  /**
   * 按时间顺序 (最旧 → 最新) 物化 plain array.
   * 每次调用 alloc 一个新 array; 调用端按需缓存 (e.g. useMemo) 避免每帧重物化.
   */
  toArray(): T[] {
    if (this._length < this.capacity) {
      // 未满: 元素在 [0, _length), writeIdx 即下一空 slot.
      return this.buf.slice(0, this._length);
    }
    // 已满: writeIdx 是最旧位置, 拼 [writeIdx..end] ++ [0..writeIdx].
    return this.buf.slice(this.writeIdx).concat(this.buf.slice(0, this.writeIdx));
  }

  /** 清空 (capacity 不变). 测试 + WS 重连初始化时用. */
  clear(): void {
    this.buf = new Array(this.capacity);
    this.writeIdx = 0;
    this._length = 0;
  }
}
