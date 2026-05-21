// ============================================================
// PLC 通讯配置页面
// ★ 新增需求: 连接管理 + 变量地址映射表 + CSV/JSON 导入导出
// 路由: /settings/plc-config
// 权限: admin
// ============================================================

'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Plus, Trash2, Upload, Download, TestTube, Wifi, WifiOff,
  Save, FileJson, FileSpreadsheet, RefreshCw, Search, Edit2,
  AlertCircle, CheckCircle2, Activity,
} from 'lucide-react';
import type { PLCConnection, PLCVariableMapping, PLCVariableGroup, PLCDataType, PLCDirection, PLCProtocol } from '@/types';
import { useAudit } from '@/hooks/useAudit';
import { useLocale } from '@/i18n/useLocale';
import { DebugTab } from './DebugTab';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// ─── 变量分组颜色 ──────────────────────────────────────────

const GROUP_COLORS: Record<PLCVariableGroup, string> = {
  '模拟量输入': 'bg-blue-100 text-blue-800',
  '模拟量输出': 'bg-green-100 text-green-800',
  '数字量输入': 'bg-purple-100 text-purple-800',
  '数字量输出': 'bg-orange-100 text-orange-800',
  '设定值': 'bg-cyan-100 text-cyan-800',
  'PID参数': 'bg-yellow-100 text-yellow-800',
  '控制字': 'bg-red-100 text-red-800',
  '状态字': 'bg-indigo-100 text-indigo-800',
  '报警': 'bg-rose-100 text-rose-800',
  '变频器': 'bg-teal-100 text-teal-800',
  '心跳': 'bg-gray-100 text-gray-800',
};

// ─── 默认V区地址模板 (基于01_PLC硬件规格.md) ───────────────

const DEFAULT_VARIABLE_TEMPLATES: Partial<PLCVariableMapping>[] = [
  // 模拟量输入 (PV)
  { tag_name: 'TEMP_PV', description: '罐内温度', plc_address: 'VW100', data_type: 'INT16', direction: 'READ', scaling_enabled: true, raw_min: 0, raw_max: 27648, eng_min: 0, eng_max: 150, eng_unit: '°C', group: '模拟量输入', poll_rate_ms: 1000 },
  { tag_name: 'JACKET_TEMP_PV', description: '夹套温度', plc_address: 'VW102', data_type: 'INT16', direction: 'READ', scaling_enabled: true, raw_min: 0, raw_max: 27648, eng_min: 0, eng_max: 150, eng_unit: '°C', group: '模拟量输入', poll_rate_ms: 1000 },
  { tag_name: 'PH_PV', description: 'pH值', plc_address: 'VW104', data_type: 'INT16', direction: 'READ', scaling_enabled: true, raw_min: 0, raw_max: 27648, eng_min: 0, eng_max: 14, eng_unit: 'pH', group: '模拟量输入', poll_rate_ms: 1000 },
  { tag_name: 'DO_PV', description: '溶氧', plc_address: 'VW106', data_type: 'INT16', direction: 'READ', scaling_enabled: true, raw_min: 0, raw_max: 27648, eng_min: 0, eng_max: 100, eng_unit: '%', group: '模拟量输入', poll_rate_ms: 1000 },
  { tag_name: 'PRESSURE_PV', description: '罐压', plc_address: 'VW108', data_type: 'INT16', direction: 'READ', scaling_enabled: true, raw_min: 0, raw_max: 27648, eng_min: -1, eng_max: 3, eng_unit: 'bar', group: '模拟量输入', poll_rate_ms: 1000 },
  { tag_name: 'AIRFLOW_PV', description: '空气流量', plc_address: 'VW110', data_type: 'INT16', direction: 'READ', scaling_enabled: true, raw_min: 0, raw_max: 27648, eng_min: 0, eng_max: 30, eng_unit: 'NL/MIN', group: '模拟量输入', poll_rate_ms: 1000 },
  { tag_name: 'WEIGHT_PV', description: '称重', plc_address: 'VW112', data_type: 'INT16', direction: 'READ', scaling_enabled: true, raw_min: 0, raw_max: 27648, eng_min: 0, eng_max: 80, eng_unit: 'kg', group: '模拟量输入', poll_rate_ms: 1000 },
  // 模拟量输出 (CV)
  { tag_name: 'STEAM_CV', description: '蒸汽阀开度', plc_address: 'VW150', data_type: 'INT16', direction: 'READ', scaling_enabled: true, raw_min: 0, raw_max: 27648, eng_min: 0, eng_max: 100, eng_unit: '%', group: '模拟量输出', poll_rate_ms: 1000 },
  { tag_name: 'COOL_CV', description: '冷却阀开度', plc_address: 'VW152', data_type: 'INT16', direction: 'READ', scaling_enabled: true, raw_min: 0, raw_max: 27648, eng_min: 0, eng_max: 100, eng_unit: '%', group: '模拟量输出', poll_rate_ms: 1000 },
  { tag_name: 'AIR_CV', description: '空气阀开度', plc_address: 'VW154', data_type: 'INT16', direction: 'READ', scaling_enabled: true, raw_min: 0, raw_max: 27648, eng_min: 0, eng_max: 100, eng_unit: '%', group: '模拟量输出', poll_rate_ms: 1000 },
  // 设定值 (SV)
  { tag_name: 'TEMP_SV', description: '温度设定值', plc_address: 'VW10', data_type: 'FLOAT32', direction: 'WRITE', scaling_enabled: false, raw_min: 0, raw_max: 0, eng_min: 0, eng_max: 150, eng_unit: '°C', group: '设定值', poll_rate_ms: 1000 },
  { tag_name: 'PH_SV', description: 'pH设定值', plc_address: 'VW14', data_type: 'FLOAT32', direction: 'WRITE', scaling_enabled: false, raw_min: 0, raw_max: 0, eng_min: 0, eng_max: 14, eng_unit: 'pH', group: '设定值', poll_rate_ms: 1000 },
  { tag_name: 'DO_SV', description: 'DO设定值', plc_address: 'VW18', data_type: 'FLOAT32', direction: 'WRITE', scaling_enabled: false, raw_min: 0, raw_max: 0, eng_min: 0, eng_max: 100, eng_unit: '%', group: '设定值', poll_rate_ms: 1000 },
  { tag_name: 'RPM_SV', description: '搅拌转速设定值', plc_address: 'VW22', data_type: 'INT16', direction: 'WRITE', scaling_enabled: false, raw_min: 0, raw_max: 0, eng_min: 50, eng_max: 1200, eng_unit: 'rpm', group: '设定值', poll_rate_ms: 1000 },
  // 控制字
  { tag_name: 'CONTROL_WORD', description: '系统控制字', plc_address: 'VW0', data_type: 'UINT16', direction: 'WRITE', scaling_enabled: false, raw_min: 0, raw_max: 0, eng_min: 0, eng_max: 65535, eng_unit: '', group: '控制字', poll_rate_ms: 100 },
  { tag_name: 'STATE_CODE', description: '状态机编码', plc_address: 'VW2', data_type: 'UINT16', direction: 'WRITE', scaling_enabled: false, raw_min: 0, raw_max: 0, eng_min: 0, eng_max: 5, eng_unit: '', group: '控制字', poll_rate_ms: 100 },
  // 心跳
  { tag_name: 'HEARTBEAT', description: '心跳字节', plc_address: 'VB400', data_type: 'UINT16', direction: 'READWRITE', scaling_enabled: false, raw_min: 0, raw_max: 0, eng_min: 0, eng_max: 255, eng_unit: '', group: '心跳', poll_rate_ms: 100 },
  // 报警
  { tag_name: 'ALARM_WORD_0', description: '报警字0', plc_address: 'VW200', data_type: 'UINT16', direction: 'READ', scaling_enabled: false, raw_min: 0, raw_max: 0, eng_min: 0, eng_max: 65535, eng_unit: '', group: '报警', poll_rate_ms: 100 },
  // 变频器
  { tag_name: 'VFD_ACTUAL_FREQ', description: '变频器实际频率', plc_address: 'VW210', data_type: 'INT16', direction: 'READ', scaling_enabled: true, raw_min: 0, raw_max: 10000, eng_min: 0, eng_max: 50, eng_unit: 'Hz', group: '变频器', poll_rate_ms: 1000 },
  { tag_name: 'VFD_CURRENT', description: '变频器输出电流', plc_address: 'VW212', data_type: 'INT16', direction: 'READ', scaling_enabled: true, raw_min: 0, raw_max: 10000, eng_min: 0, eng_max: 10, eng_unit: 'A', group: '变频器', poll_rate_ms: 1000 },
  { tag_name: 'VFD_FAULT_CODE', description: '变频器故障码', plc_address: 'VW218', data_type: 'UINT16', direction: 'READ', scaling_enabled: false, raw_min: 0, raw_max: 0, eng_min: 0, eng_max: 65535, eng_unit: '', group: '变频器', poll_rate_ms: 1000 },
];

