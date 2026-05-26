// ============================================================
// plc-bridge — PLC driver re-exports + dev/MOCK simulator
// ============================================================
// Extracted from index.ts (v1.9.0 P2 bucket 1).
//
// Responsibilities:
//   - Surface the pure-JS plc-driver helpers/types the server consumes
//     (parseAddr, byteLen, decode, scale, validateAddr,
//     VariableMappingManager, PLCConnectionConfig, PLCVariableMapping).
//   - Provide the MOCK_PLC env flag + dev random-walk simulator
//     (devPlcRead) used by collectors and AI getRunningBatches.
//
// Module-load side effect: prints the MOCK_PLC warning banner when
// MOCK_PLC=true. Importing this module is what triggers the banner —
// behavior preserved from the previous module-top placement in index.ts.
// ============================================================

// NOTE: We import from the dedicated pure-JS sub-entry @biocore/plc-driver/utils
// rather than the main barrel (.) because the barrel (src/index.ts) eagerly
// imports node-snap7 (a native binding) and modbus-serial at module load. The
// server only needs the pure-JS utility helpers and types — it has its own
// dynamic loader for S7Client. Importing from the barrel would force-load
// node-snap7 native bindings on Node hosts without the compiled .node file
// (e.g. tsx dev, MOCK_PLC environments).
//
// ✅ post-v1.8.0: now uses @biocore/plc-driver/utils sub-entry (package.json
// `exports` map). The previous deep import (../../plc-driver/src/...) hack
// has been removed.
import {
  parseAddr,
  byteLen,
  decode,
  scale,
  validateAddr,
  VariableMappingManager,
  prepareWrite,
} from '@biocore/plc-driver/utils';
import type {
  WritePrep,
  WriteSuccess,
  PLCConnectionConfig,
  PLCVariableMapping,
} from '@biocore/plc-driver/utils';

export { parseAddr, byteLen, decode, scale, validateAddr, VariableMappingManager, prepareWrite };
export type { PLCConnectionConfig, PLCVariableMapping, WritePrep, WriteSuccess };

// MOCK_PLC: 默认 false (生产安全), 开发演示需在 .env 设置 MOCK_PLC=true
// 开启后所有 plcRead 调用返回模拟值, 启动时打印多行红色警告框
// Sprint1 M7.1: ANSI 红色加粗码 (\x1b[1;31m...\x1b[0m), TTY 检测避免日志文件中残留转义码
export const MOCK_PLC = process.env.MOCK_PLC === 'true';
if (MOCK_PLC) {
  const useColor = process.stderr.isTTY && !process.env.NO_COLOR;
  const red = useColor ? '\x1b[1;31m' : '';
  const reset = useColor ? '\x1b[0m' : '';
  console.warn('');
  console.warn(`  ${red}╔══════════════════════════════════════════════════════╗${reset}`);
  console.warn(`  ${red}║  ⚠ MOCK_PLC=true 模式启用 — 所有 PLC 读取返回模拟值  ║${reset}`);
  console.warn(`  ${red}║  生产部署前必须设置 MOCK_PLC=false 或移除该环境变量  ║${reset}`);
  console.warn(`  ${red}╚══════════════════════════════════════════════════════╝${reset}`);
  console.warn('');
}

// 开发模式 PLC 读取 (统一定义,server 全局共享)
// 模拟量慢漂移 (DEMO 用, 让趋势图更逼真)
// CUSUM 演示: 周期性注入异常, 让 CUSUM 检测并展示效果
const _demoBase: Record<string, number> = {};
const _demoDrift: Record<string, number> = {};
const _demoStartTime = Date.now();
export function devPlcRead(tag: string): number {
  // 缓慢随机游走 + 微小噪声
  if (!_demoBase[tag]) {
    const defaults: Record<string, number> = {
      TEMP_PV: 37, JACKET_PV: 36.5, PH_PV: 7.0, DO_PV: 55,
      PRESSURE_PV: 0.35, AIRFLOW_PV: 5.5, WEIGHT_PV: 7.2,
      VFD_ACTUAL_FREQ: 15, VFD_CURRENT: 2.1,
      STEAM_CV: 0, COOL_CV: 35, AIR_CV: 55,
      P01_RATE: 2.5, P02_RATE: 8.0, P03_RATE: 0.8, P04_RATE: 0,
      VFD_FAULT_CODE: 0, ESTOP: 0,
      STEAM_VALVE_CLOSED: 1, COOL_VALVE_CLOSED: 1, LID_LOCKED: 1,
      STEAM_PRESSURE_SW: 1, HEARTBEAT: 0,
      TEMP_SV: 37, PH_SV: 7, DO_SV: 30,
    };
    _demoBase[tag] = defaults[tag] ?? 0;
    _demoDrift[tag] = 0;
  }
  // 随机游走: 每次调用微小漂移
  _demoDrift[tag] += (Math.random() - 0.5) * 0.06;
  _demoDrift[tag] *= 0.95; // 衰减回零
  const noise = (Math.random() - 0.5) * 0.3;
  if (tag === 'HEARTBEAT') return Date.now() % 256;
  if (tag === 'ESTOP' || tag === 'VFD_FAULT_CODE') return 0;
  if (tag.endsWith('_CLOSED') || tag.endsWith('_LOCKED') || tag.endsWith('_SW')) return 1;

  // ── CUSUM 演示异常注入 ──
  // 周期性偏移, 让 CUSUM S⁺/S⁻ 累积并触发报警, 展示统计过程控制能力
  const elapsedSec = (Date.now() - _demoStartTime) / 1000;
  let anomalyBias = 0;

  if (tag === 'TEMP_PV') {
    // 每 5 分钟周期: 前 2 分钟温度上升 0.8°C (CUSUM S⁺ 累积)
    const cycle = elapsedSec % 300; // 5min 周期
    if (cycle >= 60 && cycle < 180) anomalyBias = 0.8;
  } else if (tag === 'PH_PV') {
    // 每 7 分钟周期: 中间 2 分钟 pH 下降 0.15 (CUSUM S⁻ 累积)
    const cycle = elapsedSec % 420; // 7min 周期
    if (cycle >= 120 && cycle < 240) anomalyBias = -0.15;
  } else if (tag === 'DO_PV') {
    // 每 4 分钟周期: 后 1.5 分钟 DO 下降 12% (明显偏移)
    const cycle = elapsedSec % 240; // 4min 周期
    if (cycle >= 150 && cycle < 240) anomalyBias = -12;
  }

  return _demoBase[tag] + _demoDrift[tag] + noise + anomalyBias;
}
