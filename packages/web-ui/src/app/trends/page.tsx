// Trends 页面 — 全屏趋势图查看器 (发酵监控)
// Sprint 2 重构:
//   M2.7: SVG → ECharts (已完成)
//   M2.1: LTTB 下采样 (后端 max_points 参数已启用)
//   M2.2: batch_id 过滤 (后端支持)
//   M2.3: 多反应器/多批次对比, 按发酵经过秒数对齐
'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Download, RefreshCw, CheckSquare, Square, Rows3, LineChart as LineChartIcon } from 'lucide-react';
import { apiFetch } from '@/lib/auth';
import { EChartsWrapper } from '@/components/charts/EChartsWrapperDynamic';
import { buildTrendOption, buildFacetedTrendOption, PARAM_LABELS, PARAM_UNITS } from '@/lib/echarts-helpers';
import type { TrendSeries } from '@/lib/echarts-helpers';
import { alignByElapsedSeconds, generateSeriesPalette } from '@/lib/trend-utils';
import { buildSampleScatterSeries, SAMPLE_ANALYTES } from '@/lib/sample-overlay';
import { useLocale } from '@/i18n/useLocale';

// 懒加载 CusumHistoryPanel — 它只在选定具体批次后才渲染,
// 静态 import 会让 /trends 首次访问拖额外的 chunk.
const CusumHistoryPanel = dynamic(
  () => import('@/components/trends/CusumHistoryPanel').then(m => ({ default: m.CusumHistoryPanel })),
  { ssr: false, loading: () => <div className="p-4 text-sm text-muted-foreground">CUSUM 历史加载中...</div> },
);

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

const PARAMS = [
  { key: 'temperature', label: '温度', unit: '°C', color: '#ef4444', on: true },
  { key: 'pH', label: 'pH', unit: '', color: '#a855f7', on: true },
  { key: 'DO', label: 'DO', unit: '%', color: '#22c55e', on: true },
  { key: 'rpm', label: '搅拌', unit: 'rpm', color: '#f97316', on: false },
  { key: 'airflow', label: '通气', unit: 'L/min', color: '#06b6d4', on: false },
  { key: 'pressure', label: '罐压', unit: 'bar', color: '#64748b', on: false },
  { key: 'jacket_temp', label: '夹套', unit: '°C', color: '#fb923c', on: false },
  { key: 'weight', label: '称重', unit: 'kg', color: '#eab308', on: false },
  { key: 'vfd_current', label: '变频电流', unit: 'A', color: '#ec4899', on: false },
] as const;
type PK = (typeof PARAMS)[number]['key'];

const RANGES = [
  { label: '1h', s: 3600 }, { label: '6h', s: 21600 }, { label: '12h', s: 43200 },
  { label: '24h', s: 86400 }, { label: '全程', s: 0 },
] as const;

// "不限定批次" 占位 (select value)
const NO_BATCH = '__all__';

interface ReactorOption { reactor_id: string; name: string; vessel_volume_L?: number; }
interface BatchOption { batch_id: string; started_at?: string | null; recipe_id?: string; current_state?: string; }

interface TrendDataRow {
  _time: string;
  [field: string]: any;
}

// 后端单次 fetch 结果
interface TrendFetchResult {
  reactor_id: string;
  batch_id: string | null;
  started_at: string | null; // 用于按经过秒对齐
  rows: TrendDataRow[];
  error?: string;
}

