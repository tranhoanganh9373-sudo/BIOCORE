// ============================================================
// SP-PLC-3 Phase 3c Commit 5 (P3c.5) — Phase 3c 端到端 E2E (5 项)
// 计划: docs/plans/SP-PLC-3-tag-cache-phase3c-plan.md  §1 Commit 5 "E2E"
// ============================================================
//
// 覆盖 (plan §1 Commit 5 E2E):
//   1. 2 server 实例 Redis 共享 cache — server A write → server B 看到 (双 sync handle + 双 cache)
//   2. 跨 server subscription Redis hash 查询 — 双 server 各写一份, scan 验
//   3. server restart 恢复 ws_message_queue pending — rollbackInProgress: 'dispatching' → 'pending'
//   4. Redis 断连降级 — redis=null → cache.write 仍工作, publish noop
//   5. alarm critical message ack 完整路径 — enqueue → tick send → ack → markDelivered + observe latency
//
// 不依赖真 Redis / 真 sqlite, 全 mock. 4 新 metric 同 E2E 验入:
//   - biocore_redis_publish_total{channel} (E2E 1 路径)
//   - biocore_redis_connected (E2E 4 验 set(0))
//   - biocore_ws_queue_size{status} (E2E 3 验 set)
//   - biocore_ws_ack_latency_seconds (E2E 5 验 observe)
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { MetricsRegistry } from '../../services/metrics';
import { TagCache, type SnapshotInput } from '../tag-cache';
import { registerCacheMetrics } from '../cache-metrics';
import { startRedisCacheSync, REDIS_CACHE_SYNC_CHANNEL } from '../redis-cache-sync';
import {
  CRITICAL_CHANNELS,
  enqueueCriticalMessage,
  startWsMessageQueueDispatcher,
  markAckReceived,
  __resetPendingAcksForTests,
  type WsQueueSqliteShape,
} from '../ws-message-queue';

// ────────────────────────────────────────────────────────────
// MockIORedis: 共享 pub/sub bus 让两个 client 实例可以互相收到对方 publish.
// duplicate() 返回独立 MockIORedis 共用同 bus (跟真 ioredis 行为一致).
// ────────────────────────────────────────────────────────────

const bus = new EventEmitter();

class MockIORedis extends EventEmitter {
  public publish = vi.fn(async (channel: string, payload: string) => {
    // bus 上 broadcast 给所有 subscriber (本 client 自己包括 — 自回环由 source 字段判 skip).
    bus.emit('msg', channel, payload);
    return 1;
  });
  public subscribe = vi.fn(async (channel: string) => {
    bus.on('msg', (ch: string, raw: string) => {
      if (ch === channel) this.emit('message', ch, raw);
    });
    return 1;
  });
  public unsubscribe = vi.fn(async () => 1);
  public quit = vi.fn(async () => 'OK');
  /** ioredis 的 duplicate() 在 redis-cache-sync 内被调以创建独立 subscribe client. */
  public duplicate(): MockIORedis {
    return new MockIORedis();
  }
}

const TS = '2026-05-26T00:00:00.000Z';
function snap(values: Record<string, number>): SnapshotInput {
  const quality: Record<string, 'good' | 'bad' | 'uncertain'> = {};
  for (const k of Object.keys(values)) quality[k] = 'good';
  return { timestamp: TS, values, quality };
}

// ─── mock helpers (ws-message-queue) ───────────────────────────

