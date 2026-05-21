import type { PLCConnectionConfig, PLCVariableMapping, ParsedAddress } from './types';
import { validateAddr, parseAddr, encode, unscale } from './utils';

export interface PrepareWriteBody {
  value?: unknown;
  confirmed?: unknown;
}

export interface WriteFailure {
  ok: false;
  status: number;
  error: string;
}

export interface WriteSuccess {
  ok: true;
  variable: PLCVariableMapping;
  connection: PLCConnectionConfig;
  parsed: ParsedAddress;
  db: number;
  buf: Buffer;
  raw: number;
}

export type WritePrep = WriteFailure | WriteSuccess;

export function prepareWrite(
  varId: string,
  body: PrepareWriteBody,
  variables: PLCVariableMapping[],
  connections: PLCConnectionConfig[],
): WritePrep {
  if (body.confirmed !== true) {
    return { ok: false, status: 400, error: 'confirmation required' };
  }
  if (typeof body.value !== 'number' || !Number.isFinite(body.value)) {
    return { ok: false, status: 400, error: 'value must be a finite number' };
  }
  const v = variables.find(x => x.id === varId);
  if (!v) return { ok: false, status: 404, error: 'variable not found' };
  if (v.direction === 'READ') return { ok: false, status: 400, error: 'read-only tag' };
  if (v.data_type === 'BOOL') {
    return { ok: false, status: 400, error: 'BOOL write not yet supported (SP-PLC-3)' };
  }

  const addrCheck = validateAddr(v.plc_address, v.data_type);
  if (!addrCheck.valid) {
    return { ok: false, status: 400, error: `address invalid: ${addrCheck.error}` };
  }
  const conn = connections.find(c => c.id === v.connection_id);
  if (!conn) return { ok: false, status: 404, error: 'connection not found' };

  const parsed = parseAddr(v.plc_address);
  const db = parsed.db ?? conn.s7_db ?? 1;
  const rawFloat = v.scaling_enabled ? unscale(body.value, v) : body.value;
  const raw = v.data_type === 'FLOAT32' ? rawFloat : Math.round(rawFloat);
  const buf = encode(raw, v.data_type);
  return { ok: true, variable: v, connection: conn, parsed, db, buf, raw };
}