export default function TrendsPage() {
  const { t } = useLocale();
  const [active, setActive] = useState<Set<PK>>(() => new Set(PARAMS.filter(p => p.on).map(p => p.key)));
  const [ri, setRi] = useState(0);
  const [cFrom, setCFrom] = useState('');
  const [cTo, setCTo] = useState('');
  const [custom, setCustom] = useState(false);

  // M2.3: 多反应器 / 多批次状态
  const [reactors, setReactors] = useState<ReactorOption[]>([]);
  const [selectedReactors, setSelectedReactors] = useState<Set<string>>(new Set());
  // reactor_id → batch_id ("__all__" 表示不限定)
  const [selectedBatches, setSelectedBatches] = useState<Map<string, string>>(new Map());
  // reactor_id → BatchOption[] (异步加载的批次列表)
  const [batchesByReactor, setBatchesByReactor] = useState<Map<string, BatchOption[]>>(new Map());

  // 时序数据 (每个 reactor 一份)
  const [results, setResults] = useState<TrendFetchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [errMsg, setErrMsg] = useState<string>('');

  // 是否按发酵经过秒数对齐 (仅当至少 1 个反应器选了具体批次且有 started_at 时启用)
  const [alignElapsed, setAlignElapsed] = useState(true);

  // M2.3+: 单批次多参数对比趋势图 — 分面显示 (每个参数独立 subplot)
  // 默认关闭; 单反应器 + 具体批次 + 激活参数 >=2 时建议开启
  const [facetedMode, setFacetedMode] = useState(false);

  // 离线取样叠加显示
  const [showSamples, setShowSamples] = useState(false);
  const [sampleData, setSampleData] = useState<any[]>([]);

  // 加载反应器列表 + 默认选第一个
  useEffect(() => {
    apiFetch(`${API}/api/v1/reactor-configs`)
      .then(r => r.ok ? r.json() : [])
      .then((list: any[]) => {
        const enabled = (list || [])
          .filter(r => r.enabled)
          .map(r => ({ reactor_id: r.reactor_id, name: r.name, vessel_volume_L: r.vessel_volume_L }));
        setReactors(enabled);
        setSelectedReactors(prev => {
          if (prev.size > 0) return prev;
          return enabled.length > 0 ? new Set([enabled[0].reactor_id]) : new Set();
        });
      })
      .catch(() => { /* ignore */ });
  }, []);

  // 每次 selectedReactors 变化,把新加的反应器拉取批次列表 (首次)
  useEffect(() => {
    selectedReactors.forEach(rid => {
      if (batchesByReactor.has(rid)) return;
      apiFetch(`${API}/api/v1/batches?reactor_id=${encodeURIComponent(rid)}&limit=20`)
        .then(r => r.ok ? r.json() : [])
        .then((list: any) => {
          const arr = Array.isArray(list) ? list : list?.data ?? [];
          setBatchesByReactor(prev => {
            const next = new Map(prev);
            next.set(rid, arr.map((b: any) => ({
              batch_id: b.batch_id,
              started_at: b.started_at,
              recipe_id: b.recipe_id,
              current_state: b.current_state,
            })));
            return next;
          });
        })
        .catch(() => { /* ignore */ });
    });
  }, [selectedReactors, batchesByReactor]);

  // M2.3: 并行 fetcher — Promise.allSettled 多个 /api/v1/trends
  const loadHistory = useCallback(async () => {
    if (selectedReactors.size === 0) { setResults([]); return; }
    setLoading(true);
    setErrMsg('');
    const fields = ['temperature', 'jacket_temp', 'pH', 'DO', 'pressure', 'airflow', 'weight', 'rpm', 'vfd_current'];
    // "全程" (RANGES[4].s === 0) → 拉 7 天 (Flux 不支持 -0s)
    const rangeSec = RANGES[ri].s > 0 ? RANGES[ri].s : 7 * 86400;
    const start = `-${rangeSec}s`;
    const stop = 'now()';

    const tasks = [...selectedReactors].map(async (rid): Promise<TrendFetchResult> => {
      const bid = selectedBatches.get(rid);
      const useBatch = bid && bid !== NO_BATCH;
      const params = new URLSearchParams();
      params.set('reactor_id', rid);
      params.set('fields', fields.join(','));
      if (useBatch) {
        params.set('batch_id', bid!);
      } else {
        params.set('start', start);
        params.set('stop', stop);
      }
      params.set('max_points', '800');

      try {
        const r = await apiFetch(`${API}/api/v1/trends?${params.toString()}`);
        if (!r.ok) return { reactor_id: rid, batch_id: useBatch ? bid! : null, started_at: null, rows: [], error: `HTTP ${r.status}` };
        const resp = await r.json();
        const rows: TrendDataRow[] = resp?.data || [];

        // 如果选了具体批次, 再拉 batch.started_at 用于经过秒对齐
        let startedAt: string | null = null;
        if (useBatch) {
          try {
            const b = await apiFetch(`${API}/api/v1/batches/${encodeURIComponent(bid!)}`);
            if (b.ok) {
              const bd = await b.json();
              startedAt = bd?.started_at || null;
            }
          } catch { /* ignore */ }
        }

        return { reactor_id: rid, batch_id: useBatch ? bid! : null, started_at: startedAt, rows };
      } catch (e: any) {
        return { reactor_id: rid, batch_id: useBatch ? bid! : null, started_at: null, rows: [], error: e?.message || String(e) };
      }
    });

    const settled = await Promise.allSettled(tasks);
    const outcome: TrendFetchResult[] = settled.map((s, i) => {
      if (s.status === 'fulfilled') return s.value;
      const rid = [...selectedReactors][i];
      return { reactor_id: rid, batch_id: null, started_at: null, rows: [], error: s.reason?.message || '加载失败' };
    });
    setResults(outcome);
    const failed = outcome.filter(o => o.error);
    if (failed.length > 0) {
      setErrMsg(`${failed.length} 个反应器加载失败: ${failed.map(f => `${f.reactor_id} (${f.error})`).join(', ')}`);
    }
    setLoading(false);
  }, [selectedReactors, selectedBatches, ri]);

  // selectedReactors / batches / range 变化时自动重新查询
  useEffect(() => { loadHistory(); }, [loadHistory]);

  // 离线取样数据加载 — 仅当 showSamples=true 且至少一个反应器选了具体批次时触发
  useEffect(() => {
    if (!showSamples) { setSampleData([]); return; }
    const batchIds = [...selectedBatches.entries()]
      .filter(([rid, bid]) => bid && bid !== NO_BATCH && selectedReactors.has(rid))
      .map(([, bid]) => bid);
    if (batchIds.length === 0) { setSampleData([]); return; }
    // 并行拉取所有选中批次的离线取样
    Promise.all(
      batchIds.map(bid =>
        apiFetch(`${API}/api/v1/batches/${encodeURIComponent(bid)}/samples`)
          .then(r => r.ok ? r.json() : [])
          .then(d => (Array.isArray(d) ? d : d?.data ?? []))
          .catch(() => [])
      )
    ).then(arrays => setSampleData(arrays.flat()));
  }, [showSamples, selectedBatches, selectedReactors]);

  const toggleParam = (k: PK) => setActive(p => {
    const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n;
  });
  const toggleReactor = (rid: string) => setSelectedReactors(p => {
    const n = new Set(p); n.has(rid) ? n.delete(rid) : n.add(rid); return n;
  });

  // 自定义日期范围 client-side 过滤 (仅对绝对时间轴生效, 按经过秒对齐时无效)
  const filteredResults = useMemo(() => {
    if (!custom || !cFrom) return results;
    const fromMs = new Date(cFrom).getTime();
    const toMs = cTo ? new Date(cTo).getTime() : Infinity;
    return results.map(res => ({
      ...res,
      rows: res.rows.filter(r => {
        const t = new Date(r._time).getTime();
        return t >= fromMs && t <= toMs;
      }),
    }));
  }, [results, custom, cFrom, cTo]);

  // M2.3: 决定是否可以按经过秒对齐 (至少 1 个 result 有 started_at)
  const canAlign = useMemo(
    () => filteredResults.some(r => r.started_at),
    [filteredResults]
  );
  const shouldAlign = alignElapsed && canAlign;

  // 构建 ECharts series: 每个 (reactor, field) 组合 = 一条曲线
  const echartsOption = useMemo(() => {
    const activeParams = PARAMS.filter(p => active.has(p.key));
    const seriesList: TrendSeries[] = [];

    // 生成 reactor 调色板 (多反应器每个独立色相)
    const reactorPalette = generateSeriesPalette(Math.max(filteredResults.length, 1));
    const lineTypes: ('solid' | 'dashed' | 'dotted')[] = ['solid', 'dashed', 'dotted'];

    filteredResults.forEach((res, rIdx) => {
      if (res.rows.length === 0) return;
      const ro = reactors.find(r => r.reactor_id === res.reactor_id);
      const volumeStr = ro?.vessel_volume_L ? ` ${ro.vessel_volume_L}L` : '';
      // 批次标签: 截短 batch_id 到最后 5 字符
      const bidShort = res.batch_id ? res.batch_id.slice(-6) : '';
      const prefix = res.batch_id
        ? `${res.reactor_id}·${bidShort}${volumeStr}`
        : `${res.reactor_id}${volumeStr}`;
      const reactorColor = filteredResults.length > 1 ? reactorPalette[rIdx] : undefined;
      const reactorLineType = filteredResults.length > 1 ? lineTypes[rIdx % lineTypes.length] : 'solid';

      activeParams.forEach((p) => {
        const data = shouldAlign
          ? alignByElapsedSeconds(res.rows, p.key, res.started_at)
          : alignByElapsedSeconds(res.rows, p.key, null);
        // 跳过完全为空的序列 (所有 y 都是 null)
        if (data.every(([, y]) => y === null)) return;

        seriesList.push({
          id: `${res.reactor_id}-${res.batch_id || 'nobatch'}-${p.key}`,
          name: `${prefix} — ${PARAM_LABELS[p.key] || p.label}${PARAM_UNITS[p.key] ? ` (${PARAM_UNITS[p.key]})` : ''}`,
          field: p.key,
          color: reactorColor,
          lineType: reactorLineType,
          data: data as [number | string, number | null][],
        });
      });
    });

    // 离线取样 scatter 叠加 (在线条系列之上)
    if (showSamples && sampleData.length > 0) {
      // 使用第一个有 started_at 的 result 作为批次起始时间
      const firstStarted = filteredResults.find(r => r.started_at)?.started_at;
      const scatterSeries = buildSampleScatterSeries(
        sampleData,
        SAMPLE_ANALYTES.map(a => a.analyte),
        shouldAlign,
        firstStarted || undefined,
      );
      seriesList.push(...scatterSeries);
    }

    // 分面模式: 每个参数独立 subplot (适合单批次多参数对比)
    if (facetedMode && seriesList.length > 0) {
      return buildFacetedTrendOption(seriesList, {
        xAxisType: shouldAlign ? 'value' : 'time',
        dataZoom: true,
      });
    }

    return buildTrendOption(seriesList, {
      xAxisType: shouldAlign ? 'value' : 'time',
      dataZoom: true,
    });
  }, [filteredResults, active, reactors, shouldAlign, facetedMode, showSamples, sampleData]);

  // CSV 导出 (合并多 reactor 的数据为长表格式)
  const exportCSV = () => {
    if (filteredResults.every(r => r.rows.length === 0)) return;
    const ap = PARAMS.filter(p => active.has(p.key));
    const hdr = ['reactor_id', 'batch_id', '时间', ...ap.map(p => p.label)].join(',');
    const lines: string[] = [hdr];
    filteredResults.forEach(res => {
      res.rows.forEach(r => {
        lines.push([res.reactor_id, res.batch_id ?? '', r._time, ...ap.map(p => r[p.key] ?? '')].join(','));
      });
    });
    const csv = '\uFEFF' + lines.join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `trend_compare_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  const totalPoints = filteredResults.reduce((sum, r) => sum + r.rows.length, 0);
  const hasAnyData = filteredResults.some(r => r.rows.length > 0);

  return (
    <div className="h-full flex flex-col p-4 gap-3">
      {/* 工具栏 */}
      <Card>
        <CardContent className="p-3 flex flex-wrap items-start gap-3">
          {/* 反应器多选 */}
          <div className="flex flex-col gap-1">
            <span className="text-sm text-muted-foreground">反应器 (可多选)</span>
            <div className="flex flex-wrap gap-1 max-w-xl">
              {reactors.length === 0 && <span className="text-sm text-muted-foreground">(无设备)</span>}
              {reactors.map(r => {
                const on = selectedReactors.has(r.reactor_id);
                return (
                  <button
                    key={r.reactor_id}
                    onClick={() => toggleReactor(r.reactor_id)}
                    className={`flex items-center gap-1 h-8 px-2 rounded border text-sm transition ${on ? 'bg-primary/20 border-primary text-primary' : 'bg-card border-border text-muted-foreground hover:bg-muted'}`}
                  >
                    {on ? <CheckSquare className="w-3 h-3" /> : <Square className="w-3 h-3" />}
                    <span className="font-mono">{r.reactor_id}</span>
                    <span className="text-sm opacity-70">{r.vessel_volume_L ? `${r.vessel_volume_L}L` : ''}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="w-px h-10 bg-border" />

          {/* 每个 reactor 的批次选择 */}
          {selectedReactors.size > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-sm text-muted-foreground">每反应器的批次</span>
              <div className="flex flex-wrap gap-2">
                {[...selectedReactors].map(rid => {
                  const list = batchesByReactor.get(rid) || [];
                  const current = selectedBatches.get(rid) || NO_BATCH;
                  return (
                    <div key={rid} className="flex items-center gap-1">
                      <span className="text-sm text-muted-foreground font-mono">{rid}:</span>
                      <select value={current}
                        onChange={e => setSelectedBatches(prev => {
                          const next = new Map(prev);
                          next.set(rid, e.target.value);
                          return next;
                        })}
                        className="h-8 px-1.5 text-[12px] rounded border bg-card max-w-[160px]">
                        <option value={NO_BATCH}>不限定批次</option>
                        {list.map(b => (
                          <option key={b.batch_id} value={b.batch_id}>
                            {b.batch_id.length > 18 ? `...${b.batch_id.slice(-15)}` : b.batch_id}
                            {b.current_state ? ` [${b.current_state}]` : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex-1" />
          <Button size="sm" variant="outline" onClick={loadHistory} disabled={loading || selectedReactors.size === 0}>
            <RefreshCw className={`w-3.5 h-3.5 mr-1 ${loading ? 'animate-spin' : ''}`} />
            {loading ? '加载中' : '刷新'}
          </Button>
        </CardContent>
      </Card>

      {/* 第二行: 时间范围 + 对齐 + 参数 + CSV */}
      <Card>
        <CardContent className="p-3 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1">
            {RANGES.map((r, i) => (
              <Button key={r.label} size="sm" variant={!custom && ri === i ? 'default' : 'outline'}
                onClick={() => { setRi(i); setCustom(false); }}>{r.label}</Button>
            ))}
            <Button size="sm" variant={custom ? 'default' : 'outline'} onClick={() => setCustom(true)}>自定义</Button>
            {custom && (<>
              <Input type="datetime-local" value={cFrom} onChange={e => setCFrom(e.target.value)} className="h-9 w-44 text-sm" />
              <span className="text-muted-foreground text-sm">~</span>
              <Input type="datetime-local" value={cTo} onChange={e => setCTo(e.target.value)} className="h-9 w-44 text-sm" />
            </>)}
          </div>

          <div className="w-px h-6 bg-border" />

          {/* M2.3: 按发酵经过秒数对齐开关 */}
          <label className="flex items-center gap-1.5 cursor-pointer text-sm">
            <input
              type="checkbox"
              checked={shouldAlign}
              disabled={!canAlign}
              onChange={e => setAlignElapsed(e.target.checked)}
              className="cursor-pointer disabled:cursor-not-allowed"
            />
            <span className={canAlign ? 'text-foreground' : 'text-muted-foreground'}>
              按发酵经过时间对齐 {!canAlign && '(需选具体批次)'}
            </span>
          </label>

          <div className="w-px h-6 bg-border" />

          {/* 单批次多参数对比 — 分面显示开关 (每参数独立 subplot) */}
          <div className="flex items-center gap-1">
            <Button size="sm" variant={!facetedMode ? 'default' : 'outline'} onClick={() => setFacetedMode(false)}
              title="叠加模式 — 所有参数共用 Y 轴">
              <LineChartIcon className="w-3.5 h-3.5 mr-1" />叠加
            </Button>
            <Button size="sm" variant={facetedMode ? 'default' : 'outline'} onClick={() => setFacetedMode(true)}
              title="分面模式 — 每个参数独立 Y 轴, 便于单批次多参数对比">
              <Rows3 className="w-3.5 h-3.5 mr-1" />分面
            </Button>
          </div>

          <div className="w-px h-6 bg-border" />

          {/* 离线取样叠加开关 */}
          <label className="flex items-center gap-1.5 cursor-pointer text-sm">
            <input type="checkbox" checked={showSamples} onChange={e => setShowSamples(e.target.checked)} />
            <span>显示离线取样</span>
          </label>

          <div className="w-px h-6 bg-border" />

          <div className="flex items-center gap-2 flex-wrap">
            {PARAMS.map(p => (
              <label key={p.key} className="flex items-center gap-1 cursor-pointer text-sm select-none">
                <input type="checkbox" checked={active.has(p.key)} onChange={() => toggleParam(p.key)} style={{ accentColor: p.color }} />
                <span style={{ color: p.color }}>{p.label}</span>
              </label>
            ))}
          </div>
          <div className="flex-1" />
          <Button size="sm" variant="outline" onClick={exportCSV} disabled={!hasAnyData}>
            <Download className="w-4 h-4 mr-1" />CSV
          </Button>
        </CardContent>
      </Card>

      {/* 错误提示 */}
      {errMsg && (
        <Card className="border-red-500/30 bg-red-500/10">
          <CardContent className="p-3 text-sm text-red-600">{errMsg}</CardContent>
        </Card>
      )}

      {/* 主图 (ECharts) */}
      <div className="flex-1 min-h-0">
        {!hasAnyData ? (
          <Card className="h-full flex items-center justify-center text-muted-foreground text-sm">
            {loading ? '正在从 InfluxDB 加载历史数据...' :
              selectedReactors.size === 0 ? '请选择至少 1 个反应器' : '所选范围内暂无数据'}
          </Card>
        ) : (
          <Card className="h-full">
            <CardContent className="p-2 h-full">
              <EChartsWrapper option={echartsOption} style={{ height: '100%', minHeight: 400 }} />
            </CardContent>
          </Card>
        )}
      </div>

      {/* CUSUM 历史分析 (仅选了具体批次时显示) */}
      {(() => {
        const firstRid = [...selectedReactors][0];
        const bid = firstRid ? selectedBatches.get(firstRid) : undefined;
        if (bid && bid !== NO_BATCH) {
          return <CusumHistoryPanel batchId={bid} />;
        }
        return null;
      })()}

      {/* 底部统计 */}
      <div className="text-sm text-muted-foreground text-right">
        共 {totalPoints} 个数据点 · {filteredResults.length} 个反应器 · {shouldAlign ? '按发酵经过时间对齐' : '绝对时间'} · {facetedMode ? '分面' : '叠加'} · 范围 {custom ? '自定义' : RANGES[ri].label}
      </div>
    </div>
  );
}
