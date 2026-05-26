// ============================================================
// reactor-wiring — ReactorManager + collector + event bridge
// ============================================================
// Extracted from index.ts (v1.9.0 P2 bucket 1).
//
// This is the highest-ROI seam per the v1.9.0 P2 architect plan:
// reactor wiring is the densest cluster of cross-system glue in the
// server (PLC reads, InfluxDB writes, CUSUM detectors, KPI/DOE side
// effects, audit log writes, WS broadcasts) and was the most painful
// part of index.ts to navigate.
//
// Exports:
//   - reactorManager      module-load singleton (matches old behavior)
//   - INTERLOCK_META,
//     RUNNING_FAULT_META  static metadata tables consumed by routes
//   - createReactorWiring(deps)  builds:
//       startReactorCollector / stopReactorCollector
//       wireReactorEvents
//       reactorCollectorTimers (exposed so gracefulShutdown can iterate)
//
// All ws broadcasts, audit writes, CUSUM init/cleanup, KPI compute,
// DOE response collection are byte-identical to the previous inline
// version — the move is purely structural.
// ============================================================

import type Database from 'better-sqlite3';
// SP-PLC-3 P3 (plan §1 Commit 3): Point 已不再在本模块用 (写入移到
// engine/influx-flusher.ts). WriteApi 类型仍出现在 ReactorWiringDeps
// 上, 保留 — 主调用方 (index.ts) 仍需向 influxWriteApi 注入实例供
// startInfluxFlusher 使用; 同时 collector 的 `if (!influxWriteApi) return`
// guard 沿用旧 "无 Influx 不启动 collector" 行为.
import type { WriteApi } from '@influxdata/influxdb-client';
import { getAuditQueue } from './audit-queue';

import { ReactorManager } from '@biocore/batch-engine';

import { devPlcRead, MOCK_PLC } from './plc-bridge';
import { softSensorEngine, getCusumKey, clearCusumDetectors } from './ai-wiring';
import { initCusumBaselines } from './cusum-routes';
import { computeAndStore as computeKpi } from './kpi-routes';
// SP-PLC-3 P2: TagCache + PollingScheduler 接入 (plan §1 Commit 2)
import { TagCache, type SnapshotInput } from './engine/tag-cache';
// PollingScheduler 类型仅用于参数 typing; 真实实例由 index.ts 启动期注入
// (主 entry 含 node-snap7 native binding, 不能在 server 顶层直接 import —
//  index.ts 用 dynamic import 隔离). 这里只引 type, type-only import 编译期
//  消解, 不会触发 native 加载.
import type { PollingScheduler } from '@biocore/plc-driver';

// ─── Module-load singletons & state (matches old index.ts semantics) ─
export const reactorManager = new ReactorManager();

// reactor 数据采集 timer (key: reactor_id) — exposed so gracefulShutdown
// can iterate and clear.
export const reactorCollectorTimers = new Map<string, ReturnType<typeof setInterval>>();

// ─── 静态元数据 (IL/RF) ────────────────────────────────────
// 所有 IL / RF 定义的元数据 (来自 06_ISA-88状态机规格 + running-fault-monitor.ts)
export const INTERLOCK_META: { id: string; name: string; description: string; severity: 'critical' | 'warning' }[] = [
  { id: 'IL-01', name: '传感器信号',   description: 'AI-0~AI-5 全部 4-20mA 有效 (>3.8mA)',                  severity: 'critical' },
  { id: 'IL-02', name: '变频器',       description: 'VFD 通讯正常且故障码=0',                                  severity: 'critical' },
  { id: 'IL-03', name: '蒸汽阀关闭',   description: '启动前蒸汽阀必须关到位 (防止意外灭菌)',                  severity: 'critical' },
  { id: 'IL-04', name: '冷却阀关闭',   description: '启动前冷却阀必须关到位',                                  severity: 'critical' },
  { id: 'IL-05', name: '急停状态',     description: 'I0.0 硬件急停未按下',                                     severity: 'critical' },
  { id: 'IL-06', name: '罐盖限位',     description: '罐盖限位开关确认已锁紧',                                   severity: 'critical' },
  { id: 'IL-07', name: 'PLC心跳',      description: 'VB400/VB401 双向心跳正常 (证明 PLC 程序在跑)',            severity: 'critical' },
  { id: 'IL-08', name: '配方状态',     description: '已下载配方且 status=approved',                             severity: 'critical' },
  { id: 'IL-09', name: '数据库可写',   description: 'InfluxDB 和 SQLite 连接正常可写入',                         severity: 'critical' },
  { id: 'IL-10', name: '蒸汽供气',     description: '蒸汽压力开关 > 0.5bar (警告级, 不阻止启动)',               severity: 'warning' },
];

