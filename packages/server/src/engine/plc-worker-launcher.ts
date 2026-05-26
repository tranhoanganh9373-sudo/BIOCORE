// ============================================================
// SP-PLC-3 P3b.2: per-reactor PLC worker_threads launch helper.
//
// 抽离 index.ts 的 worker spawn + exponential backoff (1s/2s/4s, 最多 3 次)
// + 失败降级 mock + IPC 事件桥接逻辑, 让单测可独立验证生命周期 (worker
// spawn/重启/降级/SIGTERM) 而不需要起整个 server.
//
// 设计原则:
//   - 不持依赖图: 仅依赖回调函数, 把 tagCache.write / cacheMetrics.plcWorkerState
//     / startSchedulerInWorker 都做成 deps. 单测注入 mock, 生产由 index.ts 注入.
//   - per-reactor 1 个 launcher. backoff state 在闭包内, 不暴露.
//   - exit code === 0 = 主动 terminate, 不触发重启 (与 plan §1 Commit 2 决策一致).
//   - 3 次重启失败 → 降级 mock: tagCache 不写新数据, 老缓存仍可读 (Q(iv) A).
// ============================================================

import type { PLCConnectionConfig, PLCVariableMapping, ProcessSnapshot, WorkerHandle } from '@biocore/plc-driver';

/** plan §1 Commit 2 决策 Q(ii): 3 次 backoff (1s/2s/4s) 后降级. */
export const MAX_WORKER_ATTEMPTS = 3;
/** 首次 backoff 1000ms, 每次 ×2 → 1s/2s/4s. */
export const INITIAL_BACKOFF_MS = 1000;

/** worker 内 emit 'snapshot' 时上行的 IPC 包 (与 plc-driver WorkerSnapshotMsg 同). */
export interface WorkerSnapshotPayload {
  reactorId: string;
  snap: ProcessSnapshot;
}

