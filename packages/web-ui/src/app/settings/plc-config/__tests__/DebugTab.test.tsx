import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DebugTab } from '../DebugTab';
import type { PLCVariableMapping } from '@/types';

const conns = [{ id: 'c1', name: 'F01-PLC' }];

const mkVar = (overrides: Partial<PLCVariableMapping> = {}): PLCVariableMapping => ({
  id: 'v1', tag_name: 'Temp_T1', description: '', plc_address: 'DB1.DBW4',
  data_type: 'INT16', direction: 'READWRITE', scaling_enabled: true,
  raw_min: 0, raw_max: 32767, eng_min: 0, eng_max: 100, eng_unit: '°C',
  group: '模拟量输入', poll_rate_ms: 1000, enabled: true, connection_id: 'c1',
  ...overrides,
});

function setup(opts: { variables?: PLCVariableMapping[]; apiFetch?: any } = {}) {
  const audit: any = { confirm: vi.fn(), close: vi.fn(), state: {}, handleConfirm: vi.fn() };
  const apiFetch = opts.apiFetch ?? vi.fn().mockResolvedValue({
    json: async () => ({ success: true, value: 67.4, raw: 22094 }),
  });
  const variables = opts.variables ?? [mkVar()];
  render(
    <DebugTab
      connections={conns}
      variables={variables}
      apiBase=""
      apiFetch={apiFetch}
      audit={audit}
    />,
  );
  return { apiFetch, audit };
}

describe('DebugTab', () => {
  it('渲染调试面板提示文案', () => {
    setup();
    expect(screen.getByText(/实时观察 tag 值变化/)).toBeTruthy();
  });

  it('显示 "选择目标" 卡片标题 (PLC + Tag 下拉)', () => {
    setup();
    expect(screen.getByText('选择目标')).toBeTruthy();
    expect(screen.getByText('PLC 连接')).toBeTruthy();
    expect(screen.getByText('变量 Tag')).toBeTruthy();
  });

  it('未选 tag 时不渲染实时值卡片', () => {
    setup();
    expect(screen.queryByTestId('poll-start')).toBeNull();
    expect(screen.queryByTestId('poll-stop')).toBeNull();
  });

  it('未选 tag 时不渲染写入区', () => {
    setup();
    expect(screen.queryByTestId('write-value-input')).toBeNull();
    expect(screen.queryByTestId('write-submit')).toBeNull();
  });

  it('空 connections 不报错', () => {
    render(
      <DebugTab
        connections={[]}
        variables={[]}
        apiBase=""
        apiFetch={vi.fn()}
        audit={{ confirm: vi.fn(), close: vi.fn(), state: {}, handleConfirm: vi.fn() } as any}
      />,
    );
    expect(screen.getByText('选择目标')).toBeTruthy();
  });
});