// ─── 主页面组件 ─────────────────────────────────────────────

export default function PLCConfigPage() {
  const { t } = useLocale();
  const [activeTab, setActiveTab] = useState<'connections' | 'variables' | 'debug'>('connections');
  const [connections, setConnections] = useState<PLCConnection[]>([]);
  const [variables, setVariables] = useState<PLCVariableMapping[]>([]);
  const [selectedConnection, setSelectedConnection] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterGroup, setFilterGroup] = useState<string>('all');
  const [showConnectionDialog, setShowConnectionDialog] = useState(false);
  const [showVariableDialog, setShowVariableDialog] = useState(false);
  const [editingConnection, setEditingConnection] = useState<PLCConnection | null>(null);
  const [editingVariable, setEditingVariable] = useState<PLCVariableMapping | null>(null);
  // 变量测试结果
  const [varTestResults, setVarTestResults] = useState<Record<string, { value?: number; ok: boolean; message: string; testing: boolean }>>({});
  // 心跳状态: { [conn_id]: { running, counter, errors } }
  const [heartbeatStatus, setHeartbeatStatus] = useState<Record<string, { running: boolean; counter: number; errors: number }>>({});
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message: string }>>({});
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [apiError, setApiError] = useState<string | null>(null);
  const unmountedRef = useRef(false);
  const pollingIdsRef = useRef<Set<string>>(new Set());
  const audit = useAudit();

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      unmountedRef.current = true;
      pollingIdsRef.current.clear();
    };
  }, []);

  // API 调用封装 (含错误提示)
  const apiFetch = async (url: string, opts?: RequestInit) => {
    try {
      const resp = await fetch(url, opts);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setApiError(null);
      return resp;
    } catch (e) {
      const msg = `API请求失败 (${url}): ${(e as Error).message}. 请确认后端服务已启动 (npx tsx src/api-server.ts)`;
      setApiError(msg);
      throw e;
    }
  };

  // --- 数据加载 ---
  const loadConnections = useCallback(async () => {
    try {
      const resp = await apiFetch(`${API_BASE}/api/plc/connections`);
      setConnections(await resp.json());
    } catch { /* apiError 已设置 */ }
  }, []);

  const loadVariables = useCallback(async () => {
    try {
      const url = selectedConnection
        ? `${API_BASE}/api/plc/variables?connection_id=${selectedConnection}`
        : `${API_BASE}/api/plc/variables`;
      const resp = await apiFetch(url);
      setVariables(await resp.json());
    } catch { /* apiError 已设置 */ }
  }, [selectedConnection]);

  useEffect(() => { loadConnections(); }, [loadConnections]);
  useEffect(() => { loadVariables(); }, [loadVariables]);

  // --- 连接管理 ---
  // SP-PLC-1: connection 现含可选 reactor_id 字段,server 接受透传
  // 实际写入逻辑 (不含审计)
  const doSaveConnection = async (conn: PLCConnection & { reactor_id?: string | null }): Promise<string | null> => {
    try {
      const method = editingConnection ? 'PUT' : 'POST';
      const url = editingConnection
        ? `${API_BASE}/api/plc/connections/${conn.id}`
        : `${API_BASE}/api/plc/connections`;
      const resp = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(conn) });
      const data = await resp.json();
      if (data.error) return data.error;
      setShowConnectionDialog(false);
      setEditingConnection(null);
      loadConnections();
      return null;
    } catch (e) {
      return (e as Error).message || '保存失败，请确认后端服务已启动';
    }
  };

  // 返回错误信息给对话框显示, 成功返回 null, 用户取消返回特殊标记
  const saveConnection = (conn: PLCConnection & { reactor_id?: string | null }): Promise<string | null> => {
    return new Promise((resolve) => {
      audit.confirm({
        description: editingConnection ? `编辑 PLC 连接 ${conn.name}` : `创建 PLC 连接 ${conn.name}`,
        action: editingConnection ? 'plc_connection_update' : 'plc_connection_create',
        targetType: 'plc_connection', targetId: conn.id,
        oldValue: editingConnection ? `${editingConnection.name} (${editingConnection.protocol} ${editingConnection.ip}:${editingConnection.port})` : undefined,
        newValue: `${conn.name} (${conn.protocol} ${conn.ip}:${conn.port})`,
        onConfirm: async () => {
          const err = await doSaveConnection(conn);
          resolve(err);
        },
        onCancel: () => resolve('已取消审计确认'),
      });
    });
  };

  const deleteConnection = (c: PLCConnection) => {
    audit.confirm({
      description: `删除 PLC 连接 ${c.name} — 同时删除其下所有变量映射`,
      action: 'plc_connection_delete', targetType: 'plc_connection', targetId: c.id,
      oldValue: `${c.name} (${c.protocol} ${c.ip}:${c.port})`,
      onConfirm: async () => {
        try {
          await apiFetch(`${API_BASE}/api/plc/connections/${c.id}`, { method: 'DELETE' });
          loadConnections();
          loadVariables();
        } catch {}
      },
    });
  };

  const testConnection = async (id: string) => {
    setTestResults(prev => { const next = { ...prev }; delete next[id]; return next; });
    try {
      const resp = await apiFetch(`${API_BASE}/api/plc/connections/${id}/test`, { method: 'POST' });
      const result = await resp.json();
      setTestResults(prev => ({ ...prev, [id]: result }));
    } catch {
      setTestResults(prev => ({ ...prev, [id]: { success: false, message: '无法连接到后端服务' } }));
    }
  };

  // --- 心跳控制 ---
  const doToggleHeartbeat = async (id: string, start: boolean) => {
    try {
      const action = start ? 'start' : 'stop';
      const resp = await apiFetch(`${API_BASE}/api/plc/connections/${id}/heartbeat/${action}`, { method: 'POST' });
      const result = await resp.json();
      if (!result.success) { setTestResults(prev => ({ ...prev, [id]: result })); return; }
      if (start) pollHeartbeat(id);
      else {
        pollingIdsRef.current.delete(id);
        setHeartbeatStatus(prev => ({ ...prev, [id]: { running: false, counter: 0, errors: 0 } }));
      }
    } catch {}
  };

  const toggleHeartbeat = (id: string, start: boolean) => {
    const conn = connections.find(c => c.id === id);
    audit.confirm({
      description: `${start ? '启动' : '停止'} PLC 心跳: ${conn?.name || id}`,
      action: start ? 'plc_heartbeat_start' : 'plc_heartbeat_stop',
      targetType: 'plc_connection', targetId: id,
      oldValue: start ? '已停止' : '运行中',
      newValue: start ? '运行中' : '已停止',
      onConfirm: () => doToggleHeartbeat(id, start),
    });
  };

  const pollHeartbeat = (id: string) => {
    if (pollingIdsRef.current.has(id)) return; // avoid duplicate poll loops
    pollingIdsRef.current.add(id);
    const poll = async () => {
      if (unmountedRef.current || !pollingIdsRef.current.has(id)) return;
      try {
        const resp = await fetch(`${API_BASE}/api/plc/connections/${id}/heartbeat/status`);
        const status = await resp.json();
        if (unmountedRef.current) return;
        setHeartbeatStatus(prev => ({ ...prev, [id]: status }));
        if (status.running && !unmountedRef.current) {
          setTimeout(poll, 1000);
        } else {
          pollingIdsRef.current.delete(id);
        }
      } catch {
        pollingIdsRef.current.delete(id);
      }
    };
    poll();
  };

  // 页面加载时检查已有心跳状态
  useEffect(() => {
    connections.forEach(c => {
      fetch(`${API_BASE}/api/plc/connections/${c.id}/heartbeat/status`)
        .then(r => r.json())
        .then(s => {
          if (s.running) {
            setHeartbeatStatus(prev => ({ ...prev, [c.id]: s }));
            pollHeartbeat(c.id);
          }
        })
        .catch(() => {});
    });
  }, [connections]);

  // --- 变量管理 ---
  const doSaveVariable = async (v: PLCVariableMapping): Promise<string | null> => {
    try {
      const method = editingVariable ? 'PUT' : 'POST';
      const url = editingVariable
        ? `${API_BASE}/api/plc/variables/${v.id}`
        : `${API_BASE}/api/plc/variables`;
      const resp = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) });
      const data = await resp.json();
      if (data.error) return data.error;
      setShowVariableDialog(false);
      setEditingVariable(null);
      loadVariables();
      return null;
    } catch (e) {
      return (e as Error).message || '保存失败，请确认后端服务已启动';
    }
  };

  const saveVariable = (v: PLCVariableMapping): Promise<string | null> => {
    return new Promise((resolve) => {
      audit.confirm({
        description: editingVariable ? `编辑 PLC 变量 ${v.tag_name}` : `创建 PLC 变量 ${v.tag_name}`,
        action: editingVariable ? 'plc_variable_update' : 'plc_variable_create',
        targetType: 'plc_variable', targetId: v.id,
        oldValue: editingVariable ? `${editingVariable.tag_name} @ ${editingVariable.plc_address} (${editingVariable.data_type}/${editingVariable.direction})` : undefined,
        newValue: `${v.tag_name} @ ${v.plc_address} (${v.data_type}/${v.direction})`,
        onConfirm: async () => {
          const err = await doSaveVariable(v);
          resolve(err);
        },
        onCancel: () => resolve('已取消审计确认'),
      });
    });
  };

  const deleteVariable = (v: PLCVariableMapping) => {
    audit.confirm({
      description: `删除 PLC 变量 ${v.tag_name} (${v.description})`,
      action: 'plc_variable_delete', targetType: 'plc_variable', targetId: v.id,
      oldValue: `${v.tag_name} @ ${v.plc_address}`,
      onConfirm: async () => {
        try {
          await apiFetch(`${API_BASE}/api/plc/variables/${v.id}`, { method: 'DELETE' });
        } catch { /* apiError already set */ }
        loadVariables();
      },
    });
  };

  // --- 变量测试 (读取PLC实际值) ---
  const testVariable = async (v: PLCVariableMapping) => {
    setVarTestResults(prev => ({ ...prev, [v.id]: { ok: false, message: '读取中...', testing: true } }));
    try {
      const resp = await apiFetch(`${API_BASE}/api/plc/variables/${v.id}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(v),
      });
      const result = await resp.json();
      setVarTestResults(prev => ({ ...prev, [v.id]: { value: result.value, ok: result.success, message: result.message, testing: false } }));
    } catch {
      setVarTestResults(prev => ({ ...prev, [v.id]: { ok: false, message: '后端无响应', testing: false } }));
    }
  };

  const testAllVariables = async () => {
    const readable = filteredVariables.filter(v => v.direction !== 'WRITE' && v.enabled);
    for (const v of readable) {
      await testVariable(v);
    }
  };

  // --- 导入导出 ---
  const exportJSON = () => {
    window.open(`${API_BASE}/api/plc/export/json`, '_blank');
  };

  const exportCSV = () => {
    window.open(`${API_BASE}/api/plc/export/csv`, '_blank');
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    audit.confirm({
      description: `导入 PLC 变量映射文件: ${file.name}`,
      action: 'plc_variable_import', targetType: 'plc_variable', targetId: file.name,
      newValue: `${file.name} (${(file.size / 1024).toFixed(1)} KB)`,
      onConfirm: () => doImportFile(file),
      onCancel: () => { if (fileInputRef.current) fileInputRef.current.value = ''; },
    });
  };

  const doImportFile = async (file: File) => {
    setImporting(true);
    try {
      const text = await file.text();
      if (file.name.endsWith('.json')) {
        const data = JSON.parse(text);
        const resp = await fetch(`${API_BASE}/api/plc/import/json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        const result = await resp.json();
        alert(`导入完成: 成功${result.imported}条${result.errors.length > 0 ? ', 失败' + result.errors.length + '条' : ''}`);
      } else if (file.name.endsWith('.csv')) {
        const lines = text.split('\n').filter(l => l.trim());
        const headers = lines[0].split(',').map(h => h.trim());
        const variables = lines.slice(1).map(line => {
          const values = parseCSVLine(line);
          const obj: any = {};
          headers.forEach((h, i) => {
            obj[h] = values[i]?.trim();
          });
          obj.scaling_enabled = obj.scaling_enabled === 'true' || obj.scaling_enabled === '1';
          obj.enabled = obj.enabled === 'true' || obj.enabled === '1';
          obj.raw_min = parseFloat(obj.raw_min) || 0;
          obj.raw_max = parseFloat(obj.raw_max) || 0;
          obj.eng_min = parseFloat(obj.eng_min) || 0;
          obj.eng_max = parseFloat(obj.eng_max) || 0;
          obj.poll_rate_ms = parseInt(obj.poll_rate_ms) || 1000;
          return obj;
        });

        const resp = await fetch(`${API_BASE}/api/plc/import/csv`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ variables }),
        });
        const result = await resp.json();
        alert(`CSV导入完成: 成功${result.imported}条${result.errors.length > 0 ? ', 失败' + result.errors.length + '条' : ''}`);
      }

      loadConnections();
      loadVariables();
    } catch (err) {
      alert(`导入失败: ${(err as Error).message}`);
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // 加载默认模板
  const loadDefaultTemplate = () => {
    if (!selectedConnection) {
      alert('请先选择一个PLC连接');
      return;
    }
    const conn = connections.find(c => c.id === selectedConnection);
    audit.confirm({
      description: `加载 BIOCore 默认 V 区地址模板到 ${conn?.name || selectedConnection}`,
      action: 'plc_variable_load_template', targetType: 'plc_connection', targetId: selectedConnection,
      newValue: `${DEFAULT_VARIABLE_TEMPLATES.length} 个默认变量 (S7-200 SMART G2)`,
      onConfirm: async () => {
        const vars = DEFAULT_VARIABLE_TEMPLATES.map(t => ({
          ...t,
          id: crypto.randomUUID(),
          connection_id: selectedConnection,
          enabled: true,
        }));
        await fetch(`${API_BASE}/api/plc/variables`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(vars),
        });
        loadVariables();
      },
    });
  };

  // --- 过滤 ---
  const filteredVariables = variables.filter(v => {
    const matchSearch = searchTerm === '' ||
      v.tag_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      v.description.includes(searchTerm) ||
      v.plc_address.toLowerCase().includes(searchTerm.toLowerCase());
    const matchGroup = filterGroup === 'all' || v.group === filterGroup;
    return matchSearch && matchGroup;
  });

  const groups = [...new Set(variables.map(v => v.group))];

  // ─── 渲染 ─────────────────────────────────────────────────

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-6">
      {/* 页面标题 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">PLC 通讯配置</h1>
          <p className="text-muted-foreground mt-1">
            管理PLC连接参数和变量地址映射表, 支持CSV/JSON批量导入导出
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={exportJSON}>
            <FileJson className="w-4 h-4 mr-1" /> 导出JSON
          </Button>
          <Button variant="outline" size="sm" onClick={exportCSV}>
            <FileSpreadsheet className="w-4 h-4 mr-1" /> 导出CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={importing}>
            <Upload className="w-4 h-4 mr-1" /> {importing ? '导入中...' : '导入'}
          </Button>
          <input ref={fileInputRef} type="file" accept=".json,.csv" className="hidden" onChange={handleImportFile} />
        </div>
      </div>

      {/* API 错误提示 */}
      {apiError && (
        <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-lg flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <span className="text-sm">{apiError}</span>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setApiError(null)}>
            关闭
          </Button>
        </div>
      )}

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
        <TabsList>
          <TabsTrigger value="connections">
            <Wifi className="w-4 h-4 mr-1" /> PLC连接 ({connections.length})
          </TabsTrigger>
          <TabsTrigger value="variables">
            <Edit2 className="w-4 h-4 mr-1" /> 变量映射 ({variables.length})
          </TabsTrigger>
          <TabsTrigger value="debug">
            <Activity className="w-4 h-4 mr-1" /> 调试
          </TabsTrigger>
        </TabsList>

        {/* ── Tab 1: PLC 连接管理 ── */}
        <TabsContent value="connections" className="space-y-4">
          <div className="flex justify-between items-center">
            <p className="text-sm text-muted-foreground">配置S7-200 SMART G2 PLC的网络连接参数</p>
            <Button onClick={() => { setEditingConnection(null); setShowConnectionDialog(true); }}>
              <Plus className="w-4 h-4 mr-1" /> 添加PLC连接
            </Button>
          </div>

          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {connections.map(conn => (
              <Card key={conn.id} className={`relative ${conn.enabled ? '' : 'opacity-50'}`}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">{conn.name}</CardTitle>
                    <Badge variant={conn.enabled ? 'default' : 'secondary'}>
                      {conn.enabled ? '启用' : '禁用'}
                    </Badge>
                  </div>
                  <CardDescription>{conn.ip}:{conn.port}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    {/* SP-PLC-1: 绑定的 Unit (reactor) */}
                    <div className="text-muted-foreground">绑定 Unit</div>
                    <div>
                      {(conn as any).reactor_id
                        ? <Badge className="text-sm bg-emerald-100 text-emerald-800 hover:bg-emerald-100">{(conn as any).reactor_id}</Badge>
                        : <span className="text-zinc-400 text-sm">未绑定</span>
                      }
                    </div>
                    <div className="text-muted-foreground">协议</div>
                    <div>
                      <Badge variant="outline" className="text-sm">
                        {conn.protocol === 's7' ? 'S7' : conn.protocol === 'modbus_tcp' ? 'Modbus TCP' : 'Modbus RTU'}
                      </Badge>
                    </div>
                    {conn.protocol === 's7' && (
                      <>
                        <div className="text-muted-foreground">Rack/Slot/DB</div>
                        <div>{conn.rack}/{conn.slot}/DB{conn.s7_db}</div>
                      </>
                    )}
                    {conn.protocol === 'modbus_rtu' && (
                      <>
                        <div className="text-muted-foreground">串口</div>
                        <div>{conn.serial_port} @ {conn.baudrate}</div>
                      </>
                    )}
                    <div className="text-muted-foreground">心跳(写/读)</div>
                    <div className="font-mono text-sm">{conn.heartbeat_write_address}/{conn.heartbeat_read_address}</div>
                    <div className="text-muted-foreground">超时/重连</div>
                    <div>{conn.heartbeat_timeout_ms}ms / {conn.reconnect_interval_ms}ms</div>
                  </div>
                  {/* 心跳状态 */}
                  {(() => {
                    const hb = heartbeatStatus[conn.id];
                    if (!hb?.running) return null;
                    return (
                      <div className="bg-green-50 border border-green-200 rounded px-3 py-2 mt-1">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-green-700 font-medium flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                            心跳运行中
                          </span>
                          <span className="font-mono text-green-600">
                            {conn.heartbeat_write_address} = {hb.counter}
                          </span>
                        </div>
                        {hb.errors > 0 && (
                          <div className="text-sm text-orange-600 mt-1">写入错误: {hb.errors}次</div>
                        )}
                      </div>
                    );
                  })()}

                  <div className="flex gap-2 pt-2">
                    <Button size="sm" variant="outline" className="flex-1"
                      onClick={() => testConnection(conn.id)}>
                      <TestTube className="w-3 h-3 mr-1" /> 测试
                    </Button>
                    {heartbeatStatus[conn.id]?.running ? (
                      <Button size="sm" variant="outline" className="flex-1 border-red-200 text-red-600 hover:bg-red-50"
                        onClick={() => toggleHeartbeat(conn.id, false)}>
                        <WifiOff className="w-3 h-3 mr-1" /> 停止心跳
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" className="flex-1 border-green-200 text-green-600 hover:bg-green-50"
                        onClick={() => toggleHeartbeat(conn.id, true)}>
                        <Wifi className="w-3 h-3 mr-1" /> 启动心跳
                      </Button>
                    )}
                    <Button size="sm" variant="outline"
                      onClick={() => { setEditingConnection(conn); setShowConnectionDialog(true); }}>
                      <Edit2 className="w-3 h-3" />
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => deleteConnection(conn)}>
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>

                  {testResults[conn.id] && (
                    <div className={`text-sm p-2 rounded ${testResults[conn.id].success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                      {testResults[conn.id].success ? <CheckCircle2 className="w-4 h-4 inline mr-1" /> : <AlertCircle className="w-4 h-4 inline mr-1" />}
                      {testResults[conn.id].message}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}

            {connections.length === 0 && (
              <Card className="col-span-full p-8 text-center text-muted-foreground">
                <WifiOff className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p>尚未配置PLC连接</p>
                <p className="text-sm">点击"添加PLC连接"开始配置</p>
              </Card>
            )}
          </div>
        </TabsContent>

        {/* ── Tab 2: 变量映射表 ── */}
        <TabsContent value="variables" className="space-y-4">
          {/* 工具栏 */}
          <div className="flex flex-wrap gap-3 items-center justify-between">
            <div className="flex gap-2 items-center">
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input placeholder="搜索变量名/描述/地址..." className="pl-8 w-[280px]"
                  value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
              </div>
              <Select value={filterGroup} onValueChange={setFilterGroup}>
                <SelectTrigger className="w-[160px]"><SelectValue placeholder="分组筛选" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部分组</SelectItem>
                  {groups.map(g => <SelectItem key={g} value={g}>{g}</SelectItem>)}
                </SelectContent>
              </Select>
              {connections.length > 0 && (
                <Select value={selectedConnection || 'all'} onValueChange={v => setSelectedConnection(v === 'all' ? null : v)}>
                  <SelectTrigger className="w-[200px]"><SelectValue placeholder="PLC连接" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部连接</SelectItem>
                    {connections.map(c => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name} ({c.ip}){(c as any).reactor_id ? ` — Unit: ${(c as any).reactor_id}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={loadDefaultTemplate}>
                <RefreshCw className="w-4 h-4 mr-1" /> 加载默认模板
              </Button>
              <Button variant="outline" size="sm" onClick={testAllVariables}>
                <TestTube className="w-4 h-4 mr-1" /> 全部测试
              </Button>
              <Button size="sm" onClick={() => { setEditingVariable(null); setShowVariableDialog(true); }}>
                <Plus className="w-4 h-4 mr-1" /> 添加变量
              </Button>
            </div>
          </div>

          {/* 变量表格 */}
          <Card>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[50px]">启用</TableHead>
                    <TableHead>变量名</TableHead>
                    <TableHead>描述</TableHead>
                    <TableHead>PLC地址</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>方向</TableHead>
                    <TableHead>实时值</TableHead>
                    <TableHead>工程范围</TableHead>
                    <TableHead>分组</TableHead>
                    <TableHead>轮询</TableHead>
                    <TableHead className="w-[140px]">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredVariables.map(v => (
                    <TableRow key={v.id} className={v.enabled ? '' : 'opacity-50'}>
                      <TableCell>
                        <Switch checked={v.enabled} onCheckedChange={async (checked) => {
                          await saveVariable({ ...v, enabled: checked });
                        }} />
                      </TableCell>
                      <TableCell className="font-mono text-sm font-medium">{v.tag_name}</TableCell>
                      <TableCell className="text-sm">{v.description}</TableCell>
                      <TableCell className="font-mono text-sm">{v.plc_address}</TableCell>
                      <TableCell><Badge variant="outline" className="text-sm">{v.data_type}</Badge></TableCell>
                      <TableCell>
                        <Badge variant={v.direction === 'READ' ? 'secondary' : v.direction === 'WRITE' ? 'default' : 'outline'} className="text-sm">
                          {v.direction}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm font-mono">
                        {(() => {
                          const tr = varTestResults[v.id];
                          if (!tr) return <span className="text-muted-foreground">-</span>;
                          if (tr.testing) return <span className="text-blue-500">...</span>;
                          if (tr.ok) return (
                            <span className="text-green-600" title={tr.message}>
                              {tr.value !== undefined ? tr.value : '-'}
                              {v.eng_unit ? ` ${v.eng_unit}` : ''}
                            </span>
                          );
                          return <span className="text-red-500" title={tr.message}>ERR</span>;
                        })()}
                      </TableCell>
                      <TableCell className="text-sm">
                        {v.scaling_enabled
                          ? `${v.eng_min}~${v.eng_max} ${v.eng_unit}`
                          : <span className="text-muted-foreground">无转换</span>
                        }
                      </TableCell>
                      <TableCell>
                        <Badge className={`text-sm ${GROUP_COLORS[v.group as PLCVariableGroup] || ''}`}>
                          {v.group}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">{v.poll_rate_ms}ms</TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button size="icon" variant="ghost" className="h-7 w-7"
                            title="测试读取"
                            disabled={v.direction === 'WRITE' || varTestResults[v.id]?.testing}
                            onClick={() => testVariable(v)}>
                            <TestTube className="w-3 h-3" />
                          </Button>
                          <Button size="icon" variant="ghost" className="h-7 w-7"
                            onClick={() => { setEditingVariable(v); setShowVariableDialog(true); }}>
                            <Edit2 className="w-3 h-3" />
                          </Button>
                          <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive"
                            onClick={() => deleteVariable(v)}>
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {filteredVariables.length === 0 && (
              <div className="p-8 text-center text-muted-foreground">
                {variables.length === 0 ? '暂无变量映射, 点击"加载默认模板"快速初始化' : '无匹配结果'}
              </div>
            )}
          </Card>

          {/* 统计信息 */}
          <div className="flex gap-4 text-sm text-muted-foreground">
            <span>共 {variables.length} 个变量</span>
            <span>READ: {variables.filter(v => v.direction === 'READ').length}</span>
            <span>READWRITE: {variables.filter(v => v.direction === 'READWRITE').length}</span>
            <span>已启用: {variables.filter(v => v.enabled).length}</span>
          </div>
        </TabsContent>

        {/* ── Tab 3: 调试面板 (SP-PLC-2) ── */}
        <TabsContent value="debug" className="space-y-4">
          <DebugTab
            connections={connections}
            variables={variables}
            apiBase={API_BASE}
            apiFetch={apiFetch}
            audit={audit}
          />
        </TabsContent>
      </Tabs>

      {/* ── 连接编辑对话框 ── */}
      <ConnectionDialog
        open={showConnectionDialog}
        onClose={() => { setShowConnectionDialog(false); setEditingConnection(null); }}
        onSave={saveConnection}
        initial={editingConnection}
      />

      {/* ── 变量编辑对话框 ── */}
      <VariableDialog
        open={showVariableDialog}
        onClose={() => { setShowVariableDialog(false); setEditingVariable(null); }}
        onSave={saveVariable}
        initial={editingVariable}
        connections={connections}
        selectedConnection={selectedConnection}
      />

      {audit.dialog}
    </div>
  );
}

// ─── 连接编辑对话框 ─────────────────────────────────────────

// SP-PLC-1: 表单内部数据 = PLCConnection + 可选 reactor_id 绑定
interface ConnectionFormData extends PLCConnection {
  reactor_id?: string | null;
}

function ConnectionDialog({ open, onClose, onSave, initial }: {
  open: boolean;
  onClose: () => void;
  onSave: (c: ConnectionFormData) => Promise<string | null>;
  initial: (PLCConnection & { reactor_id?: string | null }) | null;
}) {
  const defaultConn: ConnectionFormData = {
    id: '', name: 'F01-PLC', protocol: 's7', ip: '192.168.1.10', port: 102,
    rack: 0, slot: 1, s7_db: 1,
    heartbeat_write_address: 'VB400', heartbeat_read_address: 'VB401',
    heartbeat_timeout_ms: 3000, reconnect_interval_ms: 5000, enabled: true,
    reactor_id: null,
  };
  const [form, setForm] = useState<ConnectionFormData>(defaultConn);
  // SP-PLC-1: 反应器列表(用于绑定 Unit 下拉)
  const [reactors, setReactors] = useState<Array<{ reactor_id: string; name: string }>>([]);

  useEffect(() => {
    if (!open) return;
    const tok = typeof window !== 'undefined' ? localStorage.getItem('biocore_token') ?? '' : '';
    fetch(`${API_BASE}/api/v1/reactor-configs`, { headers: { Authorization: `Bearer ${tok}` } })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(j => {
        const rows = j && typeof j === 'object' && 'data' in j ? j.data : j;
        if (Array.isArray(rows)) setReactors(rows);
      })
      .catch(() => { /* 静默 */ });
  }, [open]);

  useEffect(() => {
    if (initial) setForm({ ...initial, reactor_id: initial.reactor_id ?? null });
    else setForm({ ...defaultConn, id: crypto.randomUUID() });
    setSaveError(null);
  }, [initial, open]);

  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    const err = await onSave(form);
    setSaving(false);
    if (err) setSaveError(err);
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{initial ? '编辑PLC连接' : '添加PLC连接'}</DialogTitle>
          <DialogDescription>配置S7-200 SMART G2的网络参数</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4 max-h-[65vh] overflow-y-auto">
          <div className="grid grid-cols-4 items-center gap-4">
            <Label className="text-right">名称</Label>
            <Input className="col-span-3" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          </div>
          {/* SP-PLC-1: 绑定 Unit (reactor) */}
          <div className="grid grid-cols-4 items-center gap-4">
            <Label className="text-right">绑定 Unit</Label>
            <Select
              value={form.reactor_id ?? '__none__'}
              onValueChange={v => setForm({ ...form, reactor_id: v === '__none__' ? null : v })}
            >
              <SelectTrigger className="col-span-3"><SelectValue placeholder="未绑定" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">未绑定</SelectItem>
                {reactors.map(r => (
                  <SelectItem key={r.reactor_id} value={r.reactor_id}>{r.reactor_id} — {r.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-4 items-center gap-4">
            <Label className="text-right">协议</Label>
            <Select value={form.protocol} onValueChange={(v) => { const p = v as PLCProtocol; setForm({
              ...form, protocol: p, port: p === 's7' ? 102 : p === 'modbus_tcp' ? 502 : form.port,
            }); }}>
              <SelectTrigger className="col-span-3"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="s7">S7协议 (node-snap7)</SelectItem>
                <SelectItem value="modbus_tcp">Modbus TCP</SelectItem>
                <SelectItem value="modbus_rtu">Modbus RTU (串口)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-4 items-center gap-4">
            <Label className="text-right">IP地址</Label>
            <Input className="col-span-3" value={form.ip} onChange={e => setForm({ ...form, ip: e.target.value })} placeholder="192.168.1.10" />
          </div>
          <div className="grid grid-cols-4 items-center gap-4">
            <Label className="text-right">端口</Label>
            <Input className="col-span-3" type="number" value={form.port} onChange={e => setForm({ ...form, port: parseInt(e.target.value) })} />
          </div>
          {form.protocol === 's7' && (
            <>
              <div className="grid grid-cols-4 items-center gap-4">
                <Label className="text-right">Rack</Label>
                <Input className="col-span-1" type="number" value={form.rack} onChange={e => setForm({ ...form, rack: parseInt(e.target.value) })} />
                <Label className="text-right">Slot</Label>
                <Input className="col-span-1" type="number" value={form.slot} onChange={e => setForm({ ...form, slot: parseInt(e.target.value) })} />
              </div>
              <div className="grid grid-cols-4 items-center gap-4">
                <Label className="text-right">DB号</Label>
                <Input className="col-span-3" type="number" value={form.s7_db} onChange={e => setForm({ ...form, s7_db: parseInt(e.target.value) })} />
                <span className="col-span-4 text-sm text-muted-foreground pl-[calc(25%+1rem)]">
                  S7-200 SMART V区通常映射为DB1, 通讯数据块可能在DB2
                </span>
              </div>
            </>
          )}
          {form.protocol === 'modbus_rtu' && (
            <>
              <div className="grid grid-cols-4 items-center gap-4">
                <Label className="text-right">串口</Label>
                <Input className="col-span-3" value={form.serial_port || ''} onChange={e => setForm({ ...form, serial_port: e.target.value })} placeholder="COM3 或 /dev/ttyUSB0" />
              </div>
              <div className="grid grid-cols-4 items-center gap-4">
                <Label className="text-right">波特率</Label>
                <Select value={String(form.baudrate || 9600)} onValueChange={v => setForm({ ...form, baudrate: parseInt(v) })}>
                  <SelectTrigger className="col-span-3"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {[4800, 9600, 19200, 38400, 57600, 115200].map(b => (
                      <SelectItem key={b} value={String(b)}>{b}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-4 items-center gap-4">
                <Label className="text-right">校验</Label>
                <Select value={form.parity || 'even'} onValueChange={v => setForm({ ...form, parity: v as any })}>
                  <SelectTrigger className="col-span-3"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="even">Even</SelectItem>
                    <SelectItem value="odd">Odd</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
          {(form.protocol === 'modbus_rtu' || form.protocol === 'modbus_tcp') && (
            <div className="grid grid-cols-4 items-center gap-4">
              <Label className="text-right">从站号</Label>
              <Input className="col-span-3" type="number" value={form.slave_id || 1} onChange={e => setForm({ ...form, slave_id: parseInt(e.target.value) })} />
            </div>
          )}
          <div className="grid grid-cols-4 items-center gap-4">
            <Label className="text-right">PC→PLC心跳</Label>
            <Input className="col-span-3" value={form.heartbeat_write_address} onChange={e => setForm({ ...form, heartbeat_write_address: e.target.value })} placeholder="VB400" />
          </div>
          <div className="grid grid-cols-4 items-center gap-4">
            <Label className="text-right">PLC→PC心跳</Label>
            <Input className="col-span-3" value={form.heartbeat_read_address} onChange={e => setForm({ ...form, heartbeat_read_address: e.target.value })} placeholder="VB401" />
          </div>
          <div className="grid grid-cols-4 items-center gap-4">
            <Label className="text-right">心跳超时</Label>
            <Input className="col-span-3" type="number" value={form.heartbeat_timeout_ms} onChange={e => setForm({ ...form, heartbeat_timeout_ms: parseInt(e.target.value) })} />
          </div>
          <div className="grid grid-cols-4 items-center gap-4">
            <Label className="text-right">启用</Label>
            <Switch checked={form.enabled} onCheckedChange={v => setForm({ ...form, enabled: v })} />
          </div>
        </div>
        {saveError && (
          <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {saveError}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={handleSave} disabled={saving}>
            <Save className="w-4 h-4 mr-1" /> {saving ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── 变量编辑对话框 ─────────────────────────────────────────

function VariableDialog({ open, onClose, onSave, initial, connections, selectedConnection }: {
  open: boolean;
  onClose: () => void;
  onSave: (v: PLCVariableMapping) => Promise<string | null>;
  initial: PLCVariableMapping | null;
  connections: PLCConnection[];
  selectedConnection: string | null;
}) {
  const [form, setForm] = useState<PLCVariableMapping>({
    id: '', tag_name: '', description: '', plc_address: 'VW0',
    data_type: 'INT16', direction: 'READ', scaling_enabled: false,
    raw_min: 0, raw_max: 27648, eng_min: 0, eng_max: 100, eng_unit: '',
    group: '模拟量输入', poll_rate_ms: 1000, enabled: true, connection_id: '',
  });

  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (initial) setForm(initial);
    else setForm({
      id: crypto.randomUUID(), tag_name: '', description: '', plc_address: '',
      data_type: 'INT16', direction: 'READ', scaling_enabled: false,
      raw_min: 0, raw_max: 27648, eng_min: 0, eng_max: 100, eng_unit: '',
      group: '模拟量输入', poll_rate_ms: 1000, enabled: true,
      connection_id: selectedConnection || connections[0]?.id || '',
    });
    setSaveError(null);
  }, [initial, open, selectedConnection, connections]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    const err = await onSave(form);
    setSaving(false);
    if (err) setSaveError(err);
  };

  const allGroups: PLCVariableGroup[] = ['模拟量输入', '模拟量输出', '数字量输入', '数字量输出', '设定值', 'PID参数', '控制字', '状态字', '报警', '变频器', '心跳'];
  const dataTypes: PLCDataType[] = ['BOOL', 'INT16', 'INT32', 'FLOAT32', 'UINT16'];
  const directions: PLCDirection[] = ['READ', 'READWRITE'];

  // 前端地址校验 (与后端 validateAddr 同步)
  const VALID_ADDR_PATTERNS = [
    /^DB\d{1,3}\.DBB\d{1,4}$/i,
    /^DB\d{1,3}\.DBW\d{1,4}$/i,
    /^DB\d{1,3}\.DBD\d{1,4}$/i,
    /^DB\d{1,3}\.DBX\d{1,4}\.[0-7]$/i,
    /^DBB\d{1,4}$/i, /^DBW\d{1,4}$/i, /^DBD\d{1,4}$/i,
    /^DBX\d{1,4}\.[0-7]$/i,
    /^VB\d{1,4}$/i, /^VW\d{1,4}$/i, /^VD\d{1,4}$/i,
    /^V\d{1,4}\.[0-7]$/i,
  ];

  const addrError = (() => {
    const addr = form.plc_address.trim();
    if (!addr) return '地址不能为空';
    if (!VALID_ADDR_PATTERNS.some(p => p.test(addr))) {
      return '无效地址 (合法: DB2.DBW4, DBW4, VW100, V200.0 等)';
    }
    // BOOL类型必须用位地址
    const isBitAddr = /\.\d$/.test(addr) && !/\.\d{2,}$/.test(addr);
    if (form.data_type === 'BOOL' && !isBitAddr) return 'BOOL类型必须使用位地址 (如 DB2.DBX0.3, V200.0)';
    if (form.data_type !== 'BOOL' && isBitAddr && !addr.includes('.DB')) return '非BOOL类型不能使用位地址';
    return null;
  })();

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{initial ? '编辑变量' : '添加变量'}</DialogTitle>
          <DialogDescription>配置系统Tag与PLC V区地址的映射关系</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-4 max-h-[60vh] overflow-y-auto">
          <div className="grid grid-cols-4 items-center gap-3">
            <Label className="text-right text-sm">变量名 *</Label>
            <Input className="col-span-3 font-mono" value={form.tag_name}
              onChange={e => setForm({ ...form, tag_name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })}
              placeholder="TEMP_PV" />
          </div>
          <div className="grid grid-cols-4 items-center gap-3">
            <Label className="text-right text-sm">描述</Label>
            <Input className="col-span-3" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="罐内温度过程值" />
          </div>
          <div className="grid grid-cols-4 items-center gap-3">
            <Label className="text-right text-sm">PLC地址 *</Label>
            <div className="col-span-3 space-y-1">
              <Input className={`font-mono ${addrError ? 'border-red-500' : ''}`} value={form.plc_address}
                onChange={e => setForm({ ...form, plc_address: e.target.value.trim() })}
                placeholder="DB2.DBW4 或 VW100" />
              {addrError && <p className="text-sm text-red-500">{addrError}</p>}
              {!addrError && form.plc_address && <p className="text-sm text-green-600">地址有效</p>}
            </div>
          </div>
          <div className="grid grid-cols-4 items-center gap-3">
            <Label className="text-right text-sm">数据类型</Label>
            <Select value={form.data_type} onValueChange={v => setForm({ ...form, data_type: v as PLCDataType })}>
              <SelectTrigger className="col-span-3"><SelectValue /></SelectTrigger>
              <SelectContent>{dataTypes.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-4 items-center gap-3">
            <Label className="text-right text-sm">读写方向</Label>
            <Select value={form.direction} onValueChange={v => setForm({ ...form, direction: v as PLCDirection })}>
              <SelectTrigger className="col-span-3"><SelectValue /></SelectTrigger>
              <SelectContent>{directions.map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-4 items-center gap-3">
            <Label className="text-right text-sm">分组</Label>
            <Select value={form.group} onValueChange={v => setForm({ ...form, group: v as PLCVariableGroup })}>
              <SelectTrigger className="col-span-3"><SelectValue /></SelectTrigger>
              <SelectContent>{allGroups.map(g => <SelectItem key={g} value={g}>{g}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-4 items-center gap-3">
            <Label className="text-right text-sm">工程量转换</Label>
            <Switch checked={form.scaling_enabled} onCheckedChange={v => setForm({ ...form, scaling_enabled: v })} />
          </div>
          {form.scaling_enabled && (
            <>
              <div className="grid grid-cols-4 items-center gap-3">
                <Label className="text-right text-sm">原始范围</Label>
                <div className="col-span-3 flex gap-2 items-center">
                  <Input type="number" value={form.raw_min} onChange={e => setForm({ ...form, raw_min: parseFloat(e.target.value) })} className="w-24" />
                  <span>~</span>
                  <Input type="number" value={form.raw_max} onChange={e => setForm({ ...form, raw_max: parseFloat(e.target.value) })} className="w-24" />
                </div>
              </div>
              <div className="grid grid-cols-4 items-center gap-3">
                <Label className="text-right text-sm">工程范围</Label>
                <div className="col-span-3 flex gap-2 items-center">
                  <Input type="number" value={form.eng_min} onChange={e => setForm({ ...form, eng_min: parseFloat(e.target.value) })} className="w-24" />
                  <span>~</span>
                  <Input type="number" value={form.eng_max} onChange={e => setForm({ ...form, eng_max: parseFloat(e.target.value) })} className="w-24" />
                  <Input value={form.eng_unit} onChange={e => setForm({ ...form, eng_unit: e.target.value })} className="w-16" placeholder="单位" />
                </div>
              </div>
            </>
          )}
          <div className="grid grid-cols-4 items-center gap-3">
            <Label className="text-right text-sm">轮询周期</Label>
            <Select value={String(form.poll_rate_ms)} onValueChange={v => setForm({ ...form, poll_rate_ms: parseInt(v) })}>
              <SelectTrigger className="col-span-3"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="100">100ms (安全/报警)</SelectItem>
                <SelectItem value="1000">1000ms (标准PV)</SelectItem>
                <SelectItem value="10000">10000ms (配置/慢速)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-4 items-center gap-3">
            <Label className="text-right text-sm">PLC连接</Label>
            <Select value={form.connection_id} onValueChange={v => setForm({ ...form, connection_id: v })}>
              <SelectTrigger className="col-span-3"><SelectValue /></SelectTrigger>
              <SelectContent>{connections.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        {saveError && (
          <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {saveError}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={handleSave} disabled={!form.tag_name || !form.plc_address || !!addrError || saving}>
            <Save className="w-4 h-4 mr-1" /> {saving ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── CSV 解析工具 ───────────────────────────────────────────

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}
