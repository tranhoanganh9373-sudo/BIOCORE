// ============================================================
// 拖拽式配方编辑器
//
// 布局: 左侧Phase模板面板(点击添加) | 右侧配方时间线(拖拽排序)
// 交互: 点击左侧模板 → 添加到末尾 → 时间线内拖拽排序 → 点击展开参数
// 路由: /recipes/[id]/edit
// ============================================================

'use client';

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor,
  useSensor, useSensors, DragEndEvent, DragStartEvent, DragOverlay,
} from '@dnd-kit/core';
import {
  SortableContext, verticalListSortingStrategy,
  useSortable, arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  GripVertical, Plus, Trash2, ChevronDown, ChevronRight,
  Save, Download, Upload, Code, CheckCircle, AlertCircle,
  Copy, ClipboardPaste, CheckSquare, Square,
} from 'lucide-react';
import { phaseLabel } from '@/lib/utils';
import { useAudit } from '@/hooks/useAudit';
import { copyPhases, readClipboard, preparePaste, type ClipboardPhase } from '@/lib/phase-clipboard';
import { useLocale } from '@/i18n/useLocale';
const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// Phase模板从API动态加载，不再使用硬编码
interface APIPhaseTemplate {
  type: string;
  label: string;
  color: string;
  category: string;
  description: string;
  fixed_steps: number;
  default_params: Record<string, any>;
  param_schema: any[];
  steps: any[];
}

interface ParamField {
  key?: string;
  plc_tag?: string;
  label: string;
  type?: 'number' | 'text' | 'select' | 'boolean';
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  default?: any;
  default_value?: any;
  options?: { value: string; label: string }[];
  required?: boolean;
  condition?: { field: string; value: any };
}

interface PhaseInstance {
  id: string;
  phase_id: string;
  type: string;
  label: string;
  params: Record<string, any>;
  expanded: boolean;
  instance_id?: string;  // SP-RG-4: 绑定的 phase instance id
}

// SP-RG-4: phase class 绑到 reactor 的中间层
interface APIPhaseInstance {
  instance_id: string;
  phase_class: string;
  reactor_id: string;
  label: string | null;
  params_override: Record<string, unknown>;
}

type ExecutionMode = 'free' | 'sequential';

interface RecipeData {
  recipe_id: string;
  name: string;
  version: string;
  author: string;
  target_organism: string;
  execution_mode?: ExecutionMode;
  vessel_config: { id: string; working_volume_L: number };
  phases: Array<{ phase_id: string; type: string; params: Record<string, any> }>;
  status?: string;
}

// ─── Color map (avoids dynamic Tailwind class purging) ───────

const COLOR_MAP: Record<string, { bg: string; text: string; border: string; dot: string }> = {
  gray:    { bg: 'bg-gray-100',    text: 'text-gray-800',    border: 'border-gray-200',    dot: 'bg-gray-500' },
  blue:    { bg: 'bg-blue-100',    text: 'text-blue-800',    border: 'border-blue-200',    dot: 'bg-blue-500' },
  amber:   { bg: 'bg-amber-100',   text: 'text-amber-800',   border: 'border-amber-200',   dot: 'bg-amber-500' },
  red:     { bg: 'bg-red-100',     text: 'text-red-800',     border: 'border-red-200',     dot: 'bg-red-500' },
  orange:  { bg: 'bg-orange-100',  text: 'text-orange-800',  border: 'border-orange-200',  dot: 'bg-orange-500' },
  teal:    { bg: 'bg-teal-100',    text: 'text-teal-800',    border: 'border-teal-200',    dot: 'bg-teal-500' },
  green:   { bg: 'bg-green-100',   text: 'text-green-800',   border: 'border-green-200',   dot: 'bg-green-500' },
  purple:  { bg: 'bg-purple-100',  text: 'text-purple-800',  border: 'border-purple-200',  dot: 'bg-purple-500' },
  cyan:    { bg: 'bg-cyan-100',    text: 'text-cyan-800',    border: 'border-cyan-200',    dot: 'bg-cyan-500' },
  sky:     { bg: 'bg-sky-100',     text: 'text-sky-800',     border: 'border-sky-200',     dot: 'bg-sky-500' },
  emerald: { bg: 'bg-emerald-100', text: 'text-emerald-800', border: 'border-emerald-200', dot: 'bg-emerald-500' },
  slate:   { bg: 'bg-slate-100',   text: 'text-slate-800',   border: 'border-slate-200',   dot: 'bg-slate-500' },
  indigo:  { bg: 'bg-indigo-100',  text: 'text-indigo-800',  border: 'border-indigo-200',  dot: 'bg-indigo-500' },
};

function getColor(c: string) { return COLOR_MAP[c] ?? COLOR_MAP.gray; }

