// ============================================================
// SP-PLC-3 Phase 3a Commit 1 (P3a.1) — WS msgpack 二进制协议单测
// 计划: docs/plans/SP-PLC-3-tag-cache-phase3a-plan.md  §1 Commit 1
// ============================================================
//
// 覆盖 ws-server.ts 新加的 wire 协商路径:
//   1. resolveWireMode: ?wire=msgpack → 'msgpack'
//   2. resolveWireMode: 无 query → 'json' (老 client 兼容)
//   3. resolveWireMode: 非法值 (?wire=xml) → 'json' (不抛)
//   4. serializeForClient: 'msgpack' → Uint8Array 能 msgpack.decode 还原
//   5. serializeForClient: 'json' → string 能 JSON.parse 还原
//   6. mixed broadcast cache: 同 envelope fan-out 两种 client, 各自正确
//      (验证 cache lazy 一次性 encode + 一次性 stringify, 不重复)
//
// 不真起 WebSocketServer — 那是 phase1-e2e 集成测的事. 此处单测 export
// 的纯函数 + 模拟 broadcast 内部 cache 模式 (caller 端职责验证).
//
// 注: WS_WIRE_MODE_FORCED 是 module-load 时 evaluate 的常量, 测试无法
// 在 import 后动态切. 用 `vi.resetModules` 重 import 验 env 回归路径 (Test 7).
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { decode as msgpackDecode } from '@msgpack/msgpack';
import { resolveWireMode, serializeForClient, type WireMode } from '../../ws-server';

