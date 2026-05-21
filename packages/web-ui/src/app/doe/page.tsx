// DoE 研究列表页 — 参照 DASware design 风格, 与配方编辑器双向对接
'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, FlaskConical, Trash2, Search, X, CheckCircle, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/auth';
import { useAudit } from '@/hooks/useAudit';
import { useLocale } from '@/i18n/useLocale';
import { PageHeader } from '@/components/layout/PageHeader';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

interface DoeStudySummary {
  study_id: string;
  name: string;
  description: string | null;
  base_recipe_id: string | null;
  base_recipe_version: string | null;
  design_type: string;
  status: string;
  factors: any[];
  responses: any[];
  created_at: string;
  created_by: string;
  run_count: number;
  completed_count: number;
}

const STATUS_STYLES: Record<string, { bg: string; label: string }> = {
  draft:      { bg: 'bg-gray-500/15 text-gray-400 border border-gray-500/30',   label: '草稿' },
  designed:   { bg: 'bg-blue-500/15 text-blue-600 border border-blue-500/30',   label: '已生成矩阵' },
  running:    { bg: 'bg-yellow-500/15 text-amber-600 border border-yellow-500/30', label: '执行中' },
  completed:  { bg: 'bg-green-500/15 text-emerald-600 border border-green-500/30', label: '已完成' },
  archived:   { bg: 'bg-orange-500/15 text-orange-600 border border-orange-500/30', label: '已归档' },
};

const DESIGN_TYPE_LABEL: Record<string, string> = {
  full_factorial: '全因子',
  fractional_factorial: '分数因子 2^(k-p)',
  ccd: 'CCD 中心复合',
  latin_hypercube: '拉丁超立方',
  orthogonal: '正交设计 (田口)',
  uniform: '均匀设计',
  plackett_burman: 'Plackett-Burman 筛选',
  box_behnken: 'Box-Behnken RSM',
  definitive_screening: 'DSD 确定性筛选',
  bayesian: '贝叶斯',
};

