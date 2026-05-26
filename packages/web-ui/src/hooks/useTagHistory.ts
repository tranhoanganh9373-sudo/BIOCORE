import { useRealtimeStore } from '@/stores/realtime-store';
import { parseTagId } from './useTag';

export interface UseTagHistoryOpts {
  windowSec?: number;
  staleMs?: number;  // 同 useTag, age 超阈则 isStale=true; 默认 5000ms
}

export interface TagHistoryPoint {
  t: number;
  v: number;
}

export interface TagHistory {
  points: TagHistoryPoint[];
  isStale: boolean;
}

const DEFAULT_WINDOW_SEC = 60;
const DEFAULT_STALE_MS = 5000;

const TREND_FIELD_MAP: Record<string, 'temperature' | 'pH' | 'DO' | 'rpm' | 'airflow'> = {
  'AI-0': 'temperature',
  'AI-2': 'pH',
  'AI-3': 'DO',
  'AI-5': 'airflow',
  rpm: 'rpm',
};

const EMPTY_HISTORY: TagHistory = Object.freeze({ points: [], isStale: true });

export function useTagHistory(tagId: string, opts: UseTagHistoryOpts = {}): TagHistory {
  const windowSec = opts.windowSec ?? DEFAULT_WINDOW_SEC;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const wsConnected = useRealtimeStore((s) => s.wsConnected);
  const parsed = parseTagId(tagId);
  const reactorData = useRealtimeStore((s) =>
    parsed ? s.reactorData[parsed.reactorId] : undefined
  );

  if (!parsed) return EMPTY_HISTORY;
  if (!reactorData) return EMPTY_HISTORY;

  const latestTs = reactorData.processValues?.timestamp;
  const ageMs = latestTs ? Date.now() - new Date(latestTs).getTime() : Infinity;
  const isStale = !wsConnected || ageMs > staleMs;

  if (windowSec <= 0) return { points: [], isStale };

  const bufferKey = TREND_FIELD_MAP[parsed.field];
  if (!bufferKey) return { points: [], isStale };

  // SP-PLC-3 Patch B: trendBuffer 现在是 RingBuffer 实例, 必须 toArray() 物化.
  // 每次 hook re-run alloc 两个新 array (timestamps + values, 各 ≤3600 元素),
  // 远低于原 5Hz × 5 数组 spread+slice 的写端 alloc 量.
  // Follow-up (Patch C 或后续): 若 chart 重渲染频率成瓶颈, 在调用端 useMemo
  // (依赖 trendBuffer 引用) 包裹 toArray() 调用.
  const trend = reactorData.trendBuffer;
  const timestamps = trend.timestamps.toArray();
  const values = trend[bufferKey].toArray();
  if (!timestamps.length || !values.length) {
    return { points: [], isStale };
  }

  const n = Math.min(timestamps.length, values.length);
  const cutoffMs = Date.now() - windowSec * 1000;
  const points: TagHistoryPoint[] = [];
  for (let i = 0; i < n; i++) {
    const t = new Date(timestamps[i]).getTime();
    if (Number.isNaN(t)) continue;
    if (t < cutoffMs) continue;
    points.push({ t, v: values[i] });
  }

  return { points, isStale };
}
