// ============================================================
// redis-cache-sync — TagCache 跨实例 pub/sub 桥接 (SP-PLC-3 Phase 3c, Commit 1)
// ============================================================
//
// 计划: docs/plans/SP-PLC-3-tag-cache-phase3c-plan.md  §1 Commit 1
//
// 职责:
//   - server A 写 cache → publish {source: server_id, reactorId, snap}
//     到 Redis channel 'tagcache:write'.
//   - server B subscribe 同 channel → 收到 msg → 若 source !== my_id
//     则在本地 TagCache.write (不再 publish, 避免环路).
//
// 协议:
//   channel: 'tagcache:write'
//   payload (JSON): { source: string; reactorId: string; snap: SnapshotInput }
//
// 自回环检测:
//   每实例启动期生成 serverId (或调用方注入). publish 时 source=serverId,
//   subscribe handler 比对 msg.source === serverId → skip.
//
// 降级:
//   deps.redis === null → 返 noop handle (publish/stop 都不做事).
//   单实例部署 / REDIS_URL 未设 = 此分支.
//
// ioredis 限制:
//   一个 client 进入 subscribe 模式后不能执行普通命令 (publish/get/set).
//   故 subscribe 用 deps.redis.duplicate() 独立 client, publish 用主 client.
//
// 不在 Phase 3c.1 范围:
//   - msgpack payload (P3c.5 评估)
//   - pipeline 批量 publish (P3c.5 性能调优)
//   - /metrics 暴露 publish/recv 计数 (P3c.5)
// ============================================================

import type IORedis from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { TagCache, SnapshotInput } from './tag-cache';

/** Redis channel 名 (生产+测试共享, 避免拼写漂移). */
export const REDIS_CACHE_SYNC_CHANNEL = 'tagcache:write';

export interface RedisCacheSyncDeps {
  /** null 表示不启动 sync (单实例模式 / Redis 不可用). */
  redis: IORedis | null;
  /** 本地 TagCache 实例, 远端 msg 落地点. */
  tagCache: TagCache;
  /** 可选注入 server_id (默认启动期生成 UUID). 用于自回环检测. */
  serverId?: string;
  /**
   * SP-PLC-3 P3c.5: 可选 publish 钩子. 每次本实例真发 publish 命令时调一次
   * (无论 publish 是否成功). 给 cache-metrics 累计 biocore_redis_publish_total{channel}
   * 用. noop handle (redis=null) 永远不调.
   */
  onPublish?: (channel: string) => void;
}

export interface RedisCacheSyncHandle {
  /** 本实例的 server_id (生成或注入). 给 publish payload + 自回环判断用. */
  serverId: string;
  /**
   * 把一次本地 TagCache.write 的 (reactorId, snapshot) publish 到 channel.
   * 异步; publish 失败被 console.error 吞, 不抛回 TagCache.write.
   * redis===null 时是 noop.
   */
  publish: (reactorId: string, snap: SnapshotInput) => void;
  /** SIGTERM 时调用: unsubscribe + 关闭 sub client. 主 client 由 caller 关. */
  stop: () => Promise<void>;
}

/**
 * SP-PLC-3 P3c.1: 启动跨实例同步桥.
 *
 * @returns RedisCacheSyncHandle (noop handle 若 redis===null).
 */
export async function startRedisCacheSync(
  deps: RedisCacheSyncDeps,
): Promise<RedisCacheSyncHandle> {
  const serverId = deps.serverId ?? randomUUID();

  // 降级: Redis 不可用 → noop handle.
  if (!deps.redis) {
    return {
      serverId,
      publish: () => {
        /* noop (单实例模式) */
      },
      stop: async () => {
        /* noop */
      },
    };
  }

  const mainClient = deps.redis;
  // ioredis 要求 subscribe 用独立 client (subscribe 模式锁住命令通道).
  const subClient = mainClient.duplicate();

  await subClient.subscribe(REDIS_CACHE_SYNC_CHANNEL);

  subClient.on('message', (channel: string, raw: string) => {
    if (channel !== REDIS_CACHE_SYNC_CHANNEL) return;
    try {
      const msg = JSON.parse(raw) as {
        source?: string;
        reactorId?: string;
        snap?: SnapshotInput;
      };
      // 自回环: 本实例 publish 出去的消息 Redis 会回推, skip.
      if (msg.source === serverId) return;
      // 字段校验: 缺字段直接吞 (远端 bug 不应让本实例 crash).
      if (typeof msg.reactorId !== 'string' || !msg.snap) return;
      // 本地写, **不带 onWrite** → 不会再 publish (避免环路).
      deps.tagCache.write(msg.reactorId, msg.snap);
    } catch (err) {
      console.error('[redis-cache-sync] subscribe handler error:', err);
    }
  });

  return {
    serverId,
    publish: (reactorId, snap) => {
      // 异步 publish; 失败吞错 (TagCache.write 已 onWrite 内 try/catch,
      // 此处 catch 是双保险 + 区分日志来源).
      // P3c.5: onPublish 钩子在发出 publish 命令时同步调一次 (无论 promise
      // 成功还是失败 — Counter 表 "尝试 publish 次数"); 钩子异常被吞防 caller crash.
      const payload = JSON.stringify({ source: serverId, reactorId, snap });
      if (deps.onPublish) {
        try {
          deps.onPublish(REDIS_CACHE_SYNC_CHANNEL);
        } catch (err) {
          console.error('[redis-cache-sync] onPublish hook threw:', (err as Error).message);
        }
      }
      mainClient.publish(REDIS_CACHE_SYNC_CHANNEL, payload).catch((err: Error) => {
        console.error('[redis-cache-sync] publish error:', err.message);
      });
    },
    stop: async () => {
      try {
        await subClient.unsubscribe(REDIS_CACHE_SYNC_CHANNEL);
      } catch {
        /* ignore */
      }
      try {
        await subClient.quit();
      } catch {
        /* ignore */
      }
    },
  };
}
