// ============================================================
// realtime-broadcaster — dirty-only WS pv_realtime fan-out
// ============================================================
// SP-PLC-3 Phase 1 Commit 3 (P3)
// 计划: docs/plans/SP-PLC-3-tag-cache-plan.md  §1 Commit 3
//
// 职责:
//   - 订阅 TagCache 全 reactor 全 tag 的变化 (`reactorId='*' tags='*'`).
//   - 内部维护 dirtyQueue: Map<reactorId, Set<tag>>, 订阅 callback 仅 push
//     (不立即 broadcast), 避免高频变化下 WS 流量暴涨.
//   - setInterval(tickMs) 周期 flush dirtyQueue: 按 reactor 聚合, 从 cache
//     读全 19 个 tag 拼 pv_realtime payload (保持前端字段兼容), 一次
//     broadcast/reactor.
//   - 静态期 dirtyQueue 空 → 0 推送 (零 WS 流量, P3 关键性能目标).
//   - back-pressure: 推送前检查 wss.clients 中是否有 client.bufferedAmount
//     超阈; 任一超阈则**整个 broadcast 该 tick skip 该 reactor** + console.warn.
//
// 与旧 reactor-wiring inline 推送的兼容性:
//   - payload 字段名 / shape 与旧 reactor-wiring.ts:193-216 pvPayload 一致
//     (23 字段, 见下方 PV_FIELDS), 新增 `quality` 字段携带各 tag quality 三态.
//   - broadcast 调用签名 (channel, payload, batchId, reactorId) — 第 3 参
//     batchId 通过外部 getBatchId 注入, 与旧 `batchId === 'idle' ? null : batchId` 等价.
//   - 旧 collector 60s 一次 tick (setInterval(tick, 60000)). 本 broadcaster
//     200ms 一次 tick → 5Hz fan-out, 是 plan §1 Commit 3 明示的性能升级
//     (静态期无流量补偿 5Hz 空 tick 成本).
//
// 不做:
//   - 客户端订阅过滤 / per-channel 速率限制 (Phase 2)
//   - 重要事件 ack/重传 (alarm/phase 走独立路径, plan §2e)
// ============================================================

import type { TagCache, CacheChange } from './tag-cache';

/** broadcaster 启动时注入的依赖. wss 仅取 clients 集合做 back-pressure 度量. */
export interface BroadcasterDeps {
  tagCache: TagCache;
  /** 与 ws-server.broadcast 同签名: (channel, payload, batchId, reactorId). */
  broadcast: (
    channel: string,
    payload: any,
    batchId: string | null,
    reactorId: string,
  ) => void;
  /**
   * ws.WebSocketServer 实例 (或 minimal duck-typed shape). 仅读 `clients`
   * 集合的 `bufferedAmount` 做 back-pressure 检查, 不做其它操作.
   */
  wss: { clients: { forEach(cb: (client: { bufferedAmount: number }) => void): void } };
  /**
   * batchId 解析回调. 每 tick 每 reactor 查一次, 落 broadcast 第 3 参数.
   * 'idle' / 不存在 reactor / 不在 running 状态时返 null (与旧
   * `batchId === 'idle' ? null : batchId` 等价语义).
   */
  getBatchId: (reactorId: string) => string | null;
  /** 默认 200ms, 可被 env BROADCAST_TICK_MS override. */
  tickMs?: number;
  /** 默认 1MB (1048576), 可被 env WS_MAX_BUFFERED_AMOUNT override. */
  maxBufferedAmount?: number;
  /**
   * SP-PLC-3 P2.5: 可选 skip 事件回调. 每次因 back-pressure 整 reactor skip
   * fan-out 时调一次 (per reactor). 用于 cache-metrics 累计
   * biocore_broadcaster_skipped_total{reason='back-pressure'} 计数器.
   * 不传 → 行为不变 (老 wiring 兼容).
   */
  onSkip?: (reason: 'back-pressure') => void;
  /**
   * SP-PLC-3 P3a.2: 可选 fan-out 延迟回调. 仅在 tick 真做 fan-out
   * (dirtyQueue.size>0) 时, 在 reactor 循环外整体 wrap performance.now() 后调一次
   * elapsedSeconds 入参. 0-dirty 空 tick 不调 (避免噪声入桶). 用于 cache-metrics
   * 累计 biocore_broadcaster_fanout_seconds Histogram. 不传 → 行为不变.
   */
  onFanout?: (elapsedSeconds: number) => void;
}

