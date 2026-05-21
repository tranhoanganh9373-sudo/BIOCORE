'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Activity, History, Search, Play, FlaskConical } from 'lucide-react';
import { useLocale } from '@/i18n/useLocale';
import { PageHeader } from '@/components/layout/PageHeader';

// 懒加载 BatchComparePanel: 它静态 import echarts,eager 加载会拖首屏.
const BatchComparePanel = dynamic(
  () => import('@/components/BatchComparePanel').then(m => ({ default: m.BatchComparePanel })),
  { ssr: false, loading: () => <div className="p-8 text-center text-muted-foreground">对比面板加载中...</div> },
);

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

interface Batch {
  id?: string;
  batch_id: string;
  reactor_id?: string;
  recipe_id?: string;
  recipe_name?: string;
  organism?: string;
  current_state?: string;
  state?: string;          // legacy fallback
  started_at?: string;
  ended_at?: string;
  duration_h?: number;
  outcome?: string;
  current_phase_index?: number;
  current_phase_id?: string | null;
  current_phase_type?: string | null;
  total_phases?: number;
  operator_id?: string;
  hold_reason?: string | null;
}

const STATE_STYLES: Record<string, string> = {
  running: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  complete: 'bg-blue-100 text-blue-800 border-blue-300',
  completed: 'bg-blue-100 text-blue-800 border-blue-300',
  stopped: 'bg-red-100 text-red-800 border-red-300',
  aborted: 'bg-red-100 text-red-800 border-red-300',
  held: 'bg-orange-100 text-orange-800 border-orange-300',
  paused: 'bg-amber-100 text-amber-800 border-amber-300',
  idle: 'bg-gray-100 text-gray-800 border-gray-300',
};

const STATE_LABEL: Record<string, string> = {
  running: '运行中', complete: '已完成', completed: '已完成',
  stopped: '已停止', aborted: '已中止', held: '保持', paused: '暂停', idle: '空闲',
};

function getState(b: Batch): string {
  return b.current_state || b.state || 'unknown';
}

function formatDuration(startedAt?: string, endedAt?: string, durationH?: number): string {
  if (durationH != null) return `${durationH.toFixed(1)}h`;
  if (!startedAt) return '-';
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const hours = (end - start) / 3600000;
  if (!Number.isFinite(hours)) return '-';
  return hours < 1 ? `${(hours * 60).toFixed(0)}m` : `${hours.toFixed(1)}h`;
}

function PhaseProgress({ idx, total }: { idx?: number; total?: number }) {
  if (idx == null || total == null || total === 0) return <span className="text-muted-foreground">-</span>;
  const pct = Math.min(100, Math.max(0, ((idx + 1) / total) * 100));
  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <div className="flex-1 h-1.5 rounded bg-muted overflow-hidden">
        <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-mono text-muted-foreground tabular-nums">{idx + 1}/{total}</span>
    </div>
  );
}

