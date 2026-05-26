// ============================================================
// Dashboard 页面 -- MES风格操作员主屏幕
// 左侧: 控制面板
// 右侧: 大字参数卡片 → 实时趋势 → 报警信息
// 底部: 软件测算值横条
// ============================================================

'use client';

import React, { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { useRealtimeStore } from '@/stores/realtime-store';
import { createTrendBuffer } from '@/stores/realtime-store';
import dynamic from 'next/dynamic';
import { ControlPanel } from '@/components/dashboard/ControlPanel';
import { TrendChartGroup } from '@/components/dashboard/TrendChartGroup';
import { EventCenter } from '@/components/dashboard/EventCenter';
import { isNotice } from '@/components/dashboard/NoticeBanner';
import { CalculatedParamsBar } from '@/components/dashboard/CalculatedParamsBar';
import { CusumAlertPanel } from '@/components/dashboard/CusumAlertPanel';
import { FeedAdvisorCard } from '@/components/dashboard/FeedAdvisorCard';
import { Server, Plus, Settings } from 'lucide-react';
import { loadDashboardLayout } from '@/components/dashboard/dashboard-layout-config';
import type { DashboardLayout } from '@/components/dashboard/dashboard-layout-config';
import { useLocale } from '@/i18n/useLocale';

// @dnd-kit 较重, 仅在用户打开布局编辑器时才加载
const DashboardLayoutEditor = dynamic(
  () => import('@/components/dashboard/DashboardLayoutEditor').then(m => ({ default: m.DashboardLayoutEditor })),
  { ssr: false },
);

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

interface ReactorInfo {
  id: string;
  state: string;
  batchId: string;
}

function getReactorLedClass(state: string): string {
  switch (state) {
    case 'running': return 'status-led-running';
    case 'held': return 'status-led-held';
    case 'paused': return 'status-led-paused';
    case 'stopped': return 'status-led-stopped';
    case 'complete': return 'status-led-complete';
    default: return 'status-led-idle';
  }
}

function getStateLabel(state: string, t: (key: string) => string): string {
  switch (state) {
    case 'running': return t('dashboard.state.running');
    case 'held': return t('dashboard.state.held');
    case 'paused': return t('dashboard.state.paused');
    case 'stopped': return t('dashboard.state.stopped');
    case 'complete': return t('dashboard.state.complete');
    default: return t('dashboard.state.idle');
  }
}

// ─── 大字参数卡片 ───────────────────────────────────────────

interface BigParamCardProps {
  label: string;
  value: number | null;
  unit: string;
  sv?: number;
  precision?: number;
  color?: string; // accent color for the value
}

function BigParamCard({ label, value, unit, sv, precision = 1, color = 'text-foreground' }: BigParamCardProps) {
  const displayVal = value !== null && value !== undefined ? value.toFixed(precision) : '--';

  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 flex flex-col justify-between min-h-[87px] flex-1 min-w-[120px]">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="flex items-baseline gap-1.5 mt-0.5">
        <span className={`text-3xl font-bold font-mono tracking-tight ${color}`}>{displayVal}</span>
        <span className="text-sm text-muted-foreground">{unit}</span>
      </div>
      {sv !== undefined && (
        <div className="mt-1">
          <span className="text-sm font-mono font-semibold px-2 py-0.5 rounded bg-primary/15 text-primary">
            SP: {sv}
          </span>
        </div>
      )}
    </div>
  );
}

// ─── 主页面 ────────────────────────────────────────────────

