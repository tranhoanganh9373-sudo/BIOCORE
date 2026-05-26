import { useEffect } from 'react';
import { useRealtimeStore, sendSubscribe, sendUnsubscribe } from '@/stores/realtime-store';

export interface UseTagOpts {
  staleMs?: number;
}

/**
 * Tag quality 三态 — 来自 SP-PLC-3 P3 broadcaster (`pv_realtime` payload `quality`
 * 嵌套对象). cache 在通讯故障时保留 last-known-good value 并把 quality 翻成 'bad',
 * 这样前端可以同时拿到 "上次的值" + "现在通讯断了" 两个信号.
 */
export type TagQuality = 'good' | 'bad' | 'uncertain';

export interface TagSnapshot {
  value: number | null;
  isStale: boolean;
  ageMs: number;
  /**
   * P3+: cache 三态 quality. undefined 表示 quality 信息缺失 —
   * legacy server (P3 前) 或字段不在 FIELD_TO_QUALITY_TAG 映射表里 (e.g. temp_mode
   * 这种纯模式字段, 没对应 PLC tag).
   */
  quality?: TagQuality;
}

export interface ParsedTagId {
  reactorId: string;
  field: string;
}

const DEFAULT_STALE_MS = 5000;

const PROCESS_VALUES_FIELDS = new Set<string>([
  'AI-0', 'AI-1', 'AI-2', 'AI-3', 'AI-4', 'AI-5', 'AI-6',
  'AO-0_cv', 'AO-1_cv', 'AO-2_cv',
  'P01_rate', 'P02_rate', 'P03_rate', 'P04_rate',
  'rpm', 'vfd_current', 'temp_sv', 'temp_mode',
]);

/**
 * ProcessValues field → PLC tag 映射. 仅列出 Patch A 范围内的 5 个核心 tag.
 * broadcaster (`PV_FIELDS`) 实际为全 19 个字段写 quality, 但 Patch A 暴露范围
 * 保守 — 不在表里的 field 返 quality=undefined (e.g. AI-1/AI-5/AI-6, AO_cv,
 * P0X_rate, vfd_current, temp_sv, temp_mode). 后续 Patch 可按需扩.
 */
const FIELD_TO_QUALITY_TAG: Record<string, string> = {
  'AI-0': 'TEMP_PV',
  'AI-2': 'PH_PV',
  'AI-3': 'DO_PV',
  'AI-4': 'PRESSURE_PV',
  rpm: 'VFD_ACTUAL_FREQ',
};

/**
 * SP-PLC-3 P2.3: ProcessValues field → PLC tag 全 19 字段映射. 与
 * server `realtime-broadcaster.PV_FIELDS` 严格一一对应. 用于 useTag
 * mount 时按 field 反查 tag 发 sendSubscribe.
 *
 * 与 FIELD_TO_QUALITY_TAG 区别: 后者是 Patch A 保守暴露范围 (仅 5 字段
 * 在 UI 公开 quality), 本表是 **订阅协议** 的完整映射 — 任何 PV field
 * 的 useTag 都该订阅, 否则 server 端 fan-out 会跳过该 tag → UI 看不到值.
 *
 * temp_mode 不在 PV_FIELDS 内 (payload 有但是常量 2), 无 PLC tag, 不订阅.
 */
const FIELD_TO_TAG: Record<string, string> = {
  'AI-0': 'TEMP_PV',
  'AI-1': 'JACKET_PV',
  'AI-2': 'PH_PV',
  'AI-3': 'DO_PV',
  'AI-4': 'PRESSURE_PV',
  'AI-5': 'AIRFLOW_PV',
  'AI-6': 'WEIGHT_PV',
  rpm: 'VFD_ACTUAL_FREQ',
  vfd_current: 'VFD_CURRENT',
  'AO-0_cv': 'STEAM_CV',
  'AO-1_cv': 'COOL_CV',
  'AO-2_cv': 'AIR_CV',
  P01_rate: 'P01_RATE',
  P02_rate: 'P02_RATE',
  P03_rate: 'P03_RATE',
  P04_rate: 'P04_RATE',
  temp_sv: 'TEMP_SV',
  pH_sv: 'PH_SV',
  DO_sv: 'DO_SV',
};

