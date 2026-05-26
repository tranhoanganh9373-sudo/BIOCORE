// ============================================================
// SP-PLC-3 Phase 3c Commit 1 — redis-cache-sync 单元测试 (8 项)
// 计划: docs/plans/SP-PLC-3-tag-cache-phase3c-plan.md  §1 Commit 1 "测试"
// ============================================================
//
// 测试覆盖 (plan §1 Commit 1):
//   1. TagCache.write 触发 Redis publish (mock redis.publish spy)
//   2. Redis subscribe message 后本地 TagCache.write (mock emit 'message')
//   3. 自回环 skip (msg.source === my_server_id)
//   4. Redis 连不上 (deps.redis=null) → 降级 noop publish/stop
//   5. publish error → console.error 吞 (不抛)
//   6. env REDIS_URL 缺省 → initRedisClient 返 null
//   7. server_id 启动期生成 UUID (默认) + 自定义 serverId 选项
//   8. healthCheck 30s 周期 ping (vi.useFakeTimers)
//
// 注意: ioredis npm 包未 install (本机 pnpm 不可用, 仅 package.json 声明).
// 本测试用 vi.mock('ioredis') 注入 MockIORedis class, 避免触发 module-load
// fail. CI install 后此 vi.mock 仍生效 (vi.mock 优先级高于真实 module).
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { TagCache, type SnapshotInput } from '../tag-cache';
import {
  startRedisCacheSync,
  REDIS_CACHE_SYNC_CHANNEL,
} from '../redis-cache-sync';

// ────────────────────────────────────────────────────────────
// MockIORedis: 最小化模拟 ioredis 子集, 仅含本测试需要的方法.
// ────────────────────────────────────────────────────────────

class MockIORedis extends EventEmitter {
  public publish = vi.fn(async (_channel: string, _payload: string) => 1);
  public subscribe = vi.fn(async (_channel: string) => 1);
  public unsubscribe = vi.fn(async (_channel: string) => 1);
  public ping = vi.fn(async () => 'PONG');
  public quit = vi.fn(async () => 'OK');
  /** 测试触发收到 sub message. */
  public _emitMessage(channel: string, raw: string): void {
    this.emit('message', channel, raw);
  }
  public duplicate(): MockIORedis {
    // 默认 duplicate 返新独立 instance; 单测可在调 startRedisCacheSync 前
    // 覆盖此方法以共享 emitter 引用方便 emit subscribe message.
    return new MockIORedis();
  }
}

// vi.mock 模块 'ioredis' (CI install 后真实 ioredis 也会被这层 mock 屏蔽).
vi.mock('ioredis', () => {
  return { default: MockIORedis };
});

const TS = '2026-05-26T00:00:00.000Z';

function snap(values: Record<string, number>): SnapshotInput {
  const quality: Record<string, 'good' | 'bad' | 'uncertain'> = {};
  for (const k of Object.keys(values)) quality[k] = 'good';
  return { timestamp: TS, values, quality };
}