export default function DashboardPage() {
  const { t } = useLocale();
  const [selectedReactor, setSelectedReactor] = useState('');
  // 多反应器隔离: 按 selectedReactor 从 reactorData[id] 取数据
  // selectedReactor 缺失时退化为顶层 (启动期未拉到 reactor 列表前)
  const reactorData = useRealtimeStore(s => s.reactorData);
  const reactorStates = useRealtimeStore(s => s.reactorStates);
  const _topProcessValues = useRealtimeStore(s => s.processValues);
  const _topStateUpdate = useRealtimeStore(s => s.stateUpdate);
  const _topCalculatedParams = useRealtimeStore(s => s.calculatedParams);
  const _topAlarms = useRealtimeStore(s => s.alarms);
  const _topTrendBuffer = useRealtimeStore(s => s.trendBuffer);
  const _rd = selectedReactor ? reactorData[selectedReactor] : null;
  // 反应器隔离: selectedReactor 选定时只用其独立数据, 不 fallback 顶层
  // (避免 F01 running 的 PV 渗透到 F02 idle 视图)
  const _reactorState = selectedReactor ? reactorStates[selectedReactor] : null;
  const _isReactorActive = !!_reactorState && _reactorState.state !== 'idle' && _reactorState.state !== 'stopped';
  // PV/计算参数/趋势只在该反应器活跃时显示, 否则 null (UI 显 '--')
  const processValues = selectedReactor
    ? (_isReactorActive ? (_rd?.processValues ?? null) : null)
    : _topProcessValues;
  const stateUpdate = _rd?.stateUpdate ?? (selectedReactor ? null : _topStateUpdate);
  const calculatedParams = selectedReactor
    ? (_isReactorActive ? (_rd?.calculatedParams ?? null) : null)
    : _topCalculatedParams;
  const alarms = _rd?.alarms ?? (selectedReactor ? [] : _topAlarms);
  // SP-PLC-3 Patch B: trendBuffer 现是 RingBuffer 实例 wrapper.
  // idle 反应器仍要 "无数据" 占位 — 用 useMemo 锁住一个空 buffer 实例
  // (mount 一次, 之后不重 alloc), 避免每 render 都 new 一组 RingBuffer.
  // 注意: 这是占位 read-only 实例, 上层 dashboard 只读不 push.
  const _emptyTrend = useMemo(() => createTrendBuffer(), []);
  const trendBuffer = selectedReactor
    ? (_isReactorActive ? (_rd?.trendBuffer ?? _topTrendBuffer) : _emptyTrend)
    : _topTrendBuffer;
  const [configuredIds, setConfiguredIds] = useState<string[]>([]);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [layoutEditorOpen, setLayoutEditorOpen] = useState(false);
  const [dashLayout, setDashLayout] = useState<DashboardLayout>(() => loadDashboardLayout());

  // 一次性加载设备列表 (设备配置很少变, 不需要轮询)
  useEffect(() => {
    fetch(`${API}/api/reactor-configs`)
      .then(r => r.ok ? r.json() : [])
      .then((configs: { reactor_id: string; enabled: number }[]) => {
        const ids = configs.filter(c => c.enabled).map(c => c.reactor_id);
        setConfiguredIds(ids);
        setSelectedReactor(prev => (prev && ids.includes(prev)) ? prev : (ids[0] || ''));
        setConfigLoaded(true);
      })
      .catch(() => setConfigLoaded(true));
  }, []);

  // 派生 reactor list (运行时 state 来自 WS reactorStates map)
  const reactorList: ReactorInfo[] = configuredIds.map(id => {
    const ws = reactorStates[id];
    return {
      id,
      state: (ws?.state as string) || 'idle',
      batchId: (ws as any)?.batch_id || '',
    };
  });

  // 尚未配置设备 → 引导
  if (configLoaded && reactorList.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center max-w-md">
          <div className="w-16 h-16 rounded-full bg-muted/50 flex items-center justify-center mx-auto mb-5">
            <Server className="w-8 h-8 text-muted-foreground/50" />
          </div>
          <h2 className="text-xl font-bold mb-2">{t('dashboard.no-reactor-title')}</h2>
          <p className="text-sm text-muted-foreground mb-6">
            {t('dashboard.no-reactor-desc')}
          </p>
          <Link href="/settings/device-config"
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-md bg-primary text-white text-sm font-medium hover:bg-primary/80 transition-colors">
            <Plus className="w-4 h-4" /> {t('dashboard.go-device-config')}
          </Link>
        </div>
      </div>
    );
  }

  // 从processValues中提取当前值
  const pv = processValues;
  const temp = pv?.['AI-0'] ?? null;
  const ph = pv?.['AI-2'] ?? null;
  const doVal = pv?.['AI-3'] ?? null;
  const rpm = pv?.rpm ?? null;
  const weight = pv?.['AI-6'] ?? null;
  const pressure = pv?.['AI-4'] ?? null;
  const airflow = pv?.['AI-5'] ?? null;
  const feedRate = pv?.P02_rate ?? null;

  return (
    <div className="h-full flex flex-col">
      {/* 反应器选择栏 */}
      <div className="flex items-center gap-2 px-4 py-1 border-b border-border bg-card/50">
        {reactorList.map(reactor => {
          const isSelected = selectedReactor === reactor.id;
          return (
            <button key={reactor.id} onClick={() => setSelectedReactor(reactor.id)}
              className={`flex items-center gap-2 px-4 py-1 rounded text-sm font-medium transition-all ${
                isSelected
                  ? 'bg-primary/15 text-primary border border-primary/40'
                  : 'bg-muted/50 text-muted-foreground border border-transparent hover:bg-muted hover:text-foreground'
              }`}>
              <div className={`status-led ${getReactorLedClass(reactor.state)}`} />
              <span className="font-mono font-semibold">{reactor.id}</span>
              <span className={`text-sm ${isSelected ? 'text-primary/70' : 'text-muted-foreground/70'}`}>
                {getStateLabel(reactor.state, t)}
              </span>
            </button>
          );
        })}
        {/* 布局自定义按钮 */}
        <div className="ml-auto">
          <button onClick={() => setLayoutEditorOpen(true)} title={t('dashboard.customize-layout')}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 主内容区 */}
      <div className="flex-1 flex gap-2 p-2 overflow-hidden">
        {/* 左: 控制面板 + 状态机连锁面板
            min-h-0 + overflow-y-scroll: 列可滚动
            内层 wrap 加 flex-shrink-0: panel 保持自然高度, 不被 flex 压缩 */}
        <div className="w-[360px] flex-shrink-0 flex flex-col min-h-0">
          <ControlPanel state={stateUpdate} reactorId={selectedReactor} />
        </div>

        {/* 右: 参数 + 趋势 + 报警 (计算参数横条固定置顶, 其余滚动) */}
        <div className="flex-1 flex flex-col min-h-0">

          {/* ⓪ 固定置顶区: 计算参数横条 + 大字参数卡片 (不随下方内容滚动) */}
          <div className="shrink-0 flex flex-col gap-4">
            {dashLayout.showCalculated && (
              <CalculatedParamsBar
                params={calculatedParams}
                airflow={_isReactorActive ? airflow : null}
                feedRate={_isReactorActive ? feedRate : null}
              />
            )}
            {/* ① 大字参数卡片 — 按布局配置动态渲染 */}
            <div className="flex flex-wrap gap-2">
              {dashLayout.bigParams.filter(p => p.visible).map(p => {
                const pvLookup: Record<string, number | null> = {
                  temperature: temp, pH: ph, DO: doVal,
                  rpm: rpm, weight: weight, pressure: pressure,
                };
                const precisionLookup: Record<string, number> = {
                  temperature: 1, pH: 2, DO: 1, rpm: 0, weight: 1, pressure: 2,
                };
                return (
                  <BigParamCard
                    key={p.key}
                    label={p.label}
                    value={pvLookup[p.key] ?? null}
                    unit={p.unit}
                    sv={p.sv}
                    precision={precisionLookup[p.key] ?? 1}
                  />
                );
              })}
            </div>
          </div>

          {/* 滚动区: 趋势 + 事件 + ... */}
          <div className="flex-1 flex flex-col gap-4 overflow-y-auto mes-scroll min-h-0 pt-4">

          {/* ② 次要参数行已并入顶部 CalculatedParamsBar (通气量 / 补料速率) */}

          {/* ③ 实时趋势图 (按布局配置显隐) */}
          {dashLayout.showTrends && (
          <TrendChartGroup
            // SP-PLC-3 Patch B: trendBuffer.* 现是 RingBuffer 实例, .toArray() 物化为
            // number[] (TrendChartGroup prop 类型不变, 完全兼容).
            // Follow-up: 高频 re-render 下可 useMemo 包裹 toArray() 调用 (本 Patch 不做).
            tempHistory={trendBuffer.temperature.toArray()}
            phHistory={trendBuffer.pH.toArray()}
            doHistory={trendBuffer.DO.toArray()}
            currentTemp={temp}
            currentPH={ph}
            currentDO={doVal}
          />
          )}

          {/* ④ 事件中心 — 报警 + 提示合并卡 (Tabs 切换, 限高内滚) */}
          {dashLayout.showAlarms && (() => {
            const acknowledgeFn = async (id: string) => {
              try {
                const res = await fetch(`${API}/api/alarms/${id}/acknowledge`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ user_id: 'admin-001' }),
                });
                if (res.ok) useRealtimeStore.getState().acknowledgeAlarm(id);
              } catch (err) { console.error('[Dashboard] Failed to acknowledge alarm:', err); }
            };
            const operAlarms = alarms.filter(a => !isNotice(a));
            const noticeAlarms = alarms.filter(a => isNotice(a));
            return <EventCenter alarms={operAlarms} notices={noticeAlarms} onAcknowledge={acknowledgeFn} />;
          })()}

          {/* ⑤ CUSUM 实时异常检测 */}
          <CusumAlertPanel batchId={reactorList.find(r => r.id === selectedReactor)?.batchId} reactorId={selectedReactor} />

          {/* ⑥ 补料建议 */}
          <FeedAdvisorCard batchId={reactorList.find(r => r.id === selectedReactor)?.batchId} />
          </div>
        </div>
      </div>

      {/* 计算参数横条已移到大字参数卡片上方 (右列顶部) */}

      {/* 布局编辑器弹窗 */}
      <DashboardLayoutEditor
        open={layoutEditorOpen}
        onClose={() => { setLayoutEditorOpen(false); setDashLayout(loadDashboardLayout()); }}
      />
    </div>
  );
}
