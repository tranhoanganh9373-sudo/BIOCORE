// ============================================================
// 实时数据 Store (Zustand + WebSocket)
// 管理所有WebSocket频道推送的实时数据
// ============================================================

import { create } from 'zustand';
import type {
  ProcessValues,
  StateUpdatePayload,
  CalculatedParams,
  Alarm,
  WSMessage,
  BatchRuntimeState,
  BranchEvaluationEntry,
} from '@/types';
import type { TagQuality } from '@/hooks/useTag';

interface HeartbeatStatus {
  pc: number;
  alive: boolean;
  /** Server stamps each heartbeat with its PLC connection id (== reactor.id by convention). */
  connection_id?: string;
}

interface StepProgress {
  stepNumber: number;
  progress: number;
  stepName: string;
}

interface AiSuggestion {
  id: number | string;
  type?: string;
  message?: string;
  parameter?: string;
  current_value?: number;
  suggested_value?: number | null;
  confidence?: number;
  timestamp?: string;
  // SCADA display fields (sub-project 6)
  action?: string;
  source?: string;
  source_module?: string;
  target_param?: string;
}

interface SoftSensorData {
  timestamp: string;
  biomass?: number;
  substrate?: number;
  product?: number;
  [key: string]: any;
}

interface ReactorRecipe {
  recipe_id: string;
  recipe_name: string;
  version: string;
  phases: any[];
  execution_mode: 'free' | 'sequential';
  downloaded_at: string;
}

// 多反应器隔离: 单反应器完整运行时数据
export interface ReactorRuntimeData {
  processValues: ProcessValues | null;
  stateUpdate: StateUpdatePayload | null;
  calculatedParams: CalculatedParams | null;
  alarms: Alarm[];
  cusumAlerts: Array<{ channel: string; deviation: number; alarming: boolean; cumPos: number; cumNeg: number }>;
  cusumHistory: Record<string, Array<{ t: number; cumPos: number; cumNeg: number; deviation: number }>>;
  softSensorData: SoftSensorData | null;
  trendBuffer: {
    timestamps: string[];
    temperature: number[];
    pH: number[];
    DO: number[];
    rpm: number[];
    airflow: number[];
  };
  /**
   * P3+: PLC tag quality 三态映射 (keyed by PLC tag name, e.g. 'TEMP_PV').
   * 由 `pv_realtime` payload 的 `quality` 嵌套对象注入. 可选 — legacy server
   * (P3 前) 或字段不在 broadcaster 映射表里则缺省.
   */
  qualityMap?: Record<string, TagQuality>;
}

const EMPTY_REACTOR_DATA: ReactorRuntimeData = {
  processValues: null,
  stateUpdate: null,
  calculatedParams: null,
  alarms: [],
  cusumAlerts: [],
  cusumHistory: {},
  softSensorData: null,
  trendBuffer: { timestamps: [], temperature: [], pH: [], DO: [], rpm: [], airflow: [] },
};

interface RealtimeState {
  // 连接状态
  wsConnected: boolean;
  // 全局 1Hz tick — hook 用来周期性重判 staleness (即使 WS 断, store 不再 set, hook 仍能 re-eval)
  _tick: number;

  // 各频道数据
  processValues: ProcessValues | null;
  stateUpdate: StateUpdatePayload | null;
  calculatedParams: CalculatedParams | null;
  alarms: Alarm[];
  cusumAlerts: Array<{ channel: string; deviation: number; alarming: boolean; cumPos: number; cumNeg: number }>;

  // CUSUM 累积和历史缓冲 (最近 300 个采样点, 用于趋势图)
  cusumHistory: Record<string, Array<{ t: number; cumPos: number; cumNeg: number; deviation: number }>>;

