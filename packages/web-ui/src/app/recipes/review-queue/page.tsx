// 配方审核队列 (Sprint 3 M3.2 + 废弃审核)
'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ShieldCheck, FileText, X, Check, Loader2, Ban } from 'lucide-react';
import { apiFetch } from '@/lib/auth';
import { useAudit } from '@/hooks/useAudit';
import { useLocale } from '@/i18n/useLocale';
import { PageHeader } from '@/components/layout/PageHeader';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

interface PendingRecipe {
  recipe_id: string;
  version: string;
  name: string;
  author: string;
  created_at: string;
  created_by: string;
  parent_version: string | null;
  dag_schema_version: number;
  status: string;                    // 'pending_approval' | 'pending_deprecation'
  pre_deprecation_status?: string;   // 废弃前的原状态
}

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  approved: '已批准',
  pending_approval: '待审核',
};

export default function ReviewQueuePage() {
  const { t } = useLocale();
  const router = useRouter();
  const audit = useAudit();
  const [pending, setPending] = useState<PendingRecipe[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`${API}/api/v1/recipes/pending-review`);
      if (res.ok) {
        const data = await res.json();
        setPending(Array.isArray(data) ? data : (data?.data ?? []));
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── 审批流程 (pending_approval) ──

  const doApprove = (recipe: PendingRecipe) => {
    audit.confirm({
      description: `批准配方 ${recipe.recipe_id} v${recipe.version}`,
      action: 'recipe_approve',
      targetType: 'recipe',
      targetId: `${recipe.recipe_id}@${recipe.version}`,
      oldValue: 'pending_approval',
      newValue: 'approved',
      onConfirm: async () => {
        const res = await apiFetch(`${API}/api/v1/recipes/${recipe.recipe_id}/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: recipe.version }),
        });
        if (res.ok) load();
      },
    });
  };

  const doReject = (recipe: PendingRecipe) => {
    audit.confirm({
      title: '拒绝配方审核',
      description: `拒绝配方 ${recipe.name} (${recipe.recipe_id} v${recipe.version}) — 配方将回到草稿状态, 拒绝原因(下面"修改原因"字段)将记入配方备注`,
      action: 'recipe_reject',
      targetType: 'recipe',
      targetId: `${recipe.recipe_id}@${recipe.version}`,
      oldValue: 'pending_approval',
      newValue: 'draft',
      onConfirm: async (_username?: string, reason?: string) => {
        const rejectReason = reason || '审核未通过';
        const res = await apiFetch(`${API}/api/v1/recipes/${encodeURIComponent(recipe.recipe_id)}/reject`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: recipe.version, reason: rejectReason }),
        });
        if (res.ok) {
          load();
        } else {
          const data = await res.json().catch(() => ({}));
          alert('拒绝失败: ' + (data.error || data.msg || '未知错误'));
        }
      },
    });
  };

  // ── 废弃审核流程 (pending_deprecation) ──

  const doApproveDeprecation = (recipe: PendingRecipe) => {
    audit.confirm({
      description: `确认废弃配方 ${recipe.recipe_id} v${recipe.version} (${recipe.name})`,
      action: 'recipe_approve_deprecation',
      targetType: 'recipe',
      targetId: `${recipe.recipe_id}@${recipe.version}`,
      oldValue: 'pending_deprecation',
      newValue: 'deprecated',
      onConfirm: async () => {
        const res = await apiFetch(`${API}/api/v1/recipes/${encodeURIComponent(recipe.recipe_id)}/approve-deprecation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: recipe.version }),
        });
        if (res.ok) load();
      },
    });
  };

  const doRejectDeprecation = (recipe: PendingRecipe) => {
    const origLabel = STATUS_LABEL[recipe.pre_deprecation_status ?? ''] || recipe.pre_deprecation_status || '原状态';
    audit.confirm({
      title: '拒绝废弃请求',
      description: `拒绝废弃配方 ${recipe.name} (${recipe.recipe_id} v${recipe.version}) — 配方将恢复到「${origLabel}」状态`,
      action: 'recipe_reject_deprecation',
      targetType: 'recipe',
      targetId: `${recipe.recipe_id}@${recipe.version}`,
      oldValue: 'pending_deprecation',
      newValue: recipe.pre_deprecation_status || 'draft',
      onConfirm: async (_username?: string, reason?: string) => {
        const rejectReason = reason || '废弃请求被拒绝';
        const res = await apiFetch(`${API}/api/v1/recipes/${encodeURIComponent(recipe.recipe_id)}/reject-deprecation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: recipe.version, reason: rejectReason }),
        });
        if (res.ok) {
          load();
        } else {
          const data = await res.json().catch(() => ({}));
          alert('拒绝失败: ' + (data.error || data.msg || '未知错误'));
        }
      },
    });
  };

  // ── 统计 ──
  const approvalCount = pending.filter(r => r.status === 'pending_approval').length;
  const deprecationCount = pending.filter(r => r.status === 'pending_deprecation').length;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {audit.dialog}

      <PageHeader
        icon={ShieldCheck}
        title="配方审核队列"
        subtitle="审核配方批准和废弃请求, 批准后生效, 拒绝将回到原状态并记录原因"
        right={
          <>
            {approvalCount > 0 && (
              <div className="px-3 py-1.5 rounded bg-amber-500/10 text-sm text-amber-500">
                待批准 <span className="font-bold">{approvalCount}</span>
              </div>
            )}
            {deprecationCount > 0 && (
              <div className="px-3 py-1.5 rounded bg-red-500/10 text-sm text-red-600">
                待废弃 <span className="font-bold">{deprecationCount}</span>
              </div>
            )}
            {pending.length === 0 && !loading && (
              <div className="px-3 py-1.5 rounded bg-muted text-sm">
                待审 <span className="font-bold text-primary">0</span>
              </div>
            )}
          </>
        }
      />

      {loading ? (
        <Card><CardContent className="p-8 text-center text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin mx-auto mb-2" />加载中...</CardContent></Card>
      ) : pending.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-muted-foreground">
            <ShieldCheck className="w-10 h-10 mx-auto text-muted-foreground/30 mb-3" />
            <p className="text-sm">当前没有待审核的配方</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {pending.map(r => {
            const isDeprecation = r.status === 'pending_deprecation';
            const origLabel = STATUS_LABEL[r.pre_deprecation_status ?? ''] || r.pre_deprecation_status;

            return (
              <Card key={`${r.recipe_id}-${r.version}`}>
                <CardContent className="p-4 flex items-center gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold text-sm">{r.name}</span>
                      <span className="font-mono text-sm text-muted-foreground">
                        {r.recipe_id} · v{r.version}
                      </span>
                      {r.dag_schema_version >= 2 && (
                        <span className="px-1.5 py-0.5 rounded text-sm bg-purple-500/20 text-purple-300">
                          DAG v2
                        </span>
                      )}
                      {/* 审核类型标签 */}
                      {isDeprecation ? (
                        <span className="px-1.5 py-0.5 rounded text-sm bg-red-500/15 text-red-600 border border-red-500/30">
                          废弃申请
                        </span>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded text-sm bg-amber-500/15 text-amber-400 border border-amber-500/30">
                          新配方审批
                        </span>
                      )}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      提交人: {r.created_by} · {new Date(r.created_at).toLocaleString('zh-CN')}
                      {r.parent_version && (
                        <span className="ml-2">· 源自 v{r.parent_version}</span>
                      )}
                      {isDeprecation && origLabel && (
                        <span className="ml-2">· 原状态: {origLabel}</span>
                      )}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => router.push(`/recipes/${r.recipe_id}/edit?version=${r.version}`)}
                  >
                    <FileText className="w-3.5 h-3.5 mr-1" />查看
                  </Button>
                  {isDeprecation ? (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => doRejectDeprecation(r)}
                        className="text-muted-foreground border-border hover:bg-muted"
                      >
                        <X className="w-3.5 h-3.5 mr-1" />拒绝废弃
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => doApproveDeprecation(r)}
                        className="bg-red-600 hover:bg-red-700"
                      >
                        <Ban className="w-3.5 h-3.5 mr-1" />确认废弃
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => doReject(r)}
                        className="text-red-600 border-red-500/30 hover:bg-red-500/10"
                      >
                        <X className="w-3.5 h-3.5 mr-1" />拒绝
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => doApprove(r)}
                        className="bg-green-600 hover:bg-green-700"
                      >
                        <Check className="w-3.5 h-3.5 mr-1" />批准
                      </Button>
                    </>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

    </div>
  );
}