export const RUNNING_FAULT_META: { code: string; name: string; description: string; severity: 'critical' | 'warning'; holdAction?: string }[] = [
  { code: 'RF-01', name: '变频器故障',          description: 'VFD_FAULT_CODE 非零',                                     severity: 'critical', holdAction: '搅拌急停' },
  { code: 'RF-02', name: 'VFD通讯超时',         description: 'VFD 连续 >3s 无响应或同值',                               severity: 'critical', holdAction: '搅拌急停' },
  { code: 'RF-03', name: '温度偏差过大',        description: '|PV-SP| > 2°C 持续 3min',                                 severity: 'critical', holdAction: '温度PID继续运行' },
  { code: 'RF-04', name: 'pH偏差过大(泵满速)', description: '|PV-SP| > 0.5 且补料/校正泵满速 持续 5min',              severity: 'critical', holdAction: '补料泵停' },
  { code: 'RF-05', name: 'DO过低',              description: 'DO < 5% 持续 5min',                                        severity: 'critical', holdAction: '补料泵停' },
  { code: 'RF-06', name: '罐压过高',            description: 'PRESSURE > 2.5bar',                                        severity: 'critical', holdAction: '排气全开, 蒸汽关' },
  { code: 'RF-07', name: '传感器断线',          description: '通道 raw < 100 (低于 3.6mA)',                              severity: 'warning' },
  { code: 'RF-08', name: '传感器饱和',          description: '通道 raw > 28000 (高于 20.5mA)',                           severity: 'warning' },
  { code: 'RF-09', name: '称重无变化(泵运行)', description: '补料泵 >0 但称重 30min 无变化 (疑似泵失效)',             severity: 'warning', holdAction: '补料泵停' },
  { code: 'RF-10', name: '疑似泡沫事件',        description: '称重突增 >5% 且所有泵关停',                                severity: 'warning', holdAction: '消泡泵脉冲' },
  { code: 'RF-11', name: 'PLC通讯断线',         description: '心跳丢失, 由 CommWatchdog 触发',                           severity: 'critical', holdAction: '全部进入 Hold' },
];

export interface ReactorWiringDeps {
  sqlite: { getDatabase: () => Database.Database; createAlarm: (a: any) => void; writeAuditLog: (e: any) => void; setDoeRunResponse: (sid: string, idx: number, resp: any) => void; listDoeRuns: (sid: string) => any[]; updateDoeStudyStatus: (sid: string, s: string) => void };
  influxWriteApi: WriteApi | null;
  broadcast: (channel: string, payload: any, batchId?: string | null, reactorId?: string | null) => void;
  autoCollectDoeResponses: (db: any, studyId: string, runIndex: number) => Record<string, number> | null;
  // SP-PLC-3 P2: TagCache 必传, 所有 tag 读写统一走 cache (plan §1 Commit 2).
  tagCache: TagCache;
  // SP-PLC-3 P2 (Q5): pollingSchedulers 可选; MOCK_PLC 或某 reactor 无 PLC
  // 绑定时不创建 scheduler, reactor-wiring 走 buildMockSnapshot 写 cache.
  pollingSchedulers?: Map<string, PollingScheduler>;
}

