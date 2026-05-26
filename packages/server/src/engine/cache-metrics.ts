// ============================================================
// cache-metrics — TagCache + broadcaster 监控指标 (SP-PLC-3 P2.5)
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

import type { Counter, Gauge, MetricsRegistry } from '../services/metrics';
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
  }, sizeSampleMs);

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(sizeTick);
    deps.tagCache.unsubscribe(subId);
  };

  return { writesTotal, sizeGauge, dirtyTotal, skippedTotal, stop };
}
