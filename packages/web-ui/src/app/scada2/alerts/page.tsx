// ============================================================
// alerts/page.tsx — 告警通知管理页 (SP-FX-42)
// ============================================================
// 路由: /scada2/alerts
// 功能: 管理告警规则 / 渠道 / 历史 (admin only)
// 三 Tab: Rules / Channels / History
// ============================================================

'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useLocale } from '@/i18n/useLocale';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// ─── 类型 ─────────────────────────────────────────────────────

interface AlertChannel {
  id: number;
  type: 'slack' | 'email' | 'webhook';
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
}

interface AlertRule {
  id: number;
  name: string;
  trigger_type: 'audit_log' | 'write_intent_reject' | 'system_error' | 'threshold';
  condition_expr: string;
  channel_id: number;
  enabled: boolean;
  created_at: string;
}

interface AlertHistoryRow {
  id: number;
  rule_id: number;
  fired_at: string;
  payload: unknown;
  delivered: boolean;
  retry_count: number;
}

type Tab = 'rules' | 'channels' | 'history';

const TRIGGER_TYPES = ['audit_log', 'write_intent_reject', 'system_error', 'threshold'] as const;
const CHANNEL_TYPES = ['slack', 'email', 'webhook'] as const;

// ─── 主页面 ───────────────────────────────────────────────────

export default function AlertsPage() {
  const { t } = useLocale();
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>('rules');

  // 非 admin 门控
  if (!user || user.role !== 'admin') {
    return (
      <div style={{ padding: 24 }}>
        <p style={{ color: '#ef4444', fontWeight: 600 }}>无权访问</p>
        <p style={{ color: '#6b7280' }}>此页面仅管理员可访问。</p>
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ margin: '0 0 16px' }}>告警通知管理</h2>

      {/* Tab 导航 */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '2px solid #e5e7eb', marginBottom: 16 }}>
        {(['rules', 'channels', 'history'] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              padding: '8px 20px',
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              fontWeight: activeTab === tab ? 700 : 400,
              borderBottom: activeTab === tab ? '2px solid #3b82f6' : '2px solid transparent',
              marginBottom: -2,
              color: activeTab === tab ? '#3b82f6' : '#374151',
              fontSize: 14,
            }}
          >
            {tab === 'rules' ? 'Rules 规则' : tab === 'channels' ? 'Channels 渠道' : 'History 历史'}
          </button>
        ))}
      </div>

      {/* Tab 内容 */}
      {activeTab === 'rules' && <RulesTab />}
      {activeTab === 'channels' && <ChannelsTab />}
      {activeTab === 'history' && <HistoryTab />}
    </div>
  );
}

// ─── Rules Tab ────────────────────────────────────────────────