/** 给 useTagHistory 复用 (避免双源真相). */
export function tagForField(field: string): string | undefined {
  return FIELD_TO_TAG[field];
}

export function parseTagId(tagId: string): ParsedTagId | null {
  if (typeof tagId !== 'string') return null;
  const parts = tagId.split('.');
  if (parts.length !== 2) return null;
  const [reactorId, field] = parts;
  if (!reactorId || !field) return null;
  return { reactorId, field };
}

let tickStarted = false;
export function ensureTick(): void {
  if (tickStarted) return;
  if (typeof window === 'undefined') return;
  tickStarted = true;
  setInterval(() => {
    useRealtimeStore.setState({ _tick: Date.now() });
  }, 1000);
}

const STALE_SNAPSHOT: TagSnapshot = Object.freeze({
  value: null,
  isStale: true,
  ageMs: Infinity,
});

export function useTag(tagId: string, opts: UseTagOpts = {}): TagSnapshot {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;

  useEffect(() => {
    ensureTick();
  }, []);

  const wsConnected = useRealtimeStore((s) => s.wsConnected);
  const tick = useRealtimeStore((s) => s._tick);
  const parsed = parseTagId(tagId);
  const reactorData = useRealtimeStore((s) =>
    parsed ? s.reactorData[parsed.reactorId] : undefined
  );

  // SP-PLC-3 P2.3: mount 时按 (reactorId, plcTag) 自动 sendSubscribe,
  // unmount 时 sendUnsubscribe. WS 未 open 时 helper 静默不发 (会被重连后的
  // wsConnected → true 触发的 effect re-run 自动补发).
  //
  // 依赖 [parsed?.reactorId, parsed?.field, wsConnected] —
  //   - tagId 变 (reactor / field 切换) → 取消旧订阅, 发新订阅
  //   - wsConnected 从 false → true (重连后) → 补发订阅
  //   - 服务端 SubscriptionState 是 Set 自动去重, idempotent 安全
  const reactorIdForSub = parsed?.reactorId;
  const fieldForSub = parsed?.field;
  const plcTagForSub = fieldForSub ? FIELD_TO_TAG[fieldForSub] : undefined;
  useEffect(() => {
    if (!reactorIdForSub || !plcTagForSub) return;
    sendSubscribe(reactorIdForSub, [plcTagForSub]);
    return () => {
      sendUnsubscribe(reactorIdForSub, [plcTagForSub]);
    };
  }, [reactorIdForSub, plcTagForSub, wsConnected]);

  if (!parsed) return STALE_SNAPSHOT;
  if (!reactorData || !reactorData.processValues) return STALE_SNAPSHOT;
  if (!PROCESS_VALUES_FIELDS.has(parsed.field)) return STALE_SNAPSHOT;

  const pv = reactorData.processValues as Record<string, any>;
  const raw = pv[parsed.field];
  const value = typeof raw === 'number' ? raw : null;

  let ageMs = Infinity;
  if (pv.timestamp) {
    const ts = new Date(pv.timestamp).getTime();
    if (!Number.isNaN(ts)) {
      ageMs = Date.now() - ts;
    }
  }
  void tick;

  const isStale = value === null || !wsConnected || ageMs > staleMs;

  // P3+ quality: 按 field → PLC tag 映射, 从 reactorData.qualityMap 查.
  // 缺 qualityMap (legacy) / 字段不映射 → undefined (向后兼容, 旧消费者 destructure
  // { value, isStale, ageMs } 完全不受影响).
  const qualityTag = FIELD_TO_QUALITY_TAG[parsed.field];
  const quality: TagQuality | undefined = qualityTag
    ? reactorData.qualityMap?.[qualityTag]
    : undefined;

  return { value, isStale, ageMs, quality };
}
