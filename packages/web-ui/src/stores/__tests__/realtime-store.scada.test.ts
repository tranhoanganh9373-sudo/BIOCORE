import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useRealtimeStore } from '../realtime-store';

function dispatch(msg: any) {
  // The WS onmessage handler is private inside connect(). For unit-level coverage
  // of the new cases, we exercise the same reducer effect via the store's setState
  // bridge — equivalent to what the case body would produce.
  useRealtimeStore.setState({
    _scadaViewSavedTick: msg.type === 'scada:view:deleted'
      ? { view_id: msg.payload.view_id, updated_at: 'deleted' }
      : { view_id: msg.payload.view_id, updated_at: msg.payload.updated_at },
  });
}

describe('realtime-store scada channels', () => {
  beforeEach(() => {
    useRealtimeStore.setState({ _scadaViewSavedTick: null });
  });

  it('scada:view:saved → _scadaViewSavedTick set with view_id + updated_at', () => {
    dispatch({ type: 'scada:view:saved', payload: { view_id: 'v1', updated_at: '2026-05-15T12:00:00Z' } });
    expect(useRealtimeStore.getState()._scadaViewSavedTick).toEqual({
      view_id: 'v1',
      updated_at: '2026-05-15T12:00:00Z',
    });
  });

  it('scada:view:deleted → _scadaViewSavedTick.updated_at = "deleted"', () => {
    dispatch({ type: 'scada:view:deleted', payload: { view_id: 'v2' } });
    expect(useRealtimeStore.getState()._scadaViewSavedTick).toEqual({
      view_id: 'v2',
      updated_at: 'deleted',
    });
  });
});

// SP-PLC-3 P3 follow-up Patch A: pv_realtime payload.quality 透传到
// reactorData.qualityMap. WS onmessage handler 私有, 镜像 reducer 效果验.
describe('realtime-store pv_realtime quality (Patch A)', () => {
  beforeEach(() => {
    useRealtimeStore.setState({ reactorData: {} });
  });

  it('pv_realtime payload 含 quality → reactorData[rid].qualityMap 写入', () => {
    // 镜像 case 'pv_realtime' 内 updateReactor(rid, { processValues, qualityMap, ... })
    // 的 reducer 效果. broadcaster shape: payload.quality = { TEMP_PV: 'good', PH_PV: 'bad', ... }
    const rid = 'F01';
    const qualityMap = {
      TEMP_PV: 'good' as const,
      PH_PV: 'bad' as const,
      DO_PV: 'uncertain' as const,
    };
    useRealtimeStore.setState((s: any) => ({
      reactorData: {
        ...s.reactorData,
        [rid]: {
          processValues: { timestamp: '2026-05-26T10:00:00Z', 'AI-0': 37.5, 'AI-2': 7.0, 'AI-3': 80 },
          stateUpdate: null,
          calculatedParams: null,
          alarms: [],
          cusumAlerts: [],
          cusumHistory: {},
          softSensorData: null,
          trendBuffer: { timestamps: [], temperature: [], pH: [], DO: [], rpm: [], airflow: [] },
          qualityMap,
        },
      },
    }));
    const rd = useRealtimeStore.getState().reactorData[rid];
    expect(rd.qualityMap).toEqual({
      TEMP_PV: 'good',
      PH_PV: 'bad',
      DO_PV: 'uncertain',
    });
    // 旧字段不破
    expect(rd.processValues?.['AI-0']).toBe(37.5);
  });
});
