// SP-RG-4: Phase Instances 管理页 — phase class 绑定到 reactor 的中间层。
'use client';

import React, { useEffect, useState } from 'react';
import { usePhaseInstances, type PhaseInstance } from '@/hooks/usePhaseInstances';

interface ParamSchemaEntry {
  key?: string;
  plc_tag?: string;
  label?: string;
  type?: string;          // 'number' | 'text' | 'select' | ...
  unit?: string;
  eng_unit?: string;
  default?: unknown;
  default_value?: unknown;
  min?: number;
  max?: number;
  options?: Array<{ value: string; label?: string } | string>;
}
interface ClassMeta {
  type: string;
  label: string;
  color: string;
  default_params: Record<string, unknown>;
  param_schema?: ParamSchemaEntry[];
}
interface ReactorMeta { reactor_id: string; name: string }

function jwtHeader(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const t = localStorage.getItem('biocore_token');
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: jwtHeader() });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return (j && typeof j === 'object' && 'data' in j ? j.data : j) as T;
}

export default function PhaseInstancesPage(): JSX.Element {
  const [reactorFilter, setReactorFilter] = useState<string>('');
  const [classFilter, setClassFilter] = useState<string>('');
  const { instances, loading, error, create, update, remove, refetch } = usePhaseInstances({
    reactor: reactorFilter || undefined,
    phaseClass: classFilter || undefined,
  });
  const [classes, setClasses] = useState<ClassMeta[]>([]);
  const [reactors, setReactors] = useState<ReactorMeta[]>([]);
  const [editing, setEditing] = useState<PhaseInstance | null>(null);
  const [creating, setCreating] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [cls, rxs] = await Promise.all([
          jget<ClassMeta[]>('/api/v1/phase-templates'),
          jget<ReactorMeta[]>('/api/v1/reactor-configs'),
        ]);
        setClasses(Array.isArray(cls) ? cls : []);
        setReactors(Array.isArray(rxs) ? rxs : []);
      } catch (e) {
        setOpError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  async function handleDelete(id: string): Promise<void> {
    if (!confirm(`删除 phase instance "${id}"?`)) return;
    try { await remove(id); setOpError(null); }
    catch (e) { setOpError(e instanceof Error ? e.message : String(e)); }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-semibold mb-4">Phase Instances <span className="text-sm text-zinc-400 font-normal">— phase class 绑定到反应器的中间层</span></h1>

      <div className="flex gap-2 items-end mb-4">
        <div>
          <label className="block text-xs text-zinc-500 mb-1">按反应器筛选</label>
          <select value={reactorFilter} onChange={(e) => setReactorFilter(e.target.value)} className="border border-zinc-300 rounded px-2 py-1 text-sm">
            <option value="">全部</option>
            {reactors.map(r => <option key={r.reactor_id} value={r.reactor_id}>{r.reactor_id} — {r.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1">按 Phase Class 筛选</label>
          <select value={classFilter} onChange={(e) => setClassFilter(e.target.value)} className="border border-zinc-300 rounded px-2 py-1 text-sm">
            <option value="">全部</option>
            {classes.map(c => <option key={c.type} value={c.type}>{c.label} ({c.type})</option>)}
          </select>
        </div>
        <button onClick={() => setCreating(true)} className="ml-auto px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">
          + 新建 Instance
        </button>
        <button onClick={() => refetch()} className="px-3 py-1.5 border border-zinc-300 rounded text-sm hover:bg-zinc-50">
          刷新
        </button>
      </div>

      {opError && (
        <div className="mb-3 p-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded flex items-center justify-between">
          <span>{opError}</span>
          <button onClick={() => setOpError(null)} className="ml-2 text-red-600 hover:text-red-800">✕</button>
        </div>
      )}

      {loading ? (
        <div className="text-zinc-500">加载中...</div>
      ) : error ? (
        <div className="text-red-600">错误: {error.message}</div>
      ) : instances.length === 0 ? (
        <div className="text-zinc-500 p-8 text-center border border-dashed border-zinc-300 rounded">
          暂无 phase instance — 点击"新建 Instance" 创建第一个绑定
        </div>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-zinc-100 text-left">
              <th className="px-3 py-2 border-b">Instance ID</th>
              <th className="px-3 py-2 border-b">Phase Class</th>
              <th className="px-3 py-2 border-b">Reactor</th>
              <th className="px-3 py-2 border-b">标签</th>
              <th className="px-3 py-2 border-b">params 覆盖</th>
              <th className="px-3 py-2 border-b">创建</th>
              <th className="px-3 py-2 border-b w-32 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {instances.map(inst => (
              <tr key={inst.instance_id} className="hover:bg-zinc-50 border-b">
                <td className="px-3 py-2 font-mono text-xs">{inst.instance_id}</td>
                <td className="px-3 py-2">{inst.phase_class}</td>
                <td className="px-3 py-2 font-mono text-xs">{inst.reactor_id}</td>
                <td className="px-3 py-2">{inst.label || <span className="text-zinc-400">—</span>}</td>
                <td className="px-3 py-2 font-mono text-xs text-zinc-600 max-w-[300px] truncate" title={JSON.stringify(inst.params_override)}>
                  {Object.keys(inst.params_override).length === 0
                    ? <span className="text-zinc-400">{`{}`}</span>
                    : JSON.stringify(inst.params_override)}
                </td>
                <td className="px-3 py-2 text-xs text-zinc-500">{inst.created_at}</td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => setEditing(inst)} className="text-blue-600 hover:underline mr-3">编辑</button>
                  <button onClick={() => handleDelete(inst.instance_id)} className="text-red-600 hover:underline">删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {creating && (
        <PhaseInstanceDialog
          classes={classes}
          reactors={reactors}
          existingIds={instances.map(i => i.instance_id)}
          onSave={async (form) => {
            try { await create(form); setCreating(false); setOpError(null); }
            catch (e) { setOpError(e instanceof Error ? e.message : String(e)); }
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      {editing && (
        <PhaseInstanceDialog
          initial={editing}
          classes={classes}
          reactors={reactors}
          isEdit
          onSave={async (form) => {
            try {
              await update(editing.instance_id, {
                phase_class: form.phase_class,
                reactor_id: form.reactor_id,
                label: form.label,
                params_override: form.params_override,
                notes: form.notes,
              });
              setEditing(null);
              setOpError(null);
            } catch (e) { setOpError(e instanceof Error ? e.message : String(e)); }
          }}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}

interface FormState {
  instance_id: string;
  phase_class: string;
  reactor_id: string;
  label: string;
  params_override: Record<string, unknown>;
  notes: string;
}

function nextInstanceId(existing: string[]): string {
  // 找出形如 "instance<N>" 的最大 N,返回 instance(N+1)
  let maxN = 0;
  for (const id of existing) {
    const m = /^instance(\d+)$/i.exec(id);
    if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
  }
  return `instance${maxN + 1}`;
}

function PhaseInstanceDialog({
  initial, classes, reactors, existingIds = [], isEdit, onSave, onCancel,
}: {
  initial?: PhaseInstance;
  classes: ClassMeta[];
  reactors: ReactorMeta[];
  existingIds?: string[];
  isEdit?: boolean;
  onSave: (form: FormState) => void | Promise<void>;
  onCancel: () => void;
}): JSX.Element {
  const initialClass = initial?.phase_class ?? classes[0]?.type ?? '';
  // Merge: class default_params (基线) overridden by initial.params_override (已存的覆盖)
  const initialParams: Record<string, unknown> = (() => {
    const cls = classes.find(c => c.type === initialClass);
    return { ...(cls?.default_params ?? {}), ...(initial?.params_override ?? {}) };
  })();
  const [form, setForm] = useState<FormState>(() => ({
    instance_id: initial?.instance_id ?? (isEdit ? '' : nextInstanceId(existingIds)),
    phase_class: initialClass,
    reactor_id: initial?.reactor_id ?? reactors[0]?.reactor_id ?? '',
    label: initial?.label ?? '',
    params_override: initialParams,
    notes: initial?.notes ?? '',
  }));

  const currentClass = classes.find(c => c.type === form.phase_class);

  // 合并 param_schema 与 default_params,产出统一字段列表(模板没显式 schema 时按 default_params 键展开)。
  const fields: ParamSchemaEntry[] = (() => {
    if (!currentClass) return [];
    const schema = (currentClass.param_schema ?? []) as ParamSchemaEntry[];
    const known = new Set<string>();
    const list: ParamSchemaEntry[] = [];
    for (const e of schema) {
      const k = e.key || e.plc_tag;
      if (!k) continue;
      known.add(k);
      list.push({ ...e, key: k });
    }
    for (const k of Object.keys(currentClass.default_params ?? {})) {
      if (!known.has(k)) list.push({ key: k, label: k });
    }
    return list;
  })();

  function setParam(key: string, value: unknown): void {
    setForm(f => ({ ...f, params_override: { ...f.params_override, [key]: value } }));
  }

  function changeClass(newClass: string): void {
    const cls = classes.find(c => c.type === newClass);
    setForm(f => ({
      ...f,
      phase_class: newClass,
      params_override: { ...(cls?.default_params ?? {}) },
    }));
  }

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    void onSave(form);
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onCancel}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="bg-white rounded-lg shadow-xl w-full max-w-lg p-5"
      >
        <h2 className="text-lg font-semibold mb-4">{isEdit ? '编辑' : '新建'} Phase Instance</h2>

        <div className="space-y-3">
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Instance ID *</label>
            <input
              value={form.instance_id}
              onChange={(e) => setForm(f => ({ ...f, instance_id: e.target.value }))}
              required disabled={isEdit}
              placeholder="e.g. F01_HEATING_01"
              className="w-full border border-zinc-300 rounded px-2 py-1.5 text-sm font-mono disabled:bg-zinc-100"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Phase Class *</label>
              <select
                value={form.phase_class}
                onChange={(e) => changeClass(e.target.value)}
                required
                className="w-full border border-zinc-300 rounded px-2 py-1.5 text-sm"
              >
                {classes.map(c => <option key={c.type} value={c.type}>{c.label} ({c.type})</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Reactor *</label>
              <select
                value={form.reactor_id}
                onChange={(e) => setForm(f => ({ ...f, reactor_id: e.target.value }))}
                required
                className="w-full border border-zinc-300 rounded px-2 py-1.5 text-sm"
              >
                {reactors.map(r => <option key={r.reactor_id} value={r.reactor_id}>{r.reactor_id} — {r.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">显示标签</label>
            <input
              value={form.label}
              onChange={(e) => setForm(f => ({ ...f, label: e.target.value }))}
              placeholder="留空则用 phase class 默认"
              className="w-full border border-zinc-300 rounded px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">参数 (来自 phase class 模板)</label>
            {fields.length === 0 ? (
              <div className="text-xs text-zinc-400 italic px-2 py-2 bg-zinc-50 border border-zinc-200 rounded">
                此 Phase Class 模板无可编辑参数
              </div>
            ) : (
              <div className="space-y-2 border border-zinc-200 rounded p-2 bg-zinc-50">
                {fields.map((field) => {
                  const k = field.key!;
                  const val = form.params_override[k];
                  const unit = field.unit || field.eng_unit || '';
                  const fieldLabel = field.label || k;
                  const isNumber = field.type === 'number' || typeof val === 'number';
                  const hasOptions = Array.isArray(field.options) && field.options.length > 0;
                  return (
                    <div key={k} className="grid grid-cols-3 gap-2 items-center">
                      <label className="text-xs text-zinc-600 col-span-1 truncate" title={k}>
                        {fieldLabel}
                        {unit && <span className="text-zinc-400 ml-1">({unit})</span>}
                      </label>
                      {hasOptions ? (
                        <select
                          value={String(val ?? '')}
                          onChange={(e) => setParam(k, e.target.value)}
                          className="col-span-2 border border-zinc-300 rounded px-2 py-1 text-xs"
                        >
                          <option value="">--</option>
                          {field.options!.map((opt, i) => {
                            const value = typeof opt === 'string' ? opt : opt.value;
                            const label = typeof opt === 'string' ? opt : (opt.label || opt.value);
                            return <option key={i} value={value}>{label}</option>;
                          })}
                        </select>
                      ) : (
                        <input
                          type={isNumber ? 'number' : 'text'}
                          value={val === undefined || val === null ? '' : String(val)}
                          onChange={(e) => {
                            const raw = e.target.value;
                            if (raw === '') { setParam(k, undefined); return; }
                            setParam(k, isNumber ? parseFloat(raw) : raw);
                          }}
                          {...(field.min !== undefined ? { min: field.min } : {})}
                          {...(field.max !== undefined ? { max: field.max } : {})}
                          className="col-span-2 border border-zinc-300 rounded px-2 py-1 text-xs font-mono"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">备注</label>
            <input
              value={form.notes}
              onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))}
              className="w-full border border-zinc-300 rounded px-2 py-1.5 text-sm"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button type="button" onClick={onCancel} className="px-3 py-1.5 border border-zinc-300 rounded text-sm hover:bg-zinc-50">取消</button>
          <button type="submit" className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">
            {isEdit ? '保存' : '创建'}
          </button>
        </div>
      </form>
    </div>
  );
}