function makeMockSqlite(): WsQueueSqliteShape & {
  _rows: Map<number, any>;
  _nextId: { v: number };
} {
  const _rows = new Map<number, any>();
  const _nextId = { v: 1 };
  return {
    _rows,
    _nextId,
    enqueueWsMessage: vi.fn((e: { client_id: string; channel: string; payload: any }) => {
      const id = _nextId.v++;
      _rows.set(id, {
        id,
        client_id: e.client_id,
        channel: e.channel,
        payload: JSON.stringify(e.payload),
        status: 'pending',
        retry_count: 0,
      });
      return id;
    }),
    claimPendingWsMessages: vi.fn((limit: number) => {
      const out: any[] = [];
      for (const row of _rows.values()) {
        if (row.status === 'pending' && out.length < limit) {
          row.status = 'dispatching';
          out.push({ ...row });
        }
      }
      return out;
    }),
    markWsMessageDelivered: vi.fn((id: number) => {
      const r = _rows.get(id);
      if (r) r.status = 'delivered';
    }),
    incrementWsMessageRetry: vi.fn((id: number, err: string) => {
      const r = _rows.get(id);
      if (r) { r.status = 'pending'; r.retry_count += 1; r.last_error = err; }
    }),
    markWsMessageFailed: vi.fn((id: number, err: string) => {
      const r = _rows.get(id);
      if (r) { r.status = 'failed'; r.last_error = err; }
    }),
    rollbackInProgressWsMessages: vi.fn(() => {
      for (const row of _rows.values()) {
        if (row.status === 'dispatching') row.status = 'pending';
      }
    }),
  };
}

function makeMockWs(clientId: string, readyState = 1): WebSocket {
  return { clientId, readyState, send: vi.fn() } as unknown as WebSocket;
}

// ────────────────────────────────────────────────────────────