export default function DoeListPage() {
  const { t } = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const audit = useAudit();
  const [studies, setStudies] = useState<DoeStudySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  // 创建对话框
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newDesignType, setNewDesignType] = useState<string>('full_factorial');
  const [newBaseRecipeId, setNewBaseRecipeId] = useState<string>('');
  const [newBaseVersion, setNewBaseVersion] = useState<string>('');
  const [recipeOptions, setRecipeOptions] = useState<{ recipe_id: string; version: string; name: string }[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiFetch(`${API}/api/v1/doe/studies`);
      if (r.ok) {
        const data = await r.json();
        setStudies(Array.isArray(data) ? data : (data?.data ?? []));
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // 加载可选基础配方 (只接受 approved)
  useEffect(() => {
    if (!createOpen) return;
    apiFetch(`${API}/api/v1/recipes?status=approved`)
      .then(r => r.ok ? r.json() : [])
      .then(data => {
        const list = Array.isArray(data) ? data : (data?.data || []);
        setRecipeOptions(list.map((r: any) => ({ recipe_id: r.recipe_id, version: r.version, name: r.name })));
      })
      .catch(() => {});
  }, [createOpen]);

  // URL 参数支持: /doe?new=1&baseRecipe=XXX&baseVersion=1.0.0 → 自动弹出创建对话框 + 预填基础配方
  useEffect(() => {
    const openParam = searchParams?.get('new');
    const baseRecipe = searchParams?.get('baseRecipe');
    const baseVersion = searchParams?.get('baseVersion');
    if (openParam === '1') {
      setCreateOpen(true);
      if (baseRecipe) setNewBaseRecipeId(baseRecipe);
      if (baseVersion) setNewBaseVersion(baseVersion);
      if (baseRecipe) setNewName(`${baseRecipe} DoE 研究`);
    }
  }, [searchParams]);

  const doCreate = () => {
    if (!newName.trim()) { alert('研究名称不能为空'); return; }
    // 先关闭新建对话框, 避免 z-index 遮挡审计确认弹窗
    const name = newName;
    const desc = newDescription;
    const designType = newDesignType;
    const baseRecipeId = newBaseRecipeId;
    const baseVersion = newBaseVersion;
    setCreateOpen(false);
    audit.confirm({
      description: `创建 DoE 研究 "${name}" (${DESIGN_TYPE_LABEL[designType] || designType})`,
      action: 'doe_create',
      targetType: 'doe_study',
      targetId: name,
      newValue: `${name} / ${DESIGN_TYPE_LABEL[designType]}`,
      onConfirm: async () => {
        const res = await apiFetch(`${API}/api/v1/doe/studies`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            description: desc || null,
            design_type: designType,
            base_recipe_id: baseRecipeId || null,
            base_recipe_version: baseVersion || null,
            factors: [],
            responses: [],
          }),
        });
        if (res.ok) {
          const data = await res.json();
          setNewName(''); setNewDescription(''); setNewBaseRecipeId(''); setNewBaseVersion('');
          router.push(`/doe/${encodeURIComponent(data.study_id)}`);
        } else {
          const data = await res.json().catch(() => ({}));
          alert('创建失败: ' + (data.error || '未知错误'));
        }
      },
      onCancel: () => {
        // 用户取消审计确认 → 重新打开新建对话框, 恢复表单内容
        setNewName(name); setNewDescription(desc);
        setNewDesignType(designType);
        setNewBaseRecipeId(baseRecipeId); setNewBaseVersion(baseVersion);
        setCreateOpen(true);
      },
    });
  };

  const doDelete = (study: DoeStudySummary) => {
    audit.confirm({
      description: `删除 DoE 研究 "${study.name}" (${study.run_count} 次运行将一并删除)`,
      action: 'doe_delete',
      targetType: 'doe_study',
      targetId: study.study_id,
      oldValue: `${study.name} / ${study.run_count} runs`,
      onConfirm: async () => {
        const res = await apiFetch(`${API}/api/v1/doe/studies/${study.study_id}`, { method: 'DELETE' });
        if (res.ok) load();
      },
    });
  };

  const filtered = search.trim()
    ? studies.filter(s =>
        s.name.toLowerCase().includes(search.toLowerCase()) ||
        s.study_id.toLowerCase().includes(search.toLowerCase()) ||
        (s.base_recipe_id || '').toLowerCase().includes(search.toLowerCase()))
    : studies;

  return (
    <div className="p-6 space-y-6">
      {audit.dialog}

      <PageHeader
        icon={FlaskConical}
        title="DoE 实验设计"
        subtitle="因子筛选 · 响应面建模 · 最优点搜索 · 与配方编辑器双向对接"
        right={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="w-4 h-4 mr-1" /> 新建研究
          </Button>
        }
      />

      {/* 搜索 */}
      <div className="relative w-full max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <input value={search} onChange={e => setSearch(e.target.value)}
          className="w-full h-8 pl-9 pr-3 rounded bg-card border border-border text-sm"
          placeholder="搜索研究名/ID/基础配方..." />
      </div>

      {/* DO 策略 DOE 模板 — 一键创建 */}
      <DoStrategyTemplates onCreated={load} />

      {/* 列表 */}
      {loading && <div className="text-center text-muted-foreground py-16 text-sm"><Loader2 className="w-4 h-4 animate-spin inline mr-1" />加载中...</div>}
      {!loading && filtered.length === 0 && (
        <Card>
          <CardContent className="p-10 text-center text-muted-foreground">
            <FlaskConical className="w-10 h-10 mx-auto text-muted-foreground/30 mb-3" />
            <p className="text-sm mb-3">{search ? '无匹配研究' : '暂无 DoE 研究, 点击右上角新建'}</p>
          </CardContent>
        </Card>
      )}
      {!loading && filtered.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map(s => {
            const st = STATUS_STYLES[s.status] || STATUS_STYLES.draft;
            const progress = s.run_count > 0 ? Math.round((s.completed_count / s.run_count) * 100) : 0;
            return (
              <Card
                key={s.study_id}
                className="hover:border-primary/50 transition-colors cursor-pointer"
                onClick={() => router.push(`/doe/${encodeURIComponent(s.study_id)}`)}
              >
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-sm truncate">{s.name}</div>
                      <div className="text-sm text-muted-foreground font-mono truncate">{s.study_id}</div>
                    </div>
                    <span className={`px-2 py-0.5 rounded text-sm font-semibold ${st.bg}`}>{st.label}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 text-sm">
                    <span className="bg-muted/50 text-muted-foreground px-2 py-0.5 rounded">
                      {DESIGN_TYPE_LABEL[s.design_type] || s.design_type}
                    </span>
                    <span className="bg-muted/50 text-muted-foreground px-2 py-0.5 rounded">{s.factors.length} 因子</span>
                    <span className="bg-muted/50 text-muted-foreground px-2 py-0.5 rounded">{s.responses.length} 响应</span>
                    {s.base_recipe_id && (
                      <span className="bg-primary/15 text-primary px-2 py-0.5 rounded truncate max-w-[120px]" title={s.base_recipe_id}>
                        基于 {s.base_recipe_id}
                      </span>
                    )}
                  </div>
                  {s.run_count > 0 && (
                    <div className="space-y-0.5">
                      <div className="flex justify-between text-sm text-muted-foreground">
                        <span>运行进度</span>
                        <span>{s.completed_count}/{s.run_count}</span>
                      </div>
                      <div className="h-1 bg-muted rounded overflow-hidden">
                        <div className="h-full bg-primary rounded transition-all" style={{ width: `${progress}%` }} />
                      </div>
                    </div>
                  )}
                  <div className="flex justify-end pt-1">
                    <button
                      onClick={e => { e.stopPropagation(); doDelete(s); }}
                      className="text-red-600 hover:bg-red-500/10 rounded p-1"
                      title="删除研究"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* 创建对话框 */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 backdrop-blur-sm" onClick={() => setCreateOpen(false)}>
          <div className="bg-card border border-border rounded-lg w-[520px] shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <FlaskConical className="w-4 h-4 text-primary" />
                <span className="text-sm font-semibold">新建 DoE 研究</span>
              </div>
              <button onClick={() => setCreateOpen(false)} className="text-muted-foreground hover:text-foreground">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div>
                <label className="text-sm text-muted-foreground">研究名称 *</label>
                <Input value={newName} onChange={e => setNewName(e.target.value)} className="mt-1 h-8" placeholder="例: E.coli 培养基优化" />
              </div>
              <div>
                <label className="text-sm text-muted-foreground">说明</label>
                <Input value={newDescription} onChange={e => setNewDescription(e.target.value)} className="mt-1 h-8" placeholder="研究目的/假设" />
              </div>
              <div>
                <label className="text-sm text-muted-foreground">设计类型</label>
                <select
                  value={newDesignType}
                  onChange={e => setNewDesignType(e.target.value)}
                  className="mt-1 w-full h-8 px-2 rounded bg-background border border-border text-sm"
                >
                  <option value="full_factorial">全因子 (Full Factorial, 2^k / 3^k)</option>
                  <option value="ccd">中心复合 (CCD, 响应面 RSM)</option>
                  <option value="latin_hypercube">拉丁超立方 (LHS, 空间填充)</option>
                  <option value="orthogonal">正交设计 (L9/L16/L18/L27, 极差分析)</option>
                  <option value="uniform">均匀设计 (U7/U12/U13, 回归分析)</option>
                  <option value="fractional_factorial">分数因子 2^(k-p) (部分因子筛选)</option>
                  <option value="plackett_burman">Plackett-Burman (2水平快速筛选)</option>
                  <option value="box_behnken">Box-Behnken (3水平RSM, 少试验)</option>
                  <option value="definitive_screening">DSD 确定性筛选 (3水平, 检测二次)</option>
                </select>
              </div>
              <div>
                <label className="text-sm text-muted-foreground">基础配方 (可选)</label>
                <select
                  value={newBaseRecipeId ? `${newBaseRecipeId}::${newBaseVersion}` : ''}
                  onChange={e => {
                    const [id, v] = e.target.value.split('::');
                    setNewBaseRecipeId(id || '');
                    setNewBaseVersion(v || '');
                  }}
                  className="mt-1 w-full h-8 px-2 rounded bg-background border border-border text-sm"
                >
                  <option value="">-- 不关联基础配方 --</option>
                  {recipeOptions.map(r => (
                    <option key={`${r.recipe_id}::${r.version}`} value={`${r.recipe_id}::${r.version}`}>
                      {r.name} ({r.recipe_id} v{r.version})
                    </option>
                  ))}
                </select>
                <p className="text-sm text-muted-foreground mt-1">
                  关联后可 materialize 生成每次运行对应的子配方 (双向对接)
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
              <Button variant="outline" size="sm" onClick={() => setCreateOpen(false)}>取消</Button>
              <Button size="sm" onClick={doCreate} disabled={!newName.trim()}>
                <CheckCircle className="w-3.5 h-3.5 mr-1" /> 创建
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── DO 策略 DOE 模板组件 ──────────────────────────────────

const DO_STRATEGY_INFO: Record<string, { icon: string; color: string; shortDesc: string }> = {
  active_O2:     { icon: '🫁', color: 'border-blue-500/40 bg-blue-500/5',    shortDesc: 'DO→搅拌+通气级联' },
  active_feed:   { icon: '🧬', color: 'border-green-500/40 bg-green-500/5',  shortDesc: 'DO→补料速率PID' },
  constant_O2:   { icon: '💨', color: 'border-orange-500/40 bg-orange-500/5', shortDesc: '搅拌/通气固定, DO自然浮动' },
  constant_feed: { icon: '📐', color: 'border-purple-500/40 bg-purple-500/5', shortDesc: '全开环, 可重复性优先' },
};

function DoStrategyTemplates({ onCreated }: { onCreated: () => void }) {
  const [templates, setTemplates] = useState<any[]>([]);
  const [creating, setCreating] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    apiFetch(`${API}/api/v1/doe/templates/do-strategies`)
      .then(r => r.ok ? r.json() : [])
      .then(d => setTemplates(Array.isArray(d?.data ?? d) ? (d?.data ?? d) : []))
      .catch(() => {});
  }, []);

  const createFromTemplate = async (key: string) => {
    setCreating(key);
    try {
      const res = await apiFetch(`${API}/api/v1/doe/templates/do-strategies/${key}/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const data = await res.json();
        const studyId = (data?.data ?? data)?.study_id;
        onCreated();
        if (studyId) router.push(`/doe/${encodeURIComponent(studyId)}`);
      } else {
        const d = await res.json().catch(() => ({}));
        alert('创建失败: ' + ((d?.data ?? d)?.error || '未知错误'));
      }
    } catch { alert('网络错误'); }
    setCreating(null);
  };

  if (templates.length === 0) return null;

  return (
    <div>
      <div className="text-sm font-semibold text-muted-foreground mb-2">DO 控制策略 DOE 模板 — 一键创建 L9(3⁴) 正交设计</div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {templates.map(t => {
          const info = DO_STRATEGY_INFO[t.key] || { icon: '🔬', color: '', shortDesc: '' };
          return (
            <button
              key={t.key}
              onClick={() => createFromTemplate(t.key)}
              disabled={creating !== null}
              className={`text-left rounded-lg border p-3 space-y-1 transition-all hover:border-primary/60 hover:shadow-md ${info.color} ${creating === t.key ? 'opacity-50' : ''}`}
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">{info.icon}</span>
                <span className="text-sm font-semibold truncate flex-1">{t.name.replace('DO 策略', '').replace(': ', '')}</span>
              </div>
              <div className="text-sm text-muted-foreground">{info.shortDesc}</div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>{t.factor_count} 因素</span>
                <span>·</span>
                <span>{t.response_count} 响应</span>
                <span>·</span>
                <span>{t.estimated_runs} 次试验</span>
              </div>
              {creating === t.key && <Loader2 className="w-3 h-3 animate-spin text-primary" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
