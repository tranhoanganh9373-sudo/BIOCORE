import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// SP-PLC-3 P2.3: 把 sendSubscribe / sendUnsubscribe stub 成 vi.fn 以便断言
// mount/unmount 调用. 其它 store export (useRealtimeStore, createTrendBuffer,
// sendWsMessage, __testHooks) 全保留真身.
vi.mock('@/stores/realtime-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/realtime-store')>();
  return {
    ...actual,
    sendSubscribe: vi.fn(),
    sendUnsubscribe: vi.fn(),
  };
});

import {
  useRealtimeStore,
  createTrendBuffer,
  sendSubscribe,
  sendUnsubscribe,
} from '@/stores/realtime-store';
import { useTag } from '../useTag';

function resetStore() {
  useRealtimeStore.setState({
    wsConnected: false,
    _tick: 0,
    reactorData: {},
    processValues: null,
    stateUpdate: null,
    calculatedParams: null,
    alarms: [],
    cusumAlerts: [],
    cusumHistory: {},
    heartbeatStatus: null,
    stepProgress: null,
    aiSuggestions: [],
    softSensorData: null,
    reactorStates: {},
    reactorRecipes: {},
    // SP-PLC-3 Patch B: trendBuffer 改 RingBuffer wrapper, helper alloc fresh 实例
    trendBuffer: createTrendBuffer(),
    batchRuntime: {},
    recentBranchEvaluations: [],
  });
}

function seedReactor(opts: {
  reactorId?: string;
  processValues?: any;
  wsConnected?: boolean;
  now?: number;
  qualityMap?: Record<string, 'good' | 'bad' | 'uncertain'>;
}) {
  const {
    reactorId = 'F01',
    processValues = null,
    wsConnected = true,
    now = Date.now(),
    qualityMap,
  } = opts;
  useRealtimeStore.setState({
    wsConnected,
    _tick: now,
    reactorData: {
      [reactorId]: {
        processValues,
        stateUpdate: null,
        calculatedParams: null,
        alarms: [],
        cusumAlerts: [],
        cusumHistory: {},
        softSensorData: null,
        // SP-PLC-3 Patch B: 每个 reactor 独立 RingBuffer wrapper, 严禁共享
        trendBuffer: createTrendBuffer(),
        qualityMap,
      },
    },
  });
}