/**
 * SP-PLC-3 P2: 用 devPlcRead 拼 mock snapshot, shape 与 PollingScheduler
 * emit 的 ProcessSnapshot 一致 (plan §1 Commit 2 + §2g 行为等价不变).
 *
 * 关键 invariant: `buildMockSnapshot(TAGS, r).values[tag]` 对每个 tag 等于
 * `devPlcRead(tag)` (catch 后 0 兜底), 保持 MOCK_PLC 演示路径行为不变.
 */
export function buildMockSnapshot(tags: readonly string[], _reactorId: string): SnapshotInput {
  const values: Record<string, number> = {};
  const quality: Record<string, 'good' | 'bad' | 'uncertain'> = {};
  for (const tag of tags) {
    try {
      values[tag] = devPlcRead(tag);
    } catch {
      // 旧路径在 catch 后写 0 (line 119 of pre-P2). MOCK 环境无通讯故障概念,
      // 同步落 quality='good' 跟旧 broadcast/influx 行为一致.
      values[tag] = 0;
    }
    quality[tag] = 'good';
  }
  return {
    timestamp: new Date().toISOString(),
    values,
    quality,
  };
}

export interface ReactorWiringHandles {
  startReactorCollector: (reactorId: string) => void;
  stopReactorCollector: (reactorId: string) => void;
  wireReactorEvents: (reactorId: string) => void;
}

