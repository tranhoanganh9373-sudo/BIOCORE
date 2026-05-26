// ============================================================
// utils-public — pure-JS sub-entry barrel for @biocore/plc-driver
// ============================================================
// Re-exports the pure-JS helpers + types that downstream packages
// (e.g. @biocore/server, @biocore/batch-engine) need without
// triggering eager loads of native bindings (node-snap7) or
// modbus-serial that the main barrel (./index.ts) pulls in.
//
// Exposed via package.json `exports`:
//   "./utils": { "types": "./dist/utils-public.d.ts",
//                "default": "./dist/utils-public.js" }
//
// IMPORTANT: This file must NEVER import from ./index, from
// node-snap7, modbus-serial, or any other native module. If you
// add a new pure-JS helper that consumers need, re-export it here
// — do not let consumers fall back to deep imports.
// ============================================================

export { parseAddr, byteLen, decode, scale, validateAddr } from './utils';
export { VariableMappingManager } from './variable-mapping';
export { prepareWrite } from './write-helpers';

export type { WritePrep, WriteSuccess } from './write-helpers';
export type { PLCConnectionConfig, PLCVariableMapping } from './types';