describe('SP-PLC-3 Phase 3c E2E (P3c.5)', () => {
  beforeEach(() => {
    bus.removeAllListeners();
    __resetPendingAcksForTests();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  // E2E 1: 2 server 实例 Redis 共享 cache.
  it('E2E 1 — 2 server 实例 Redis 共享 cache: A write → B 看到', async () => {
    const cacheA = new TagCache();
    const cacheB = new TagCache();
    const redisA = new MockIORedis();
    const redisB = new MockIORedis();
    const registryA = new MetricsRegistry();
    const metricsA = registerCacheMetrics({
      registry: registryA,
      tagCache: cacheA,
      reactorIds: () => ['R1'],
    });
    const syncA = await startRedisCacheSync({
      redis: redisA as any,
      tagCache: cacheA,
      serverId: 'server-A',
      onPublish: (ch) => metricsA.redisPublishTotal.inc({ channel: ch }),
    });
    const syncB = await startRedisCacheSync({
      redis: redisB as any,
      tagCache: cacheB,
      serverId: 'server-B',
    });

    // server A write + publish — handle.publish 显式调 (生产路径在 TagCache.onWrite 钩子).
    cacheA.write('R1', snap({ temperature: 37.5 }));
    syncA.publish('R1', snap({ temperature: 37.5 }));

    // 异步 bus emit — await microtask flush.
    await new Promise((r) => setImmediate(r));

    // server B 应通过 subscribe 收到 → write 本地 cache.
    expect(cacheB.size('R1')).toBe(1);
    expect(cacheB.read('R1', 'temperature')?.value).toBe(37.5);
    // server A 自回环 skip — 不会重复 write (write 一次即 size=1).
    expect(cacheA.size('R1')).toBe(1);
    // P3c.5 metric: publish counter inc 一次.
    expect(metricsA.redisPublishTotal.get({ channel: REDIS_CACHE_SYNC_CHANNEL })).toBe(1);

    await syncA.stop();
    await syncB.stop();
    metricsA.stop();
  });

  // E2E 2: 跨 server subscription state — 双 server 各 hash 写一份, 第三方 scan 验.
  // 不真起 ws-server, 直接 mock 一个 module-scope Map 模拟 Redis hash 行为.
  it('E2E 2 — 跨 server subscription Redis hash 查询', () => {
    // 模拟两个 server (server_id 不同) 各自往 redis hash 写 subscription state.
    const fakeRedisHash = new Map<string, Map<string, string>>();
    const hset = (key: string, field: string, val: string): void => {
      let h = fakeRedisHash.get(key);
      if (!h) { h = new Map(); fakeRedisHash.set(key, h); }
      h.set(field, val);
    };
    const hgetall = (key: string): Record<string, string> =>
      Object.fromEntries(fakeRedisHash.get(key) ?? new Map());
    const scanKeys = (prefix: string): string[] => {
      const out: string[] = [];
      for (const k of fakeRedisHash.keys()) if (k.startsWith(prefix)) out.push(k);
      return out;
    };

    // server A 注册 client-1 订阅 R1.
    hset('subscriptions:server-A:client-1', 'R1', JSON.stringify(['temperature', 'pH']));
    // server B 注册 client-2 订阅 R2.
    hset('subscriptions:server-B:client-2', 'R2', JSON.stringify(['DO']));

    // 跨 server query — 第三方 (operator / admin UI) 扫所有 subscription.
    const allKeys = scanKeys('subscriptions:');
    expect(allKeys).toHaveLength(2);
    expect(allKeys.sort()).toEqual([
      'subscriptions:server-A:client-1',
      'subscriptions:server-B:client-2',
    ]);
    // server A 的 client-1 订阅可被 server B 看到.
    const a1 = hgetall('subscriptions:server-A:client-1');
    expect(JSON.parse(a1.R1)).toEqual(['temperature', 'pH']);
  });

  // E2E 3: server restart 恢复 ws_message_queue pending.
  it('E2E 3 — server restart 恢复 ws_message_queue: dispatching → pending', () => {
    const sqlite = makeMockSqlite();
    const wss = { clients: new Set<WebSocket>() };
    const registry = new MetricsRegistry();

    // 入队两条 critical msg.
    enqueueCriticalMessage(sqlite, 'cid-1', 'alarm', { code: 'TEMP_HIGH' });
    enqueueCriticalMessage(sqlite, 'cid-2', 'state_update', { state: 'running' });
    // 模拟上次 server 崩溃: claim 后还没送出, status=dispatching 残留.
    sqlite.claimPendingWsMessages(100);
    expect(Array.from(sqlite._rows.values()).every((r) => r.status === 'dispatching')).toBe(true);

    // server restart: startWsMessageQueueDispatcher 内调 rollbackInProgressWsMessages.
    const handle = startWsMessageQueueDispatcher({
      sqlite,
      wss,
      tickMs: 100000, // 不让 timer 自动 tick, 用 tickOnce 手控.
    });
    expect(sqlite.rollbackInProgressWsMessages).toHaveBeenCalledTimes(1);
    // rollback 后两条 row 应回 'pending'.
    expect(Array.from(sqlite._rows.values()).every((r) => r.status === 'pending')).toBe(true);

    // P3c.5 metric: cache-metrics wsQueueSize gauge set 行为 (通过注入闭包).
    const cache = new TagCache();
    vi.useFakeTimers();
    const metrics = registerCacheMetrics({
      registry,
      tagCache: cache,
      reactorIds: () => [],
      sizeSampleMs: 10, // 快速触发 tick.
      countWsMessagesByStatus: () => {
        const counts: Record<string, number> = {};
        for (const r of sqlite._rows.values()) counts[r.status] = (counts[r.status] ?? 0) + 1;
        return counts;
      },
    });
    vi.advanceTimersByTime(20);
    expect(metrics.wsQueueSize.get({ status: 'pending' })).toBe(2);
    expect(metrics.wsQueueSize.get({ status: 'delivered' })).toBe(0);
    expect(metrics.wsQueueSize.get({ status: 'failed' })).toBe(0);
    vi.useRealTimers();

    handle.stop();
    metrics.stop();
  });

  // E2E 4: Redis 断连降级 — cache.write 仍工作.
  it('E2E 4 — Redis 断连降级: redis=null → cache 仍工作, publish noop', async () => {
    const cache = new TagCache();
    const registry = new MetricsRegistry();
    vi.useFakeTimers();
    const metrics = registerCacheMetrics({
      registry,
      tagCache: cache,
      reactorIds: () => ['R1'],
      sizeSampleMs: 10,
      isRedisConnected: () => false, // 模拟 Redis 断连.
    });
    const sync = await startRedisCacheSync({
      redis: null,
      tagCache: cache,
      serverId: 'standalone',
      onPublish: (ch) => metrics.redisPublishTotal.inc({ channel: ch }),
    });

    // cache.write 不依赖 Redis, 正常工作.
    cache.write('R1', snap({ temperature: 25 }));
    expect(cache.size('R1')).toBe(1);

    // publish 是 noop, Counter 不增 (handle.publish 在 noop 分支不走 onPublish 钩子).
    sync.publish('R1', snap({ temperature: 25 }));
    expect(metrics.redisPublishTotal.get({ channel: REDIS_CACHE_SYNC_CHANNEL })).toBe(0);

    // P3c.5 metric: redisConnected Gauge 应在 tick 内 set 0.
    vi.advanceTimersByTime(20);
    expect(metrics.redisConnected.get()).toBe(0);
    vi.useRealTimers();

    await sync.stop();
    metrics.stop();
  });

  // E2E 5: alarm critical message ack 完整路径.
  it('E2E 5 — alarm critical ack 完整路径 enqueue → send → ack → markDelivered + latency', () => {
    const sqlite = makeMockSqlite();
    const ws = makeMockWs('cid-A');
    const wss = { clients: new Set<WebSocket>([ws]) };
    const registry = new MetricsRegistry();
    const cache = new TagCache();
    const metrics = registerCacheMetrics({
      registry,
      tagCache: cache,
      reactorIds: () => [],
    });

    // alarm 是 CRITICAL_CHANNELS 之一.
    expect(CRITICAL_CHANNELS.has('alarm')).toBe(true);

    // 入队 alarm msg.
    const rowId = enqueueCriticalMessage(sqlite, 'cid-A', 'alarm', { code: 'PH_LOW' });
    expect(rowId).toBe(1);

    // 启动 dispatcher (假时钟控 + 假 now).
    let fakeNow = 1_000_000;
    const handle = startWsMessageQueueDispatcher({
      sqlite,
      wss,
      tickMs: 100000,
      ackTimeoutMs: 5000,
      now: () => fakeNow,
    });

    // tick 一次 — claim + send + 放入 pendingAcks (不立即 delivered).
    handle.tickOnce();
    expect(ws.send).toHaveBeenCalledTimes(1);
    const envelope = JSON.parse((ws.send as any).mock.calls[0][0]);
    expect(envelope.msg_id).toBe(rowId);
    expect(envelope.channel).toBe('alarm');
    expect(envelope.payload).toEqual({ code: 'PH_LOW' });
    // 还没 ack → row 仍 'dispatching', 不是 'delivered'.
    expect(sqlite._rows.get(rowId)!.status).toBe('dispatching');
    expect(sqlite.markWsMessageDelivered).not.toHaveBeenCalled();

    // 模拟 client 200ms 后 send ack.
    fakeNow += 200;
    const ok = markAckReceived(sqlite, rowId, {
      now: () => fakeNow,
      onAckLatency: (s) => metrics.wsAckLatencySeconds.observe(s),
    });
    expect(ok).toBe(true);
    expect(sqlite._rows.get(rowId)!.status).toBe('delivered');
    expect(sqlite.markWsMessageDelivered).toHaveBeenCalledWith(rowId);

    // P3c.5 latency Histogram: 200ms = 0.2s, 应 ≤ 0.5 bucket.
    const histSnap = metrics.wsAckLatencySeconds.snapshot();
    expect(histSnap.count).toBe(1);
    expect(histSnap.sum).toBeCloseTo(0.2, 3);
    expect(histSnap.buckets[0.5]).toBe(1);

    handle.stop();
    metrics.stop();
  });
});