/** launchPlcWorkerForReactor 依赖. */
export interface PlcWorkerLauncherDeps {
  /** plc-driver 注入: `startSchedulerInWorker` (dynamic import 拿到的). */
  startSchedulerInWorker: (config: {
    reactorId: string;
    plcConfig: PLCConnectionConfig;
    variables: PLCVariableMapping[];
    pollRates: number[];
  }) => WorkerHandle;
  /** reactor → snapshot 写 tagCache (含 P2.2 deadbandResolver). */
  onSnapshot: (reactorId: string, snap: ProcessSnapshot) => void;
  /** worker 'state' 事件桥到 plcWorkerState gauge (1=running, 0=其它). */
  onWorkerState: (reactorId: string, state: string) => void;
  /** worker 'error' / 3 次失败降级时调用, 标记 tagCache 为 stale. */
  onMarkStale: (reactorId: string) => void;
  /** 仅测试用: 覆盖 setTimeout (vi.useFakeTimers 兼容). 默认全局 setTimeout. */
  setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  /** 仅测试用: 注入 console (静默测试输出). 默认全局 console. */
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

/** launchPlcWorkerForReactor 配置. */
export interface PlcWorkerLaunchConfig {
  reactorId: string;
  plcConfig: PLCConnectionConfig;
  variables: PLCVariableMapping[];
}

/**
 * 启动单 reactor 的 PLC worker, 含 exponential backoff + 降级.
 *
 * launcher 内部维护 attempts/backoffMs 状态, 每次 exit code !== 0 自动按
 * 1s/2s/4s 重启, 3 次后降级 (调 onMarkStale + onWorkerState='failed').
 *
 * 每次 spawn (含重启后) 都会 invoke onHandleReplace(newHandle), 失败降级时
 * invoke onHandleReplace(null), 调用者据此更新 Map (P3b.2 SIGTERM 用).
 */
export function launchPlcWorkerForReactor(
  config: PlcWorkerLaunchConfig,
  deps: PlcWorkerLauncherDeps,
  onHandleReplace: (handle: WorkerHandle | null) => void,
): void {
  const setTimeoutFn = deps.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
  const logger = deps.logger ?? console;
  const { reactorId, plcConfig, variables } = config;
  // PollingScheduler 内部按 var.poll_rate_ms 自动 group, pollRates 仅作 P3b.1
  // 协议字段传递 (worker 不再使用); 这里取唯一 rate 集.
  const pollRates = Array.from(new Set(variables.map((v) => v.poll_rate_ms ?? 1000)));

  let attempts = 0;
  let backoffMs = INITIAL_BACKOFF_MS;

  const launch = (): void => {
    attempts++;
    try {
      const worker = deps.startSchedulerInWorker({ reactorId, plcConfig, variables, pollRates });
      worker.on('snapshot', (msg: WorkerSnapshotPayload) => {
        deps.onSnapshot(reactorId, msg.snap);
      });
      worker.on('state', (state: string) => {
        deps.onWorkerState(reactorId, state);
      });
      worker.on('error', (err: Error) => {
        logger.error(`[plc-worker:${reactorId}] error:`, err.message);
        deps.onMarkStale(reactorId);
      });
      worker.on('exit', (code: number) => {
        if (code === 0) return; // 主动 terminate, 正常退出
        if (attempts < MAX_WORKER_ATTEMPTS) {
          logger.warn(`[plc-worker:${reactorId}] exit code=${code}, ${backoffMs}ms 后第 ${attempts + 1}/${MAX_WORKER_ATTEMPTS} 次重启`);
          const delay = backoffMs;
          backoffMs *= 2;
          setTimeoutFn(launch, delay);
        } else {
          logger.error(`[plc-worker:${reactorId}] ${MAX_WORKER_ATTEMPTS} 次启动失败, 降级 mock 路径 (老缓存仍可读)`);
          deps.onWorkerState(reactorId, 'failed');
          deps.onMarkStale(reactorId);
          onHandleReplace(null);
        }
      });
      onHandleReplace(worker);
      logger.log(`[plc-worker:${reactorId}] worker spawn 成功 (attempt=${attempts})`);
    } catch (err) {
      logger.warn(`[plc-worker:${reactorId}] spawn 失败 (attempt=${attempts}):`, (err as Error).message);
      if (attempts < MAX_WORKER_ATTEMPTS) {
        const delay = backoffMs;
        backoffMs *= 2;
        setTimeoutFn(launch, delay);
      } else {
        deps.onWorkerState(reactorId, 'failed');
        onHandleReplace(null);
      }
    }
  };

  launch();
}

/**
 * SP-PLC-3 P3b.2: SIGTERM/SIGINT 平稳停所有 worker (5s 超时强 kill).
 *
 * 每个 worker 先发 stop IPC (worker 内 PollingScheduler.stop + mgr.disconnect)
 * 5s 后调 terminate(). Promise.race 确保单 worker 卡死不阻塞总关闭流.
 *
 * 抽出来便于测试 (vi.useFakeTimers 配合 Promise.race 直接验)。
 */
export async function shutdownPlcWorkers(
  workers: Iterable<[string, WorkerHandle]>,
  options?: { terminateTimeoutMs?: number; logger?: Pick<Console, 'warn'> },
): Promise<void> {
  const TERMINATE_TIMEOUT_MS = options?.terminateTimeoutMs ?? 5000;
  const logger = options?.logger ?? console;
  const tasks: Array<Promise<void>> = [];
  for (const [reactorId, worker] of workers) {
    tasks.push((async () => {
      try {
        await Promise.race([
          worker.stop(),
          new Promise<void>((resolve) => setTimeout(resolve, TERMINATE_TIMEOUT_MS)),
        ]);
      } catch (err) {
        logger.warn(`[plc-worker:${reactorId}] stop 错误:`, (err as Error).message);
      }
      try {
        await worker.terminate();
      } catch { /* terminate 失败 = 已退出, 忽略 */ }
    })());
  }
  await Promise.allSettled(tasks);
}
