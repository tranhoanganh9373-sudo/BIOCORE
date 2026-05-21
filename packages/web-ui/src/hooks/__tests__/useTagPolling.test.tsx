import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTagPolling, type TagPollResult } from '../useTagPolling';

function mkFetcher(values: number[] = [10, 20, 30]) {
  let i = 0;
  return vi.fn(async (): Promise<TagPollResult> => {
    const v = values[i % values.length];
    i++;
    return { value: v, raw: v * 100, success: true };
  });
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('useTagPolling', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('初始 isPolling=false, samples 为空', () => {
    const { result } = renderHook(() => useTagPolling(mkFetcher(), 500));
    expect(result.current.isPolling).toBe(false);
    expect(result.current.samples).toHaveLength(0);
    expect(result.current.latest).toBeNull();
  });

  it('start() 立即触发一次 fetch + isPolling=true', async () => {
    const fetcher = mkFetcher([42]);
    const { result } = renderHook(() => useTagPolling(fetcher, 500));
    await act(async () => { result.current.start(); await flushMicrotasks(); });
    expect(result.current.isPolling).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.latest?.value).toBe(42);
    expect(result.current.latest?.raw).toBe(4200);
  });

  it('每 intervalMs 调用一次 fetcher', async () => {
    const fetcher = mkFetcher([1, 2, 3, 4]);
    const { result } = renderHook(() => useTagPolling(fetcher, 1000));
    await act(async () => { result.current.start(); await flushMicrotasks(); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1000); await flushMicrotasks(); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    // 分步推进避免 inFlightRef 锁吞掉中间 tick
    await act(async () => { vi.advanceTimersByTime(1000); await flushMicrotasks(); });
    expect(fetcher).toHaveBeenCalledTimes(3);
    await act(async () => { vi.advanceTimersByTime(1000); await flushMicrotasks(); });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('intervalMs < 250 被 clamp 到 250', async () => {
    const fetcher = mkFetcher();
    const { result } = renderHook(() => useTagPolling(fetcher, 100));
    await act(async () => { result.current.start(); await flushMicrotasks(); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(249); await flushMicrotasks(); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1); await flushMicrotasks(); });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('stop() 之后不再调 fetcher', async () => {
    const fetcher = mkFetcher();
    const { result } = renderHook(() => useTagPolling(fetcher, 500));
    await act(async () => { result.current.start(); await flushMicrotasks(); });
    await act(async () => { result.current.stop(); });
    expect(result.current.isPolling).toBe(false);
    const callsAtStop = fetcher.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(5000); await flushMicrotasks(); });
    expect(fetcher).toHaveBeenCalledTimes(callsAtStop);
  });

  it('samples 上限 maxSamples', async () => {
    const fetcher = mkFetcher([1, 2, 3, 4, 5]);
    const { result } = renderHook(() => useTagPolling(fetcher, 500, 3));
    await act(async () => { result.current.start(); await flushMicrotasks(); });
    for (let i = 0; i < 5; i++) {
      await act(async () => { vi.advanceTimersByTime(500); await flushMicrotasks(); });
    }
    expect(result.current.samples.length).toBeLessThanOrEqual(3);
  });

  it('fetcher 返回 success=false → sample.ok=false + error', async () => {
    const fetcher = vi.fn().mockResolvedValue({ value: 0, raw: 0, success: false, message: 'timeout' });
    const { result } = renderHook(() => useTagPolling(fetcher, 500));
    await act(async () => { result.current.start(); await flushMicrotasks(); });
    expect(result.current.latest?.ok).toBe(false);
    expect(result.current.latest?.error).toBe('timeout');
  });

  it('unmount 清理 timer', async () => {
    const fetcher = mkFetcher();
    const { result, unmount } = renderHook(() => useTagPolling(fetcher, 500));
    await act(async () => { result.current.start(); await flushMicrotasks(); });
    unmount();
    const callsAtUnmount = fetcher.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(5000); await flushMicrotasks(); });
    expect(fetcher).toHaveBeenCalledTimes(callsAtUnmount);
  });

  it('clear() 清空 samples', async () => {
    const fetcher = mkFetcher();
    const { result } = renderHook(() => useTagPolling(fetcher, 500));
    await act(async () => { result.current.start(); await flushMicrotasks(); });
    expect(result.current.samples.length).toBeGreaterThan(0);
    await act(async () => { result.current.clear(); });
    expect(result.current.samples).toHaveLength(0);
  });
});