function RulesTab() {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editTarget, setEditTarget] = useState<AlertRule | null>(null);

  const fetchRules = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/v1/alerts/rules`);
      const data = await res.json();
      setRules(Array.isArray(data) ? data : []);
    } catch {
      setError('加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchRules(); }, [fetchRules]);

  const handleDelete = async (id: number) => {
    await fetch(`${API}/api/v1/alerts/rules/${id}`, { method: 'DELETE' });
    fetchRules();
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontWeight: 600 }}>告警规则</span>
        <button
          onClick={() => { setEditTarget(null); setShowModal(true); }}
          style={{ padding: '6px 14px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}
        >
          新建规则
        </button>
      </div>

      {error && <p style={{ color: '#ef4444' }}>加载失败: {error}</p>}
      {loading && <p style={{ color: '#6b7280' }}>加载中...</p>}

      {!loading && rules.length === 0 && !error && (
        <p style={{ color: '#9ca3af' }}>暂无告警规则</p>
      )}

      {rules.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              {['名称', '触发类型', '条件', '渠道ID', '启用', '操作'].map(h => (
                <th key={h} style={{ padding: '8px 10px', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <td style={{ padding: '8px 10px' }}>{r.name}</td>
                <td style={{ padding: '8px 10px' }}>{r.trigger_type}</td>
                <td style={{ padding: '8px 10px', fontFamily: 'monospace', fontSize: 12 }}>{r.condition_expr}</td>
                <td style={{ padding: '8px 10px' }}>{r.channel_id}</td>
                <td style={{ padding: '8px 10px' }}>{r.enabled ? '✓' : '✗'}</td>
                <td style={{ padding: '8px 10px', display: 'flex', gap: 6 }}>
                  <button onClick={() => { setEditTarget(r); setShowModal(true); }}
                    style={{ fontSize: 12, padding: '2px 8px', cursor: 'pointer' }}>编辑</button>
                  <button onClick={() => handleDelete(r.id)}
                    style={{ fontSize: 12, padding: '2px 8px', cursor: 'pointer', color: '#ef4444' }}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showModal && (
        <RuleModal
          initial={editTarget}
          onClose={() => setShowModal(false)}
          onSaved={() => { setShowModal(false); fetchRules(); }}
        />
      )}
    </div>
  );
}

// ─── Channels Tab ─────────────────────────────────────────────

function ChannelsTab() {
  const [channels, setChannels] = useState<AlertChannel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editTarget, setEditTarget] = useState<AlertChannel | null>(null);

  const fetchChannels = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/v1/alerts/channels`);
      const data = await res.json();
      setChannels(Array.isArray(data) ? data : []);
    } catch {
      setError('加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchChannels(); }, [fetchChannels]);

  const handleDelete = async (id: number) => {
    await fetch(`${API}/api/v1/alerts/channels/${id}`, { method: 'DELETE' });
    fetchChannels();
  };

  const handleTest = async (id: number) => {
    await fetch(`${API}/api/v1/alerts/test/${id}`, { method: 'POST' });
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontWeight: 600 }}>告警渠道</span>
        <button
          onClick={() => { setEditTarget(null); setShowModal(true); }}
          style={{ padding: '6px 14px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}
        >
          新建渠道
        </button>
      </div>

      {error && <p style={{ color: '#ef4444' }}>加载失败: {error}</p>}
      {loading && <p style={{ color: '#6b7280' }}>加载中...</p>}

      {!loading && channels.length === 0 && !error && (
        <p style={{ color: '#9ca3af' }}>暂无告警渠道</p>
      )}

      {channels.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              {['名称', '类型', '启用', '操作'].map(h => (
                <th key={h} style={{ padding: '8px 10px', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {channels.map((c) => (
              <tr key={c.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <td style={{ padding: '8px 10px' }}>{c.name}</td>
                <td style={{ padding: '8px 10px' }}>{c.type}</td>
                <td style={{ padding: '8px 10px' }}>{c.enabled ? '✓' : '✗'}</td>
                <td style={{ padding: '8px 10px', display: 'flex', gap: 6 }}>
                  <button onClick={() => { setEditTarget(c); setShowModal(true); }}
                    style={{ fontSize: 12, padding: '2px 8px', cursor: 'pointer' }}>编辑</button>
                  <button onClick={() => handleTest(c.id)}
                    style={{ fontSize: 12, padding: '2px 8px', cursor: 'pointer', color: '#3b82f6' }}>测试</button>
                  <button onClick={() => handleDelete(c.id)}
                    style={{ fontSize: 12, padding: '2px 8px', cursor: 'pointer', color: '#ef4444' }}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showModal && (
        <ChannelModal
          initial={editTarget}
          onClose={() => setShowModal(false)}
          onSaved={() => { setShowModal(false); fetchChannels(); }}
        />
      )}
    </div>
  );
}

// ─── History Tab ──────────────────────────────────────────────

function HistoryTab() {
  const [rows, setRows] = useState<AlertHistoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/v1/alerts/history?limit=100`);
      const data = await res.json();
      setRows(Array.isArray(data) ? data : []);
    } catch {
      setError('加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  return (
    <div>
      <div style={{ marginBottom: 12, fontWeight: 600 }}>告警历史 (最近 100 条)</div>

      {error && <p style={{ color: '#ef4444' }}>加载失败: {error}</p>}
      {loading && <p style={{ color: '#6b7280' }}>加载中...</p>}

      {!loading && rows.length === 0 && !error && (
        <p style={{ color: '#9ca3af' }}>暂无告警历史</p>
      )}

      {rows.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              {['规则ID', '触发时间', '投递', 'retry 次数'].map(h => (
                <th key={h} style={{ padding: '8px 10px', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <td style={{ padding: '8px 10px' }}>{r.rule_id}</td>
                <td style={{ padding: '8px 10px' }}>{r.fired_at}</td>
                <td style={{ padding: '8px 10px', color: r.delivered ? '#16a34a' : '#ef4444' }}>
                  {r.delivered ? '成功' : '失败'}
                </td>
                <td style={{ padding: '8px 10px' }}>{r.retry_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── Rule Modal ───────────────────────────────────────────────

interface RuleModalProps {
  initial: AlertRule | null;
  onClose: () => void;
  onSaved: () => void;
}

function RuleModal({ initial, onClose, onSaved }: RuleModalProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [triggerType, setTriggerType] = useState<string>(initial?.trigger_type ?? 'threshold');
  const [conditionExpr, setConditionExpr] = useState(initial?.condition_expr ?? 'true');
  const [channelId, setChannelId] = useState<string>(String(initial?.channel_id ?? ''));
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    const body = { name, trigger_type: triggerType, condition_expr: conditionExpr, channel_id: Number(channelId), enabled };
    const url = initial ? `${API}/api/v1/alerts/rules/${initial.id}` : `${API}/api/v1/alerts/rules`;
    const method = initial ? 'PUT' : 'POST';
    await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    setSaving(false);
    onSaved();
  };

  return (
    <div style={OVERLAY_STYLE}>
      <div style={MODAL_STYLE}>
        <h3 style={{ margin: '0 0 16px' }}>{initial ? '编辑规则' : '新建规则'}</h3>

        <label style={LABEL_STYLE}>规则名称</label>
        <input value={name} onChange={e => setName(e.target.value)} style={INPUT_STYLE} />

        <label style={LABEL_STYLE}>触发类型</label>
        <select value={triggerType} onChange={e => setTriggerType(e.target.value)} style={INPUT_STYLE}>
          {TRIGGER_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>

        <label style={LABEL_STYLE}>条件表达式</label>
        <input value={conditionExpr} onChange={e => setConditionExpr(e.target.value)} style={INPUT_STYLE} placeholder="e.g. value > 80" />

        <label style={LABEL_STYLE}>渠道 ID</label>
        <input type="number" value={channelId} onChange={e => setChannelId(e.target.value)} style={INPUT_STYLE} />

        <label style={{ ...LABEL_STYLE, display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
          启用
        </label>

        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={CANCEL_BTN_STYLE}>取消</button>
          <button onClick={handleSave} disabled={saving} style={SAVE_BTN_STYLE}>
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Channel Modal ────────────────────────────────────────────

interface ChannelModalProps {
  initial: AlertChannel | null;
  onClose: () => void;
  onSaved: () => void;
}

function ChannelModal({ initial, onClose, onSaved }: ChannelModalProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [type, setType] = useState<string>(initial?.type ?? 'slack');
  const [configStr, setConfigStr] = useState(initial ? JSON.stringify(initial.config, null, 2) : '{}');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    let config: unknown = {};
    try { config = JSON.parse(configStr); } catch { /* keep empty */ }
    const body = { name, type, config, enabled };
    const url = initial ? `${API}/api/v1/alerts/channels/${initial.id}` : `${API}/api/v1/alerts/channels`;
    const method = initial ? 'PUT' : 'POST';
    await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    setSaving(false);
    onSaved();
  };

  return (
    <div style={OVERLAY_STYLE}>
      <div style={MODAL_STYLE}>
        <h3 style={{ margin: '0 0 16px' }}>{initial ? '编辑渠道' : '新建渠道'}</h3>

        <label style={LABEL_STYLE}>渠道名称</label>
        <input value={name} onChange={e => setName(e.target.value)} style={INPUT_STYLE} />

        <label style={LABEL_STYLE}>类型</label>
        <select value={type} onChange={e => setType(e.target.value)} style={INPUT_STYLE}>
          {CHANNEL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>

        <label style={LABEL_STYLE}>配置 (JSON)</label>
        <textarea value={configStr} onChange={e => setConfigStr(e.target.value)}
          style={{ ...INPUT_STYLE, minHeight: 80, fontFamily: 'monospace', fontSize: 12 }} />

        <label style={{ ...LABEL_STYLE, display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
          启用
        </label>

        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={CANCEL_BTN_STYLE}>取消</button>
          <button onClick={handleSave} disabled={saving} style={SAVE_BTN_STYLE}>
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 样式常量 ─────────────────────────────────────────────────

const OVERLAY_STYLE: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
};

const MODAL_STYLE: React.CSSProperties = {
  background: '#fff', borderRadius: 10, padding: 24, minWidth: 360, maxWidth: 480,
  boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
};

const LABEL_STYLE: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4, marginTop: 10,
};

const INPUT_STYLE: React.CSSProperties = {
  width: '100%', padding: '6px 10px', border: '1px solid #d1d5db',
  borderRadius: 6, fontSize: 13, boxSizing: 'border-box',
};

const SAVE_BTN_STYLE: React.CSSProperties = {
  padding: '7px 18px', background: '#3b82f6', color: '#fff',
  border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600,
};

const CANCEL_BTN_STYLE: React.CSSProperties = {
  padding: '7px 18px', background: '#f3f4f6', color: '#374151',
  border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer',
};