/**
 * pv_realtime payload tag → field 映射 (与旧 reactor-wiring.ts:193-216 一致).
 * 这是前端兼容契约: 字段集合 + 字段名 / shape 不能变 (新增 quality 字段除外).
 *
 * `transform` 函数对单个 tag value 做必要变换 (例如 VFD_ACTUAL_FREQ × 24
 * → rpm 整数). undefined 表示直传.
 */
// SP-PLC-3 P2.3: export 让 ws-server.buildSubsetPvPayload 复用 (反向 tag→field 查表).
// 仅 export, 行为不变.
export const PV_FIELDS: ReadonlyArray<{ field: string; tag: string; transform?: (v: number) => number }> = [
  { field: 'AI-0', tag: 'TEMP_PV' },          // 罐温
  { field: 'AI-1', tag: 'JACKET_PV' },        // 夹套温度
  { field: 'AI-2', tag: 'PH_PV' },            // pH
  { field: 'AI-3', tag: 'DO_PV' },            // DO
  { field: 'AI-4', tag: 'PRESSURE_PV' },      // 罐压
  { field: 'AI-5', tag: 'AIRFLOW_PV' },       // 空气流量
  { field: 'AI-6', tag: 'WEIGHT_PV' },        // 称重
  { field: 'rpm', tag: 'VFD_ACTUAL_FREQ', transform: (v) => Math.round(v * 24) },
  { field: 'vfd_current', tag: 'VFD_CURRENT' },
  { field: 'AO-0_cv', tag: 'STEAM_CV' },       // 蒸汽阀
  { field: 'AO-1_cv', tag: 'COOL_CV' },        // 冷却阀
  { field: 'AO-2_cv', tag: 'AIR_CV' },         // 空气阀
  { field: 'P01_rate', tag: 'P01_RATE' },       // 碱泵
  { field: 'P02_rate', tag: 'P02_RATE' },       // 补料泵
  { field: 'P03_rate', tag: 'P03_RATE' },       // 氮源泵
  { field: 'P04_rate', tag: 'P04_RATE' },       // 酸泵
  { field: 'temp_sv', tag: 'TEMP_SV' },
  { field: 'pH_sv', tag: 'PH_SV' },
  { field: 'DO_sv', tag: 'DO_SV' },
];

const DEFAULT_TICK_MS = 200;
const DEFAULT_MAX_BUFFERED_AMOUNT = 1024 * 1024; // 1 MB

/**
 * 启动 broadcaster. 返 stop function (清 interval + cache.unsubscribe).
 * 重复调用 stop 安全 (第二次 no-op).
 */