  // 新增频道数据
  heartbeatStatus: HeartbeatStatus | null;
  // Per-reactor heartbeat keyed by PLC connection_id (== reactor.id by convention).
  // Falls back to heartbeatStatus when payload lacks connection_id (legacy server).
  heartbeatByReactor: Record<string, HeartbeatStatus>;
  stepProgress: StepProgress | null;
  aiSuggestions: AiSuggestion[];
  softSensorData: SoftSensorData | null;

  // 多反应器: per-reactor 状态映射 (替代 setInterval 轮询)
  reactorStates: Record<string, StateUpdatePayload>;
  reactorRecipes: Record<string, ReactorRecipe | null>;
  // 多反应器隔离: 各反应器完整运行时数据 (PV/计算/报警/趋势/CUSUM/软测量)
  reactorData: Record<string, ReactorRuntimeData>;

  // 趋势数据缓冲 (最近60分钟, 用于Dashboard趋势图)
  trendBuffer: {
    timestamps: string[];
    temperature: number[];
    pH: number[];
    DO: number[];
    rpm: number[];
    airflow: number[];
  };

  // T18: per-batch DAG runtime state (keyed by batch_id)
  batchRuntime: Record<string, BatchRuntimeState>;
  // T18: ring buffer of recent branch evaluation events (capped at 50)
  recentBranchEvaluations: BranchEvaluationEntry[];

  // sub-project 4: SCADA view 协同保存 tick (其他用户保存 / 删除时通知)
  _scadaViewSavedTick: { view_id: string; updated_at: string } | null;

  // Actions
  connect: (url?: string) => void;
  disconnect: () => void;
  addAlarm: (alarm: Alarm) => void;
  acknowledgeAlarm: (id: string) => void;
  setReactorState: (reactorId: string, state: StateUpdatePayload) => void;
  setReactorRecipe: (reactorId: string, recipe: ReactorRecipe | null) => void;
  setAlarms: (alarms: Alarm[]) => void;
}

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let intentionalDisconnect = false;

// P0 修复: WebSocket 重连指数退避 (1s → 2s → 4s → ... → 30s 上限) + 最大尝试 20 次
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 20;
const MAX_RECONNECT_DELAY_MS = 30000;

