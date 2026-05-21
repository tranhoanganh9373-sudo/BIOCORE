// ============================================================
// 配方管理页 — 卡片列表 + 搜索 + 删除/锁定/编辑
// ============================================================

'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Search, BookOpen, Edit, FlaskConical, Trash2, Unlock, Download, Loader2, Check, X, History, BookmarkPlus, Bookmark, Sparkles, Send, ShieldCheck, Sigma, Ban, RotateCcw, FileText } from 'lucide-react';
import { useAudit } from '@/hooks/useAudit';
import { apiFetch } from '@/lib/auth';
import { RecipeHistoryDrawer } from '@/components/recipes/RecipeHistoryDrawer';
import { useLocale } from '@/i18n/useLocale';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

interface RecipeSummary {
  recipe_id: string;
  name: string;
  version: string;
  status?: string;
  author?: string;
  target_organism?: string | null;
  phases?: any[];
  created_at?: string;
  is_template?: number;
  parent_template_id?: string | null;
  dag_schema_version?: number;
  vessel_config?: { reactor_id?: string } | null;
  vessel?: { reactor_id?: string } | null;
}

// 取 recipe 的目标 reactor (兼容 vessel_config / vessel 两种字段)
function recipeReactor(r: RecipeSummary): string | null {
  return r.vessel_config?.reactor_id ?? r.vessel?.reactor_id ?? null;
}

// M3.7: 根据 dag_schema_version 路由到不同编辑器
function editUrlFor(recipe: RecipeSummary): string {
  const base = `/recipes/${encodeURIComponent(recipe.recipe_id)}`;
  const versionQuery = `?version=${recipe.version}`;
  if ((recipe.dag_schema_version ?? 1) >= 2) {
    return `${base}/edit-v2${versionQuery}`;
  }
  return `${base}/edit${versionQuery}`;
}

type RecipeTab = 'recipes' | 'templates' | 'deprecated';

const STATUS_STYLES: Record<string, { bg: string; label: string }> = {
  draft:            { bg: 'bg-gray-500/15 text-gray-400 border border-gray-500/30', label: '草稿' },
  pending_approval: { bg: 'bg-amber-500/15 text-amber-400 border border-amber-500/30', label: '待审核' },
  approved:         { bg: 'bg-green-500/15 text-emerald-600 border border-green-500/30', label: '已批准' },
  archived:              { bg: 'bg-orange-500/15 text-orange-600 border border-orange-500/30', label: '已归档' },
  pending_deprecation:   { bg: 'bg-red-500/15 text-red-600 border border-red-500/30', label: '待废弃审核' },
  deprecated:            { bg: 'bg-red-800/15 text-red-500 border border-red-800/30', label: '已废弃' },
};

