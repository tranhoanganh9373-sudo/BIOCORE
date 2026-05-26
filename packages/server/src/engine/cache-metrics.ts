// ============================================================
// cache-metrics — TagCache + broadcaster 监控指标 (SP-PLC-3 P2.5)
// SP-PLC-3 P3a.2 加 fanoutHistogram; P3b.2 加 plcWorkerState;
// P3c.5 加 redisConnected / redisPublishTotal / wsQueueSize / wsAckLatencySeconds.
// ============================================================
//
// 注册 4 个 Prometheus metrics (复用 SP-FX-28 MetricsRegistry):
//   - biocore_tagcache_size{reactor}                Gauge,   30s 周期采集
//   - biocore_tagcache_writes_total                 Counter, caller (snapshot
//       wiring) 显式 inc 一次表示一次 cache.write 调用 (含 deadband 抑制)
//   - biocore_tagcache_dirty_total{reactor}         Counter, 通过 TagCache
//       subscribe('*','*') 自动累计 dirty change 数 (deadband 抑制不增).
//   - biocore_broadcaster_skipped_total{reason}     Counter, caller 把
//       handle.skippedTotal 注入 broadcaster.onSkip / createWsServer.onSkip
//       (reason='back-pressure' | 'no-subscription'). cache-metrics 仅
//       注册指标, 不直接订阅 broadcaster — 解耦, 测试也更直白.
//   - biocore_broadcaster_fanout_seconds             Histogram (SP-PLC-3 P3a.2),
//       broadcaster tick 在真正 fan-out 整段 wrap performance.now() 后回调
//       (deps.onFanout) 显式 observe; 0 dirty 空 tick 不 observe. 无 label
//       (Phase 3a Q(iii) 决策, 避免 reactor 数量增长导致桶 cardinality 爆).
//
// 设计抉择 (writes_total 计数路径):
//   - 不动 P1 TagCache (未加 onWrite hook): 保 SP-PLC-3 Phase 1 模块表面
//     不变, 测试稳定.
//   - 改 caller 显式 inc: index.ts:3705 (真 PLC 路径) + reactor-wiring.ts:167
//     (mock 路径) 各加一行 `metrics.writesTotal.inc()`.
//   - dirty_total 走 subscribe callback: P1 TagCache subscribe 已在
//     write 内仅当 changes.length>0 (sameValue=false) 才触发, 语义天然=
//     "dirty change 数", 与 spec "deadband 抑制时不增" 一致.
//
// 注册风格 (与 index.ts:3118/3140 的 metricsRegistry.counter() 用法一致):
//   - 用 registry.counter(name, help) / .gauge(name, help) factory 拿同名
//     单例; 多次注册同名 metric 安全 (返同实例).
//   - registerCacheMetrics 返 stop 函数清 setInterval + unsubscribe, 不
//     清 metric 本身 (metric 是全局单例, 不需要也不应清).
// ============================================================

import type { Counter, Gauge, Histogram, MetricsRegistry } from '../services/metrics';
import type { TagCache } from './tag-cache';

/** 30 秒一次, 把 TagCache 当前 size 写入 Gauge. 不宜过频, size 是慢变量. */
const DEFAULT_SIZE_SAMPLE_MS = 30000;

/** broadcaster skip 的统计原因. 与 spec line 252 完全一致. */
export type BroadcasterSkipReason = 'back-pressure' | 'no-subscription';

/** registerCacheMetrics 依赖. 见模块头注释. */
export interface CacheMetricsDeps {
  /** 全局 MetricsRegistry 实例 (services/metrics 的 metricsRegistry singleton). */
  registry: MetricsRegistry;
  /** TagCache 实例, 用于 size() 周期采集 + subscribe('*','*') 收 dirty. */
  tagCache: TagCache;
  /** 每 tick 调一次, 用于按 reactor 维度采 size gauge. 内部异常被 try/catch. */
  reactorIds: () => string[];
  /** 仅测试用: 覆盖 size gauge 采样周期 (ms). 默认 30000. */
  sizeSampleMs?: number;
  /**
   * SP-PLC-3 P3c.5: 可选 Redis 连接状态采样函数. 注入时 30s 周期采集到
   * biocore_redis_connected Gauge (1=connected, 0=disconnected). 未注入
   * 则 Gauge 保持 0 (等价 "Redis 不可用 / 未启用").
   * 实参通常是 `() => isRedisConnected()` (lib/redis-client export).
   */
  isRedisConnected?: () => boolean;
  /**
   * SP-PLC-3 P3c.5: 可选 ws_message_queue 各状态行数采样函数. 注入时 30s
   * 周期采集到 biocore_ws_queue_size{status} Gauge. 未注入则 Gauge 留 0.
   * 实参通常是 `() => sqlite.countWsMessagesByStatus()` (data-service export).
   * 返回字典必须含全部状态 ('pending'/'dispatching'/'delivered'/'failed');
   * 缺失状态被 set(0) 不报错.
   */
  countWsMessagesByStatus?: () => Record<string, number>;
}