export default function BatchesPage() {
  const { t } = useLocale();
  const router = useRouter();
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'running' | 'history' | 'compare'>('running');
  const [now, setNow] = useState(Date.now());

  // 运行中批次的 "已运行时长" 需要每秒刷新
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    fetch(`${API}/api/batches`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error('加载失败')))
      .then(d => {
        const list = Array.isArray(d) ? d : d.data ?? [];
        setBatches(list);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const running = useMemo(
    () => batches.filter(b => ['running', 'held', 'paused'].includes(getState(b))),
    [batches],
  );
  const history = useMemo(
    () => batches.filter(b => !['running', 'held', 'paused'].includes(getState(b))),
    [batches],
  );

  const filterFn = (list: Batch[]): Batch[] => {
    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter(b =>
      (b.batch_id ?? '').toLowerCase().includes(q) ||
      (b.organism ?? '').toLowerCase().includes(q) ||
      (b.recipe_name ?? '').toLowerCase().includes(q) ||
      (b.recipe_id ?? '').toLowerCase().includes(q)
    );
  };

  if (loading) return <div className="p-8 text-center text-muted-foreground">加载批次数据中...</div>;
  if (error) return <div className="p-8 text-center text-destructive">{error}</div>;

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        icon={FlaskConical}
        title="配方运行"
        subtitle="正在运行的批次实时状态、历史回顾、批次对比分析"
      />

      {/* 标签页切换 */}
      <div className="flex gap-1 border-b border-border">
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${tab === 'running' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          onClick={() => setTab('running')}
        >
          <Activity className="w-4 h-4" />运行中 <span className="ml-1 text-xs font-mono">({running.length})</span>
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${tab === 'history' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          onClick={() => setTab('history')}
        >
          <History className="w-4 h-4" />历史 <span className="ml-1 text-xs font-mono">({history.length})</span>
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === 'compare' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          onClick={() => setTab('compare')}
        >
          对比分析
        </button>
      </div>

      {tab === 'running' && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Activity className="w-4 h-4 text-emerald-500" />运行中批次
              </CardTitle>
              <div className="relative w-64">
                <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
                <Input placeholder="搜索批次号/罐号/配方..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9 h-9" />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {filterFn(running).length === 0 ? (
              <div className="text-center text-muted-foreground py-12">
                {running.length === 0
                  ? '当前无运行中批次 — 从 /recipes 列表中选定配方下载到反应器后启动'
                  : '未找到匹配结果'}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>批次号</TableHead>
                    <TableHead>罐号</TableHead>
                    <TableHead>配方</TableHead>
                    <TableHead>菌种</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>当前 Phase</TableHead>
                    <TableHead>进度</TableHead>
                    <TableHead>已运行</TableHead>
                    <TableHead>操作员</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filterFn(running).map(b => {
                    const state = getState(b);
                    return (
                      <TableRow
                        key={b.batch_id}
                        className="cursor-pointer hover:bg-muted/30"
                        onClick={() => router.push(`/batches/${b.batch_id}`)}
                      >
                        <TableCell className="font-medium font-mono">{b.batch_id}</TableCell>
                        <TableCell className="font-mono font-semibold">{b.reactor_id ?? '-'}</TableCell>
                        <TableCell className="text-sm">{b.recipe_id ?? b.recipe_name ?? '-'}</TableCell>
                        <TableCell className="text-sm">{b.organism ?? '-'}</TableCell>
                        <TableCell>
                          <Badge className={STATE_STYLES[state] ?? STATE_STYLES.idle}>
                            {STATE_LABEL[state] ?? state}
                          </Badge>
                          {b.hold_reason && (
                            <div className="text-xs text-muted-foreground mt-1">原因: {b.hold_reason}</div>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {b.current_phase_id ?? '-'}
                          {b.current_phase_type && (
                            <span className="text-muted-foreground ml-1">({b.current_phase_type})</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <PhaseProgress idx={b.current_phase_index} total={b.total_phases} />
                        </TableCell>
                        <TableCell className="text-sm tabular-nums">
                          {/* now 触发重渲染 */}
                          <span data-now={now}>{formatDuration(b.started_at, b.ended_at, b.duration_h)}</span>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{b.operator_id ?? '-'}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {tab === 'history' && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2"><History className="w-4 h-4" />批次历史</CardTitle>
              <div className="relative w-64">
                <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
                <Input placeholder="搜索批次号/菌种/配方..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9 h-9" />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {filterFn(history).length === 0 ? (
              <div className="text-center text-muted-foreground py-12">{history.length === 0 ? '暂无批次记录' : '未找到匹配结果'}</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>批次号</TableHead>
                    <TableHead>罐号</TableHead>
                    <TableHead>配方</TableHead>
                    <TableHead>菌种</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>开始时间</TableHead>
                    <TableHead>持续时间</TableHead>
                    <TableHead>结果</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filterFn(history).map(b => {
                    const state = getState(b);
                    return (
                      <TableRow key={b.batch_id} className="cursor-pointer hover:bg-muted/30" onClick={() => router.push(`/batches/${b.batch_id}`)}>
                        <TableCell className="font-medium font-mono">{b.batch_id}</TableCell>
                        <TableCell className="font-mono font-semibold">{b.reactor_id ?? '-'}</TableCell>
                        <TableCell className="text-sm">{b.recipe_id ?? b.recipe_name ?? '-'}</TableCell>
                        <TableCell className="text-sm">{b.organism ?? '-'}</TableCell>
                        <TableCell>
                          <Badge className={STATE_STYLES[state] ?? STATE_STYLES.idle}>
                            {STATE_LABEL[state] ?? state}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm">{b.started_at ? new Date(b.started_at).toLocaleString('zh-CN') : '-'}</TableCell>
                        <TableCell className="text-sm tabular-nums">{formatDuration(b.started_at, b.ended_at, b.duration_h)}</TableCell>
                        <TableCell>{b.outcome ?? '-'}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {tab === 'compare' && <BatchComparePanel />}
    </div>
  );
}
