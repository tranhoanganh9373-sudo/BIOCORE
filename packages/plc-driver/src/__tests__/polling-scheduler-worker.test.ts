// ============================================================
// SP-PLC-3 P3b.1: startSchedulerInWorker IPC 协议测试
//
// 策略选择 (plan 选项 A): vi.mock('worker_threads').
//   - vitest 直接跑 .ts 不 build, 真 spawn worker 需先 tsc 编译, 测试链路复杂
//   - mock Worker 验 IPC 协议 (postMessage 入参 + 事件桥接) 已覆盖 P3b.1 scope
//   - P3b.2 加 worker-lifecycle 集成测时可走真 spawn (server 启动后 dist 已 build)
//
// 覆盖 (6 tests, 对应 plan §1 Commit 1 line 78-84):
//   1. init message 发送后 handle 触发 'state' = 'running'
//   2. snapshot 从 worker (mock) 收到 → handle.emit('snapshot', WorkerSnapshotMsg)
//   3. addVariable 转发到 worker.postMessage
//   4. removeVariable 转发到 worker.postMessage
//   5. stop 转发 worker.postMessage + handle 收 'state' = 'stopped'
//   6. worker 'error' 事件 → handle 收 'error' (Error 对象)
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { PLCConnectionConfig, PLCVariableMapping } from '../types';

// ─── mock worker_threads.Worker ──────────────────────────────
// 用 EventEmitter 模拟 Worker, postMessage 捕获到 vi.fn, 'message'/'error'/'exit'
// 通过 emit 触发 (模拟 worker 内 postBack).

class MockWorker extends EventEmitter {
  postMessage = vi.fn();
  terminate = vi.fn(async () => 0);
}

const mockWorkerInstances: MockWorker[] = [];

vi.mock('worker_threads', () => ({
  Worker: vi.fn(() => {
    const w = new MockWorker();
    mockWorkerInstances.push(w);
    return w;
  }),
}));

// 注意: 必须 import 在 vi.mock 之后 (vi.mock 被 hoist, 但显式后置更清晰)
import { startSchedulerInWorker } from '../index';

// ─── 测试 fixture ────────────────────────────────────────────
const sampleConfig: PLCConnectionConfig = {
  id: 'plc-1',
  name: 'PLC-1',
  protocol: 's7',
  ip: '127.0.0.1',
  port: 102,
  enabled: true,
  rack: 0,
  slot: 1,
  heartbeat_write_address: 'VB400',
  heartbeat_read_address: 'VB401',
  heartbeat_timeout_ms: 3000,
  reconnect_interval_ms: 5000,
};

const sampleVar: PLCVariableMapping = {
  id: 'var-1',
  tag_name: 'temp_1',
  description: 'Temperature 1',
  plc_address: 'VD100',
  data_type: 'FLOAT32',
  direction: 'READ',
  scaling_enabled: false,
  raw_min: 0,
  raw_max: 32767,
  eng_min: 0,
  eng_max: 100,
  eng_unit: '°C',
  group: 'sensors',
  poll_rate_ms: 1000,
  enabled: true,
  connection_id: 'plc-1',
};

const baseConfig = {
  reactorId: 'reactor-A',
  plcConfig: sampleConfig,
  variables: [sampleVar],
  pollRates: [1000],
  workerPath: '/dummy/path.js', // mock 不真用
};

beforeEach(() => {
  mockWorkerInstances.length = 0;
});

// ─── tests ───────────────────────────────────────────────────
describe('startSchedulerInWorker IPC', () => {
  it('init message → handle 收到 state="running"', async () => {
    const handle = startSchedulerInWorker(baseConfig);
    const worker = mockWorkerInstances[0];

    // 验 init postMessage 已发
    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'init',
      reactorId: 'reactor-A',
      plcConfig: sampleConfig,
      variables: [sampleVar],
      pollRates: [1000],
    });

    // 模拟 worker postBack 'state:running'
    const stateP = new Promise<string>((resolve) => handle.on('state', resolve));
    worker.emit('message', { type: 'state', state: 'running' });
    expect(await stateP).toBe('running');
  });

  it('worker snapshot message → handle 触发 "snapshot" 事件含 reactorId+snap', async () => {
    const handle = startSchedulerInWorker(baseConfig);
    const worker = mockWorkerInstances[0];

    const snapP = new Promise<{ reactorId: string; snap: { values: Record<string, number> } }>(
      (resolve) => handle.on('snapshot', resolve),
    );

    const fakeSnap = {
      timestamp: '2026-05-26T12:00:00.000Z',
      connection_id: 'reactor-A',
      values: { temp_1: 42.0 },
      raw_values: { temp_1: 42.0 },
      quality: { temp_1: 'good' as const },
    };
    worker.emit('message', { type: 'snapshot', reactorId: 'reactor-A', snap: fakeSnap });

    const received = await snapP;
    expect(received.reactorId).toBe('reactor-A');
    expect(received.snap.values).toEqual({ temp_1: 42.0 });
  });

  it('addVariable() → postMessage type=addVariable + variable payload', () => {
    const handle = startSchedulerInWorker(baseConfig);
    const worker = mockWorkerInstances[0];
    worker.postMessage.mockClear(); // 清掉 init 那次

    const newVar: PLCVariableMapping = { ...sampleVar, id: 'var-2', tag_name: 'temp_2' };
    handle.addVariable(newVar);

    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'addVariable', variable: newVar });
  });

  it('removeVariable() → postMessage type=removeVariable + id payload', () => {
    const handle = startSchedulerInWorker(baseConfig);
    const worker = mockWorkerInstances[0];
    worker.postMessage.mockClear();

    handle.removeVariable('var-1');

    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'removeVariable', id: 'var-1' });
  });

  it('stop() → postMessage type=stop; worker postBack state=stopped → handle 收到', async () => {
    const handle = startSchedulerInWorker(baseConfig);
    const worker = mockWorkerInstances[0];
    worker.postMessage.mockClear();

    const stateP = new Promise<string>((resolve) => handle.on('state', resolve));
    await handle.stop();

    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'stop' });

    // 模拟 worker 收到 stop 后 postBack state
    worker.emit('message', { type: 'state', state: 'stopped' });
    expect(await stateP).toBe('stopped');
  });

  it('worker error event → handle 收 Error 对象', async () => {
    const handle = startSchedulerInWorker(baseConfig);
    const worker = mockWorkerInstances[0];

    const errP = new Promise<Error>((resolve) => handle.on('error', resolve));
    const fakeErr = new Error('worker boom');
    worker.emit('error', fakeErr);

    const received = await errP;
    expect(received).toBeInstanceOf(Error);
    expect(received.message).toBe('worker boom');
  });
});
