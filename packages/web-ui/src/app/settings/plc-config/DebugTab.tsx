'use client';

import React, { useCallback, useMemo, useState } from 'react';
import { Activity, Play, Pause, Send, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { PLCVariableMapping } from '@/types';
import { useTagPolling } from '@/hooks/useTagPolling';
import type { TagPollResult } from '@/hooks/useTagPolling';
import type { useAudit } from '@/hooks/useAudit';

export interface PLCConnectionSummary {
  id: string;
  name: string;
}

export interface DebugTabProps {
  connections: PLCConnectionSummary[];
  variables: PLCVariableMapping[];
  apiBase: string;
  apiFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  audit: ReturnType<typeof useAudit>;
}

const DEFAULT_INTERVAL_MS = 1000;

function Sparkline({ values, width = 240, height = 40 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) {
    return (
      <svg
        role="img"
        aria-label="sparkline 占位"
        width={width}
        height={height}
        className="text-muted-foreground"
      >
        <text x={4} y={height / 2 + 4} fontSize={11} fill="currentColor">采样中…</text>
      </svg>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = width / (values.length - 1);
  const points = values
    .map((v, i) => `${(i * stepX).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`)
    .join(' ');
  return (
    <svg role="img" aria-label="sparkline" width={width} height={height} className="text-emerald-500">
      <polyline fill="none" stroke="currentColor" strokeWidth={1.5} points={points} />
    </svg>
  );
}

export function DebugTab({ connections, variables, apiBase, apiFetch, audit }: DebugTabProps) {
  const [selectedConnId, setSelectedConnId] = useState<string>(connections[0]?.id ?? '');
  const [selectedVarId, setSelectedVarId] = useState<string>('');
  const [intervalMs, setIntervalMs] = useState<number>(DEFAULT_INTERVAL_MS);
  const [writeValue, setWriteValue] = useState<string>('');
  const [writeBusy, setWriteBusy] = useState(false);
  const [writeMsg, setWriteMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const connVars = useMemo(
    () => variables.filter(v => v.connection_id === selectedConnId && v.enabled),
    [variables, selectedConnId],
  );
  const selectedVar = useMemo(
    () => connVars.find(v => v.id === selectedVarId) ?? null,
    [connVars, selectedVarId],
  );

  const fetcher = useCallback(async (): Promise<TagPollResult> => {
    if (!selectedVar) return { value: NaN, raw: NaN, success: false, message: 'no tag selected' };
    try {
      const resp = await apiFetch(`${apiBase}/api/plc/variables/${selectedVar.id}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selectedVar),
      });
      const data = await resp.json();
      return {
        value: typeof data.value === 'number' ? data.value : NaN,
        raw: typeof data.raw === 'number' ? data.raw : NaN,
        success: !!data.success,
        message: data.message,
      };
    } catch (e) {
      return { value: NaN, raw: NaN, success: false, message: (e as Error).message };
    }
  }, [apiBase, apiFetch, selectedVar]);

  const polling = useTagPolling(fetcher, intervalMs);

  const canWrite = !!selectedVar && selectedVar.direction !== 'READ' && selectedVar.data_type !== 'BOOL';

  const doWrite = async () => {
    if (!selectedVar) return;
    const num = Number(writeValue);
    if (!Number.isFinite(num)) {
      setWriteMsg({ ok: false, text: '请输入合法数字' });
      return;
    }
    setWriteBusy(true);
    setWriteMsg(null);
    try {
      const resp = await apiFetch(`${apiBase}/api/v1/plc/variables/${selectedVar.id}/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: num, confirmed: true }),
      });
      const data = await resp.json();
      if (data.success) {
        setWriteMsg({ ok: true, text: `已写入 ${num}${selectedVar.eng_unit ? ' ' + selectedVar.eng_unit : ''} (raw=${data.raw})` });
      } else {
        setWriteMsg({ ok: false, text: `写入失败: ${data.error ?? '未知错误'}` });
      }
    } catch (e) {
      setWriteMsg({ ok: false, text: `请求失败: ${(e as Error).message}` });
    } finally {
      setWriteBusy(false);
    }
  };

  const handleWriteClick = () => {
    if (!selectedVar) return;
    audit.confirm({
      description: `对 PLC tag "${selectedVar.tag_name}" (${selectedVar.plc_address}) 写入 ${writeValue}${selectedVar.eng_unit ? ' ' + selectedVar.eng_unit : ''}`,
      action: 'plc_tag_write',
      targetType: 'plc_variable',
      targetId: selectedVar.id,
      newValue: writeValue,
      onConfirm: () => { void doWrite(); },
    });
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">实时观察 tag 值变化，受控写入测试 (写入操作落 audit_log)</p>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">选择目标</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label>PLC 连接</Label>
            <Select value={selectedConnId} onValueChange={(v) => { setSelectedConnId(v); setSelectedVarId(''); polling.stop(); polling.clear(); }}>
              <SelectTrigger><SelectValue placeholder="选择 PLC..." /></SelectTrigger>
              <SelectContent>
                {connections.map(c => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>变量 Tag</Label>
            <Select value={selectedVarId} onValueChange={(v) => { setSelectedVarId(v); polling.stop(); polling.clear(); }}>
              <SelectTrigger><SelectValue placeholder="选择 tag..." /></SelectTrigger>
              <SelectContent>
                {connVars.map(v => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.tag_name} ({v.plc_address}) — {v.direction}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {selectedVar && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="w-4 h-4" /> 实时值 — {selectedVar.tag_name}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-xs text-muted-foreground">
              地址: {selectedVar.plc_address} · 类型: {selectedVar.data_type} · 方向: {selectedVar.direction}
              {selectedVar.scaling_enabled && (
                <> · 缩放: {selectedVar.raw_min}~{selectedVar.raw_max} → {selectedVar.eng_min}~{selectedVar.eng_max} {selectedVar.eng_unit}</>
              )}
            </div>

            <div className="flex items-center gap-4">
              <div className="text-3xl font-mono tabular-nums">
                {polling.latest && polling.latest.ok
                  ? `${polling.latest.value.toFixed(2)}${selectedVar.eng_unit ? ' ' + selectedVar.eng_unit : ''}`
                  : <span className="text-muted-foreground text-base">—</span>}
              </div>
              <div className="text-xs text-muted-foreground">
                {polling.latest?.ok && <>raw={polling.latest.raw}</>}
                {polling.latest && !polling.latest.ok && (
                  <span className="text-red-500">err: {polling.latest.error}</span>
                )}
              </div>
              <Sparkline values={polling.samples.filter(s => s.ok).map(s => s.value)} />
            </div>

            <div className="flex items-center gap-2">
              {polling.isPolling ? (
                <Button variant="secondary" size="sm" onClick={polling.stop} data-testid="poll-stop">
                  <Pause className="w-4 h-4 mr-1" /> 停止
                </Button>
              ) : (
                <Button size="sm" onClick={polling.start} data-testid="poll-start">
                  <Play className="w-4 h-4 mr-1" /> 开始轮询
                </Button>
              )}
              <Label htmlFor="interval" className="text-xs">间隔 (ms, 最小 250)</Label>
              <Input id="interval" type="number" min={250} step={250} className="w-24"
                value={intervalMs}
                onChange={(e) => setIntervalMs(Math.max(250, Number(e.target.value) || 250))} />
              <Button variant="ghost" size="sm" onClick={polling.clear} data-testid="poll-clear">
                <Trash2 className="w-4 h-4" />
              </Button>
              <span className="text-xs text-muted-foreground">{polling.samples.length} 样本</span>
            </div>
          </CardContent>
        </Card>
      )}

      {selectedVar && canWrite && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">写入测试</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center gap-2">
              <Input
                placeholder={`新值 (${selectedVar.eng_unit || selectedVar.data_type})`}
                value={writeValue}
                onChange={(e) => setWriteValue(e.target.value)}
                className="max-w-xs"
                data-testid="write-value-input"
              />
              <Button onClick={handleWriteClick} disabled={writeBusy || writeValue === ''} data-testid="write-submit">
                <Send className="w-4 h-4 mr-1" /> 写入
              </Button>
            </div>
            {writeMsg && (
              <div className={writeMsg.ok ? 'text-sm text-emerald-600' : 'text-sm text-red-500'}>
                {writeMsg.text}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              写入会弹二次确认对话框并落 audit_log。BOOL 类型本版本未支持。
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