export default function RecipeListPage() {
  const { t } = useLocale();
  const router = useRouter();
  const [recipes, setRecipes] = useState<RecipeSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const audit = useAudit();

  // M3.3: 配方/模板 tabs
  const [tab, setTab] = useState<RecipeTab>('recipes');
  // 按罐子过滤 (null = 全部, 'unassigned' = 未绑定)
  const [selectedReactor, setSelectedReactor] = useState<string | null>(null);

  // 配方列表: recipes tab 不含归档/废弃; deprecated tab 只含废弃; templates 原样
  const loadRecipes = () => {
    setLoading(true);
    const url = tab === 'templates'
      ? `${API}/api/v1/recipes?is_template=true`
      : tab === 'deprecated'
        ? `${API}/api/v1/recipes?status=deprecated`
        : `${API}/api/v1/recipes`;
    apiFetch(url)
      .then(r => { if (!r.ok) throw new Error('获取失败'); return r.json(); })
      .then(data => {
        const list: RecipeSummary[] = Array.isArray(data) ? data : (data?.data ?? []);
        // recipes tab 过滤归档和废弃; 其它 tab 保持原样
        setRecipes(tab === 'recipes'
          ? list.filter(r => r.status !== 'archived' && r.status !== 'deprecated')
          : list);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadRecipes(); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // M3.3: 另存为模板
  const saveAsTemplate = (recipe: RecipeSummary) => {
    audit.confirm({
      description: `把配方 ${recipe.recipe_id} v${recipe.version} 另存为模板`,
      action: 'recipe_save_as_template',
      targetType: 'recipe',
      targetId: `${recipe.recipe_id}@${recipe.version}`,
      newValue: `源自 ${recipe.name}`,
      onConfirm: async () => {
        const res = await apiFetch(`${API}/api/v1/recipes/${recipe.recipe_id}/save-as-template`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: recipe.version }),
        });
        if (res.ok) {
          alert('模板创建成功, 切到"模板"标签查看');
        } else {
          const data = await res.json().catch(() => ({}));
          alert('保存失败: ' + (data.error || data.msg));
        }
      },
    });
  };

  // M3.3 (修复): 应用此模板 — 一键创建并跳转到编辑页
  // 原来的"打开对话框手动填 ID/名称"流程 UX 太重 + 某些情况下对话框不弹出, 改为:
  //   点击 → 自动生成唯一 recipe_id (基于模板名+timestamp) → 直接调用后端 → 跳转到新配方编辑页
  const applyTemplate = (template: RecipeSummary) => {
    // 从模板 recipe_id (形如 TPL-{srcId}-{ts}) 提取源 ID 做前缀, 否则用模板自身 ID
    const base = template.recipe_id.replace(/^TPL-/, '').replace(/-\d{10,}$/, '');
    const ts = Date.now().toString().slice(-6);
    const newId = `${base}_${ts}`;
    const newName = template.name.replace('(模板)', '').trim() + ' (副本)';
    audit.confirm({
      description: `从模板 ${template.recipe_id} 创建新配方 ${newId}`,
      action: 'recipe_instantiate_template',
      targetType: 'recipe',
      targetId: newId,
      newValue: `${newName} (源模板: ${template.recipe_id})`,
      onConfirm: async () => {
        const res = await apiFetch(`${API}/api/v1/recipes/from-template/${encodeURIComponent(template.recipe_id)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recipe_id: newId, name: newName, template_version: template.version }),
        });
        if (res.ok) {
          // 直接跳转到新配方的编辑页 (根据 dag schema 版本选编辑器)
          const dagV = (template.dag_schema_version ?? 1) >= 2 ? 'edit-v2' : 'edit';
          router.push(`/recipes/${encodeURIComponent(newId)}/${dagV}?version=1.0.0`);
        } else {
          const data = await res.json().catch(() => ({}));
          alert('应用模板失败: ' + (data.error || data.msg || '未知错误'));
        }
      },
    });
  };

  const deleteRecipe = (recipe: RecipeSummary) => {
    audit.confirm({
      description: `删除配方 ${recipe.recipe_id} v${recipe.version} (${recipe.name})`,
      action: 'recipe_delete', targetType: 'recipe', targetId: `${recipe.recipe_id}@${recipe.version}`,
      oldValue: `${recipe.name} / 状态:${recipe.status || 'draft'}`,
      onConfirm: async () => {
        const res = await fetch(`${API}/api/recipes/${recipe.recipe_id}?version=${recipe.version}`, { method: 'DELETE' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          alert(data.error || '删除失败');
          return;
        }
        loadRecipes();
      },
    });
  };

  // 提交废弃申请 (draft/approved → pending_deprecation)
  const submitForDeprecation = (recipe: RecipeSummary) => {
    audit.confirm({
      description: `申请废弃配方 ${recipe.recipe_id} v${recipe.version} (${recipe.name})`,
      action: 'recipe_submit_deprecation',
      targetType: 'recipe', targetId: `${recipe.recipe_id}@${recipe.version}`,
      oldValue: recipe.status || 'draft', newValue: 'pending_deprecation',
      onConfirm: async () => {
        const res = await apiFetch(`${API}/api/v1/recipes/${encodeURIComponent(recipe.recipe_id)}/submit-for-deprecation`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: recipe.version }),
        });
        if (res.ok) {
          loadRecipes();
        } else {
          const data = await res.json().catch(() => ({}));
          alert('提交废弃失败: ' + (data.error || data.msg || '未知错误'));
        }
      },
    });
  };

  // 从废弃恢复到草稿
  const restoreRecipe = (recipe: RecipeSummary) => {
    audit.confirm({
      description: `恢复废弃配方 ${recipe.recipe_id} v${recipe.version} (${recipe.name}) 到草稿`,
      action: 'recipe_restore',
      targetType: 'recipe', targetId: `${recipe.recipe_id}@${recipe.version}`,
      oldValue: 'deprecated', newValue: 'draft',
      onConfirm: async () => {
        const res = await apiFetch(`${API}/api/v1/recipes/${encodeURIComponent(recipe.recipe_id)}/restore`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: recipe.version }),
        });
        if (res.ok) {
          loadRecipes();
        } else {
          const data = await res.json().catch(() => ({}));
          alert('恢复失败: ' + (data.error || data.msg || '未知错误'));
        }
      },
    });
  };

  // M3.2: 提交审核 (draft → pending_approval)
  const submitForReview = (recipe: RecipeSummary) => {
    audit.confirm({
      description: `提交配方 ${recipe.recipe_id} v${recipe.version} 进入审核队列`,
      action: 'recipe_submit_review',
      targetType: 'recipe', targetId: `${recipe.recipe_id}@${recipe.version}`,
      oldValue: 'draft', newValue: 'pending_approval',
      onConfirm: async () => {
        const res = await apiFetch(`${API}/api/v1/recipes/${encodeURIComponent(recipe.recipe_id)}/submit-for-review`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: recipe.version }),
        });
        if (res.ok) {
          loadRecipes();
        } else {
          const data = await res.json().catch(() => ({}));
          alert('提交审核失败: ' + (data.error || data.msg || '未知错误'));
        }
      },
    });
  };

  // 解锁 approved → draft (允许再次编辑)
  const unlockRecipe = (recipe: RecipeSummary) => {
    audit.confirm({
      description: `解锁配方 ${recipe.recipe_id} v${recipe.version} (转回草稿)`,
      action: 'recipe_unapprove',
      targetType: 'recipe', targetId: `${recipe.recipe_id}@${recipe.version}`,
      oldValue: 'approved', newValue: 'draft',
      onConfirm: async () => {
        await fetch(`${API}/api/recipes/${recipe.recipe_id}/status`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: recipe.version, status: 'draft' }),
        });
        loadRecipes();
      },
    });
  };

  // 下载配方到罐子 — REACTORS 从 /api/reactor-configs 动态拉取
  const [reactorIds, setReactorIds] = useState<string[]>([]);
  const [showDownload, setShowDownload] = useState<RecipeSummary | null>(null);
  const [downloadReactor, setDownloadReactor] = useState<string>('');
  const [downloading, setDownloading] = useState(false);
  const [downloadResult, setDownloadResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [reactorStatuses, setReactorStatuses] = useState<Record<string, any>>({});

  // M3.1: 历史抽屉
  const [historyOpenFor, setHistoryOpenFor] = useState<string | null>(null);

  // 拉取启用反应器
  useEffect(() => {
    fetch(`${API}/api/reactor-configs`)
      .then(r => r.ok ? r.json() : [])
      .then((rows: any[]) => {
        const ids = Array.isArray(rows)
          ? rows.filter(r => r?.enabled !== 0).map(r => r.reactor_id).filter(Boolean)
          : [];
        setReactorIds(ids);
        setDownloadReactor(prev => (prev && ids.includes(prev)) ? prev : (ids[0] || ''));
      })
      .catch(() => { /* offline OK */ });
  }, []);

  // 轮询罐子配方状态
  useEffect(() => {
    if (reactorIds.length === 0) return;
    const poll = () => {
      Promise.all(reactorIds.map(id =>
        fetch(`${API}/api/reactors/${id}/recipe`).then(r => r.json()).catch(() => ({ downloaded: false }))
      )).then(results => {
        const map: Record<string, any> = {};
        reactorIds.forEach((id, i) => { map[id] = results[i]; });
        setReactorStatuses(map);
      });
    };
    poll();
    const t = setInterval(poll, 2000);
    return () => clearInterval(t);
  }, [reactorIds]);

  const doDownload = async () => {
    if (!showDownload) return;
    setDownloading(true);
    setDownloadResult(null);
    try {
      const resp = await fetch(`${API}/api/reactors/${downloadReactor}/download-recipe`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipe_id: showDownload.recipe_id, version: showDownload.version }),
      });
      const data = await resp.json();
      if (data.success) {
        setDownloadResult({ ok: true, msg: `${showDownload.name} 已下载到 ${downloadReactor}` });
        setTimeout(() => { setShowDownload(null); setDownloadResult(null); }, 800);
      } else {
        setDownloadResult({ ok: false, msg: data.error || '下载失败' });
      }
    } catch {
      setDownloadResult({ ok: false, msg: '网络错误' });
    }
    setDownloading(false);
  };

  const searched = search.trim()
    ? recipes.filter(r =>
        r.recipe_id.toLowerCase().includes(search.toLowerCase()) ||
        r.name.toLowerCase().includes(search.toLowerCase()) ||
        (r.target_organism ?? '').toLowerCase().includes(search.toLowerCase())
      )
    : recipes;
  const filtered = selectedReactor === null
    ? searched
    : selectedReactor === '__unassigned__'
      ? searched.filter(r => !recipeReactor(r))
      : searched.filter(r => recipeReactor(r) === selectedReactor);

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      {/* 标题 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2 text-foreground">
            <BookOpen className="w-5 h-5 text-primary" /> 配方管理
          </h1>
          <p className="text-sm text-muted-foreground mt-1">创建和管理发酵配方</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => router.push('/recipes/new/edit-v2')}
            className="flex items-center gap-1.5 h-8 px-3 rounded text-sm font-medium bg-purple-600 text-white hover:bg-purple-700">
            <Plus className="w-3.5 h-3.5" /> 新建 DAG 配方
          </button>
          <button onClick={() => router.push('/recipes/new/edit')}
            className="flex items-center gap-1.5 h-8 px-3 rounded text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90">
            <Plus className="w-3.5 h-3.5" /> 新建配方
          </button>
        </div>
      </div>

      {/* M3.3: 配方 / 模板 tabs */}
      <div className="flex items-center gap-1 border-b border-border">
        <button
          onClick={() => setTab('recipes')}
          className={`h-8 px-4 text-sm font-medium flex items-center gap-1.5 border-b-2 -mb-px ${
            tab === 'recipes'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <BookOpen className="w-3 h-3" /> 配方
        </button>
        <button
          onClick={() => setTab('templates')}
          className={`h-8 px-4 text-sm font-medium flex items-center gap-1.5 border-b-2 -mb-px ${
            tab === 'templates'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <Bookmark className="w-3 h-3" /> 模板
        </button>
        <button
          onClick={() => setTab('deprecated')}
          className={`h-8 px-4 text-sm font-medium flex items-center gap-1.5 border-b-2 -mb-px ${
            tab === 'deprecated'
              ? 'border-red-500 text-red-500'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <Ban className="w-3 h-3" /> 废弃
        </button>
      </div>

      {/* 按罐子分页 — 每个 reactor 一个 pill,显示该罐配方数 */}
      {reactorIds.length > 0 && (
        <div className="flex flex-wrap gap-1 border-b pb-2">
          <button
            onClick={() => setSelectedReactor(null)}
            className={`px-3 py-1 text-sm rounded ${selectedReactor === null
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-muted'}`}
          >
            全部 ({searched.length})
          </button>
          {reactorIds.map(rid => {
            const count = searched.filter(r => recipeReactor(r) === rid).length;
            return (
              <button key={rid}
                onClick={() => setSelectedReactor(rid)}
                className={`px-3 py-1 text-sm rounded font-mono ${selectedReactor === rid
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted'}`}
              >
                {rid} ({count})
              </button>
            );
          })}
          {(() => {
            const unassigned = searched.filter(r => !recipeReactor(r)).length;
            if (unassigned === 0) return null;
            return (
              <button
                onClick={() => setSelectedReactor('__unassigned__')}
                className={`px-3 py-1 text-sm rounded ${selectedReactor === '__unassigned__'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted'}`}
              >
                未绑定 ({unassigned})
              </button>
            );
          })()}
        </div>
      )}

      {/* 搜索 */}
      <div className="relative w-full max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <input value={search} onChange={e => setSearch(e.target.value)}
          className="w-full h-8 pl-9 pr-3 rounded bg-card border border-border text-sm text-foreground placeholder:text-muted-foreground"
          placeholder="搜索配方ID、名称、菌种..." />
      </div>

      {/* 加载/错误/空 */}
      {loading && <div className="text-center text-muted-foreground py-16 text-sm">加载中...</div>}
      {error && <div className="text-center text-red-600 py-16 text-sm">{error}</div>}
      {!loading && !error && filtered.length === 0 && (
        <div className="text-center py-16 space-y-3">
          <FlaskConical className="w-12 h-12 mx-auto text-muted-foreground/50" />
          <p className="text-muted-foreground text-sm">{search ? '没有匹配的配方' : '暂无配方，点击上方按钮创建'}</p>
        </div>
      )}

      {/* 配方卡片网格 */}
      {!loading && !error && filtered.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map(recipe => {
            const st = STATUS_STYLES[recipe.status ?? 'draft'] ?? STATUS_STYLES.draft;
            const phaseCount = recipe.phases?.length ?? 0;
            const isLocked = recipe.status === 'approved';
            const isPending = recipe.status === 'pending_approval';
            const isDraft = !recipe.status || recipe.status === 'draft';
            const isPendingDeprecation = recipe.status === 'pending_deprecation';
            const isDeprecated = recipe.status === 'deprecated';
            const isReadOnly = isLocked || isPending || isPendingDeprecation || isDeprecated;

            return (
              <div key={`${recipe.recipe_id}-${recipe.version}`}
                className="bg-card border border-border rounded-md hover:border-primary/50 transition-colors cursor-pointer"
                onClick={() => router.push(editUrlFor(recipe))}>
                <div className="p-4 space-y-3">
                  {/* 头部 */}
                  <div className="flex items-start justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-sm text-foreground truncate">{recipe.name}</div>
                      <div className="text-sm text-muted-foreground font-mono mt-0.5 truncate">{recipe.recipe_id}</div>
                    </div>
                    <span className={`px-2 py-0.5 rounded text-sm font-semibold ${st.bg}`}>{st.label}</span>
                  </div>

                  {/* 标签 */}
                  <div className="flex flex-wrap gap-1.5 text-sm">
                    <span className="bg-muted/50 text-muted-foreground px-2 py-0.5 rounded">v{recipe.version}</span>
                    {(recipe.dag_schema_version ?? 1) >= 2 && (
                      <span className="bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded">DAG v2</span>
                    )}
                    {phaseCount > 0 && <span className="bg-muted/50 text-muted-foreground px-2 py-0.5 rounded">{phaseCount} Phases</span>}
                    {recipe.target_organism && <span className="bg-muted/50 text-muted-foreground px-2 py-0.5 rounded">{recipe.target_organism}</span>}
                  </div>

                  {recipe.author && <div className="text-sm text-muted-foreground">作者: {recipe.author}</div>}

                  {/* 操作按钮 */}
                  <div className="flex justify-end gap-1.5 pt-1 flex-wrap">
                    {tab === 'templates' ? (
                      // 模板卡片: 应用 + 删除
                      <>
                        <button onClick={e => { e.stopPropagation(); applyTemplate(recipe); }}
                          className="flex items-center gap-1 h-6 px-2 rounded text-sm font-medium border border-primary/40 text-primary hover:bg-primary/10">
                          <Sparkles className="w-3 h-3" /> 应用此模板
                        </button>
                        <button onClick={e => { e.stopPropagation(); deleteRecipe(recipe); }}
                          className="flex items-center h-6 px-1.5 rounded text-sm border border-border text-red-600 hover:bg-red-500/10">
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </>
                    ) : tab === 'deprecated' ? (
                      // 废弃 tab: 只显示恢复按钮
                      <button onClick={e => { e.stopPropagation(); restoreRecipe(recipe); }}
                        className="flex items-center gap-1 h-6 px-2 rounded text-sm font-medium border border-primary/40 text-primary hover:bg-primary/10">
                        <RotateCcw className="w-3 h-3" /> 恢复到草稿
                      </button>
                    ) : (
                      <>
                        {isLocked && (
                          <button onClick={e => { e.stopPropagation(); setShowDownload(recipe); }}
                            className="flex items-center gap-1 h-6 px-2 rounded text-sm font-medium border border-primary/40 text-primary hover:bg-primary/10">
                            <Download className="w-3 h-3" /> 下载到罐
                          </button>
                        )}
                        {isLocked && (
                          <button
                            onClick={e => {
                              e.stopPropagation();
                              router.push(`/doe?new=1&baseRecipe=${encodeURIComponent(recipe.recipe_id)}&baseVersion=${recipe.version}`);
                            }}
                            className="flex items-center gap-1 h-6 px-2 rounded text-sm font-medium border border-primary/40 text-primary hover:bg-primary/10"
                            title="基于此配方创建 DoE 实验设计研究">
                            <Sigma className="w-3 h-3" /> 创建 DoE
                          </button>
                        )}
                        <button onClick={e => { e.stopPropagation(); setHistoryOpenFor(recipe.recipe_id); }}
                          className="flex items-center gap-1 h-6 px-2 rounded text-sm font-medium border border-border text-muted-foreground hover:bg-muted">
                          <History className="w-3 h-3" /> 历史
                        </button>
                        <button onClick={e => { e.stopPropagation(); saveAsTemplate(recipe); }}
                          className="flex items-center gap-1 h-6 px-2 rounded text-sm font-medium border border-border text-muted-foreground hover:bg-muted"
                          title="另存为模板">
                          <BookmarkPlus className="w-3 h-3" />
                        </button>
                      </>
                    )}
                    {/* 状态感知按钮 */}
                    {tab === 'recipes' && isDraft && (
                      <button onClick={e => { e.stopPropagation(); submitForReview(recipe); }}
                        className="flex items-center gap-1 h-6 px-2 rounded text-sm font-medium border border-amber-500/40 text-amber-400 hover:bg-amber-500/10"
                        title="提交配方到审核队列">
                        <Send className="w-3 h-3" /> 提交审核
                      </button>
                    )}
                    {tab === 'recipes' && isPending && (
                      <button onClick={e => { e.stopPropagation(); router.push('/recipes/review-queue'); }}
                        className="flex items-center gap-1 h-6 px-2 rounded text-sm font-medium border border-amber-500/40 text-amber-400 hover:bg-amber-500/10"
                        title="配方在审核队列中等待批准">
                        <ShieldCheck className="w-3 h-3" /> 待审核
                      </button>
                    )}
                    {tab === 'recipes' && isPendingDeprecation && (
                      <button onClick={e => { e.stopPropagation(); router.push('/recipes/review-queue'); }}
                        className="flex items-center gap-1 h-6 px-2 rounded text-sm font-medium border border-red-500/40 text-red-600 hover:bg-red-500/10"
                        title="配方在审核队列中等待废弃审批">
                        <Ban className="w-3 h-3" /> 待废弃
                      </button>
                    )}
                    {tab === 'recipes' && isLocked && (
                      <button onClick={e => { e.stopPropagation(); unlockRecipe(recipe); }}
                        className="flex items-center gap-1 h-6 px-2 rounded text-sm font-medium border border-border text-muted-foreground hover:bg-muted"
                        title="解锁配方 (回到草稿状态, 允许再次编辑)">
                        <Unlock className="w-3 h-3" /> 解锁
                      </button>
                    )}
                    {/* 废弃按钮: draft 和 approved 可用 */}
                    {tab === 'recipes' && (isDraft || isLocked) && (
                      <button onClick={e => { e.stopPropagation(); submitForDeprecation(recipe); }}
                        className="flex items-center gap-1 h-6 px-2 rounded text-sm font-medium border border-red-500/30 text-red-600 hover:bg-red-500/10"
                        title="申请废弃此配方">
                        <Ban className="w-3 h-3" /> 废弃
                      </button>
                    )}
                    {tab !== 'templates' && tab !== 'deprecated' && isLocked && (
                      <button onClick={e => { e.stopPropagation(); router.push(editUrlFor(recipe)); }}
                        className="flex items-center gap-1 h-6 px-2 rounded text-sm font-medium border border-border text-muted-foreground hover:bg-muted">
                        <FileText className="w-3 h-3" /> 查看
                      </button>
                    )}
                    {tab !== 'templates' && tab !== 'deprecated' && !isLocked && (
                      <button onClick={e => { e.stopPropagation(); router.push(editUrlFor(recipe)); }}
                        disabled={isPending || isPendingDeprecation}
                        className={`flex items-center gap-1 h-6 px-2 rounded text-sm font-medium border border-border
                          ${isPending || isPendingDeprecation ? 'text-muted-foreground/40 cursor-not-allowed' : 'text-muted-foreground hover:bg-muted'}`}>
                        <Edit className="w-3 h-3" /> 编辑
                      </button>
                    )}
                    {tab !== 'templates' && tab !== 'deprecated' && (
                      <button onClick={e => { e.stopPropagation(); deleteRecipe(recipe); }}
                        disabled={isReadOnly}
                        className={`flex items-center h-6 px-1.5 rounded text-sm border border-border
                          ${isReadOnly ? 'text-muted-foreground/40 cursor-not-allowed' : 'text-red-600 hover:bg-red-500/10'}`}>
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 罐子配方状态栏 */}
      <div className="bg-card border border-border rounded-md p-3">
        <div className="text-sm font-semibold text-foreground mb-2">罐子配方状态</div>
        <div className="flex flex-wrap gap-2">
          {reactorIds.length === 0 && (
            <span className="text-sm text-muted-foreground">无可用反应器</span>
          )}
          {reactorIds.map(id => {
            const st = reactorStatuses[id];
            const hasRecipe = st?.downloaded;
            return (
              <div key={id} className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-sm font-mono border
                ${hasRecipe ? 'bg-green-500/10 border-green-500/30 text-emerald-600' : 'bg-muted/30 border-border text-muted-foreground'}`}>
                <div className={`w-1.5 h-1.5 rounded-full ${hasRecipe ? 'bg-green-500' : 'bg-gray-600'}`} />
                <span className="font-semibold">{id}</span>
                {hasRecipe && <span className="text-[12px]">{st.recipe_name || st.recipe_id}</span>}
                {!hasRecipe && <span className="text-[12px]">空</span>}
              </div>
            );
          })}
        </div>
      </div>

      {audit.dialog}

      {/* M3.1: 版本历史抽屉 */}
      <RecipeHistoryDrawer
        open={historyOpenFor !== null}
        recipeId={historyOpenFor}
        onClose={() => setHistoryOpenFor(null)}
      />


      {/* 下载对话框 */}
      {showDownload && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 backdrop-blur-sm" onClick={() => !downloading && setShowDownload(null)}>
          <div className="bg-card border border-border rounded-lg w-[420px] shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <Download className="w-4 h-4 text-primary" />
                <span className="text-sm font-semibold text-foreground">下载配方至罐</span>
              </div>
              <button onClick={() => !downloading && setShowDownload(null)} className="text-muted-foreground hover:text-foreground">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              {/* 配方信息 */}
              <div className="bg-muted/30 border border-border rounded p-3 space-y-1">
                <div className="text-sm text-muted-foreground">选中配方</div>
                <div className="text-sm font-semibold text-foreground">{showDownload.name}</div>
                <div className="text-sm font-mono text-muted-foreground">{showDownload.recipe_id} v{showDownload.version}</div>
                {showDownload.phases && <div className="text-sm text-muted-foreground">{showDownload.phases.length} 个Phase</div>}
              </div>

              {/* 选择目标罐 */}
              <div>
                <div className="text-sm font-medium text-foreground mb-2">选择目标罐</div>
                <div className="grid grid-cols-4 gap-2">
                  {reactorIds.length === 0 && (
                    <span className="col-span-4 text-sm text-muted-foreground text-center py-4">无可用反应器</span>
                  )}
                  {reactorIds.map(id => {
                    const st = reactorStatuses[id];
                    const hasRecipe = st?.downloaded;
                    const selected = downloadReactor === id;
                    return (
                      <button key={id} onClick={() => setDownloadReactor(id)}
                        className={`flex flex-col items-center gap-0.5 p-2 rounded border text-sm font-mono transition-all
                          ${selected
                            ? 'border-primary bg-primary/10 text-primary'
                            : hasRecipe
                              ? 'border-yellow-500/30 bg-yellow-500/5 text-amber-600 hover:border-yellow-500/50'
                              : 'border-border bg-muted/20 text-muted-foreground hover:border-muted-foreground/50'
                          }`}>
                        <span className="font-semibold">{id}</span>
                        <span className="text-[12px]">{hasRecipe ? '已有配方' : '空闲'}</span>
                      </button>
                    );
                  })}
                </div>
                {reactorStatuses[downloadReactor]?.downloaded && (
                  <div className="flex items-center gap-1 mt-2 text-sm text-amber-600">
                    <span>⚠ {downloadReactor} 已有配方 ({reactorStatuses[downloadReactor]?.recipe_name})，下载将覆盖</span>
                  </div>
                )}
              </div>

              {/* 结果提示 */}
              {downloadResult && (
                <div className={`flex items-center gap-1.5 text-sm px-3 py-2 rounded border
                  ${downloadResult.ok
                    ? 'bg-green-500/10 border-green-500/30 text-emerald-600'
                    : 'bg-red-500/10 border-red-500/30 text-red-600'}`}>
                  {downloadResult.ok ? <Check className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
                  {downloadResult.msg}
                </div>
              )}

              {/* 按钮 */}
              <div className="flex gap-2">
                <button onClick={() => !downloading && setShowDownload(null)}
                  className="flex-1 h-9 rounded text-sm font-medium border border-border text-muted-foreground hover:bg-muted">
                  取消
                </button>
                <button onClick={doDownload} disabled={downloading}
                  className={`flex-1 flex items-center justify-center gap-1.5 h-9 rounded text-sm font-semibold transition-all
                    ${downloading
                      ? 'bg-primary/50 text-primary-foreground cursor-wait'
                      : 'bg-primary text-primary-foreground hover:bg-primary/90'}`}>
                  {downloading
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> 下载中...</>
                    : <><Download className="w-3.5 h-3.5" /> 下载到 {downloadReactor}</>}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
