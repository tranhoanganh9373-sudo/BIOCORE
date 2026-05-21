'use client';
import React, { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

import { useRealtimeStore } from '@/stores/realtime-store';
import { useAuth } from '@/hooks/useAuth';
import { apiFetch } from '@/lib/auth';
import {
  LayoutDashboard, LineChart, BookOpen, History,
  Database, Bot, Settings, Wifi, WifiOff, Blocks, ChevronDown,
  Gauge, Users, Bell, User, Activity, Droplets, LogOut, Key, FileText, FlaskConical,
  ShieldCheck, Sigma, Shield, TrendingUp, Brain, Workflow, Building2, Sun, Moon, Monitor, BarChart3,
  ChevronUp, X, Menu, Link2,
} from 'lucide-react';
import { useTheme, type ThemeMode } from '@/hooks/useTheme';
import { LocaleSwitcher } from './LocaleSwitcher';
import { useLocale } from '@/i18n/useLocale';

// NAV_ITEMS 改为函数以支持 i18n — SP-FX-26
function buildNavItems(t: (key: string) => string) {
  return [
    { href: '/dashboard', icon: LayoutDashboard, label: t('nav.dashboard'), children: [
      { href: '/dashboard/hmi', icon: Workflow, label: t('nav.hmi') },
      { href: '/clean', icon: Droplets, label: t('nav.clean') },
      { href: '/trends', icon: LineChart, label: t('nav.trends') },
    ]},
    { href: '/recipes', icon: BookOpen, label: t('nav.recipes'), children: [
      { href: '/batches', icon: FlaskConical, label: t('nav.recipe-run') },
      { href: '/recipes/review-queue', icon: ShieldCheck, label: t('nav.review-queue') },
      { href: '/phase-instances', icon: Link2, label: t('nav.phase-instances') },
      { href: '/doe', icon: Sigma, label: t('nav.doe') },
    ]},
    { href: '/analysis', icon: LineChart, label: t('nav.analysis'), children: [
      { href: '/batches', icon: History, label: t('nav.batches') },
      { href: '/analysis/alarm-history', icon: Bell, label: t('nav.alarm-history') },
      { href: '/analysis/cusum-history', icon: TrendingUp, label: t('nav.cusum-history') },
      { href: '/explorer', icon: Database, label: t('nav.explorer') },
      { href: '/analysis/kpi', icon: Gauge, label: t('nav.kpi') },
      { href: '/analysis/spc', icon: BarChart3, label: t('nav.spc') },
      { href: '/analysis/audit-logs', icon: FileText, label: t('nav.audit-logs') },
      { href: '/analysis/soft-sensor', icon: Brain, label: t('nav.soft-sensor') },
    ]},
    { href: '/ai', icon: Bot, label: t('nav.ai') },
    { href: '/settings', icon: Settings, label: t('nav.settings'), children: [
      { href: '/settings/site-meta', icon: Building2, label: t('nav.site-meta') },
      { href: '/settings/device-config', icon: Activity, label: t('nav.device-config') },
      { href: '/settings/plc-config', icon: Wifi, label: t('nav.plc-config') },
      { href: '/settings/phase-templates', icon: Blocks, label: t('nav.phase-templates') },
      { href: '/settings/calibration', icon: Gauge, label: t('nav.calibration') },
      { href: '/settings/formula-config', icon: Activity, label: t('nav.formula-config') },
      { href: '/settings/interlock-config', icon: Shield, label: t('nav.interlock-config') },
      { href: '/settings/alarm-config', icon: Bell, label: t('nav.alarm-config') },
      { href: '/settings/users', icon: Users, label: t('nav.users') },
      { href: '/settings/permissions', icon: Shield, label: t('nav.permissions') },
      { href: '/settings/api-keys', icon: Key, label: t('nav.api-keys') },
      { href: '/settings/ai-config', icon: Bot, label: t('nav.ai-config') },
      { href: '/settings/data-maintenance', icon: Database, label: t('nav.data-maintenance') },
    ]},
  ];
}

// 判断父菜单 href 是否对应真实可导航页面 (例如 /dashboard, /analysis 是页面; /settings 也是页面)
// 注: /analysis 是新增的聚合落地页, 需要创建 (或者不创建, 让点击父菜单仅展开子菜单)
const NAVIGABLE_PARENTS = new Set(['/dashboard', '/settings', '/recipes']);

function formatElapsed(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// 系统级元数据 (面包屑) — 后端 /api/system-config 已合并 db>env>推导, 前端直接渲染返回值
const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

function LiveClock() {
  const [time, setTime] = useState('');
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setTime(now.toLocaleTimeString('zh-CN', { hour12: false }));
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="font-mono text-sm text-muted-foreground">{time}</span>;
}

function getStateBadgeClass(state: string): string {
  switch (state) {
    case 'running': return 'mes-badge-running';
    case 'held': return 'mes-badge-held';
    case 'paused': return 'mes-badge-paused';
    case 'stopped': return 'mes-badge-stopped';
    case 'complete': return 'mes-badge-complete';
    default: return 'mes-badge-idle';
  }
}

function getStateLedClass(state: string): string {
  switch (state) {
    case 'running': return 'status-led-running';
    case 'held': return 'status-led-held';
    case 'paused': return 'status-led-paused';
    case 'stopped': return 'status-led-stopped';
    case 'complete': return 'status-led-complete';
    default: return 'status-led-idle';
  }
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading: authLoading, logout } = useAuth();
  const { t } = useLocale();
  const NAV_ITEMS = buildNavItems(t);
  // 用 selector 拿稳定的 state, 不解构 actions (避免 hot reload 时函数引用变化触发 deps 警告)
  const wsConnected = useRealtimeStore(s => s.wsConnected);
  const stateUpdate = useRealtimeStore(s => s.stateUpdate);
  const alarms = useRealtimeStore(s => s.alarms);
  const heartbeatStatus = useRealtimeStore(s => s.heartbeatStatus);
  const heartbeatByReactor = useRealtimeStore(s => s.heartbeatByReactor);
  const [elapsed, setElapsed] = useState(0);
  const isLoginPage = pathname === '/login';

  // SP-FX-25: mobile sidebar 折叠状态 (< md = 768px 默认关闭)
  const [sidebarOpen, setSidebarOpen] = useState(false);
  useEffect(() => {
    if (typeof window !== 'undefined') {
      setSidebarOpen(window.innerWidth >= 768);
    }
  }, []);

  // Reactor list for per-reactor PLC indicators in the header breadcrumb.
  const [reactorIds, setReactorIds] = useState<string[]>([]);
  useEffect(() => {
    if (isLoginPage || !user) return;
    const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
    apiFetch(`${API_BASE}/api/v1/reactors`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        // /api/v1/* responses are wrapped: { success, data: [...] }; /api/* returns raw array.
        const list = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
        const ids = list.map((r: any) => r.id).filter((id: any) => typeof id === 'string');
        setReactorIds(ids);
      })
      .catch(() => { /* leave empty; chip section just renders nothing */ });
  }, [isLoginPage, user]);

  // 侧栏折叠状态: key = 父菜单 href, value = 是否折叠
  // localStorage 持久化用户偏好
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    if (typeof window === 'undefined') return {};
    try {
      const raw = localStorage.getItem('biocore_nav_collapsed');
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });

  // 传入 currentCollapsed 代表按钮当前的真实状态 (含默认自动折叠逻辑), 避免从 undefined 取反的 bug
  const toggleCollapsed = useCallback((href: string, currentCollapsed: boolean) => {
    setCollapsed(prev => {
      const next = { ...prev, [href]: !currentCollapsed };
      try { localStorage.setItem('biocore_nav_collapsed', JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  // 路由守卫: loading 完毕且无 user 时跳 /login (排除 /login 自身)
  useEffect(() => {
    if (authLoading) return;
    if (!user && !isLoginPage) {
      router.replace('/login');
    }
  }, [authLoading, user, isLoginPage, router]);

  // 已登录时才连 WS (登录页不需要), 用 getState 避免 deps 包含函数引用
  useEffect(() => {
    if (user && !isLoginPage) useRealtimeStore.getState().connect();
  }, [user, isLoginPage]);

  // Dev 模式优化: 用户登录后,后台预取所有侧边栏页面 (避免首次点击的按需编译延迟)
  const prefetchedRef = useRef(false);
  useEffect(() => {
    if (!user || isLoginPage || prefetchedRef.current) return;
    prefetchedRef.current = true;
    const allHrefs: string[] = [];
    for (const item of NAV_ITEMS) {
      if (!item.children) allHrefs.push(item.href);
      else for (const c of item.children) allHrefs.push(c.href);
    }
    // 立即预取所有导航页面, 减少首次点击的编译/下载延迟
    for (const href of allHrefs) {
      try { router.prefetch(href); } catch { /* ignore */ }
    }
  }, [user, isLoginPage, router]);

  useEffect(() => {
    if (stateUpdate?.batch_elapsed_sec != null) {
      setElapsed(stateUpdate.batch_elapsed_sec);
    }
  }, [stateUpdate?.batch_elapsed_sec]);

  // 面包屑系统元数据 (后端合并 db > env > 自动推导)
  const [siteMeta, setSiteMeta] = useState<{ facility_name: string; line_name: string; reactor_group_name: string } | null>(null);
  useEffect(() => {
    if (!user || isLoginPage) return;
    apiFetch(`${API_BASE}/api/system-config`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setSiteMeta(data); })
      .catch(() => { /* offline OK */ });
  }, [user, isLoginPage]);

  useEffect(() => {
    if (stateUpdate?.state !== 'running') return;
    const interval = setInterval(() => {
      setElapsed((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [stateUpdate?.state]);

  // ── 条件 return (放在所有 hooks 之后) ──
  // ── 条件 return (放在所有 hooks 之后) ──
  if (isLoginPage) {
    return <>{children}</>;
  }
  if (authLoading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">{authLoading ? t('app-layout.loading') : t('app-layout.redirecting')}</div>
      </div>
    );
  }

  const unacknowledgedCount = alarms.filter((a) => !a.acknowledged).length;
  const currentState = stateUpdate?.state || 'idle';

  return (
    <div className="flex h-screen surface-base">
      {/* SP-FX-25: mobile sidebar overlay backdrop */}
      {sidebarOpen && (
        <div
          data-testid="sidebar-backdrop"
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* SideNav — fixed on mobile (overlay), static on md+ */}
      <nav
        data-testid="sidebar-nav"
        className={`w-[224px] surface-low flex flex-col fixed inset-y-0 left-0 z-50 transition-transform duration-200
          md:static md:z-auto md:translate-x-0
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div className="px-5 py-5">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                 style={{ background: 'linear-gradient(135deg, #0F766E, #005c55)' }}>
              <Activity className="w-4 h-4 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="text-base font-bold tracking-tight text-foreground leading-none">BIOCore</h1>
              <p className="text-sm text-muted-foreground mt-1 font-mono tracking-wider">v0.1.0 · MES</p>
            </div>
            <ThemeToggle />
            {/* SP-FX-25: mobile close sidebar button */}
            <button
              data-testid="close-sidebar-btn"
              type="button"
              className="md:hidden p-1 rounded hover:bg-accent text-muted-foreground"
              onClick={() => setSidebarOpen(false)}
              aria-label={t('app-layout.close-sidebar')}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 px-2 py-1 overflow-y-auto mes-scroll">
          {NAV_ITEMS.map(item => {
            const hasChildren = !!item.children && item.children.length > 0;
            const childActive = item.children?.some(c => pathname === c.href) || false;
            const selfActive = pathname === item.href;
            const isActive = selfActive || childActive;
            const isCollapsed = item.href in collapsed ? collapsed[item.href] : !(selfActive || childActive);
            const parentNavigable = hasChildren && NAVIGABLE_PARENTS.has(item.href);

            return (
              <div key={item.href} className="mb-0.5">
                {hasChildren && parentNavigable ? (
                  <div className={`flex items-center rounded-lg overflow-hidden ${
                    selfActive ? 'bg-primary text-white shadow-clinical' : ''
                  }`}>
                    <Link href={item.href}
                      className={`flex-1 flex items-center gap-3 px-3 py-2 text-sm transition-all ${
                        selfActive
                          ? 'text-white font-medium'
                          : isActive
                            ? 'text-primary font-medium hover:bg-accent'
                            : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                      }`}>
                      <item.icon className="w-4 h-4" />
                      {item.label}
                    </Link>
                    <button
                      type="button"
                      onClick={() => toggleCollapsed(item.href, isCollapsed)}
                      className={`px-2.5 py-2 transition-colors ${
                        selfActive ? 'text-white/80 hover:text-white' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                      }`}
                      aria-expanded={!isCollapsed}
                      aria-label={isCollapsed ? `${t('app-layout.expand-menu')} ${item.label}` : `${t('app-layout.collapse-menu')} ${item.label}`}
                    >
                      <ChevronDown className={`w-3 h-3 transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
                    </button>
                  </div>
                ) : hasChildren ? (
                  <button
                    type="button"
                    onClick={() => toggleCollapsed(item.href, isCollapsed)}
                    className={`w-full flex items-center gap-3 px-3 py-2 text-sm rounded-lg transition-colors ${
                      isActive ? 'text-primary font-medium' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                    }`}
                    aria-expanded={!isCollapsed}
                  >
                    <item.icon className="w-4 h-4" />
                    {item.label}
                    <ChevronDown className={`w-3 h-3 ml-auto transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
                  </button>
                ) : (
                  <Link href={item.href}
                    className={`flex items-center gap-3 px-3 py-2 text-sm rounded-lg transition-all ${
                      pathname === item.href
                        ? 'bg-primary text-white font-medium shadow-clinical'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                    }`}>
                    <item.icon className="w-4 h-4" />
                    {item.label}
                  </Link>
                )}
                {hasChildren && !isCollapsed && (
                  <div className="mt-0.5 space-y-0.5">
                    {item.children!.map(child => (
                      <Link key={child.href} href={child.href}
                        className={`flex items-center gap-2.5 pl-9 pr-3 py-1.5 text-[12px] rounded-md transition-colors ${
                          pathname === child.href
                            ? 'bg-primary/10 text-primary font-medium'
                            : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                        }`}>
                        <child.icon className="w-3.5 h-3.5" />
                        {child.label}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {/* Bottom: WS+clock row, user row. Theme toggle moved to brand header. */}
        <div className="px-4 py-3 text-sm text-muted-foreground space-y-2 border-t border-border/30">
          <div className="flex items-center gap-2">
            <div className={`status-led ${wsConnected ? 'status-led-running' : 'status-led-stopped'}`} />
            <span className="font-mono text-[12px]">WS {wsConnected ? t('app-layout.ws-connected') : t('app-layout.ws-disconnected')}</span>
            <div className="ml-auto"><LiveClock /></div>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <User className="w-3.5 h-3.5 text-primary" />
            </div>
            <span
              title={`${user.username} (${user.role})`}
              className="font-medium text-foreground truncate flex-1 min-w-0"
            >
              {user.display_name}
            </span>
            <button
              onClick={logout}
              title={t('app-layout.logout')}
              className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors shrink-0"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </nav>

      {/* Main Content — SP-FX-25: full width (sidebar is overlay on mobile) */}
      <div data-testid="main-content" className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Clinical TopBar — no border, uses subtle bg shift */}
        <header className="h-14 surface-base flex items-center justify-between px-6 flex-shrink-0">
          {/* SP-FX-25: hamburger button (mobile only) */}
          <button
            data-testid="hamburger-btn"
            type="button"
            className="md:hidden mr-3 p-1.5 rounded hover:bg-accent text-muted-foreground shrink-0"
            onClick={() => setSidebarOpen(true)}
            aria-label={t('app-layout.open-sidebar')}
          >
            <Menu className="w-5 h-5" />
          </button>
          {/* Left: MES breadcrumb */}
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">{siteMeta?.facility_name || process.env.NEXT_PUBLIC_FACILITY_NAME || t('app-layout.default-facility')}</span>
            <span className="text-muted-foreground/40">/</span>
            <span className="text-muted-foreground">{siteMeta?.line_name || process.env.NEXT_PUBLIC_LINE_NAME || t('app-layout.default-line')}</span>
            <span className="text-muted-foreground/40">/</span>
            <span className="text-foreground font-semibold tracking-tight">
              {siteMeta?.reactor_group_name || process.env.NEXT_PUBLIC_REACTOR_GROUP_NAME || t('app-layout.default-reactor-group')}
            </span>

            {/* Per-reactor PLC indicators (1 chip per reactor; independent state). */}
            {reactorIds.length > 0 && (
              <div className="flex items-center gap-1.5 ml-2">
                {reactorIds.map((rid) => {
                  // Convention: PLC connection_id == reactor.id. Fall back to
                  // the global heartbeat when the per-reactor entry is absent
                  // (legacy single-PLC deployment or before first heartbeat).
                  const hb = heartbeatByReactor[rid] ?? (reactorIds.length === 1 ? heartbeatStatus : null);
                  const alive = hb?.alive === true;
                  return (
                    <span
                      key={rid}
                      title={`${rid} · PLC ${alive ? t('app-layout.plc-online') : t('app-layout.plc-offline')}`}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-border/40 text-[12px] font-mono"
                    >
                      <div className={`status-led ${alive ? 'status-led-running' : 'status-led-idle'}`} />
                      <span className="text-muted-foreground">{rid}</span>
                    </span>
                  );
                })}
              </div>
            )}

            {stateUpdate && (
              <>
                <span className="ml-3 text-muted-foreground/30">·</span>
                <span className={`mes-badge ${getStateBadgeClass(currentState)}`}>
                  {({
                    idle: t('app-layout.state-idle'),
                    running: t('app-layout.state-running'),
                    held: t('app-layout.state-held'),
                    paused: t('app-layout.state-paused'),
                    stopped: t('app-layout.state-stopped'),
                    complete: t('app-layout.state-complete'),
                  } as Record<string,string>)[currentState] || currentState}
                </span>
                {currentState !== 'idle' && (
                  <span className="text-muted-foreground text-sm font-mono tabular-nums">
                    {formatElapsed(elapsed)}
                  </span>
                )}
              </>
            )}
          </div>

          {/* Middle: 报警信息条 (撑满中部, 至 max-w-5xl) — theme/user/clock moved to sidebar bottom. */}
          <TopBarAlarmStrip alarms={alarms} />
          {/* SP-FX-26: locale switcher */}
          <LocaleSwitcher />
        </header>

        {/* Page Content — on surface-base (lightest layer) */}
        <main className="flex-1 overflow-auto mes-scroll surface-base">{children}</main>
      </div>
    </div>
  );
}

// 判定 alarm 是否为 CUSUM/AI 类提示 (与 NoticeBanner.isNotice 一致)
function isNoticeAlarm(a: any): boolean {
  const src = String(a?.source || '');
  const code = String(a?.alarm_code || '');
  return src.startsWith('ai:') || src === 'cusum_anomaly' || code.startsWith('CUSUM_');
}

// TopBar 报警信息条 — 显示最新一条操作性报警, 上/下翻 (过滤掉 CUSUM 提示)
function TopBarAlarmStrip({ alarms }: { alarms: any[] }) {
  const { t } = useLocale();
  const unack = React.useMemo(
    () => alarms.filter(a => !a.acknowledged && !isNoticeAlarm(a)),
    [alarms]
  );
  const [idx, setIdx] = React.useState(0);
  React.useEffect(() => {
    if (idx >= unack.length) setIdx(0);
  }, [unack.length, idx]);

  if (unack.length === 0) {
    return (
      <div className="ml-auto flex items-center gap-2 w-full max-w-[840px] h-9">
        {/* Label chip — separate box from the message strip */}
        <div className="shrink-0 flex items-center gap-1.5 px-2.5 h-full rounded-md border border-border bg-muted">
          <Bell className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
          <span className="text-sm text-muted-foreground shrink-0">{t('app-layout.alarm-label')}</span>
          <span className="shrink-0 px-1.5 py-0.5 rounded text-sm font-bold border border-muted-foreground/40 text-muted-foreground/70">0</span>
        </div>
        {/* Message + nav strip */}
        <div className="flex-1 flex items-center gap-2 px-3 h-full rounded-md border border-border bg-muted min-w-0">
          <span className="flex-1 text-sm text-muted-foreground truncate">{t('app-layout.no-alarms')}</span>
          <span className="shrink-0 text-sm text-muted-foreground/60 font-mono tabular-nums">0/0</span>
          <button disabled className="shrink-0 p-1 rounded text-muted-foreground/30 cursor-not-allowed" title={t('app-layout.prev-alarm')}>
            <ChevronUp className="w-3 h-3" />
          </button>
          <button disabled className="shrink-0 p-1 rounded text-muted-foreground/30 cursor-not-allowed" title={t('app-layout.next-alarm')}>
            <ChevronDown className="w-3 h-3" />
          </button>
        </div>
      </div>
    );
  }

  const cur = unack[idx] || unack[0];
  const sev = (cur as any).severity || 'warning';
  const sevColor = sev === 'critical' ? 'bg-red-500/15 text-red-600 border-red-500/30'
    : sev === 'warning' ? 'bg-yellow-500/15 text-amber-600 border-yellow-500/30'
    : 'bg-blue-500/15 text-blue-600 border-blue-500/30';

  return (
    <div className="ml-auto flex items-center gap-2 w-full max-w-[840px] h-9">
      {/* Label chip — separate box, mirrors empty-state layout */}
      <div className="shrink-0 flex items-center gap-1.5 px-2.5 h-full rounded-md border border-red-500/40 bg-red-500/10 dark:bg-red-500/15">
        <Bell className="w-3.5 h-3.5 text-mes-red shrink-0" />
        <span className="text-sm font-medium text-red-700 dark:text-red-300 shrink-0">{t('app-layout.alarm-label')}</span>
        <span className={`shrink-0 px-1.5 py-0.5 rounded text-sm font-bold border ${sevColor}`}>
          {unack.length}
        </span>
      </div>
      {/* Message + nav strip */}
      <div className="flex-1 flex items-center gap-2 px-3 h-full rounded-md border border-red-500/40 bg-red-500/10 dark:bg-red-500/15 min-w-0">
        <span className="flex-1 text-sm font-medium text-red-700 dark:text-red-300 truncate" title={cur.message}>
          {cur.message || t('app-layout.no-message')}
        </span>
        <span className="shrink-0 text-sm text-muted-foreground font-mono tabular-nums">
          {idx + 1}/{unack.length}
        </span>
        <button
          onClick={() => setIdx(i => (i - 1 + unack.length) % unack.length)}
          disabled={unack.length < 2}
          className="shrink-0 p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title={t('app-layout.prev-alarm')}
        >
          <ChevronUp className="w-3 h-3" />
        </button>
        <button
          onClick={() => setIdx(i => (i + 1) % unack.length)}
          disabled={unack.length < 2}
          className="shrink-0 p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title={t('app-layout.next-alarm')}
        >
          <ChevronDown className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

// 主题切换按钮 — 循环 light → dark → system
function ThemeToggle() {
  const { mode, cycle } = useTheme();
  const { t } = useLocale();
  const LABEL: Record<ThemeMode, string> = {
    light: t('app-layout.theme-light'),
    dark: t('app-layout.theme-dark'),
    system: t('app-layout.theme-system'),
  };
  const Icon = mode === 'light' ? Sun : mode === 'dark' ? Moon : Monitor;
  return (
    <button
      onClick={cycle}
      title={t('app-layout.theme-title', { mode: LABEL[mode] })}
      className="p-1.5 rounded-md hover:bg-accent transition-colors"
    >
      <Icon className="w-4 h-4 text-muted-foreground" />
    </button>
  );
}