export function startRealtimeBroadcaster(deps: BroadcasterDeps): () => void {
  const tickMs = deps.tickMs ?? readEnvInt('BROADCAST_TICK_MS', DEFAULT_TICK_MS);
  const maxBufferedAmount =
    deps.maxBufferedAmount ?? readEnvInt('WS_MAX_BUFFERED_AMOUNT', DEFAULT_MAX_BUFFERED_AMOUNT);

  // dirtyQueue: 收 cache 变化的脏标记, 真正 fan-out 在 tick 内做.
  // 仅 reactorId 维度足够 (tag 集合用于将来 partial payload, 当前实现下游全字段 read,
  // tag set 只用于判断"是否有变化").
  const dirtyQueue: Map<string, Set<string>> = new Map();

  const subId = deps.tagCache.subscribe({
    reactorId: '*',
    tags: '*',
    callback: (changes: CacheChange[]) => {
      for (const change of changes) {
        let tagSet = dirtyQueue.get(change.reactorId);
        if (!tagSet) {
          tagSet = new Set();
          dirtyQueue.set(change.reactorId, tagSet);
        }
        tagSet.add(change.tag);
      }
    },
  });

  const tick = (): void => {
    if (dirtyQueue.size === 0) return; // 静态期: 0 推送, 0 流量
    // 一次性快照本 tick 待 flush reactor, 防止 callback 在 broadcast 同步路径上再 push
    // 污染下次 tick (当前 ws.broadcast 同步, 但保守一些).
    const reactorsToFlush = Array.from(dirtyQueue.keys());
    dirtyQueue.clear();

    // SP-PLC-3 P3a.2: 仅在真有 fan-out 时计时 (空 tick 已早返,
    // 此处 reactorsToFlush.length >= 1). performance.now() 单位 ms, 转秒上报.
    const fanoutStart = performance.now();

    for (const reactorId of reactorsToFlush) {
      try {
        // back-pressure 检查: 任一 client bufferedAmount 超阈 → 整个 reactor skip
        let slowClientCount = 0;
        deps.wss.clients.forEach((client) => {
          if (client.bufferedAmount > maxBufferedAmount) slowClientCount++;
        });
        if (slowClientCount > 0) {
          console.warn(
            `[${new Date().toISOString()}] [WARN] [broadcaster] back-pressure skip reactor=${reactorId} slowClients=${slowClientCount} threshold=${maxBufferedAmount}`,
          );
          // SP-PLC-3 P2.5: 通知 cache-metrics 累计 skip 计数 (可选回调, 老 wiring 不传).
          // try/catch 隔离, callback 抛错不影响其它 reactor 本 tick.
          if (deps.onSkip) {
            try { deps.onSkip('back-pressure'); } catch (e) {
              console.error(`[${new Date().toISOString()}] [ERROR] [broadcaster] onSkip callback threw:`, (e as Error).message);
            }
          }
          continue;
        }

        const batchId = deps.getBatchId(reactorId);
        const entries = deps.tagCache.readAll(reactorId);

        // 拼 payload (含 quality), shape 与旧 reactor-wiring pvPayload 一致.
        const payload: Record<string, any> = {
          timestamp: new Date().toISOString(),
          batch_id: batchId,
          temp_mode: 2, // 冷却模式 (旧 reactor-wiring 硬编码常量, 保留)
        };
        const quality: Record<string, 'good' | 'bad' | 'uncertain'> = {};
        for (const { field, tag, transform } of PV_FIELDS) {
          const entry = entries[tag];
          const raw = entry ? entry.value : 0; // cache miss 落 0, 跟旧 readAll 兜底等价
          payload[field] = transform ? transform(raw) : raw;
          quality[tag] = entry ? entry.quality : 'bad';
        }
        payload.quality = quality;

        deps.broadcast('pv_realtime', payload, batchId, reactorId);
      } catch (err) {
        // 单 reactor 推送失败不影响其它 reactor 本 tick
        console.error(
          `[${new Date().toISOString()}] [ERROR] [broadcaster] reactor=${reactorId} tick failed:`,
          (err as Error).message,
        );
      }
    }

    // SP-PLC-3 P3a.2: 全 reactor fan-out 完成, observe 总耗时 (ms → s).
    // try/catch 隔离: callback 抛错不影响下次 tick.
    if (deps.onFanout) {
      const elapsedSeconds = (performance.now() - fanoutStart) / 1000;
      try { deps.onFanout(elapsedSeconds); } catch (e) {
        console.error(`[${new Date().toISOString()}] [ERROR] [broadcaster] onFanout callback threw:`, (e as Error).message);
      }
    }
  };

  const interval = setInterval(tick, tickMs);

  let stopped = false;
  return function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    deps.tagCache.unsubscribe(subId);
    dirtyQueue.clear();
  };
}

/** 读 env int, parse 失败 / 未设落 default. 不抛错. */
function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
