// ============================================================
// SP-PLC-3 Phase 2 Commit 3 (P2.3) — WS 订阅协议单元测试
// 计划: docs/plans/SP-PLC-3-tag-cache-phase2-plan.md  §1 Commit 3
// ============================================================
//
// 覆盖 ws-server.ts 新加的 SubscriptionState 路径:
//   1. handleSubscriptionMessage 解析 subscribe/unsubscribe
//   2. resolveReactorTags 合并 wildcard + 指定 reactor 订阅
//   3. buildSubsetPvPayload 按订阅 tag 子集化 pv_realtime payload
//   4. 老 client (subs=null) 全推路径不破 (Phase 1 兼容关键不变量)
//
// 不直接测 broadcast 内的 wss.clients.forEach 循环 (它跑在 createWsServer
// 内部, 集成测要起 http server + 真 WebSocket — 留 phase1-e2e.test.ts).
// 8 tests 覆盖 nature 路径已足.
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebSocket } from 'ws';

// SP-PLC-3 P3c.2: 本机未 install @msgpack/msgpack + ioredis (CI install 后真包
// 替换 mock). ws-server.ts top-level import + lib/redis-client.ts 都需要 mock.
vi.mock('@msgpack/msgpack', () => ({
  encode: vi.fn((v: unknown) => new Uint8Array(Buffer.from(JSON.stringify(v)))),
}));
vi.mock('ioredis', () => ({
  // P2.3 测试不直接调 Redis, 仅需让 module load 通过.
  default: class { },
}));

import {
  handleSubscriptionMessage,
  getSubscriptionState,
  resolveReactorTags,
  buildSubsetPvPayload,
  __resetSubStatesForTests,
} from '../../ws-server';

/**
 * 测试用 fake ws — 不需任何 WebSocket 行为.
 * SP-PLC-3 P3c.2: subStates 改 Map<clientId>, 每个 fake ws 需独立 clientId.
 * 这是 fixture 调整, 不破 P2.3 业务语义 (subscribe/unsubscribe/resolve 逻辑).
 */
let _fakeWsCounter = 0;
function makeFakeWs(): WebSocket {
  _fakeWsCounter += 1;
  return { clientId: `p2.3-fake-${_fakeWsCounter}` } as unknown as WebSocket;
}
beforeEach(() => {
  __resetSubStatesForTests();
});