export const useRealtimeStore = create<RealtimeState>((set, get) => ({
  wsConnected: false,
  _tick: 0,
  processValues: null,
  stateUpdate: null,
  calculatedParams: null,
  alarms: [],
  cusumAlerts: [],
  cusumHistory: {},
  heartbeatStatus: null,
  heartbeatByReactor: {},
  stepProgress: null,
  aiSuggestions: [],
  softSensorData: null,
  reactorStates: {},
  reactorRecipes: {},
  reactorData: {},
  trendBuffer: { timestamps: [], temperature: [], pH: [], DO: [], rpm: [], airflow: [] },
  batchRuntime: {},
  recentBranchEvaluations: [],
  _scadaViewSavedTick: null,

  connect: (baseUrl = 'ws://localhost:3001/ws') => {
    if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;

    intentionalDisconnect = false;
    // 鉴权: 从 localStorage 读 JWT token, 拼接到 URL query string
    // 后端会在 connection handler 中验证, 失败 close(1008)
    const token = typeof window !== 'undefined' ? localStorage.getItem('biocore_token') : null;
    const url = token ? `${baseUrl}?token=${encodeURIComponent(token)}` : baseUrl;
    ws = new WebSocket(url);

    ws.onopen = () => {
      set({ wsConnected: true });
      reconnectAttempts = 0; // P0 修复: 连接成功后重置重试计数
      console.log('[WS] Connected to BIOCore server');
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    };

    ws.onmessage = (event) => {
      let msg: WSMessage;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        console.error('[WS] Failed to parse message:', e);
        return;
      }

      // 多反应器隔离 helper: 把 partial 合并到 reactorData[rid]
      // rid 缺失时退化为只更新顶层字段 (legacy 兼容)
      const updateReactor = (rid: string | null | undefined, patch: Partial<ReactorRuntimeData>) => {
        if (!rid) return;
        set((s) => {
          const prev = s.reactorData[rid] || EMPTY_REACTOR_DATA;
          return {
            reactorData: { ...s.reactorData, [rid]: { ...prev, ...patch } },
          };
        });
      };

      switch (msg.channel) {
        case 'pv_realtime': {
          // 追加到趋势缓冲 (single set() call)
          // T13 风险 #5 缓解：环形缓冲上限 3600 = 60min × 1Hz, 防止 24h dashboard 视图无限增长。
          const buf = get().trendBuffer;
          const MAX_POINTS = 3600;
          const pv = msg.payload as ProcessValues;
          // SP-PLC-3 P3+: broadcaster 在 payload 加 `quality` 嵌套对象 (Record<plcTag,
          // 'good'|'bad'|'uncertain'>). 透传到 reactorData.qualityMap 让 useTag 暴露
          // 给 widget — 通讯断时 quality='bad' 但 value 保留 last-known-good, widget
          // 可视觉提示 (灰色/划线/红框) 而非把 bad 值当 good 显示. legacy server (P3 前)
          // payload 无 `quality`, qualityMap undefined, 旧消费者不破.
          const qualityMap = (msg.payload as any).quality as
            | Record<string, TagQuality>
            | undefined;
          const nextTrend = {
            timestamps: [...buf.timestamps, msg.timestamp].slice(-MAX_POINTS),
            temperature: [...buf.temperature, msg.payload['AI-0'] ?? 0].slice(-MAX_POINTS),
            pH: [...buf.pH, msg.payload['AI-2'] ?? 0].slice(-MAX_POINTS),
            DO: [...buf.DO, msg.payload['AI-3'] ?? 0].slice(-MAX_POINTS),
            rpm: [...buf.rpm, msg.payload.rpm ?? 0].slice(-MAX_POINTS),
            airflow: [...buf.airflow, msg.payload['AI-5'] ?? 0].slice(-MAX_POINTS),
          };
          // legacy 顶层 (单反应器组件仍用) — quality 不进顶层 state slot, 仅进 reactorData.
          set({ processValues: pv, trendBuffer: nextTrend });
          // 反应器隔离写入 (含 qualityMap)
          const rid = msg.reactor_id;
          if (rid) {
            const prevReactor = get().reactorData[rid] || EMPTY_REACTOR_DATA;
            const reactorTrend = prevReactor.trendBuffer;
            updateReactor(rid, {
              processValues: pv,
              qualityMap,
              trendBuffer: {
                timestamps: [...reactorTrend.timestamps, msg.timestamp].slice(-MAX_POINTS),
                temperature: [...reactorTrend.temperature, msg.payload['AI-0'] ?? 0].slice(-MAX_POINTS),
                pH: [...reactorTrend.pH, msg.payload['AI-2'] ?? 0].slice(-MAX_POINTS),
                DO: [...reactorTrend.DO, msg.payload['AI-3'] ?? 0].slice(-MAX_POINTS),
                rpm: [...reactorTrend.rpm, msg.payload.rpm ?? 0].slice(-MAX_POINTS),
                airflow: [...reactorTrend.airflow, msg.payload['AI-5'] ?? 0].slice(-MAX_POINTS),
              },
            });
          }
          break;
        }

        case 'state_update': {
          const payload = msg.payload as StateUpdatePayload & { reactor_id?: string };
          // 旧字段保留用于全局组件 (TopBar 状态徽章)
          set({ stateUpdate: payload });
          const rid = payload.reactor_id || msg.reactor_id;
          if (rid) {
            set((s) => ({ reactorStates: { ...s.reactorStates, [rid]: payload } }));
            updateReactor(rid, { stateUpdate: payload });
          }
          break;
        }

        case 'recipe_downloaded': {
          const payload = msg.payload as any;
          const rid = payload.reactor_id || msg.reactor_id;
          if (rid) {
            set((s) => ({
              reactorRecipes: {
                ...s.reactorRecipes,
                [rid]: {
                  recipe_id: payload.recipe_id,
                  recipe_name: payload.recipe_name,
                  version: payload.version,
                  phases: payload.phases || [],
                  execution_mode: payload.execution_mode || 'free',
                  downloaded_at: payload.downloaded_at,
                },
              },
            }));
          }
          break;
        }

        case 'calculated': {
          const calc = msg.payload as CalculatedParams;
          set({ calculatedParams: calc });
          updateReactor(msg.reactor_id, { calculatedParams: calc });
          break;
        }

        case 'alarm': {
          const alarm = msg.payload as Alarm;
          set((s) => ({ alarms: [alarm, ...s.alarms].slice(0, 100) }));
          const rid = msg.reactor_id;
          if (rid) {
            const prev = get().reactorData[rid] || EMPTY_REACTOR_DATA;
            updateReactor(rid, { alarms: [alarm, ...prev.alarms].slice(0, 100) });
          }
          break;
        }

        case 'cusum': {
          const alerts = msg.payload as Array<{
            channel: string; deviation: number; alarming: boolean;
            cumPos: number; cumNeg: number;
          }>;
          const now = Date.now();
          const MAX_CUSUM_POINTS = 300;
          const prevHistory = get().cusumHistory;
          const nextHistory = { ...prevHistory };
          for (const a of alerts) {
            const arr = nextHistory[a.channel] || [];
            nextHistory[a.channel] = [
              ...arr, { t: now, cumPos: a.cumPos, cumNeg: a.cumNeg, deviation: a.deviation },
            ].slice(-MAX_CUSUM_POINTS);
          }
          set({ cusumAlerts: alerts, cusumHistory: nextHistory });
          // 反应器隔离: 维护各反应器的 cusumHistory
          const rid = msg.reactor_id;
          if (rid) {
            const prev = get().reactorData[rid] || EMPTY_REACTOR_DATA;
            const rHist = { ...prev.cusumHistory };
            for (const a of alerts) {
              const arr = rHist[a.channel] || [];
              rHist[a.channel] = [
                ...arr, { t: now, cumPos: a.cumPos, cumNeg: a.cumNeg, deviation: a.deviation },
              ].slice(-MAX_CUSUM_POINTS);
            }
            updateReactor(rid, { cusumAlerts: alerts, cusumHistory: rHist });
          }
          break;
        }

        case 'heartbeat': {
          const hb = msg.payload as HeartbeatStatus;
          set((s) => ({
            heartbeatStatus: hb,
            heartbeatByReactor: hb.connection_id
              ? { ...s.heartbeatByReactor, [hb.connection_id]: hb }
              : s.heartbeatByReactor,
          }));
          break;
        }

        case 'step_progress': {
          const payload = msg.payload as Record<string, any>;
          const eventType: string | undefined = payload.type;

          if (eventType === 'phase_started' || eventType === 'phase_completed') {
            const isV2 = payload.payload_version === 2;
            const nodeId: string | null = isV2 ? (payload.node_id ?? null) : null;
            const batchId: string = payload.batch_id ?? msg.batch_id ?? '';
            set((s) => ({
              batchRuntime: {
                ...s.batchRuntime,
                [batchId]: {
                  batch_id: batchId,
                  node_id: nodeId,
                  phase_id: payload.phase_id ?? '',
                  phase_type: payload.phase_type,
                  last_event: eventType,
                },
              },
            }));
          } else if (eventType === 'branch_evaluated') {
            const batchId: string = payload.batch_id ?? msg.batch_id ?? '';
            set((s) => ({
              recentBranchEvaluations: [
                {
                  ts: new Date().toISOString(),
                  batch_id: batchId,
                  node_id: payload.node_id ?? null,
                  expression: payload.expression ?? '',
                  result: Boolean(payload.result),
                  skipped: Boolean(payload.skipped),
                  pv_snapshot: payload.pv_snapshot,
                },
                ...(s.recentBranchEvaluations ?? []),
              ].slice(0, 50),
            }));
          } else {
            // Legacy / unknown step_progress shape — keep old behaviour
            set({ stepProgress: payload as StepProgress });
          }
          break;
        }

        case 'ai_suggestion':
          const suggestion = msg.payload as AiSuggestion;
          set((s) => ({ aiSuggestions: [suggestion, ...s.aiSuggestions].slice(0, 50) }));
          break;

        case 'scada:view:saved':
          set({
            _scadaViewSavedTick: {
              view_id: msg.payload.view_id,
              updated_at: msg.payload.updated_at,
            },
          });
          break;

        case 'scada:view:deleted':
          set({
            _scadaViewSavedTick: {
              view_id: msg.payload.view_id,
              updated_at: 'deleted',
            },
          });
          break;

        case 'soft_sensor': {
          const ss = msg.payload as SoftSensorData;
          set({ softSensorData: ss });
          updateReactor(msg.reactor_id, { softSensorData: ss });
          break;
        }
      }
    };

    ws.onclose = (ev) => {
      set({ wsConnected: false });
      if (intentionalDisconnect) {
        console.log('[WS] Disconnected intentionally');
        return;
      }
      // close code 1008 = Unauthorized (鉴权失败), 不重连, 触发 apiFetch 401 跳 /login
      if (ev.code === 1008) {
        console.warn('[WS] Close 1008 Unauthorized, stop reconnecting');
        intentionalDisconnect = true;
        if (typeof window !== 'undefined') {
          localStorage.removeItem('biocore_token');
          localStorage.removeItem('biocore_user');
          if (!window.location.pathname.startsWith('/login')) {
            window.location.href = '/login';
          }
        }
        return;
      }
      // 重连上限
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error(`[WS] 重连达上限 ${MAX_RECONNECT_ATTEMPTS} 次, 停止重连. 请手动刷新页面`);
        return;
      }
      // 指数退避: 1s, 2s, 4s, 8s, 16s, 30s (封顶)
      const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * Math.pow(2, reconnectAttempts));
      reconnectAttempts++;
      console.log(`[WS] ${delay}ms 后重连 (尝试 ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
      reconnectTimer = setTimeout(() => get().connect(baseUrl), delay);
    };

    ws.onerror = (err) => {
      console.error('[WS] Error:', err);
    };
  },

  disconnect: () => {
    intentionalDisconnect = true;
    reconnectAttempts = 0;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    ws?.close();
    ws = null;
    set({ wsConnected: false });
  },

  addAlarm: (alarm) => set((s) => ({ alarms: [alarm, ...s.alarms].slice(0, 100) })),

  acknowledgeAlarm: (id) => set((s) => ({
    alarms: s.alarms.map(a => a.id === id ? { ...a, acknowledged: true, acknowledged_at: new Date().toISOString() } : a),
  })),

  setReactorState: (reactorId, state) => set((s) => ({
    reactorStates: { ...s.reactorStates, [reactorId]: state },
  })),

  setReactorRecipe: (reactorId, recipe) => set((s) => ({
    reactorRecipes: { ...s.reactorRecipes, [reactorId]: recipe },
  })),

  setAlarms: (alarms) => set({ alarms: alarms.slice(0, 100) }),
}));

// SP-FX-2: minimal send hook for tag-binding writeTag. Keeps the WS singleton
// invariant intact — callers do not hold their own WebSocket reference.
export function sendWsMessage(msg: object): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('sendWsMessage: WebSocket not connected');
  }
  ws.send(JSON.stringify(msg));
}

// SP-FX-2: test-only hooks. Not used in production.
export const __testHooks = {
  __resetWsForTests(): void { ws = null; },
  __bindWsForTests(fakeWs: WebSocket): void { ws = fakeWs; },
};