// ─── Phase Instance 面板 (左侧, 从 /api/v1/phase-instances 加载) ─────
// 配方编辑应直接绑实例,不暴露模板库.

function PhaseInstancePalette({
  instances, templates, onAdd,
}: {
  instances: APIPhaseInstance[];
  templates: APIPhaseTemplate[];
  onAdd: (inst: APIPhaseInstance) => void;
}) {
  // 按 reactor 分组
  const groups = useMemo(() => {
    const map = new Map<string, APIPhaseInstance[]>();
    for (const inst of instances) {
      const key = inst.reactor_id || '未绑定 reactor';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(inst);
    }
    return [...map.entries()].map(([title, items]) => ({ title, items }));
  }, [instances]);

  return (
    <div className="w-[240px] flex-shrink-0 border-r overflow-y-auto p-3 space-y-4">
      <div className="text-sm font-medium text-muted-foreground">
        Phase Instance <span className="text-muted-foreground/60">({instances.length})</span>
      </div>
      <p className="text-sm text-muted-foreground">点击添加到配方时间线</p>
      {groups.map(group => (
        <div key={group.title} className="space-y-1.5">
          <div className="text-sm font-medium text-muted-foreground uppercase tracking-wider font-mono">{group.title}</div>
          {group.items.map(inst => {
            const tmpl = templates.find(t => t.type === inst.phase_class);
            const c = getColor(tmpl?.color || 'gray');
            return (
              <button key={inst.instance_id} onClick={() => onAdd(inst)}
                className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md border border-transparent
                  hover:border-border hover:bg-muted/50 text-left text-sm transition-colors group">
                <div className={`w-2 h-2 rounded-full ${c.dot} flex-shrink-0`} />
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate font-mono">{inst.instance_id}</div>
                  <div className="text-[12px] text-muted-foreground truncate">
                    {inst.label || tmpl?.label || inst.phase_class}
                  </div>
                </div>
                <Plus className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100" />
              </button>
            );
          })}
        </div>
      ))}
      {instances.length === 0 && (
        <div className="text-sm text-muted-foreground italic">
          暂无 Phase Instance — 到 <a href="/phase-instances" target="_blank" className="text-blue-500 underline">/phase-instances</a> 创建
        </div>
      )}
    </div>
  );
}

// ─── 参数输入组件 ─────────────────────────────────────────────

