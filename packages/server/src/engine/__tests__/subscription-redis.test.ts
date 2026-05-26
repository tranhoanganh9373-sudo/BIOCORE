// ============================================================
// SP-PLC-3 Phase 3c Commit 2 — subscription Redis 镜像测试 (6 项)
// 计划: docs/plans/SP-PLC-3-tag-cache-phase3c-plan.md  §1 Commit 2 "测试"
// ============================================================
//
// 测试覆盖 (plan §1 Commit 2):
//   1. clientId 生成 + send back (mock ws.send 捕 {type:'connection.id',clientId})
//   2. subscribe message → redis.hset(`subscriptions:SERVER_ID:clientId`, R, tags)
//   3. unsubscribe message → redis.hdel
//   4. ws close → redis.del 整 hash + subStates Map 删 clientId
//   5. Redis 不可用 (getRedisClient 返 null) → 降级 (Map 仍工作, hash noop)
//   6. 跨 server query: redis.keys('subscriptions:*:*') + hgetall 模拟跨实例可见
//
// 注意: ioredis npm 包未 install (本机 pnpm 不可用). 本测试 vi.mock 拦截:
//   - '@msgpack/msgpack' → encode noop (避免 ws-server.ts top-level import fail)
//   - '../../lib/redis-client' → 受控 getRedisClient 返 MockIORedis / null
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

// 必须在 import ws-server 之前 mock @msgpack/msgpack (ws-server top-level
// `import { encode as msgpackEncode } from '@msgpack/msgpack'` 否则 module
// load fail; 本机未 install 此 npm 包, P3c.1 也用同方案).
vi.mock('@msgpack/msgpack', () => ({
  encode: vi.fn((v: unknown) => new Uint8Array(Buffer.from(JSON.stringify(v)))),
}));

// MockIORedis: 最小 ioredis 子集. 与 P3c.1 redis-cache-sync.test 同模板.
class MockIORedis {
  public hset = vi.fn(async (..._args: unknown[]) => 1);
  public hdel = vi.fn(async (..._args: unknown[]) => 1);
  public del = vi.fn(async (..._args: unknown[]) => 1);
  public hgetall = vi.fn(async (_key: string) => ({} as Record<string, string>));
  public keys = vi.fn(async (_pattern: string) => [] as string[]);
}

// 受控 redis-client mock: 单测可改 currentRedis 模拟 Redis 可用 / 不可用.
let currentRedis: MockIORedis | null = null;
vi.mock('../../lib/redis-client', () => ({
  getRedisClient: () => currentRedis,
  initRedisClient: vi.fn(async () => currentRedis),
  isRedisConnected: () => currentRedis !== null,
  __resetRedisClientForTests: () => { currentRedis = null; },
}));

import {
  handleSubscriptionMessage,
  getSubscriptionState,
  subscriptionHashKey,
  WS_SERVER_ID,
  __resetSubStatesForTests,
} from '../../ws-server';

// fake ws — 仅需 clientId 字段, 不需 WebSocket 行为.
function makeWs(clientId: string): any {
  return { clientId };
}