describe('useTag', () => {
  beforeEach(() => {
    resetStore();
    vi.useFakeTimers();
    // SP-PLC-3 P2.3: 每 test 清 subscribe/unsubscribe call records
    (sendSubscribe as ReturnType<typeof vi.fn>).mockClear();
    (sendUnsubscribe as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('1. 合法 tag + 新鲜值 → value 正确 isStale=false ageMs 小', () => {
    const now = new Date('2026-05-15T10:00:00Z').getTime();
    vi.setSystemTime(now);
    seedReactor({
      processValues: { timestamp: '2026-05-15T10:00:00Z', 'AI-0': 37.5, batch_id: 'b1' },
      now,
    });
    const { result } = renderHook(() => useTag('F01.AI-0'));
    expect(result.current.value).toBe(37.5);
    expect(result.current.isStale).toBe(false);
    expect(result.current.ageMs).toBeLessThan(1000);
  });

  it('2. age > staleMs → isStale=true', () => {
    const start = new Date('2026-05-15T10:00:00Z').getTime();
    vi.setSystemTime(start);
    seedReactor({
      processValues: { timestamp: '2026-05-15T10:00:00Z', 'AI-0': 37.5 },
      now: start,
    });
    vi.setSystemTime(start + 10_000);
    act(() => {
      useRealtimeStore.setState({ _tick: start + 10_000 });
    });
    const { result } = renderHook(() => useTag('F01.AI-0'));
    expect(result.current.value).toBe(37.5);
    expect(result.current.isStale).toBe(true);
    expect(result.current.ageMs).toBeGreaterThanOrEqual(10_000);
  });

  it('3. tagId 缺 "." → null + stale', () => {
    seedReactor({ processValues: { timestamp: new Date().toISOString(), 'AI-0': 37.5 } });
    const { result } = renderHook(() => useTag('F01AI0'));
    expect(result.current.value).toBeNull();
    expect(result.current.isStale).toBe(true);
    expect(result.current.ageMs).toBe(Infinity);
  });

  it('4. tagId 多于一个 "." → null + stale', () => {
    seedReactor({ processValues: { timestamp: new Date().toISOString(), 'AI-0': 37.5 } });
    const { result } = renderHook(() => useTag('F01.AI.0'));
    expect(result.current.value).toBeNull();
    expect(result.current.isStale).toBe(true);
  });

  it('5. field 不在 ProcessValues 白名单 → null + stale', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    seedReactor({
      processValues: { timestamp: new Date(now).toISOString(), 'AI-0': 37.5 },
      now,
    });
    const { result } = renderHook(() => useTag('F01.UNKNOWN_FIELD'));
    expect(result.current.value).toBeNull();
    expect(result.current.isStale).toBe(true);
  });

  it('6. reactorData[rid] undefined → null + stale', () => {
    seedReactor({
      reactorId: 'F01',
      processValues: { timestamp: new Date().toISOString(), 'AI-0': 1 },
    });
    const { result } = renderHook(() => useTag('F99.AI-0'));
    expect(result.current.value).toBeNull();
    expect(result.current.isStale).toBe(true);
    expect(result.current.ageMs).toBe(Infinity);
  });

  it('7. processValues=null → null + stale', () => {
    seedReactor({ processValues: null, wsConnected: true });
    const { result } = renderHook(() => useTag('F01.AI-0'));
    expect(result.current.value).toBeNull();
    expect(result.current.isStale).toBe(true);
  });

  it('8. wsConnected=false → 强制 isStale=true 即使 ageMs 小', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    seedReactor({
      processValues: { timestamp: new Date(now).toISOString(), 'AI-0': 37.5 },
      now,
      wsConnected: false,
    });
    const { result } = renderHook(() => useTag('F01.AI-0'));
    expect(result.current.value).toBe(37.5);
    expect(result.current.isStale).toBe(true);
  });

  it('9. staleMs 自定义 10000 → 5s 后仍不 stale', () => {
    const start = Date.now();
    vi.setSystemTime(start);
    seedReactor({
      processValues: { timestamp: new Date(start).toISOString(), 'AI-0': 37.5 },
      now: start,
    });
    vi.setSystemTime(start + 5_000);
    act(() => {
      useRealtimeStore.setState({ _tick: start + 5_000 });
    });
    const { result } = renderHook(() => useTag('F01.AI-0', { staleMs: 10_000 }));
    expect(result.current.value).toBe(37.5);
    expect(result.current.isStale).toBe(false);
  });

  it('10. tick 触发后 ageMs 涨', () => {
    const start = Date.now();
    vi.setSystemTime(start);
    seedReactor({
      processValues: { timestamp: new Date(start).toISOString(), 'AI-0': 37.5 },
      now: start,
    });
    const { result } = renderHook(() => useTag('F01.AI-0'));
    expect(result.current.ageMs).toBeLessThan(1000);

    vi.setSystemTime(start + 2_000);
    act(() => {
      useRealtimeStore.setState({ _tick: start + 2_000 });
    });
    expect(result.current.ageMs).toBeGreaterThanOrEqual(2_000);
  });

  // ─── SP-PLC-3 P3 follow-up Patch A: quality 透传 ────────────────────────
  // 验 useTag 把 reactorData.qualityMap (由 broadcaster pv_realtime.payload.quality
  // 注入) 通过 FIELD_TO_QUALITY_TAG 映射后暴露成 TagSnapshot.quality.

  it('11. quality=good 时 useTag 返 quality=good', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    seedReactor({
      processValues: { timestamp: new Date(now).toISOString(), 'AI-0': 37.5 },
      now,
      qualityMap: { TEMP_PV: 'good' },
    });
    const { result } = renderHook(() => useTag('F01.AI-0'));
    expect(result.current.value).toBe(37.5);
    expect(result.current.quality).toBe('good');
  });

  it('12. quality=bad + value 保留 last-known-good → quality=bad + value 非 null', () => {
    // 模拟 P3 cache 通讯故障行为: tagCache 返 last-known-good value + quality=bad,
    // broadcaster 把 quality 透传给前端. useTag 应同时暴露 value (用于显示上次值)
    // 和 quality=bad (用于视觉提示).
    const now = Date.now();
    vi.setSystemTime(now);
    seedReactor({
      processValues: { timestamp: new Date(now).toISOString(), 'AI-2': 7.2 },
      now,
      qualityMap: { PH_PV: 'bad' },
    });
    const { result } = renderHook(() => useTag('F01.AI-2'));
    expect(result.current.value).toBe(7.2);
    expect(result.current.value).not.toBeNull();
    expect(result.current.quality).toBe('bad');
  });

  it('13. legacy server 无 qualityMap → quality undefined', () => {
    // P3 前 server 不带 payload.quality, store 写入 qualityMap=undefined.
    // 旧消费者 destructure { value, isStale, ageMs } 完全不破.
    const now = Date.now();
    vi.setSystemTime(now);
    seedReactor({
      processValues: { timestamp: new Date(now).toISOString(), 'AI-0': 37.5 },
      now,
      // qualityMap 不传 → undefined
    });
    const { result } = renderHook(() => useTag('F01.AI-0'));
    expect(result.current.value).toBe(37.5);
    expect(result.current.quality).toBeUndefined();
  });

  it('14. AI-1 不在 FIELD_TO_QUALITY_TAG 映射 → quality undefined (即使 qualityMap 含 TEMP_PV)', () => {
    // Patch A 范围保守 — 仅 AI-0/AI-2/AI-3/AI-4/rpm 映射. AI-1/AI-5/AI-6/AO_cv
    // 等不映射, useTag 返 quality undefined 即使 qualityMap 含其它 tag.
    const now = Date.now();
    vi.setSystemTime(now);
    seedReactor({
      processValues: { timestamp: new Date(now).toISOString(), 'AI-1': 22.3 },
      now,
      qualityMap: { TEMP_PV: 'good', JACKET_PV: 'bad' },
    });
    const { result } = renderHook(() => useTag('F01.AI-1'));
    expect(result.current.value).toBe(22.3);
    expect(result.current.quality).toBeUndefined();
  });

  // ============================================================
  // SP-PLC-3 Phase 2 Commit 3 (P2.3) — 自动订阅 lifecycle (3 tests)
  // ============================================================

  it('15. mount → sendSubscribe(reactorId, [plcTag]) 调一次', () => {
    seedReactor({ processValues: null });
    renderHook(() => useTag('F01.AI-2'));
    expect(sendSubscribe).toHaveBeenCalledTimes(1);
    expect(sendSubscribe).toHaveBeenCalledWith('F01', ['PH_PV']);
    expect(sendUnsubscribe).not.toHaveBeenCalled();
  });

  it('16. unmount → sendUnsubscribe(reactorId, [plcTag]) 调一次', () => {
    seedReactor({ processValues: null });
    const { unmount } = renderHook(() => useTag('F01.AI-0'));
    expect(sendSubscribe).toHaveBeenCalledWith('F01', ['TEMP_PV']);
    unmount();
    expect(sendUnsubscribe).toHaveBeenCalledTimes(1);
    expect(sendUnsubscribe).toHaveBeenCalledWith('F01', ['TEMP_PV']);
  });

  it('17. tagId 切换 → 旧 tag unsubscribe + 新 tag subscribe (无映射 field 不调)', () => {
    seedReactor({ processValues: null });
    const { rerender, unmount } = renderHook(({ tagId }) => useTag(tagId), {
      initialProps: { tagId: 'F01.AI-0' },
    });
    expect(sendSubscribe).toHaveBeenCalledWith('F01', ['TEMP_PV']);
    expect(sendSubscribe).toHaveBeenCalledTimes(1);

    // 切到不同 field 同 reactor
    rerender({ tagId: 'F01.AI-2' });
    // 旧 effect cleanup → unsubscribe('TEMP_PV'); 新 effect → subscribe('PH_PV')
    expect(sendUnsubscribe).toHaveBeenCalledWith('F01', ['TEMP_PV']);
    expect(sendSubscribe).toHaveBeenCalledWith('F01', ['PH_PV']);

    // 切到无映射的 field (temp_mode 不在 FIELD_TO_TAG) → 不发新 subscribe
    const subCallsBefore = (sendSubscribe as ReturnType<typeof vi.fn>).mock.calls.length;
    rerender({ tagId: 'F01.temp_mode' });
    expect(sendUnsubscribe).toHaveBeenCalledWith('F01', ['PH_PV']); // 旧 PH_PV cleanup
    expect((sendSubscribe as ReturnType<typeof vi.fn>).mock.calls.length).toBe(subCallsBefore);

    unmount(); // temp_mode 没注册订阅, unmount 时也不该再 unsubscribe
    // 总 unsubscribe 调用 = TEMP_PV + PH_PV = 2 次
    expect(sendUnsubscribe).toHaveBeenCalledTimes(2);
  });
});