function ParamInput({ field, value, onChange }: { field: ParamField; value: any; onChange: (v: any) => void }) {
  return (
    <div className="space-y-1">
      <Label className="text-sm">
        {field.label}
        {field.unit && <span className="text-muted-foreground ml-1">({field.unit})</span>}
        {field.required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      {field.type === 'number' && (
        <Input type="number" value={value ?? ''} className="h-8 text-sm"
          min={field.min} max={field.max} step={field.step}
          onChange={(e) => onChange(e.target.value === '' ? undefined : parseFloat(e.target.value))} />
      )}
      {field.type === 'text' && (
        <Input type="text" value={value ?? ''} className="h-8 text-sm"
          onChange={(e) => onChange(e.target.value)} />
      )}
      {field.type === 'select' && (
        <Select value={String(value ?? '')} onValueChange={onChange}>
          <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            {field.options?.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
      {field.type === 'boolean' && (
        <Switch checked={!!value} onCheckedChange={onChange} />
      )}
    </div>
  );
}

// ─── 可排序Phase卡片 ──────────────────────────────────────────

function SortablePhaseCard({ phase, index, total, executionMode, isSelected, onRemove, onToggle, onParamChange, onLabelChange, onCopy, onSelect, getTemplate }: {
  phase: PhaseInstance; index: number; total: number; executionMode: ExecutionMode;
  isSelected: boolean;
  onRemove: () => void; onToggle: () => void;
  onParamChange: (key: string, value: any) => void;
  onLabelChange: (label: string) => void;
  onCopy: () => void;
  onSelect: () => void;
  getTemplate: (type: string) => APIPhaseTemplate | undefined;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: phase.id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };
  const tmpl = getTemplate(phase.type);
  const c = getColor(tmpl?.color || 'gray');

  return (
    <div ref={setNodeRef} style={style} className="group">
      <Card className={`border ${isDragging ? 'border-primary shadow-lg' : isSelected ? 'border-primary/60 bg-primary/5' : 'border-border'}`}>
        <div className="flex items-center gap-2 px-3 py-2.5 cursor-pointer" onClick={onToggle}>
          {/* M3.4: 多选 checkbox */}
          <button
            onClick={(e) => { e.stopPropagation(); onSelect(); }}
            className="p-0.5 hover:bg-muted rounded flex-shrink-0"
            title={isSelected ? '取消选中' : '选中用于批量复制'}
          >
            {isSelected ? <CheckSquare className="w-3.5 h-3.5 text-primary" /> : <Square className="w-3.5 h-3.5 text-muted-foreground" />}
          </button>
          <div {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing p-0.5 hover:bg-muted rounded"
            onClick={(e) => e.stopPropagation()}>
            <GripVertical className="w-4 h-4 text-muted-foreground" />
          </div>
          <Badge variant="outline" className="text-sm font-mono w-6 h-6 flex items-center justify-center p-0">
            {index + 1}
          </Badge>
          <Badge className={`text-sm ${c.bg} ${c.text} ${c.border}`}>{phaseLabel(phase.type, tmpl?.label)}</Badge>
          <Input value={phase.label} className="h-7 text-sm flex-1 bg-transparent border-transparent hover:border-border focus:border-primary"
            placeholder={`${phaseLabel(phase.type, tmpl?.label)} (自定义名称)`}
            onChange={(e) => { e.stopPropagation(); onLabelChange(e.target.value); }}
            onClick={(e) => e.stopPropagation()} />
          <span className="text-sm text-muted-foreground whitespace-nowrap">{tmpl?.fixed_steps || 0} steps</span>
          {phase.expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
          {/* M3.4: 复制单个 phase 按钮 */}
          <Button variant="ghost" size="icon" className="h-7 w-7 opacity-0 group-hover:opacity-100"
            onClick={(e) => { e.stopPropagation(); onCopy(); }}
            title="复制此 phase">
            <Copy className="w-3.5 h-3.5 text-muted-foreground" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7 opacity-0 group-hover:opacity-100"
            onClick={(e) => { e.stopPropagation(); onRemove(); }}>
            <Trash2 className="w-3.5 h-3.5 text-destructive" />
          </Button>
        </div>
        {phase.expanded && (
          <CardContent className="pt-0 pb-3 px-3 border-t space-y-3">
            {/* 步骤序列 */}
            {(tmpl?.steps?.length || tmpl?.fixed_steps || 0) > 0 && (
              <div className="pt-3">
                <div className="text-sm font-medium text-muted-foreground mb-2">步骤序列 ({tmpl?.steps?.length || tmpl?.fixed_steps || 0} 步)</div>
                <div className="space-y-1">
                  {tmpl?.steps && tmpl.steps.length > 0 ? (
                    tmpl.steps.map((step: any, si: number) => {
                      // 格式化条件显示
                      const fmtCond = (c: any): string => {
                        if (!c) return '';
                        if (c.type === 'duration') return `${c.duration_s || 0}秒`;
                        if (c.type === 'in_band') return `${c.channel || '?'} 死区±${c.tolerance || 0}`;
                        if (c.type === 'accumulated') return `累积 ${c.channel || ''} ≥ ${c.value ?? '?'}`;
                        if (c.type === 'delta') return `Δ${c.channel || ''} ≥ ${c.value ?? '?'}`;
                        // >= / <=
                        return `${c.channel || '?'} ${c.type} ${c.value ?? '?'}`;
                      };
                      const conds = step.completion?.conditions || [];
                      const logic = step.completion?.logic;
                      const condText = conds.length === 1
                        ? fmtCond(conds[0])
                        : conds.length > 1
                          ? conds.map(fmtCond).join(logic === 'or' ? ' 或 ' : ' 且 ')
                          : '';

                      return (
                      <div key={si} className="flex items-center gap-2 text-sm bg-muted/50 rounded px-2 py-1.5">
                        <span className="w-5 h-5 rounded-full bg-primary/10 text-primary flex items-center justify-center text-sm font-medium flex-shrink-0">
                          {step.step_number || si + 1}
                        </span>
                        <span className="font-medium flex-shrink-0">{step.name || `Step ${si + 1}`}</span>
                        {step.description && <span className="text-muted-foreground truncate">— {step.description}</span>}
                        <span className="ml-auto text-muted-foreground flex-shrink-0 font-mono">
                          {condText || '—'}
                        </span>
                        {step.next_step && step.next_step !== 'next' && (
                          <Badge variant="outline" className="text-sm h-4 flex-shrink-0">
                            →{step.next_step === 'end' ? '结束' : `Step${step.next_step}`}
                          </Badge>
                        )}
                      </div>
                      );
                    })
                  ) : (
                    <div className="text-sm text-muted-foreground italic px-2">
                      {tmpl?.fixed_steps || 0} 个内置步骤 (在Phase模板配置中编辑)
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 参数设置 (合并模板定义 + 配方实际值) */}
            {(() => {
              // 收集所有参数: 模板定义的 + 配方中已有的
              const schemaFields = (tmpl?.param_schema || []) as any[];
              const paramKeys = new Set<string>();
              const allParams: { key: string; label: string; value: any; unit?: string }[] = [];

              // 1. 从模板param_schema取
              schemaFields.forEach((f: any) => {
                const key = f.key || f.plc_tag || '';
                if (!key) return;
                paramKeys.add(key);
                allParams.push({
                  key,
                  label: f.label || key,
                  value: getNestedValue(phase.params, key) ?? f.default ?? f.default_value,
                  unit: f.unit || f.eng_unit || '',
                });
              });

              // 2. 从配方params中补充模板未定义的 (materials 由专用编辑器渲染, 跳过)
              Object.entries(phase.params || {}).forEach(([k, v]) => {
                if (paramKeys.has(k)) return;
                if (k === 'materials') return;
                paramKeys.add(k);
                allParams.push({ key: k, label: k, value: v });
              });

              if (allParams.length === 0) return null;

              return (
                <div>
                  <div className="text-sm font-medium text-muted-foreground mb-2">参数设置</div>
                  <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
                    {allParams.map(p => (
                      <div key={p.key} className="space-y-0.5">
                        <Label className="text-sm">
                          {p.label}
                          {p.unit && <span className="text-muted-foreground ml-1">({p.unit})</span>}
                        </Label>
                        {typeof p.value === 'object' && p.value !== null ? (
                          <div className="text-sm font-mono bg-muted rounded px-2 py-1">{JSON.stringify(p.value)}</div>
                        ) : (
                          <Input className="h-8 text-sm" value={p.value ?? ''}
                            type={typeof p.value === 'number' ? 'number' : 'text'}
                            onChange={(e) => {
                              const val = typeof p.value === 'number'
                                ? (e.target.value === '' ? undefined : parseFloat(e.target.value))
                                : e.target.value;
                              onParamChange(p.key, val);
                            }} />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* 无步骤无参数时的提示 */}
            {(!tmpl?.steps?.length && !tmpl?.fixed_steps && !(tmpl?.param_schema?.length)) && (
              <div className="pt-3 text-sm text-muted-foreground italic">
                此Phase模板尚未配置步骤和参数，请到 系统设置 → Phase模板配置 中编辑
              </div>
            )}
          </CardContent>
        )}
      </Card>
      {index < total - 1 && (
        <PhaseConnector mode={executionMode} />
      )}
    </div>
  );
}

// ─── 主编辑器 ─────────────────────────────────────────────────

export default function RecipeEditorPage() {
  const { t } = useLocale();
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const routeId = params.id as string;
  const isNew = routeId === 'new';
  const version = searchParams.get('version') ?? undefined;

  const [recipeName, setRecipeName] = useState('新配方');
  const [recipeId, setRecipeId] = useState('NEW_RECIPE');
  const [recipeVersion, setRecipeVersion] = useState('1.0.0');
  const [author, setAuthor] = useState('工艺工程师');
  const [organism, setOrganism] = useState('');
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('free');
  const [phases, setPhases] = useState<PhaseInstance[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showJson, setShowJson] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [apiTemplates, setApiTemplates] = useState<APIPhaseTemplate[]>([]);
  const [phaseInstances, setPhaseInstances] = useState<APIPhaseInstance[]>([]);
  const audit = useAudit();

  // M3.4: 多选 + 剪贴板状态
  const [selectedPhaseIds, setSelectedPhaseIds] = useState<Set<string>>(new Set());
  const [clipboardHint, setClipboardHint] = useState<string | null>(null); // 提示"已复制 N 个 phase"
  const [clipboardNonEmpty, setClipboardNonEmpty] = useState(false);

  // 组件挂载时检查剪贴板
  useEffect(() => {
    setClipboardNonEmpty(readClipboard() !== null);
  }, []);

  const togglePhaseSelection = useCallback((id: string) => {
    setSelectedPhaseIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const copySinglePhase = useCallback((id: string) => {
    const phase = phases.find(p => p.id === id);
    if (!phase) return;
    copyPhases([phase as ClipboardPhase], recipeId);
    setClipboardNonEmpty(true);
    setClipboardHint(`已复制 1 个 phase (${phase.label})`);
    setTimeout(() => setClipboardHint(null), 2000);
  }, [phases, recipeId]);

  const copySelectedPhases = useCallback(() => {
    const selected = phases.filter(p => selectedPhaseIds.has(p.id));
    if (selected.length === 0) return;
    copyPhases(selected as ClipboardPhase[], recipeId);
    setClipboardNonEmpty(true);
    setClipboardHint(`已复制 ${selected.length} 个 phase`);
    setTimeout(() => setClipboardHint(null), 2000);
    setSelectedPhaseIds(new Set());
  }, [phases, selectedPhaseIds, recipeId]);

  const pastePhases = useCallback(() => {
    const payload = readClipboard();
    if (!payload || payload.phases.length === 0) return;
    const newPhases = preparePaste(payload.phases) as PhaseInstance[];
    setPhases(prev => [...prev, ...newPhases]);
    setClipboardHint(`已粘贴 ${newPhases.length} 个 phase` + (payload.sourceRecipeId ? ` (源自 ${payload.sourceRecipeId})` : ''));
    setTimeout(() => setClipboardHint(null), 2500);
  }, []);

  // 从API加载Phase模板 (内部用于派生参数 schema, 不暴露给用户)
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API}/api/phase-templates`, { signal: controller.signal })
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setApiTemplates(data); })
      .catch((err) => { if (err.name !== 'AbortError') console.error(err); });
    return () => controller.abort();
  }, []);

  // SP-RG-4: 加载 phase instances (左侧 palette + addPhaseFromInstance 用)
  useEffect(() => {
    const controller = new AbortController();
    const token = typeof window !== 'undefined' ? localStorage.getItem('biocore_token') : null;
    fetch(`${API}/api/v1/phase-instances`, {
      signal: controller.signal,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(j => {
        const data = j && typeof j === 'object' && 'data' in j ? j.data : j;
        if (Array.isArray(data)) setPhaseInstances(data);
      })
      .catch((err) => { if (err.name !== 'AbortError') console.error(err); });
    return () => controller.abort();
  }, []);

  // 模板查找辅助
  const findTemplate = useCallback(
    (type: string) => apiTemplates.find(t => t.type === type),
    [apiTemplates],
  );

  // Fetch existing recipe (skip for new)
  useEffect(() => {
    // routeId 可能是 'new' 或 URL编码后的值
    if (!routeId || routeId === 'new' || routeId === 'NEW') {
      setLoading(false);
      return;
    }
    setLoading(true);
    const controller = new AbortController();
    const url = version
      ? `${API}/api/recipes/${encodeURIComponent(routeId)}?version=${version}`
      : `${API}/api/recipes/${encodeURIComponent(routeId)}`;
    fetch(url, { signal: controller.signal })
      .then(r => { if (!r.ok) throw new Error('获取配方失败'); return r.json(); })
      .then((data: RecipeData & { status?: string; rejection_reason?: string | null }) => {
        setRecipeId(data.recipe_id);
        setRecipeName(data.name);
        setRecipeVersion(data.version);
        setAuthor(data.author || '');
        setOrganism(data.target_organism || '');
        setExecutionMode(data.execution_mode || 'free');
        setPhases((data.phases || []).map((p: any, i: number) => ({
          id: `${p.type}_${Date.now()}_${i}`,
          phase_id: p.phase_id,
          type: p.type,
          label: phaseLabel(p.type, findTemplate(p.type)?.label),
          params: p.params || {},
          expanded: false,
        })));
        // M3.2: 同步配方状态 + 拒绝原因
        setRecipeStatus(data.status || 'draft');
        setRejectionReason(data.rejection_reason || null);
      })
      .catch((err) => { if (err.name !== 'AbortError') setSaveMsg({ ok: false, text: '加载配方失败' }); })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [routeId, version, findTemplate]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  );

  // 从 Phase Instance 添加 phase row — 推断 phase_class 作 type, 合并模板默认参数 + override
  const addPhaseFromInstance = useCallback((inst: APIPhaseInstance) => {
    const tmpl = findTemplate(inst.phase_class);
    const params: Record<string, any> = { ...(tmpl?.default_params || {}) };
    (tmpl?.param_schema || []).forEach((f: any) => {
      const key = f.key || f.plc_tag;
      if (key && f.default_value !== undefined && !(key in params)) {
        params[key] = f.default_value;
      }
    });
    Object.assign(params, inst.params_override || {});
    setPhases(prev => [...prev, {
      id: `${inst.instance_id}_${Date.now()}`,
      phase_id: inst.instance_id,
      type: inst.phase_class,
      instance_id: inst.instance_id,
      label: inst.label || tmpl?.label || inst.instance_id,
      params,
      expanded: true,
    }]);
  }, [apiTemplates]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setPhases(prev => {
      const oldIdx = prev.findIndex(p => p.id === active.id);
      const newIdx = prev.findIndex(p => p.id === over.id);
      return arrayMove(prev, oldIdx, newIdx);
    });
  }, []);

  const removePhase = useCallback((id: string) => {
    setPhases(prev => prev.filter(p => p.id !== id));
  }, []);

  const togglePhase = useCallback((id: string) => {
    setPhases(prev => prev.map(p => p.id === id ? { ...p, expanded: !p.expanded } : p));
  }, []);

  const updateParam = useCallback((id: string, key: string, value: any) => {
    setPhases(prev => prev.map(p => {
      if (p.id !== id) return p;
      const params = structuredClone(p.params);
      setNestedValue(params, key, value);
      return { ...p, params };
    }));
  }, []);

  const updateLabel = useCallback((id: string, label: string) => {
    setPhases(prev => prev.map(p => p.id === id ? { ...p, label } : p));
  }, []);

  // Build recipe object
  const recipeObj = useMemo(() => ({
    recipe_id: recipeId,
    version: recipeVersion,
    name: recipeName,
    author,
    target_organism: organism || null,
    execution_mode: executionMode,
    vessel_config: { id: 'F01', working_volume_L: 5 },
    phases: phases.map(p => ({ phase_id: p.phase_id, type: p.type, params: p.params })),
    created_by: author,
  }), [recipeId, recipeVersion, recipeName, author, organism, executionMode, phases]);

  // Validation
  const errors = useMemo(() => {
    const errs: string[] = [];
    if (!recipeId.trim()) errs.push('配方ID不能为空');
    if (!recipeName.trim()) errs.push('配方名称不能为空');
    if (phases.length === 0) errs.push('至少添加一个Phase');
    phases.forEach((p, i) => {
      const tmpl = findTemplate(p.type);
      if (!tmpl) return;
      (tmpl.param_schema || []).filter((f: any) => f.required).forEach((f: any) => {
        const v = getNestedValue(p.params, f.key || f.plc_tag);
        if (v === undefined || v === null || v === '') {
          errs.push(`Phase ${i + 1} (${tmpl.label}): ${f.label} 必填`);
        }
      });
    });
    return errs;
  }, [recipeId, recipeName, phases, findTemplate]);

  // Save
  const doSave = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch(`${API}/api/recipes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(recipeObj),
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || '保存失败'); }
      setSaveMsg({ ok: true, text: '保存成功' });
      if (isNew) router.push(`/recipes/${recipeId}/edit?version=${recipeVersion}`);
    } catch (e: any) {
      setSaveMsg({ ok: false, text: e.message || '保存失败' });
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => {
    if (errors.length > 0) { setSaveMsg({ ok: false, text: errors[0] }); return; }
    audit.confirm({
      description: isNew ? `创建配方 ${recipeId} v${recipeVersion}` : `保存配方 ${recipeId} v${recipeVersion}`,
      action: isNew ? 'recipe_create' : 'recipe_update',
      targetType: 'recipe', targetId: `${recipeId}@${recipeVersion}`,
      newValue: `${recipeName} / ${phases.length} 个 Phase / ${executionMode === 'sequential' ? '顺序模式' : '自由模式'}`,
      onConfirm: doSave,
    });
  };

  // M3.2: 当前配方的状态 (加载时从后端来), 新建默认 draft
  const [recipeStatus, setRecipeStatus] = useState<string>('draft');
  const [rejectionReason, setRejectionReason] = useState<string | null>(null);

  // M3.2: 提交审核
  const handleSubmitForReview = () => {
    if (errors.length > 0) { setSaveMsg({ ok: false, text: errors[0] }); return; }
    audit.confirm({
      description: `提交配方 ${recipeId} v${recipeVersion} 进入审核`,
      action: 'recipe_submit_review',
      targetType: 'recipe',
      targetId: `${recipeId}@${recipeVersion}`,
      oldValue: 'draft',
      newValue: 'pending_approval',
      onConfirm: async () => {
        try {
          const res = await fetch(`${API}/api/v1/recipes/${encodeURIComponent(recipeId)}/submit-for-review`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${typeof window !== 'undefined' ? (localStorage.getItem('biocore_token') || '') : ''}`,
            },
            body: JSON.stringify({ version: recipeVersion }),
          });
          const body = await res.json();
          if (!res.ok) throw new Error(body?.error || body?.msg || '提交失败');
          setRecipeStatus('pending_approval');
          setRejectionReason(null);
          setSaveMsg({ ok: true, text: '已提交审核' });
        } catch (e: any) {
          setSaveMsg({ ok: false, text: e.message });
        }
      },
    });
  };

  // Export JSON
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(recipeObj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `${recipeId}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  // Import JSON
  const importJson = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text()) as RecipeData;
        setRecipeId(data.recipe_id || 'IMPORTED');
        setRecipeName(data.name || '导入配方');
        setRecipeVersion(data.version || '1.0.0');
        setAuthor(data.author || '');
        setOrganism(data.target_organism || '');
        setExecutionMode(data.execution_mode || 'free');
        setPhases((data.phases || []).map((p, i) => ({
          id: `${p.type}_${Date.now()}_${i}`,
          phase_id: p.phase_id || `${p.type.toUpperCase()}_${String(i + 1).padStart(2, '0')}`,
          type: p.type,
          label: phaseLabel(p.type, findTemplate(p.type)?.label),
          params: p.params || {},
          expanded: false,
        })));
      } catch { setSaveMsg({ ok: false, text: '导入失败: JSON格式错误' }); }
    };
    input.click();
  };

  if (loading) {
    return <div className="flex items-center justify-center h-full text-muted-foreground">加载配方中...</div>;
  }

  return (
    <div className="h-full flex flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b flex-shrink-0 bg-card">
        <Input value={recipeId} onChange={e => setRecipeId(e.target.value)}
          className="w-[180px] font-mono text-sm h-8" placeholder="配方ID" />
        <Input value={recipeName} onChange={e => setRecipeName(e.target.value)}
          className="w-[200px] text-sm h-8" placeholder="配方名称" />
        <Input value={recipeVersion} onChange={e => setRecipeVersion(e.target.value)}
          className="w-[80px] font-mono text-sm h-8" placeholder="版本" />
        <Input value={author} onChange={e => setAuthor(e.target.value)}
          className="w-[120px] text-sm h-8" placeholder="作者" />
        <Badge variant="outline">{phases.length} Phases</Badge>

        {/* 执行模式切换 */}
        <div className="flex items-center gap-1 bg-muted rounded-md p-0.5">
          <button onClick={() => setExecutionMode('free')}
            className={`px-2.5 py-1 text-sm rounded font-medium transition-colors ${
              executionMode === 'free'
                ? 'bg-primary text-white shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}>
            自由模式
          </button>
          <button onClick={() => setExecutionMode('sequential')}
            className={`px-2.5 py-1 text-sm rounded font-medium transition-colors ${
              executionMode === 'sequential'
                ? 'bg-primary text-white shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}>
            顺序模式
          </button>
        </div>

        <div className="flex-1" />

        {/* M3.4: 剪贴板操作 */}
        {clipboardHint && (
          <div className="text-sm text-primary flex items-center gap-1">
            <CheckCircle className="w-3 h-3" />{clipboardHint}
          </div>
        )}
        {selectedPhaseIds.size > 0 && (
          <Button variant="outline" size="sm" onClick={copySelectedPhases}>
            <Copy className="w-3.5 h-3.5 mr-1" />复制选中 ({selectedPhaseIds.size})
          </Button>
        )}
        {clipboardNonEmpty && (
          <Button variant="outline" size="sm" onClick={pastePhases} title="从剪贴板粘贴 phase">
            <ClipboardPaste className="w-3.5 h-3.5 mr-1" />粘贴
          </Button>
        )}

        {saveMsg && (
          <div className={`flex items-center gap-1 text-sm ${saveMsg.ok ? 'text-green-600' : 'text-destructive'}`}>
            {saveMsg.ok ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
            {saveMsg.text}
          </div>
        )}
        <Button variant="outline" size="sm" onClick={importJson}><Upload className="w-3.5 h-3.5 mr-1" />导入</Button>
        <Button variant="outline" size="sm" onClick={exportJson}><Download className="w-3.5 h-3.5 mr-1" />导出JSON</Button>
        <Button size="sm" onClick={handleSave} disabled={saving}>
          <Save className="w-3.5 h-3.5 mr-1" />{saving ? '保存中...' : '保存'}
        </Button>
        {/* M3.2: 提交审核按钮 (仅 draft 状态) */}
        {recipeStatus === 'draft' && !isNew && (
          <Button size="sm" variant="outline" onClick={handleSubmitForReview}
            className="border-amber-500/30 text-amber-400 hover:bg-amber-500/10">
            提交审核
          </Button>
        )}
        {recipeStatus === 'pending_approval' && (
          <div className="text-sm text-amber-400 flex items-center gap-1">
            <AlertCircle className="w-3 h-3" />等待审核
          </div>
        )}
        {recipeStatus === 'approved' && (
          <div className="text-sm text-emerald-600 flex items-center gap-1">
            <CheckCircle className="w-3 h-3" />已批准
          </div>
        )}
      </div>

      {/* M3.2: 被拒提示横条 */}
      {rejectionReason && recipeStatus === 'draft' && (
        <div className="mx-3 my-2 px-3 py-2 rounded border border-red-500/30 bg-red-500/10 text-sm text-red-600 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold mb-0.5">上次审核被拒</div>
            <div className="text-red-300">原因: {rejectionReason}</div>
          </div>
        </div>
      )}

      {/* Main area */}
      <div className="flex-1 flex overflow-hidden">
        <PhaseInstancePalette instances={phaseInstances} templates={apiTemplates} onAdd={addPhaseFromInstance} />

        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Timeline */}
          <div className="flex-1 overflow-y-auto p-4">
            {/* 模式说明横条 */}
            <div className={`mb-3 px-3 py-2 rounded-md text-sm flex items-center gap-2 ${
              executionMode === 'sequential'
                ? 'bg-primary/10 border border-primary/20 text-primary'
                : 'bg-muted/50 border border-border text-muted-foreground'
            }`}>
              {executionMode === 'sequential' ? (
                <>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
                    <path d="M12 5v14M5 12l7 7 7-7" />
                  </svg>
                  <span><strong>顺序模式</strong> — Phase按顺序自动执行，前一个完成后自动启动下一个，直到最后一个Phase结束。操作员只需启动批次。</span>
                </>
              ) : (
                <>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
                    <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
                    <rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
                  </svg>
                  <span><strong>自由模式</strong> — 操作员手动决定启动哪个Phase，Phase之间无自动流转。适合需要灵活控制的实验场景。</span>
                </>
              )}
            </div>

            {phases.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-64 border-2 border-dashed rounded-lg text-muted-foreground">
                <Plus className="w-8 h-8 mb-3 opacity-50" />
                <p className="text-sm font-medium">从左侧点击Phase模板添加到此处</p>
                <p className="text-sm mt-1">添加后可拖拽排序、点击展开参数</p>
              </div>
            ) : (
              <DndContext sensors={sensors} collisionDetection={closestCenter}
                onDragStart={(e: DragStartEvent) => setActiveId(String(e.active.id))}
                onDragEnd={handleDragEnd}>
                <SortableContext items={phases.map(p => p.id)} strategy={verticalListSortingStrategy}>
                  <div className="space-y-0">
                    {phases.map((phase, idx) => (
                      <SortablePhaseCard key={phase.id} phase={phase} index={idx} total={phases.length}
                        executionMode={executionMode}
                        isSelected={selectedPhaseIds.has(phase.id)}
                        onRemove={() => removePhase(phase.id)}
                        onToggle={() => togglePhase(phase.id)}
                        onParamChange={(k, v) => updateParam(phase.id, k, v)}
                        onLabelChange={(l) => updateLabel(phase.id, l)}
                        onCopy={() => copySinglePhase(phase.id)}
                        onSelect={() => togglePhaseSelection(phase.id)}
                        getTemplate={findTemplate} />
                    ))}
                  </div>
                </SortableContext>
                <DragOverlay>
                  {activeId && (() => {
                    const p = phases.find(x => x.id === activeId);
                    if (!p) return null;
                    const t = findTemplate(p.type);
                    if (!t) return null;
                    const c = getColor(t.color);
                    return (
                      <Card className="shadow-lg border-primary px-3 py-2">
                        <Badge className={`text-sm ${c.bg} ${c.text}`}>{t.label}</Badge>
                        <span className="ml-2 text-sm">{p.label}</span>
                      </Card>
                    );
                  })()}
                </DragOverlay>
              </DndContext>
            )}
          </div>

          {/* Bottom bar */}
          <div className="flex items-center gap-3 px-4 py-2 border-t flex-shrink-0 bg-card">
            <Button variant="ghost" size="sm" onClick={() => setShowJson(v => !v)}>
              <Code className="w-3.5 h-3.5 mr-1" />{showJson ? '隐藏JSON' : 'JSON源码'}
            </Button>
            <div className="flex-1" />
            {errors.length === 0 ? (
              <span className="text-sm text-green-600 flex items-center gap-1">
                <CheckCircle className="w-3.5 h-3.5" /> 验证通过
              </span>
            ) : (
              <span className="text-sm text-destructive flex items-center gap-1">
                <AlertCircle className="w-3.5 h-3.5" /> {errors.length} 个问题
              </span>
            )}
          </div>

          {/* JSON preview */}
          {showJson && (
            <div className="border-t max-h-[300px] overflow-auto bg-muted/30">
              <pre className="p-4 text-sm font-mono whitespace-pre-wrap">{JSON.stringify(recipeObj, null, 2)}</pre>
            </div>
          )}
        </div>
      </div>

      {audit.dialog}
    </div>
  );
}

// ─── Phase间连接线 ───────────────────────────────────────────

function PhaseConnector({ mode }: { mode: ExecutionMode }) {
  if (mode === 'sequential') {
    // 顺序模式: 箭头连接线，表示自动流转
    return (
      <div className="flex justify-center py-0.5">
        <div className="flex flex-col items-center">
          <div className="w-px h-2 bg-primary/60" />
          <svg width="12" height="8" viewBox="0 0 12 8" className="text-primary/60">
            <path d="M0 0 L6 7 L12 0" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
          <div className="w-px h-1 bg-primary/60" />
        </div>
      </div>
    );
  }
  // 自由模式: 虚线间隔，表示操作员手动决定
  return (
    <div className="flex justify-center py-1">
      <div className="w-px h-4 border-l border-dashed border-muted-foreground/30" />
    </div>
  );
}

// ─── Utilities ────────────────────────────────────────────────

function getNestedValue(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

function setNestedValue(obj: any, path: string, value: any): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const target = keys.reduce((o, k) => {
    if (!(k in o)) o[k] = {};
    return o[k];
  }, obj);
  target[last] = value;
}