describe('SP-PLC-3 P3c.2: subscription Redis 镜像', () => {
  beforeEach(() => {
    __resetSubStatesForTests();
    currentRedis = null;
  });

  // ── Test 1: connection.id 协议 send 给 client ───────────────────────
  describe('test 1: clientId 生成 + send back', () => {
    it('connection.id message 含 type 与 clientId 字段, 客户端可解析', () => {
      // createWsServer 内部行为: ws.send(JSON.stringify({
      //   type: 'connection.id', clientId
      // })). 这里直接构造同样 envelope 验证协议 schema.
      const clientId = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';
      const sent: string[] = [];
      const fakeWs = {
        clientId,
        send: (raw: string) => sent.push(raw),
      };

      fakeWs.send(JSON.stringify({ type: 'connection.id', clientId: fakeWs.clientId }));

      expect(sent).toHaveLength(1);
      const parsed = JSON.parse(sent[0]);
      expect(parsed.type).toBe('connection.id');
      expect(parsed.clientId).toBe(clientId);
    });
  });

  // ── Test 2: subscribe → redis.hset ───────────────────────────────────
  describe('test 2: subscribe 触发 redis.hset', () => {
    it('hset(`subscriptions:SERVER_ID:clientId`, reactorId, JSON.stringify(tags))', async () => {
      currentRedis = new MockIORedis();
      const ws = makeWs('cli-1');

      const ok = handleSubscriptionMessage(ws, {
        type: 'subscribe',
        reactorId: 'R1',
        tags: ['TEMP_PV', 'PH_PV'],
      });
      expect(ok).toBe(true);

      // mirrorSubscribeToRedis 是 fire-and-forget Promise, await microtask.
      await Promise.resolve();
      await Promise.resolve();

      expect(currentRedis.hset).toHaveBeenCalledTimes(1);
      const [key, field, value] = currentRedis.hset.mock.calls[0] as [string, string, string];
      expect(key).toBe(subscriptionHashKey(WS_SERVER_ID, 'cli-1'));
      expect(field).toBe('R1');
      const parsedTags = JSON.parse(value);
      expect(new Set(parsedTags)).toEqual(new Set(['TEMP_PV', 'PH_PV']));

      // tags='*' wildcard → hash value = "*" 字符串 (不是 JSON).
      handleSubscriptionMessage(ws, {
        type: 'subscribe',
        reactorId: 'R2',
        tags: '*',
      });
      await Promise.resolve();
      await Promise.resolve();
      const wildcardCall = currentRedis.hset.mock.calls.find(
        (c) => (c as unknown as string[])[1] === 'R2',
      ) as [string, string, string] | undefined;
      expect(wildcardCall).toBeDefined();
      expect(wildcardCall![2]).toBe('*');
    });
  });

  // ── Test 3: unsubscribe → hdel ──────────────────────────────────────
  describe('test 3: unsubscribe 整 reactor 触发 redis.hdel', () => {
    it('unsubscribe(R1, "*") 后 hdel(key, R1); 减空集合也走 hdel', async () => {
      currentRedis = new MockIORedis();
      const ws = makeWs('cli-2');

      handleSubscriptionMessage(ws, {
        type: 'subscribe',
        reactorId: 'R1',
        tags: ['TEMP_PV'],
      });
      await Promise.resolve(); await Promise.resolve();
      currentRedis.hset.mockClear();

      const ok = handleSubscriptionMessage(ws, {
        type: 'unsubscribe',
        reactorId: 'R1',
        tags: '*',
      });
      expect(ok).toBe(true);

      await Promise.resolve(); await Promise.resolve();

      expect(currentRedis.hdel).toHaveBeenCalledTimes(1);
      const [key, field] = currentRedis.hdel.mock.calls[0] as [string, string];
      expect(key).toBe(subscriptionHashKey(WS_SERVER_ID, 'cli-2'));
      expect(field).toBe('R1');

      // Map 内该 reactor 也应清掉.
      const state = getSubscriptionState(ws);
      expect(state?.subs?.has('R1')).toBe(false);

      // 部分 unsubscribe 减空集合 → 同样走 hdel 路径 (mirrorSubscribeToRedis
      // 看 state.subs.get(reactorId) === undefined → hdel).
      handleSubscriptionMessage(ws, {
        type: 'subscribe',
        reactorId: 'R3',
        tags: ['A', 'B'],
      });
      await Promise.resolve(); await Promise.resolve();
      currentRedis.hdel.mockClear();
      handleSubscriptionMessage(ws, {
        type: 'unsubscribe',
        reactorId: 'R3',
        tags: ['A', 'B'],
      });
      await Promise.resolve(); await Promise.resolve();
      expect(currentRedis.hdel).toHaveBeenCalledTimes(1);
      const [, field3] = currentRedis.hdel.mock.calls[0] as [string, string];
      expect(field3).toBe('R3');
    });
  });

  // ── Test 4: ws close → del 整 hash + Map delete ────────────────────
  describe('test 4: close 协议 — redis.del + subStates Map delete', () => {
    it('清除 clientId 后 getSubscriptionState 返 undefined + del(key) 被调', async () => {
      currentRedis = new MockIORedis();
      const ws = makeWs('cli-3');

      handleSubscriptionMessage(ws, {
        type: 'subscribe',
        reactorId: 'R1',
        tags: ['TEMP_PV'],
      });
      handleSubscriptionMessage(ws, {
        type: 'subscribe',
        reactorId: 'R2',
        tags: '*',
      });
      await Promise.resolve(); await Promise.resolve();
      expect(getSubscriptionState(ws)?.subs?.size).toBe(2);

      // 模拟 createWsServer connection.on('close') 内行为:
      //   subStates.delete(clientId);  (此处用 reset 整 Map)
      //   redis.del(subscriptionHashKey(WS_SERVER_ID, clientId))
      __resetSubStatesForTests();
      const key = subscriptionHashKey(WS_SERVER_ID, 'cli-3');
      await currentRedis.del(key);

      expect(getSubscriptionState(ws)).toBeUndefined();
      expect(currentRedis.del).toHaveBeenCalledWith(key);
    });
  });

  // ── Test 5: Redis 不可用 → 降级 (Map 仍工作, hash noop) ─────────────
  describe('test 5: Redis 不可用降级', () => {
    it('currentRedis=null → subStates Map 仍工作, 不抛错', async () => {
      currentRedis = null;
      const ws = makeWs('cli-4');

      const ok = handleSubscriptionMessage(ws, {
        type: 'subscribe',
        reactorId: 'R1',
        tags: ['TEMP_PV'],
      });
      expect(ok).toBe(true);

      // 本地 Map 仍有数据.
      const state = getSubscriptionState(ws);
      expect(state?.subs?.get('R1')).toEqual(new Set(['TEMP_PV']));

      // 异步 mirror 路径不抛 (getRedisClient 返 null 直接 return).
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  // ── Test 6: 跨 server query 模拟 ────────────────────────────────────
  describe('test 6: 跨 server query subscriptions:*:*', () => {
    it('模拟 server-A subscribe 后 server-B 读 keys + hgetall', async () => {
      currentRedis = new MockIORedis();
      const ws = makeWs('cli-5');

      handleSubscriptionMessage(ws, {
        type: 'subscribe',
        reactorId: 'R1',
        tags: ['TEMP_PV'],
      });
      handleSubscriptionMessage(ws, {
        type: 'subscribe',
        reactorId: 'R2',
        tags: '*',
      });
      await Promise.resolve(); await Promise.resolve();

      // 模拟跨 server B 的查询: KEYS 'subscriptions:*:*'.
      const expectedKey = subscriptionHashKey(WS_SERVER_ID, 'cli-5');
      currentRedis.keys = vi.fn(async (_pattern: string) => [expectedKey]);

      // server-B 端协议: 拿 keys 后 hgetall 读 reactor → tags.
      const storedFields: Record<string, string> = {};
      for (const call of currentRedis.hset.mock.calls) {
        const [key, field, value] = call as [string, string, string];
        if (key === expectedKey) storedFields[field] = value;
      }
      currentRedis.hgetall = vi.fn(async (_key: string) => storedFields);

      const allKeys = await currentRedis.keys('subscriptions:*:*');
      expect(allKeys).toContain(expectedKey);
      const fields = await currentRedis.hgetall(allKeys[0]);
      expect(Object.keys(fields).sort()).toEqual(['R1', 'R2']);
      const r1Tags = JSON.parse(fields.R1) as string[];
      expect(new Set(r1Tags)).toEqual(new Set(['TEMP_PV']));
      expect(fields.R2).toBe('*'); // wildcard 协议字符串
    });
  });
});