describe('SP-PLC-3 P2.3 — WS 订阅协议', () => {
  // ── Test 1: subscribe 单 tag → state 含该 tag ──
  it('1. subscribe 单 tag → SubscriptionState 切到 Map 模式 (subs ≠ null)', () => {
    const ws = makeFakeWs();
    expect(getSubscriptionState(ws)).toBeUndefined(); // 初始无 state

    const ok = handleSubscriptionMessage(ws, {
      type: 'subscribe',
      reactorId: 'R1',
      tags: ['TEMP_PV'],
    });
    expect(ok).toBe(true);

    const state = getSubscriptionState(ws);
    expect(state).toBeDefined();
    expect(state!.subs).not.toBeNull();
    const r1Subs = state!.subs!.get('R1');
    expect(r1Subs).toBeInstanceOf(Set);
    expect(r1Subs).toEqual(new Set(['TEMP_PV']));

    // resolveReactorTags 返该 Set
    const resolved = resolveReactorTags(state, 'R1');
    expect(resolved).toEqual(new Set(['TEMP_PV']));

    // 未订阅 reactor → undefined
    expect(resolveReactorTags(state, 'R2')).toBeUndefined();
  });

  // ── Test 2: subscribe tags='*' → 该 reactor 全 tag 推 ──
  it('2. subscribe tags="*" → resolveReactorTags 返 "*" (全 tag 推)', () => {
    const ws = makeFakeWs();
    handleSubscriptionMessage(ws, {
      type: 'subscribe',
      reactorId: 'R1',
      tags: '*',
    });
    const state = getSubscriptionState(ws);
    expect(state!.subs!.get('R1')).toBe('*');
    expect(resolveReactorTags(state, 'R1')).toBe('*');
    // 未订阅 reactor 仍 undefined
    expect(resolveReactorTags(state, 'R2')).toBeUndefined();
  });

  // ── Test 3: unsubscribe 部分 tag → 集合减; 减空 → 删 reactor ──
  it('3. unsubscribe 部分 tag → Set 减; 减空整 reactor 删', () => {
    const ws = makeFakeWs();
    handleSubscriptionMessage(ws, {
      type: 'subscribe',
      reactorId: 'R1',
      tags: ['TEMP_PV', 'PH_PV', 'DO_PV'],
    });
    handleSubscriptionMessage(ws, {
      type: 'unsubscribe',
      reactorId: 'R1',
      tags: ['PH_PV'],
    });
    let state = getSubscriptionState(ws)!;
    expect(state.subs!.get('R1')).toEqual(new Set(['TEMP_PV', 'DO_PV']));

    handleSubscriptionMessage(ws, {
      type: 'unsubscribe',
      reactorId: 'R1',
      tags: ['TEMP_PV', 'DO_PV'],
    });
    state = getSubscriptionState(ws)!;
    expect(state.subs!.has('R1')).toBe(false);
    // 但 subs 仍是 Map (不退回 null) — 保持订阅模式
    expect(state.subs).not.toBeNull();
    // 现在该 reactor → undefined (订阅模式下不推)
    expect(resolveReactorTags(state, 'R1')).toBeUndefined();
  });

  // ── Test 4: 老 client (subs=null) → resolveReactorTags 永远返 null = 全推 ──
  it('4. 老 client (subs=null) → resolveReactorTags 永远返 null (Phase 1 全推兼容)', () => {
    const ws = makeFakeWs();
    // 老 client 不发任何 message, getSubscriptionState 返 undefined
    const state = getSubscriptionState(ws);
    expect(state).toBeUndefined();
    // resolveReactorTags(undefined, ...) → null (老 client)
    expect(resolveReactorTags(state, 'R1')).toBeNull();
    expect(resolveReactorTags(state, 'R2')).toBeNull();
    expect(resolveReactorTags(state, 'ANYTHING')).toBeNull();
  });

  // ── Test 5: 多 ws 互不干扰 (subStates 按 ws 分离) ──
  it('5. 两个 ws 各自订阅 — 互不干扰 (WeakMap 按 ws key 隔离)', () => {
    const wsA = makeFakeWs();
    const wsB = makeFakeWs();
    handleSubscriptionMessage(wsA, { type: 'subscribe', reactorId: 'R1', tags: ['TEMP_PV'] });
    handleSubscriptionMessage(wsB, { type: 'subscribe', reactorId: 'R2', tags: ['PH_PV'] });

    const stateA = getSubscriptionState(wsA)!;
    const stateB = getSubscriptionState(wsB)!;

    expect(resolveReactorTags(stateA, 'R1')).toEqual(new Set(['TEMP_PV']));
    expect(resolveReactorTags(stateA, 'R2')).toBeUndefined(); // wsA 没订 R2
    expect(resolveReactorTags(stateB, 'R1')).toBeUndefined(); // wsB 没订 R1
    expect(resolveReactorTags(stateB, 'R2')).toEqual(new Set(['PH_PV']));
  });

  // ── Test 6: subscribe reactorId='*' wildcard + 具体 reactor 合并 ──
  it('6. wildcard reactorId="*" + 具体 reactor 订阅 → tag 集合并', () => {
    const ws = makeFakeWs();
    handleSubscriptionMessage(ws, { type: 'subscribe', reactorId: '*', tags: ['HEARTBEAT'] });
    handleSubscriptionMessage(ws, { type: 'subscribe', reactorId: 'R1', tags: ['TEMP_PV'] });
    const state = getSubscriptionState(ws);
    // R1 解析: 合并 R1 直接订阅 + '*' wildcard
    const resolved = resolveReactorTags(state, 'R1');
    expect(resolved).toEqual(new Set(['TEMP_PV', 'HEARTBEAT']));
    // R2 仅 wildcard 命中
    expect(resolveReactorTags(state, 'R2')).toEqual(new Set(['HEARTBEAT']));

    // 任一方为 '*' → 全推
    handleSubscriptionMessage(ws, { type: 'subscribe', reactorId: '*', tags: '*' });
    expect(resolveReactorTags(state, 'R1')).toBe('*');
    expect(resolveReactorTags(state, 'R2')).toBe('*');
  });

  // ── Test 7: buildSubsetPvPayload 按订阅 tag 子集化 ──
  it('7. buildSubsetPvPayload 仅含订阅 tag 的 field + quality + meta', () => {
    const fullPayload = {
      timestamp: '2026-05-26T01:00:00Z',
      batch_id: 'b-1',
      temp_mode: 2,
      'AI-0': 37.5,
      'AI-2': 7.2,
      'AI-3': 4.5,
      'AI-4': 1.2,
      'AI-5': 30.0,
      rpm: 800,
      quality: {
        TEMP_PV: 'good',
        PH_PV: 'good',
        DO_PV: 'bad',
        PRESSURE_PV: 'good',
        AIRFLOW_PV: 'good',
        VFD_ACTUAL_FREQ: 'good',
      },
    };

    const subset = buildSubsetPvPayload(fullPayload, new Set(['TEMP_PV', 'PH_PV']));
    expect(subset).not.toBeNull();
    expect(subset.timestamp).toBe('2026-05-26T01:00:00Z');
    expect(subset.batch_id).toBe('b-1');
    expect(subset.temp_mode).toBe(2);
    expect(subset['AI-0']).toBe(37.5);
    expect(subset['AI-2']).toBe(7.2);
    // 未订阅字段不该出现
    expect(subset['AI-3']).toBeUndefined();
    expect(subset['AI-4']).toBeUndefined();
    expect(subset.rpm).toBeUndefined();
    // quality 仅含订阅 tag
    expect(subset.quality).toEqual({ TEMP_PV: 'good', PH_PV: 'good' });

    // 订阅集合不命中任何 PV field → 返 null (caller skip send)
    expect(buildSubsetPvPayload(fullPayload, new Set(['NONEXISTENT_TAG']))).toBeNull();
    // 空订阅集合 → null
    expect(buildSubsetPvPayload(fullPayload, new Set())).toBeNull();
  });

  // ── Test 8: 非法 message 静默忽略 + idempotent ──
  it('8. 非法 message 静默忽略; subscribe 覆盖 R1 tag set', () => {
    const ws = makeFakeWs();

    // 非法 type / 缺 reactorId / 不是对象 — 全返 false 不抛
    expect(handleSubscriptionMessage(ws, null)).toBe(false);
    expect(handleSubscriptionMessage(ws, 'string')).toBe(false);
    expect(handleSubscriptionMessage(ws, { type: 'unknown' })).toBe(false);
    expect(handleSubscriptionMessage(ws, { type: 'subscribe' })).toBe(false); // 缺 reactorId
    expect(handleSubscriptionMessage(ws, { type: 'subscribe', reactorId: '' })).toBe(false);
    // 非法 message 不创 state
    expect(getSubscriptionState(ws)).toBeUndefined();

    // 同 R1 重复 subscribe → spec 是 "set" (覆盖), 不是 "add" (追加)
    handleSubscriptionMessage(ws, { type: 'subscribe', reactorId: 'R1', tags: ['TEMP_PV'] });
    handleSubscriptionMessage(ws, { type: 'subscribe', reactorId: 'R1', tags: ['TEMP_PV'] });
    handleSubscriptionMessage(ws, { type: 'subscribe', reactorId: 'R1', tags: ['TEMP_PV', 'PH_PV'] });
    const state = getSubscriptionState(ws)!;
    expect(state.subs!.get('R1')).toEqual(new Set(['TEMP_PV', 'PH_PV']));
  });
});