export function createReactorWiring(deps: ReactorWiringDeps): ReactorWiringHandles {
  const { sqlite, influxWriteApi, broadcast, autoCollectDoeResponses, tagCache, pollingSchedulers } = deps;

  // 启动单个反应器的时序采集 (60秒一次写入 InfluxDB)
  function startReactorCollector(reactorId: string): void {
    if (!influxWriteApi || reactorCollectorTimers.has(reactorId)) return;
    const tick = () => {
      try {
        const ctrl = reactorManager.getReactor(reactorId);
        // M2.2 bug 修复: 仅在批次真正 running 时标 real batch_id,
        // 否则一律 'idle' (避免把 downloaded recipe_id 误当 batch_id 污染时序数据)
        const batchId = ctrl && ctrl.currentState === 'running' && ctrl.currentBatchId
          ? ctrl.currentBatchId
          : 'idle';
        // v1.8.0 bucket 3 (perf fix 3): dedupe PLC reads. Old code called
        // devPlcRead(tag) ~32 times per tick (~18 for the InfluxDB Point + ~14
        // for the WS broadcast pvPayload), even though only 19 unique tags
        // are actually consumed. Hoist into a single rawPV map and read each
        // tag once, then build both the Point and the broadcast payload from
        // it. devPlcRead is currently sync (random-walk simulator); when
        // MOCK_PLC=false the read becomes async and the 32→19 reduction will
        // yield real network savings — see concerns note for the async-PLC
        // follow-up.
        const TAGS = [
          'TEMP_PV', 'JACKET_PV', 'PH_PV', 'DO_PV', 'PRESSURE_PV', 'AIRFLOW_PV', 'WEIGHT_PV',
          'VFD_ACTUAL_FREQ', 'VFD_CURRENT',
          'STEAM_CV', 'COOL_CV', 'AIR_CV',
          'P01_RATE', 'P02_RATE', 'P03_RATE', 'P04_RATE',
          'TEMP_SV', 'PH_SV', 'DO_SV',
        ];
        // SP-PLC-3 P2: 数据采集统一走 TagCache.
        //   - MOCK_PLC 或 reactor 无 PLC 绑定 → 内联 buildMockSnapshot 写入 cache
        //     (保留旧 mock 演示路径行为, plan §2g);
        //   - 真实 PLC 绑定 → 由启动期 PollingScheduler.on('snapshot', ...) 异步
        //     写入 cache, 本 tick 直接从 cache 读最新值 (cache 暖机期
        //     1×poll_rate_ms 内可能为空, 落 0 兜底跟旧行为一致, plan §2b).
        if (MOCK_PLC || !pollingSchedulers?.get(reactorId)) {
          tagCache.write(reactorId, buildMockSnapshot(TAGS, reactorId));
        }

        // SP-PLC-3 P3 (plan §1 Commit 3): 已拆出
        //   - InfluxDB Point 写入   → startInfluxFlusher (engine/influx-flusher.ts, 1Hz)
        //   - WS pv_realtime 推送  → startRealtimeBroadcaster (engine/realtime-broadcaster.ts, 5Hz dirty-only)
        // 本 collector 仅保留 cache 写入 + CUSUM/软测量/告警等闭包依赖路径.

        // ─── CUSUM 实时异常检测 ───────────────────────────
        if (batchId !== 'idle') {
          const detMap = getCusumKey(batchId);

          // SP-PLC-3 P4 (plan §1 Commit 4): pvMap 从 TagCache 读, 不再依赖
          // 同 tick 内 rawPV 闭包 (rawPV 已删除, 见上面 cache.write 之后).
          // quality='bad' 的 channel 直接 skip — 不进 pvMap, 不污染 CUSUM
          // 检测器历史 state (旧路径用 catch→0 兜底会把 0 当作真实值喂进
          // detector 累积偏差, 通讯断恢复后产生大量虚假告警).
          const cusumTags = ['TEMP_PV', 'PH_PV', 'DO_PV', 'PRESSURE_PV', 'VFD_ACTUAL_FREQ'];
          const cusumEntries = tagCache.readMany(reactorId, cusumTags);
          const tagToChannel: ReadonlyArray<[string, string]> = [
            ['TEMP_PV', 'temperature'],
            ['PH_PV', 'pH'],
            ['DO_PV', 'DO'],
            ['PRESSURE_PV', 'pressure'],
            ['VFD_ACTUAL_FREQ', 'rpm'],
          ];
          const pvMap: Record<string, number> = {};
          for (const [tag, channel] of tagToChannel) {
            const entry = cusumEntries[tag];
            if (entry && entry.quality === 'good') {
              // rpm = VFD_ACTUAL_FREQ × 24 转换, 与旧 rpmRaw 一致.
              pvMap[channel] = channel === 'rpm' ? entry.value * 24 : entry.value;
            }
          }

          const cusumResults: Array<{
            channel: string; anomaly: boolean; deviation: number;
            alarming: boolean; cumPos: number; cumNeg: number;
          }> = [];

          for (const [ch, detector] of detMap) {
            const val = pvMap[ch];
            if (val === undefined) continue;
            const r = detector.detect(val);
            cusumResults.push({
              channel: ch,
              anomaly: r.anomaly,
              deviation: r.normalized,
              alarming: r.anomaly,
              cumPos: r.cumPos,
              cumNeg: r.cumNeg,
            });

            // 异常时发送告警并写入数据库
            if (r.anomaly) {
              const direction = r.cumPos > r.cumNeg ? '偏高' : '偏低';
              const alarmData = {
                batch_id: batchId,
                alarm_code: `CUSUM_${ch.toUpperCase()}`,
                severity: 'warning',
                source: 'ai:cusum',
                message: `CUSUM检测: ${ch} 持续${direction}, 偏差 ${r.normalized.toFixed(1)}σ`,
                channel: ch,
                pv_at_trigger: val,
              };
              broadcast('alarm', { reactor_id: reactorId, ...alarmData }, batchId, reactorId);
              try { sqlite.createAlarm(alarmData); } catch { /* ignore */ }
            }
          }

          // 广播 CUSUM 状态到前端
          if (cusumResults.length > 0) {
            broadcast('cusum', cusumResults, batchId, reactorId);
          }

          // ─── 软测量实时推断 ─────────────────────────────
          try {
            const activeModels = softSensorEngine.listModels?.() || [];
            if (activeModels.length > 0) {
              const features: Record<string, number> = {
                temperature: pvMap.temperature,
                pH: pvMap.pH,
                DO: pvMap.DO,
                pressure: pvMap.pressure,
                rpm: pvMap.rpm,
              };
              const predictions: Record<string, any> = {};
              for (const model of activeModels) {
                try {
                  const result = softSensorEngine.predict(model.id, features);
                  predictions[model.target || model.id] = result;
                } catch { /* 单模型推断失败不影响其他 */ }
              }
              if (Object.keys(predictions).length > 0) {
                broadcast('soft_sensor', predictions, batchId, reactorId);
              }
            }
          } catch { /* 软测量模块错误不影响主采集 */ }
        }
      } catch (e: any) {
        console.error(`[${new Date().toISOString()}] [ERROR] [Influx write] ${e?.message || e}`);
      }
    };
    tick(); // 立即写一次,后续每 60 秒
    const timer = setInterval(tick, 60000);
    reactorCollectorTimers.set(reactorId, timer);
    console.log(`[${new Date().toISOString()}] [INFO] [Influx] 反应器 ${reactorId} 时序采集已启动`);
  }

  function stopReactorCollector(reactorId: string): void {
    const t = reactorCollectorTimers.get(reactorId);
    if (t) {
      clearInterval(t);
      reactorCollectorTimers.delete(reactorId);
    }
  }

  // ── WebSocket 广播集成 (状态变更/报警/步骤进度) ──
  // 监听BatchController事件并广播到WebSocket
  function wireReactorEvents(reactorId: string): void {
    const ctrl = reactorManager.getReactor(reactorId);
    if (!ctrl) return;

    // 启动该反应器的 InfluxDB 时序采集
    startReactorCollector(reactorId);

    // 状态变更广播
    ctrl.on('state_changed', (state: string) => {
      broadcast('state_update', {
        reactor_id: reactorId,
        state,
        batch_id: ctrl.currentBatchId || null,
      }, null, reactorId);

      // v1.7.2: 批次进入 running 时初始化 CUSUM 基线 — 任何异常都不能冒到 emit 链
      // 上, 否则会经 actor.subscribe → uncaughtException → SIGTERM 整服务重启.
      if (state === 'running' && ctrl.currentBatchId) {
        try {
          const detMap = getCusumKey(ctrl.currentBatchId);
          initCusumBaselines(detMap);
          console.log(`[${new Date().toISOString()}] [INFO] [CUSUM] 批次 ${ctrl.currentBatchId} 检测器已初始化`);
        } catch (e) {
          console.error(`[CUSUM] 批次 ${ctrl.currentBatchId} 基线初始化失败:`, (e as Error).message);
        }
      }
    });

    // 完整状态更新(含phase/step)
    ctrl.on('state_update', (data: any) => {
      broadcast('state_update', { reactor_id: reactorId, ...data }, data?.batch_id, reactorId);
    });

    // Phase启动/完成 — T16/T24: payload_version=2 + node_id (legacy phase_index removed in T24)
    ctrl.on('phase_started', (data: any) => {
      broadcast('step_progress', {
        reactor_id: reactorId,
        event: 'phase_started',
        payload_version: 2,
        batch_id: ctrl.currentBatchId,
        node_id: ctrl.currentNodeId,
        phase_id: data.phase_id,
        phase_type: data.phase_type,
        total_steps: data.total_steps,
      }, null, reactorId);
    });
    ctrl.on('phase_completed', (data: any) => {
      broadcast('step_progress', {
        reactor_id: reactorId,
        event: 'phase_completed',
        payload_version: 2,
        batch_id: ctrl.currentBatchId,
        node_id: ctrl.currentNodeId,
        phase_id: data.phase_id,
        phase_type: data.phase_type,
      }, null, reactorId);
    });

    // T15: branch_evaluated 审计桥 — DAG 分支求值结果落到 audit_logs
    // (T13 controller 端已发出该事件; 这里是 server 端唯一的 audit/broadcast 落点)
    ctrl.on('branch_evaluated', (data: any) => {
      // 广播给前端，用于在 DAG 视图上回放分支决策 — T16: payload_version=2 + explicit node_id
      broadcast('branch_evaluated', {
        reactor_id: reactorId,
        type: 'branch_evaluated',
        payload_version: 2,
        batch_id: data?.batch_id ?? ctrl.currentBatchId,
        node_id: data?.node_id ?? null,
        expression: data?.expression,
        result: data?.result,
        skipped: data?.skipped,
        pv_snapshot: data?.pv_snapshot,
      }, data?.batch_id, reactorId);
      // v1.9.0 P2 bucket 3: enqueue audit write — decouples sync SQLite I/O
      // from the emit chain. getAuditQueue() is always safe here because
      // initAuditQueue(sqlite) is called in index.ts before wireReactorEvents.
      getAuditQueue().enqueue({
        user_id: 'system',
        action: 'branch_evaluated',
        target_type: 'branch',
        target_id: data?.node_id ?? 'unknown',
        target_kind: 'node_id',
        batch_id: ctrl.currentBatchId || undefined,
        new_value: JSON.stringify({
          expression: data?.expression,
          result: data?.result,
          skipped: data?.skipped,
          pv_snapshot: data?.pv_snapshot,
        }),
      });
    });

    // B1.2: loop_entered 审计/广播桥 — 循环开始 (frame pushed)
    // 严格平行 branch_evaluated; try/catch wrap per v1.7.1 listener-hardening
    // pattern so audit/queue/broadcast errors cannot crash the controller.
    ctrl.on('loop_entered', (data: any) => {
      try {
        const batchId = data?.batch_id ?? ctrl.currentBatchId;
        broadcast('loop_entered', {
          reactor_id: reactorId,
          type: 'loop_entered',
          payload_version: 2,
          batch_id: batchId,
          node_id: data?.node_id ?? null,
          iteration: data?.iteration ?? 0,
          maxIterations: data?.maxIterations,
          exitExpression: data?.exitExpression,
          pv_snapshot: data?.pv_snapshot,
        }, batchId, reactorId);
        getAuditQueue().enqueue({
          user_id: 'system',
          action: 'loop_entered',
          target_type: 'loop',
          target_id: data?.node_id ?? 'unknown',
          target_kind: 'node_id',
          batch_id: batchId || undefined,
          new_value: JSON.stringify({
            iteration: data?.iteration ?? 0,
            maxIterations: data?.maxIterations,
            exitExpression: data?.exitExpression,
            pv_snapshot: data?.pv_snapshot,
          }),
        });
      } catch (err) {
        console.warn('[reactor-wiring] loop_entered listener error:', (err as Error).message);
      }
    });

    // B1.2: loop_iterated — 循环每迭代一轮 (iteration 自增)
    ctrl.on('loop_iterated', (data: any) => {
      try {
        const batchId = data?.batch_id ?? ctrl.currentBatchId;
        broadcast('loop_iterated', {
          reactor_id: reactorId,
          type: 'loop_iterated',
          payload_version: 2,
          batch_id: batchId,
          node_id: data?.node_id ?? null,
          iteration: data?.iteration ?? 0,
          maxIterations: data?.maxIterations,
          exitExpression: data?.exitExpression,
          pv_snapshot: data?.pv_snapshot,
        }, batchId, reactorId);
        getAuditQueue().enqueue({
          user_id: 'system',
          action: 'loop_iterated',
          target_type: 'loop',
          target_id: data?.node_id ?? 'unknown',
          target_kind: 'node_id',
          batch_id: batchId || undefined,
          new_value: JSON.stringify({
            iteration: data?.iteration ?? 0,
            maxIterations: data?.maxIterations,
            exitExpression: data?.exitExpression,
            pv_snapshot: data?.pv_snapshot,
          }),
        });
      } catch (err) {
        console.warn('[reactor-wiring] loop_iterated listener error:', (err as Error).message);
      }
    });

    // B1.2: loop_exited — 循环结束 (frame popped); payload 含 final_iteration
    ctrl.on('loop_exited', (data: any) => {
      try {
        const batchId = data?.batch_id ?? ctrl.currentBatchId;
        broadcast('loop_exited', {
          reactor_id: reactorId,
          type: 'loop_exited',
          payload_version: 2,
          batch_id: batchId,
          node_id: data?.node_id ?? null,
          final_iteration: data?.final_iteration ?? 0,
          pv_snapshot: data?.pv_snapshot,
        }, batchId, reactorId);
        getAuditQueue().enqueue({
          user_id: 'system',
          action: 'loop_exited',
          target_type: 'loop',
          target_id: data?.node_id ?? 'unknown',
          target_kind: 'node_id',
          batch_id: batchId || undefined,
          new_value: JSON.stringify({
            final_iteration: data?.final_iteration ?? 0,
            pv_snapshot: data?.pv_snapshot,
          }),
        });
      } catch (err) {
        console.warn('[reactor-wiring] loop_exited listener error:', (err as Error).message);
      }
    });

    // Step完成
    ctrl.on('step_completed', (log: any) => {
      broadcast('step_progress', { reactor_id: reactorId, event: 'step_completed', ...log }, null, reactorId);
    });

    // 报警广播
    ctrl.on('alarm', (data: any) => {
      broadcast('alarm', { reactor_id: reactorId, ...data }, data?.batch_id, reactorId);
      // 同时写入数据库
      try {
        sqlite.createAlarm({
          batch_id: data.batch_id,
          alarm_code: data.alarm_code || data.code || 'UNKNOWN',
          severity: data.severity || 'warning',
          source: data.source || 'node:batch-engine',
          message: data.message || '',
        });
      } catch { /* ignore */ }
    });

    // 批次完成/停止
    ctrl.on('batch_completed', (data: any) => {
      broadcast('state_update', { reactor_id: reactorId, event: 'batch_completed', ...data }, data?.batch_id, reactorId);
      // v1.7.2: 包 try/catch — 见 state_changed 同源原因
      if (data?.batch_id) {
        try { clearCusumDetectors(data.batch_id); }
        catch (e) { console.warn(`[CUSUM] 清理 ${data.batch_id} 检测器失败:`, (e as Error).message); }
      }
      // KPI + SPC 自动计算 (参考 DELMIA Apriso MPI)
      if (data?.batch_id) {
        try {
          computeKpi(sqlite.getDatabase(), data.batch_id);
          console.log(`[KPI] 批次 ${data.batch_id} KPI 已自动计算`);
        } catch (e) { console.warn(`[KPI] 自动计算失败:`, (e as Error).message); }
        // DOE 自动响应收集: 检查该批次是否关联了 DOE run
        try {
          const db = sqlite.getDatabase();
          const doeRun: any = db.prepare('SELECT study_id, run_index FROM doe_runs WHERE batch_id = ? AND status = ?').get(data.batch_id, 'running');
          if (doeRun) {
            const responses = autoCollectDoeResponses(db, doeRun.study_id, doeRun.run_index);
            if (responses && Object.keys(responses).length > 0) {
              sqlite.setDoeRunResponse(doeRun.study_id, doeRun.run_index, responses);
              console.log(`[DOE] 批次 ${data.batch_id} → 研究 ${doeRun.study_id} Run#${doeRun.run_index} 响应已自动收集:`, responses);
              // 检查研究是否全部完成
              const runs = sqlite.listDoeRuns(doeRun.study_id);
              if (runs.length > 0 && runs.every(r => r.status === 'completed')) {
                sqlite.updateDoeStudyStatus(doeRun.study_id, 'completed');
              }
            }
          }
        } catch (e) { console.warn(`[DOE] 自动响应收集失败:`, (e as Error).message); }
      }
    });
    ctrl.on('batch_stopped', (data: any) => {
      broadcast('state_update', { reactor_id: reactorId, event: 'batch_stopped', ...data }, null, reactorId);
      // v1.7.2: 包 try/catch — 见 state_changed 同源原因
      if (data?.batch_id) {
        try { clearCusumDetectors(data.batch_id); }
        catch (e) { console.warn(`[CUSUM] 清理 ${data.batch_id} 检测器失败:`, (e as Error).message); }
      }
    });
  }

  return { startReactorCollector, stopReactorCollector, wireReactorEvents };
}
