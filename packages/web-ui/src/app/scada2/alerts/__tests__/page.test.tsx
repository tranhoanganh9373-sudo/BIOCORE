// ============================================================
// alerts/page.test.tsx — SP-FX-42 TDD RED-first
// ============================================================
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Mock fetch globally
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

vi.mock('@/hooks/useAuth', () => ({
  useAuth: vi.fn(),
}));

vi.mock('@/i18n/useLocale', () => ({
  useLocale: () => ({ t: (k: string) => k }),
}));

import { useAuth } from '@/hooks/useAuth';
import AlertsPage from '../page';

function setupAdminUser() {
  (useAuth as any).mockReturnValue({ user: { user_id: 'u1', role: 'admin' } });
}

function setupOperatorUser() {
  (useAuth as any).mockReturnValue({ user: { user_id: 'u2', role: 'operator' } });
}

function setupNullUser() {
  (useAuth as any).mockReturnValue({ user: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => [],
  });
});

describe('AlertsPage — 访问控制', () => {
  it('非 admin → 显示无权访问', () => {
    setupOperatorUser();
    render(<AlertsPage />);
    expect(screen.getAllByText(/无权访问|仅管理员/).length).toBeGreaterThan(0);
  });

  it('未登录 → 显示无权访问', () => {
    setupNullUser();
    render(<AlertsPage />);
    expect(screen.getAllByText(/无权访问|仅管理员/).length).toBeGreaterThan(0);
  });
});

describe('AlertsPage — Tab 渲染', () => {
  it('admin 可看到 Rules / Channels / History 三个 tab', () => {
    setupAdminUser();
    render(<AlertsPage />);
    // 三个 tab 按钮
    expect(screen.getByText('Rules 规则')).toBeTruthy();
    expect(screen.getByText('Channels 渠道')).toBeTruthy();
    expect(screen.getByText('History 历史')).toBeTruthy();
  });

  it('默认 tab 是 Rules，显示新建规则按钮', () => {
    setupAdminUser();
    render(<AlertsPage />);
    expect(screen.getByText(/新建规则/)).toBeTruthy();
  });

  it('切换到 Channels tab 显示新建渠道按钮', () => {
    setupAdminUser();
    render(<AlertsPage />);
    const channelTab = screen.getByText('Channels 渠道');
    fireEvent.click(channelTab);
    expect(screen.getByText(/新建渠道/)).toBeTruthy();
  });

  it('切换到 History tab 显示历史标题', () => {
    setupAdminUser();
    render(<AlertsPage />);
    const historyTab = screen.getByText('History 历史');
    fireEvent.click(historyTab);
    // 历史内容区包含"告警历史"文字
    expect(screen.getAllByText(/告警历史/).length).toBeGreaterThan(0);
  });
});

describe('AlertsPage — API 调用', () => {
  it('mount 时调用 /api/v1/alerts/rules', async () => {
    setupAdminUser();
    render(<AlertsPage />);
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/alerts/rules'));
    });
  });

  it('fetch 返回规则列表, 渲染到页面', async () => {
    setupAdminUser();
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/alerts/rules')) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ id: 1, name: '高温告警', trigger_type: 'threshold', condition_expr: 'value > 80', channel_id: 1, enabled: true }],
        });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });
    render(<AlertsPage />);
    await vi.waitFor(() => {
      expect(screen.getByText('高温告警')).toBeTruthy();
    });
  });

  it('fetch 失败时显示错误提示', async () => {
    setupAdminUser();
    fetchMock.mockRejectedValue(new Error('network error'));
    render(<AlertsPage />);
    await vi.waitFor(() => {
      expect(screen.getByText(/加载失败|错误/)).toBeTruthy();
    });
  });
});

describe('AlertsPage — 新建规则 modal', () => {
  it('点击新建规则按钮打开 modal 含保存/取消', async () => {
    setupAdminUser();
    render(<AlertsPage />);
    const btn = screen.getByText(/新建规则/);
    fireEvent.click(btn);
    await vi.waitFor(() => {
      expect(screen.getByText(/保存|确认/)).toBeTruthy();
      expect(screen.getByText(/取消/)).toBeTruthy();
    });
  });
});
