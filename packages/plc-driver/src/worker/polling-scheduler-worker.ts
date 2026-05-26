// ============================================================
// SP-PLC-3 P3b.1: PollingScheduler worker_threads 入口
//
// 在 worker context 内运行 polling 调度循环，通过 parentPort IPC 与 main
// thread 交换控制消息 + snapshot 数据，避免 main event loop 被 PLC I/O 阻塞。
//
// 当前 P3b.1 (scaffold) 路径：
//   - 不连真 snap7，每 tick 用 buildMockSnapshot 生成假 ProcessSnapshot
//   - 验证 IPC 协议端到端：init/addVariable/removeVariable/stop ↔ snapshot/state/error
//
// 下游 P3b.2：替换 buildMockSnapshot → 真 PLCConnectionManager.connect + readBytesRaw
// (worker 内构造 connection, snap7 native binding 在 worker isolate 内独立加载)。
//
// IPC 协议（详 plan §1 Commit 1 line 60-76）：
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
import type { PLCConnectionConfig, PLCVariableMapping, ProcessSnapshot } from '../types';

if (!parentPort) {
  // worker 文件直接 require 会进入这里；正常 spawn 时 parentPort 必非 null
  throw new Error('polling-scheduler-worker 必须通过 worker_threads.Worker 启动');
}
const port = parentPort;

// ─── worker 内部状态 ─────────────────────────────────────────
let reactorId = '';
// plcConfig 在 P3b.1 仅存储 (mock 路径不使用)；P3b.2 用于 PLCConnectionManager 构造
let plcConfig: PLCConnectionConfig | null = null;
let variables: PLCVariableMapping[] = [];
let pollRates: number[] = [];
const timers: Map<number, ReturnType<typeof setInterval>> = new Map();
let running = false;

// 在 worker 内显式标注未使用变量 (P3b.2 启用), 避免 lint
void plcConfig;

// ─── 消息处理 ────────────────────────────────────────────────
interface InitMsg {
  type: 'init';
  reactorId: string;
  plcConfig: PLCConnectionConfig;
  variables: PLCVariableMapping[];
  pollRates: number[];
}
interface AddVarMsg { type: 'addVariable'; variable: PLCVariableMapping }
interface RemoveVarMsg { type: 'removeVariable'; id: string }
interface StopMsg { type: 'stop' }
type InboundMsg = InitMsg | AddVarMsg | RemoveVarMsg | StopMsg;

port.on('message', (msg: InboundMsg) => {
  try {
    switch (msg.type) {
      case 'init':
        reactorId = msg.reactorId;
        plcConfig = msg.plcConfig;
        variables = [...(msg.variables ?? [])];
        pollRates = [...(msg.pollRates ?? [1000])];
        startTimers();
        port.postMessage({ type: 'state', state: 'running' });
        break;

      case 'addVariable':
        variables.push(msg.variable);
        // 若新 var 的 poll_rate 尚未注册 timer, 启之 (动态扩展 rate 集)
        if (typeof msg.variable.poll_rate_ms === 'number') {
          ensureTimerForRate(msg.variable.poll_rate_ms);
        }
        break;

      case 'removeVariable':
        variables = variables.filter((v) => v.id !== msg.id);
        // 注：不主动 stop timer (空 rate 在 tick 内会 if(vars.length===0) return 跳过 emit)
        // 保持与 PollingScheduler P3a.3 行为一致：避免短时移除 + 再加触发空窗
        break;

      case 'stop':
        stopTimers();
        port.postMessage({ type: 'state', state: 'stopped' });
        // 让 main thread 决定何时 worker.terminate (P3b 决策 Q5: 5s 超时强 kill)
        break;
    }
  } catch (err) {
    port.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

// ─── timer 管理 ──────────────────────────────────────────────
function startTimers(): void {
  if (running) return;
  running = true;
  for (const rate of pollRates) ensureTimerForRate(rate);
}

function ensureTimerForRate(rate: number): void {
  if (timers.has(rate)) return;
  const timer = setInterval(() => onTick(rate), rate);
  timers.set(rate, timer);
}

function stopTimers(): void {
  running = false;
  for (const t of timers.values()) clearInterval(t);
  timers.clear();
}

function onTick(rate: number): void {
  if (!running) return;
  const varsForRate = variables.filter(
    (v) => v.poll_rate_ms === rate && v.enabled && v.direction !== 'WRITE',
  );
  if (varsForRate.length === 0) return;
  try {
    // P3b.1 mock 路径：生成随机 snapshot 验证 IPC
    // P3b.2 替换为：const snap = await mgr.pollGroup(varsForRate)
    const snap = buildMockSnapshot(varsForRate);
    port.postMessage({ type: 'snapshot', reactorId, snap });
  } catch (err) {
    port.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── mock snapshot (P3b.1 only, P3b.2 删) ────────────────────
function buildMockSnapshot(vars: PLCVariableMapping[]): ProcessSnapshot {
  const values: Record<string, number> = {};
  const raw_values: Record<string, number> = {};
  const quality: Record<string, 'good' | 'bad' | 'uncertain'> = {};
  for (const v of vars) {
    const raw = Math.random() * 100;
    raw_values[v.tag_name] = raw;
    values[v.tag_name] = raw;
    quality[v.tag_name] = 'good';
  }
  return {
    timestamp: new Date().toISOString(),
    connection_id: reactorId, // P3b.1: 用 reactorId 占位; P3b.2 用 plcConfig.id
    values,
    raw_values,
    quality,
  };
}
