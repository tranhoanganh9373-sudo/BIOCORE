// ============================================================
// redis-client — ioredis 单例 + 健康检查 (SP-PLC-3 Phase 3c, Commit 1)
// ============================================================
//
// 计划: docs/plans/SP-PLC-3-tag-cache-phase3c-plan.md  §1 Commit 1
//
// 职责:
//   - REDIS_URL 空 → 返 null (单实例模式, Phase 2 行为).
//   - REDIS_URL 设 → 启动 ioredis client + 周期性 ping 健康检查.
//   - 连接失败 / 抛错 → console.error 报警, 不阻塞 server 启动 (降级单实例).
//
// 不在 Phase 3c.1 范围:
//   - cluster / sentinel 自动 failover 配置 (ioredis 内置, ops 配置)
//   - /metrics 暴露 biocore_redis_connected Gauge (P3c.5)
//   - SET NX server_id 冲突检测 (P3c.2 集成时再加)
//
// 实现约束:
//   - 同进程仅一个 client 实例; 复用通过 getRedisClient().
//   - retryStrategy 限制 max delay 3s, 避免无限指数退避.
//   - lazyConnect=false: 立即建立 TCP, 让早期错误尽快暴露.
// ============================================================

import IORedis from 'ioredis';

let _client: IORedis | null = null;
let _connected = false;
let _healthTimer: ReturnType<typeof setInterval> | null = null;

export interface InitRedisOptions {
  /** 健康检查 ping 周期 (ms). 默认 30000 (30s). */
  healthCheckMs?: number;
}

/**
 * SP-PLC-3 P3c.1: 初始化 Redis client 单例.
 *
 * 行为:
 *   - REDIS_URL 未设 → 返 null, 跳过 Redis 初始化 (单实例兼容).
 *   - REDIS_URL 设 → 异步 connect; 失败不抛, console.error + 返 null.
 *   - 已初始化 (_client !== null) → 直接返已有 client (幂等).
 *
 * @returns IORedis 实例, 或 null (未配置 / 初始化失败).
 */
export async function initRedisClient(opts?: InitRedisOptions): Promise<IORedis | null> {
  if (_client !== null) return _client;

  const url = process.env.REDIS_URL;
  if (!url) {
    console.log('[redis-client] REDIS_URL 未设, 跳过 Redis 初始化 (单实例模式)');
    return null;
  }

  try {
    const client = new IORedis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 100, 3000),
    });
    client.on('connect', () => {
      _connected = true;
      console.log('[redis-client] connected');
    });
    client.on('error', (err: Error) => {
      console.error('[redis-client] error:', err.message);
    });
    client.on('close', () => {
      _connected = false;
    });

    _client = client;

    // 周期性 ping 健康检查 (失败被 client 'error' 事件处理, 此处吞).
    const healthMs = opts?.healthCheckMs ?? 30000;
    _healthTimer = setInterval(() => {
      _client?.ping().catch(() => {
        /* error 事件已处理, 此处不需重复 log. */
      });
    }, healthMs);
    // 健康检查 timer 不应阻塞 process exit.
    if (_healthTimer && typeof _healthTimer.unref === 'function') {
      _healthTimer.unref();
    }

    return client;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[redis-client] init 失败, 降级单实例:', msg);
    return null;
  }
}

/** 取已初始化的 client. 未初始化 / 初始化失败返 null. */
export function getRedisClient(): IORedis | null {
  return _client;
}

/** 'connect' 事件触发后 true, 'close' 后 false. */
export function isRedisConnected(): boolean {
  return _connected;
}

/**
 * 仅供测试: 重置 module-scope 状态, 释放 health timer.
 * 生产代码不应调用 (SIGTERM 通过 RedisCacheSyncHandle.stop + client.quit 关闭).
 */
export function __resetRedisClientForTests(): void {
  if (_healthTimer) {
    clearInterval(_healthTimer);
    _healthTimer = null;
  }
  _client = null;
  _connected = false;
}
