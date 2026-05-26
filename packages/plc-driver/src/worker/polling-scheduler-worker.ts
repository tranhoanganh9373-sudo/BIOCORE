// ============================================================
// SP-PLC-3 P3b.2: PollingScheduler worker_threads 入口 (真 snap7 路径)
//
// 在 worker context 内运行 polling 调度循环，通过 parentPort IPC 与 main
// thread 交换控制消息 + snapshot 数据，避免 main event loop 被 PLC I/O 阻塞。
//
// P3b.2 路径（生产）:
//   - 在 worker isolate 内 new PLCConnectionManager(plcConfig) + connect()
//   - 用 P3a.3 PollingScheduler (复用 region 批量读 + groupByRate + dirty flag +
//     pollGroup 全套逻辑), 把它的 'snapshot' / 'error' 事件桥接到 IPC postMessage
//   - main thread 不再持 native snap7 binding, worker isolate 隔离崩溃半径
//
// P3b.1 mock 路径 (buildMockSnapshot + 自管 setInterval) 已删除, 由 PollingScheduler
// 接管所有调度. addVariable / removeVariable 直接转发到 PollingScheduler 增量 API.
//
// IPC 协议（详 plan §1 Commit 1 line 60-76, P3b.2 不改）:
//   main → worker:
//     { type: 'init',           reactorId, plcConfig, variables, pollRates }
//     { type: 'addVariable',    variable }
//     { type: 'removeVariable', id }
//     { type: 'stop' }
//   worker → main:
//     { type: 'snapshot', reactorId, snap: ProcessSnapshot }
//     { type: 'state',    state: 'running' | 'stopped' | 'connecting' | 'failed' }
//     { type: 'error',    message }
// ============================================================

import { parentPort } from 'worker_threads';
import { PLCConnectionManager, PollingScheduler } from '../index';
import type { PLCConnectionConfig, PLCVariableMapping, ProcessSnapshot } from '../types';

if (!parentPort) {
  // worker 文件直接 require 会进入这里；正常 spawn 时 parentPort 必非 null
  throw new Error('polling-scheduler-worker 必须通过 worker_threads.Worker 启动');
}
const port = parentPort;

// ─── worker 内部状态 ─────────────────────────────────────────
let reactorId = '';
let mgr: PLCConnectionManager | null = null;
let scheduler: PollingScheduler | null = null;

// ─── 消息处理 ────────────────────────────────────────────────
interface InitMsg {
  type: 'init';
  reactorId: string;
  plcConfig: PLCConnectionConfig;
  variables: PLCVariableMapping[];
  /**
   * P3b.1 协议字段; P3b.2 不再使用 (PollingScheduler 内部按 var.poll_rate_ms
   * 自动 group + 启 timer). 保留接收以兼容 P3b.1 caller, 静默忽略.
   */
  pollRates?: number[];
}
interface AddVarMsg { type: 'addVariable'; variable: PLCVariableMapping }
interface RemoveVarMsg { type: 'removeVariable'; id: string }
interface StopMsg { type: 'stop' }
type InboundMsg = InitMsg | AddVarMsg | RemoveVarMsg | StopMsg;

port.on('message', (msg: InboundMsg) => {
  void handleMessage(msg);
});

async function handleMessage(msg: InboundMsg): Promise<void> {
  try {
    switch (msg.type) {
      case 'init':
        await handleInit(msg);
        break;

      case 'addVariable':
        if (scheduler) scheduler.addVariable(msg.variable);
        break;

      case 'removeVariable':
        if (scheduler) scheduler.removeVariable(msg.id);
        break;

      case 'stop':
        await handleStop();
        break;
    }
  } catch (err) {
    port.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── init: 建立 PLC 连接 + 启 PollingScheduler ───────────────
async function handleInit(msg: InitMsg): Promise<void> {
  reactorId = msg.reactorId;
  port.postMessage({ type: 'state', state: 'connecting' });
  try {
    mgr = new PLCConnectionManager(msg.plcConfig);
    // 把 caller 传入的 vars 注入 mgr (PollingScheduler 启动时会
    // lazy snapshot mgr.getVariableList() 作初始集; 这里显式 setVariables
    // 跟 P3a.3 main thread 路径 index.ts:3758 行为一致).
    mgr.setVariables(msg.variables ?? []);
    await mgr.connect();

    scheduler = new PollingScheduler(mgr);
    // 把 scheduler 'snapshot' 桥接到 IPC. PollingScheduler 内 pollGroup 已含
    // region 批量读 + raw_values + quality 全套逻辑, worker 仅 forward.
    scheduler.on('snapshot', (snap: ProcessSnapshot) => {
      port.postMessage({ type: 'snapshot', reactorId, snap });
    });
    scheduler.on('error', (err: unknown) => {
      port.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    });
    scheduler.start();
    port.postMessage({ type: 'state', state: 'running' });
  } catch (err) {
    port.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
    port.postMessage({ type: 'state', state: 'failed' });
  }
}

// ─── stop: 平稳停 scheduler + 断开 PLC ──────────────────────
async function handleStop(): Promise<void> {
  if (scheduler) {
    try { scheduler.stop(); } catch { /* ignore */ }
    scheduler = null;
  }
  if (mgr) {
    try { await mgr.disconnect(); } catch { /* ignore */ }
    mgr = null;
  }
  port.postMessage({ type: 'state', state: 'stopped' });
  // worker 不自退出, 等 main thread terminate() (P3b 决策 Q5: 5s 超时强 kill)
}