/** registerCacheMetrics 返回值, export 让 caller (index.ts 的 cache.write 处) 用. */
export interface CacheMetricsHandle {
  /** 单调累计的 TagCache.write 调用数 (caller 每次 write 后调 .inc()). */
  writesTotal: Counter;
  /** 周期采集的 reactor → tag 数量 gauge. 内部 setInterval 自动写, caller 无需操作. */
  sizeGauge: Gauge;
  /** 累计 fan-out dirty change 数. 内部 subscribe 自动累计, caller 无需操作. */
  dirtyTotal: Counter;
  /**
   * broadcaster / ws-server skip 计数 (reason='back-pressure' | 'no-subscription').
   * Caller 在 broadcaster.onSkip / createWsServer.onSkip 中调
   * `(reason) => handle.skippedTotal.inc({ reason })` 注入累计逻辑.
   */
  skippedTotal: Counter;
  /**
   * SP-PLC-3 P3a.2: broadcaster fan-out 延迟 Histogram (秒).
   * Caller 在 broadcaster.onFanout 中调
   * `(elapsedSeconds) => handle.fanoutHistogram.observe(elapsedSeconds)` 注入.
   * 无 label (避免 reactor 数量增长导致桶 cardinality 爆), 单一全局 Histogram.
   * Buckets 复用 services/metrics 固定 `[0.01, 0.05, 0.1, 0.5, 1, 5]` 秒.
   */
  fanoutHistogram: Histogram;
  /**
   * SP-PLC-3 P3b.2: per-reactor worker_threads PollingScheduler 状态 Gauge.
   * 1 = worker 'running', 0 = 'stopped' / 'failed' / 'connecting' / 降级 mock.
   * Caller (index.ts startup) 在 worker.on('state') 内调
   * `(state) => handle.plcWorkerState.set(state === 'running' ? 1 : 0, { reactor })`
   * 注入. PLC_WORKER_DISABLED=true (main thread 路径) 不写此 gauge,
   * 留 0 即等价 "无 worker 状态可报", 跟 worker spawn 失败语义一致.
   */
  plcWorkerState: Gauge;
  /**
   * SP-PLC-3 P3c.5: Redis 连接状态 Gauge. 1=connected, 0=disconnected/未启用.
   * 注入 deps.isRedisConnected 时由 30s tick 自动写; 未注入则保持 0.
   */
  redisConnected: Gauge;
  /**
   * SP-PLC-3 P3c.5: Redis publish 累计 Counter, label=channel.
   * Caller (index.ts startup) 在 startRedisCacheSync 调用前后把 publish
   * 钩子注入: deps.onPublish=(ch) => handle.redisPublishTotal.inc({channel: ch}).
   * 单实例模式 (publish=noop) 永不 inc, Counter 显示 channel=tagcache:write 0.
   */
  redisPublishTotal: Counter;
  /**
   * SP-PLC-3 P3c.5: ws_message_queue 各状态 row 数 Gauge, label=status
   * (pending/dispatching/delivered/failed). 30s tick 调
   * deps.countWsMessagesByStatus() 整批 set; 未注入则永远 0.
   */
  wsQueueSize: Gauge;
  /**
   * SP-PLC-3 P3c.5: client ack 延迟 Histogram (秒).
   * Caller (index.ts startWsMessageQueueDispatcher) 在 markAckReceived
   * 成功路径调 handle.wsAckLatencySeconds.observe((now - sentAt)/1000) 注入.
   * 无 label (与 fanoutHistogram 一致, 避免 cardinality 爆); buckets 复用
   * services/metrics 固定 `[0.01, 0.05, 0.1, 0.5, 1, 5]` 秒.
   */
  wsAckLatencySeconds: Histogram;
  /** 停止采样 / 解订阅. 重复调用安全. */
  stop: () => void;
}

/**
 * 注册 4 cache metrics 到给定 registry, 返 handle (含 writesTotal Counter
 * 供 caller 显式 inc) + stop 函数.
 *
 * 多次调用 (例如 hot-reload) 安全: registry.counter()/.gauge() 同名返同实例,
 * subscribe id 与 setInterval handle 各自闭包独立. 重复 register 不重复注册
 * metric (factory 幂等), 但会产生多个 subscribe 与 interval — caller 应自行
 * 在 reload 前调 handle.stop().
 */