describe('SP-PLC-3 P3a.1 — WS msgpack 协议协商', () => {
  // ── Test 1: ?wire=msgpack → 'msgpack' ──
  it('1. resolveWireMode: ?wire=msgpack → "msgpack"', () => {
    expect(resolveWireMode('/ws?wire=msgpack', 'localhost')).toBe('msgpack');
    expect(resolveWireMode('/ws?token=abc&wire=msgpack', 'localhost:3001')).toBe('msgpack');
    expect(resolveWireMode('/ws?wire=msgpack&api_key=xyz', 'example.com')).toBe('msgpack');
  });

  // ── Test 2: 无 query → 默认 'json' (老 client 兼容关键不变量) ──
  it('2. resolveWireMode: 无 wire query → "json" (老 client 兼容)', () => {
    expect(resolveWireMode('/ws', 'localhost')).toBe('json');
    expect(resolveWireMode('/ws?token=abc', 'localhost')).toBe('json');
    expect(resolveWireMode('/ws?api_key=xyz', 'example.com')).toBe('json');
    expect(resolveWireMode('', 'localhost')).toBe('json');
    expect(resolveWireMode(undefined, 'localhost')).toBe('json');
  });

  // ── Test 3: 非法 wire 值 → 默认 'json' (不抛, 不 close) ──
  it('3. resolveWireMode: 非法 wire 值 (xml/json/空) → "json" (不抛)', () => {
    expect(resolveWireMode('/ws?wire=xml', 'localhost')).toBe('json');
    expect(resolveWireMode('/ws?wire=', 'localhost')).toBe('json');
    expect(resolveWireMode('/ws?wire=protobuf', 'localhost')).toBe('json');
    // wire=json 显式也走 json 分支 (严格 === 'msgpack' 才进二进制)
    expect(resolveWireMode('/ws?wire=json', 'localhost')).toBe('json');
    // host 缺失也不抛
    expect(resolveWireMode('/ws?wire=msgpack', undefined)).toBe('msgpack');
  });

  // ── Test 4: msgpack serializer → Uint8Array 能 decode 还原 ──
  it('4. serializeForClient("msgpack", envelope) → Uint8Array 能 msgpack.decode 还原', () => {
    const envelope = {
      channel: 'pv_realtime',
      timestamp: '2026-05-26T12:00:00.000Z',
      batch_id: 'B-001',
      reactor_id: 'R1',
      payload: {
        'AI-0': 37.5,
        'AI-1': 7.12,
        quality: { TEMP_PV: 'good', PH_PV: 'good' },
      },
    };
    const out = serializeForClient('msgpack', envelope);
    expect(out).toBeInstanceOf(Uint8Array);
    expect((out as Uint8Array).length).toBeGreaterThan(0);
    const decoded = msgpackDecode(out as Uint8Array);
    expect(decoded).toEqual(envelope);
  });

  // ── Test 5: json serializer → string 能 JSON.parse 还原 ──
  it('5. serializeForClient("json", envelope) → string 能 JSON.parse 还原', () => {
    const envelope = {
      channel: 'alarm',
      timestamp: '2026-05-26T12:00:01.000Z',
      batch_id: null,
      reactor_id: 'R2',
      payload: { code: 'A001', severity: 'high', message: 'pH out of range' },
    };
    const out = serializeForClient('json', envelope);
    expect(typeof out).toBe('string');
    const parsed = JSON.parse(out as string);
    expect(parsed).toEqual(envelope);
  });

  // ── Test 6: mixed broadcast cache 模式 — 同 envelope, 一个 msgpack 一个 json,
  //          各自正确 + cache lazy 一次性 encode 一次性 stringify ──
  it('6. mixed clients: 同 envelope fan-out 两种 client, cache 各只算一次', () => {
    // 模拟 broadcast 内部 cache (与 ws-server.ts:264-267 一致结构)
    const envelope = {
      channel: 'pv_realtime',
      timestamp: '2026-05-26T12:00:00.000Z',
      batch_id: 'B-002',
      reactor_id: 'R3',
      payload: { 'AI-0': 36.8, 'AI-1': 7.05 },
    };

    let stringifyCalls = 0;
    let encodeCalls = 0;
    let cachedJSON: string | null = null;
    let cachedMsgpack: Uint8Array | null = null;
    const getJSON = (): string => {
      if (cachedJSON === null) {
        stringifyCalls++;
        cachedJSON = JSON.stringify(envelope);
      }
      return cachedJSON;
    };
    const getMsgpack = (): Uint8Array => {
      if (cachedMsgpack === null) {
        encodeCalls++;
        // serializeForClient('msgpack', ...) 返 Uint8Array
        cachedMsgpack = serializeForClient('msgpack', envelope) as Uint8Array;
      }
      return cachedMsgpack;
    };

    // 模拟 4 个 client: 2 msgpack + 2 json (mixed)
    const clients: WireMode[] = ['msgpack', 'json', 'msgpack', 'json'];
    const sent: Array<string | Uint8Array> = [];
    for (const wireMode of clients) {
      sent.push(wireMode === 'msgpack' ? getMsgpack() : getJSON());
    }

    // 各 client 收到的内容正确
    expect(sent[0]).toBeInstanceOf(Uint8Array);
    expect(sent[1]).toBe(JSON.stringify(envelope));
    expect(sent[2]).toBeInstanceOf(Uint8Array);
    expect(sent[3]).toBe(JSON.stringify(envelope));

    // 同引用 (cache 命中, 不重复 encode)
    expect(sent[0]).toBe(sent[2]);
    expect(sent[1]).toBe(sent[3]);

    // 每种序列化只算 1 次
    expect(stringifyCalls).toBe(1);
    expect(encodeCalls).toBe(1);

    // msgpack 内容 decode 后跟 envelope 等同
    expect(msgpackDecode(sent[0] as Uint8Array)).toEqual(envelope);
  });

  // ── Test 7 (a/b): WS_WIRE_MODE_FORCED env 强制 → 即使 ?wire=msgpack 也 'json'
  //          (回归 hot-rollback 路径, vi.resetModules 重 import 验) ──
  describe('7. WS_WIRE_MODE_FORCED env 强制全 client JSON (hot-rollback)', () => {
    const ORIGINAL = process.env.WS_WIRE_MODE_FORCED;
    beforeEach(() => {
      vi.resetModules();
    });
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.WS_WIRE_MODE_FORCED;
      else process.env.WS_WIRE_MODE_FORCED = ORIGINAL;
      vi.resetModules();
    });

    it('WS_WIRE_MODE_FORCED=json: ?wire=msgpack 仍返 "json"', async () => {
      process.env.WS_WIRE_MODE_FORCED = 'json';
      // resetModules 后重 import 让 module-load 时常量重 evaluate
      // nodenext moduleResolution: dynamic import 需 .js 后缀
const mod = await import('../../ws-server.js');
      expect(mod.resolveWireMode('/ws?wire=msgpack', 'localhost')).toBe('json');
      expect(mod.resolveWireMode('/ws?wire=msgpack&token=t', 'localhost')).toBe('json');
    });

    it('WS_WIRE_MODE_FORCED 未设: ?wire=msgpack 正常返 "msgpack"', async () => {
      delete process.env.WS_WIRE_MODE_FORCED;
      // nodenext moduleResolution: dynamic import 需 .js 后缀
const mod = await import('../../ws-server.js');
      expect(mod.resolveWireMode('/ws?wire=msgpack', 'localhost')).toBe('msgpack');
    });
  });
});