describe('SP-PLC-3 P3c.1: redis-cache-sync', () => {
  describe('test 1: TagCache.write 触发 Redis publish', () => {
    it('应通过 opts.onWrite 把 publish 钩子串到 mock redis.publish', async () => {
      // sub 用同一 emitter, publish 用主 client.
      const main = new MockIORedis();
      const sub = new MockIORedis();
      main.duplicate = () => sub;
      const cache = new TagCache();

      const handle = await startRedisCacheSync({
        redis: main as any,
        tagCache: cache,
        serverId: 'server-A',
      });
      expect(handle.serverId).toBe('server-A');
      expect(sub.subscribe).toHaveBeenCalledWith(REDIS_CACHE_SYNC_CHANNEL);

      // 模拟 caller: 注入 onWrite 闭包 → publish.
      cache.write('R1', snap({ T: 25 }), {
        onWrite: (r, s) => handle.publish(r, s),
      });

      // publish 是异步 (内部 .catch), 等下一 tick.
      await Promise.resolve();
      expect(main.publish).toHaveBeenCalledTimes(1);
      const [channel, payload] = main.publish.mock.calls[0];
      expect(channel).toBe(REDIS_CACHE_SYNC_CHANNEL);
      const parsed = JSON.parse(payload);
      expect(parsed.source).toBe('server-A');
      expect(parsed.reactorId).toBe('R1');
      expect(parsed.snap.values.T).toBe(25);

      await handle.stop();
    });
  });

  describe('test 2: Redis subscribe message 后本地 TagCache.write', () => {
    it('收到远端 msg → 本地 cache 出现该 reactor 的 entry', async () => {
      const main = new MockIORedis();
      const sub = new MockIORedis();
      main.duplicate = () => sub;
      const cache = new TagCache();

      const handle = await startRedisCacheSync({
        redis: main as any,
        tagCache: cache,
        serverId: 'server-B',
      });

      const remoteMsg = JSON.stringify({
        source: 'server-A',  // 远端
        reactorId: 'R2',
        snap: snap({ pH: 7.3 }),
      });
      sub._emitMessage(REDIS_CACHE_SYNC_CHANNEL, remoteMsg);

      // tagCache.write 同步 → 立即可读.
      const entry = cache.read('R2', 'pH');
      expect(entry).toBeDefined();
      expect(entry?.value).toBe(7.3);

      await handle.stop();
    });
  });

  describe('test 3: 自回环 skip', () => {
    it('msg.source === my_server_id → 不调本地 TagCache.write', async () => {
      const main = new MockIORedis();
      const sub = new MockIORedis();
      main.duplicate = () => sub;
      const cache = new TagCache();
      const writeSpy = vi.spyOn(cache, 'write');

      const handle = await startRedisCacheSync({
        redis: main as any,
        tagCache: cache,
        serverId: 'server-A',
      });

      const selfMsg = JSON.parse(JSON.stringify({
        source: 'server-A',  // 自己
        reactorId: 'R3',
        snap: snap({ DO: 5 }),
      }));
      sub._emitMessage(REDIS_CACHE_SYNC_CHANNEL, JSON.stringify(selfMsg));

      expect(writeSpy).not.toHaveBeenCalled();
      expect(cache.read('R3', 'DO')).toBeUndefined();

      await handle.stop();
    });
  });

  describe('test 4: deps.redis=null → 降级 noop', () => {
    it('publish/stop 不抛, serverId 仍生成', async () => {
      const cache = new TagCache();
      const handle = await startRedisCacheSync({
        redis: null,
        tagCache: cache,
      });
      // serverId 生成 (UUID v4).
      expect(typeof handle.serverId).toBe('string');
      expect(handle.serverId.length).toBeGreaterThan(0);
      // publish/stop noop, 不抛.
      expect(() => handle.publish('R4', snap({ X: 1 }))).not.toThrow();
      await expect(handle.stop()).resolves.toBeUndefined();
    });
  });

  describe('test 5: publish 失败 → console.error 吞', () => {
    it('mock publish reject → 不抛回 onWrite caller', async () => {
      const main = new MockIORedis();
      const sub = new MockIORedis();
      main.duplicate = () => sub;
      main.publish = vi.fn(async (_channel: string, _payload: string) => {
        throw new Error('boom');
      }) as any;
      const cache = new TagCache();
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const handle = await startRedisCacheSync({
        redis: main as any,
        tagCache: cache,
        serverId: 'server-A',
      });

      // 不抛.
      expect(() => {
        cache.write('R5', snap({ T: 10 }), {
          onWrite: (r, s) => handle.publish(r, s),
        });
      }).not.toThrow();

      // 等异步 .catch 回到 console.error.
      await new Promise(r => setImmediate(r));
      expect(errSpy).toHaveBeenCalled();
      const args = errSpy.mock.calls.find(c => String(c[0]).includes('[redis-cache-sync] publish'));
      expect(args).toBeDefined();

      errSpy.mockRestore();
      await handle.stop();
    });
  });

  describe('test 6: REDIS_URL 缺省 → initRedisClient 返 null', () => {
    it('process.env.REDIS_URL 未设, initRedisClient 返 null + 单实例 log', async () => {
      // 必须在 import 后再设, 用 vi.resetModules 确保 module-scope state 干净.
      const origUrl = process.env.REDIS_URL;
      delete process.env.REDIS_URL;
      vi.resetModules();
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const mod = await import('../../lib/redis-client.js');
      mod.__resetRedisClientForTests();
      const c = await mod.initRedisClient();
      expect(c).toBeNull();
      const matched = logSpy.mock.calls.find(call =>
        String(call[0]).includes('[redis-client] REDIS_URL 未设'),
      );
      expect(matched).toBeDefined();

      logSpy.mockRestore();
      if (origUrl !== undefined) process.env.REDIS_URL = origUrl;
    });
  });

  describe('test 7: serverId 默认 UUID + 自定义', () => {
    it('未传 serverId → UUID v4 格式; 传 serverId → 原样返', async () => {
      const cache = new TagCache();
      const handleA = await startRedisCacheSync({ redis: null, tagCache: cache });
      // UUID v4 正则 (loose): 8-4-4-4-12 hex.
      expect(handleA.serverId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

      const handleB = await startRedisCacheSync({
        redis: null,
        tagCache: cache,
        serverId: 'custom-server-id-123',
      });
      expect(handleB.serverId).toBe('custom-server-id-123');

      await handleA.stop();
      await handleB.stop();
    });
  });

  describe('test 8: healthCheck 周期 ping', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('REDIS_URL 设 + interval 触发 → client.ping 被调', async () => {
      const origUrl = process.env.REDIS_URL;
      process.env.REDIS_URL = 'redis://test-host:6379';
      vi.resetModules();

      const mod = await import('../../lib/redis-client.js');
      mod.__resetRedisClientForTests();
      const client = await mod.initRedisClient({ healthCheckMs: 1000 });
      expect(client).not.toBeNull();
      // mock IORedis.ping spy.
      const pingSpy = (client as any).ping as ReturnType<typeof vi.fn>;
      const baseline = pingSpy.mock.calls.length;

      vi.advanceTimersByTime(1000);
      // ping 是异步 (Promise), 等 microtask flush.
      await vi.runOnlyPendingTimersAsync().catch(() => {});

      expect(pingSpy.mock.calls.length).toBeGreaterThan(baseline);

      mod.__resetRedisClientForTests();
      if (origUrl !== undefined) process.env.REDIS_URL = origUrl;
      else delete process.env.REDIS_URL;
    });
  });
});