export function registerCacheMetrics(deps: CacheMetricsDeps): CacheMetricsHandle {
  const sizeSampleMs = deps.sizeSampleMs ?? DEFAULT_SIZE_SAMPLE_MS;

  // 注册 4 metric (factory 幂等, 多次注册同名返同实例).
  const writesTotal = deps.registry.counter(
    'biocore_tagcache_writes_total',
    'Total TagCache.write calls (caller-incremented, includes deadband-suppressed writes)',
  );
  const sizeGauge = deps.registry.gauge(
    'biocore_tagcache_size',
    'Number of cached tags per reactor',
  );
  const dirtyTotal = deps.registry.counter(
    'biocore_tagcache_dirty_total',
    'Total cache changes that triggered fan-out (deadband-suppressed writes excluded)',
  );
  const skippedTotal = deps.registry.counter(
    'biocore_broadcaster_skipped_total',
    'Broadcaster fan-out skipped due to back-pressure or no-subscription',
  );
  // SP-PLC-3 P3a.2: 无 label Histogram, buckets 由 services/metrics 统一固定.
  const fanoutHistogram = deps.registry.histogram(
    'biocore_broadcaster_fanout_seconds',
    'Broadcaster tick fan-out latency in seconds (cache change → all client fan-out completed)',
  );
  // SP-PLC-3 P3b.2: worker PollingScheduler state gauge (per reactor).
  const plcWorkerState = deps.registry.gauge(
    'biocore_plc_worker_state',
    'PLC worker thread state per reactor (1=running, 0=stopped/failed/fallback)',
  );
  // SP-PLC-3 P3c.5: Redis + ws_message_queue 4 metric (factory 幂等, 同名返同实例).
  const redisConnected = deps.registry.gauge(
    'biocore_redis_connected',
    'Redis client connection state (1=connected, 0=disconnected or REDIS_URL empty)',
  );
  const redisPublishTotal = deps.registry.counter(
    'biocore_redis_publish_total',
    'Total Redis publish calls by channel (caller-incremented in redis-cache-sync)',
  );
  const wsQueueSize = deps.registry.gauge(
    'biocore_ws_queue_size',
    'Number of ws_message_queue rows per status (pending/dispatching/delivered/failed)',
  );
  const wsAckLatencySeconds = deps.registry.histogram(
    'biocore_ws_ack_latency_seconds',
    'Critical WS message ack latency in seconds (server send → client ack received)',
  );

  // 接 TagCache fan-out (callback 仅在 sameValue=false 时触发, 即 deadband 通过).
  const subId = deps.tagCache.subscribe({
    reactorId: '*',
    tags: '*',
    callback: (changes) => {
      for (const c of changes) {
        dirtyTotal.inc({ reactor: c.reactorId });
      }
    },
  });

  // size gauge 周期采集. 异常被 try/catch 包: 任一 reactor 异常不影响其它.
  // P3c.5: 同 tick 内一并采 redisConnected + wsQueueSize (复用 30s 周期, 不开新 timer).
  const sizeTick = setInterval(() => {
    let ids: string[];
    try {
      ids = deps.reactorIds();
    } catch (err) {
      console.error(
        `[${new Date().toISOString()}] [ERROR] [cache-metrics] reactorIds() threw:`,
        (err as Error).message,
      );
      return;
    }
    for (const reactorId of ids) {
      try {
        sizeGauge.set(deps.tagCache.size(reactorId), { reactor: reactorId });
      } catch (err) {
        console.error(
          `[${new Date().toISOString()}] [ERROR] [cache-metrics] size sample failed reactor=${reactorId}:`,
          (err as Error).message,
        );
      }
    }
    // P3c.5: Redis 连接状态采样 — 注入则读, 否则保持上次值 (启动时 Gauge 默认 0).
    if (deps.isRedisConnected) {
      try {
        redisConnected.set(deps.isRedisConnected() ? 1 : 0);
      } catch (err) {
        console.error(
          `[${new Date().toISOString()}] [ERROR] [cache-metrics] isRedisConnected() threw:`,
          (err as Error).message,
        );
      }
    }
    // P3c.5: ws_message_queue 各状态行数采样 — 注入则整批 set.
    if (deps.countWsMessagesByStatus) {
      try {
        const counts = deps.countWsMessagesByStatus();
        // 显式 set 4 个已知状态 (缺失 → 0), 防 "状态被清空但 Gauge 留旧值" 假象.
        const allStatuses = ['pending', 'dispatching', 'delivered', 'failed'] as const;
        for (const status of allStatuses) {
          wsQueueSize.set(counts[status] ?? 0, { status });
        }
      } catch (err) {
        console.error(
          `[${new Date().toISOString()}] [ERROR] [cache-metrics] countWsMessagesByStatus() threw:`,
          (err as Error).message,
        );
      }
    }
  }, sizeSampleMs);

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(sizeTick);
    deps.tagCache.unsubscribe(subId);
  };

  return {
    writesTotal,
    sizeGauge,
    dirtyTotal,
    skippedTotal,
    fanoutHistogram,
    plcWorkerState,
    redisConnected,
    redisPublishTotal,
    wsQueueSize,
    wsAckLatencySeconds,
    stop,
  };
}
