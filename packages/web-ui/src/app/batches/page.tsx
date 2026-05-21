'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { History, Search } from 'lucide-react';
import { useLocale } from '@/i18n/useLocale';

// 懒加载 BatchComparePanel: 它静态 import echarts 与 boxplot helpers,
// eager 加载会让 '配方运行' 首次访问慢 (打包数千 modules). 切到对比 tab 时再加载.
const BatchComparePanel = dynamic(
  () => import('@/components/BatchComparePanel').then(m => ({ default: m.BatchComparePanel })),
  { ssr: false, loading: () => <div className="p-8 text-center text-muted-foreground">对比面板加载中...</div> },
);

const API = 'http://localhost:3001';

interface Batch {
  id: string;
  batch_id: string;
  reactor_id?: string;
  recipe_name?: string;
  organism?: string;
  state: string;
  started_at?: string;
  ended_at?: string;
  duration_h?: number;
  outcome?: string;
}

const STATE_STYLES: Record<string, string> = {
  running: 'bg-green-100 text-green-800 border-green-300',
  completed: 'bg-blue-100 text-blue-800 border-blue-300',
  aborted: 'bg-red-100 text-red-800 border-red-300',
  held: 'bg-orange-100 text-orange-800 border-orange-300',
  idle: 'bg-gray-100 text-gray-800 border-gray-300',
};

function formatDuration(startedAt?: string, endedAt?: string, durationH?: number): string {
  if (durationH != null) return `${durationH.toFixed(1)}h`;
  if (!startedAt) return '-';
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const hours = (end - start) / 3600000;
  return `${hours.toFixed(1)}h`;
}

export default function BatchesPage() {
  const { t } = useLocale();
  const router = useRouter();
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'list' | 'compare'>('list');

  useEffect(() => {
    fetch(`${API}/api/batches`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error('加载失败')))
      .then(d => setBatches(Array.isArray(d) ? d : d.data ?? []))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    if (!search.trim()) return batches;
    const q = search.toLowerCase();
    return batches.filter(b =>
      (b.batch_id ?? '').toLowerCase().includes(q) ||
      (b.organism ?? '').toLowerCase().includes(q) ||
      (b.recipe_name ?? '').toLowerCase().includes(q)
    );
  }, [batches, search]);

  if (loading) return <div className="p-8 text-center text-muted-foreground">加载批次数据中...</div>;
  if (error) return <div className="p-8 text-center text-destructive">{error}</div>;

  return (
    <div className="p-4 space-y-4">
      {/* 标签页切换 */}
      <div className="flex gap-1 border-b border-border mb-4">
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === 'list' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          onClick={() => setTab('list')}
        >
          批次列表
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === 'compare' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          onClick={() => setTab('compare')}
        >
          对比分析
        </button>
      </div>

      {/* 批次列表 */}
      {tab === 'list' && (
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
          {filtered.length === 0 ? (
            <div className="text-center text-muted-foreground py-12">{batches.length === 0 ? '暂无批次记录' : '未找到匹配结果'}</div>
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
                {filtered.map(b => (
                  <TableRow key={b.id ?? b.batch_id} className="cursor-pointer" onClick={() => router.push(`/batches/${b.id ?? b.batch_id}`)}>
                    <TableCell className="font-medium">{b.batch_id ?? b.id}</TableCell>
                    <TableCell className="font-mono font-semibold">{b.reactor_id ?? '-'}</TableCell>
                    <TableCell>{b.recipe_name ?? '-'}</TableCell>
                    <TableCell>{b.organism ?? '-'}</TableCell>
                    <TableCell>
                      <Badge className={STATE_STYLES[b.state] ?? STATE_STYLES.idle}>{b.state ?? 'unknown'}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">{b.started_at ? new Date(b.started_at).toLocaleString('zh-CN') : '-'}</TableCell>
                    <TableCell>{formatDuration(b.started_at, b.ended_at, b.duration_h)}</TableCell>
                    <TableCell>{b.outcome ?? '-'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      )}

      {/* 对比分析 */}
      {tab === 'compare' && <BatchComparePanel />}
    </div>
  );
}
