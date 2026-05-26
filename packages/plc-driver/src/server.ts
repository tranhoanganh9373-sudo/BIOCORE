// ============================================================
// BIOCore Server — 主入口
// 职责: Express API + WebSocket + 模块编排
//
// SECURITY (v1.7.3): 此 standalone server 默认仅绑定 127.0.0.1。
// 它不带任何鉴权中间件 (无 authMiddleware)，跨 package 加 auth
// 会导致循环依赖。如果必须公开暴露 PLC 配置 API，请改走主 server
// (packages/server) 并设置 AUTH_ENABLED=true，由其反代到此 driver。
// 强行设置 BIND_HOST=0.0.0.0 会触发启动告警。
// ============================================================

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';

import { PLCConnectionManager, PollingScheduler, VariableMappingManager } from '@biocore/plc-driver';
import { SQLiteService, InfluxService } from '@biocore/data-service';
import { LLMClient, NLToFlux, BatchSummaryGenerator, ContextBuilder } from '@biocore/ai-gateway';
import type { WSMessage, PLCConnection, PLCVariableMapping } from '@biocore/types';

// ─── 初始化 ─────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// 数据库
const sqlite = new SQLiteService('./data/biocore.db');
const influx = new InfluxService({
  url: process.env.INFLUX_URL || 'http://localhost:8086',
  token: process.env.INFLUX_TOKEN || 'biocore-dev-token',
  org: process.env.INFLUX_ORG || 'biocore',
  bucket: process.env.INFLUX_BUCKET || 'fermentation',
});

// PLC 变量映射管理
const varManager = new VariableMappingManager(sqlite.getDatabase());

// AI
const llm = new LLMClient();
const nlToFlux = new NLToFlux(llm);
const summaryGen = new BatchSummaryGenerator(llm);

// ─── WebSocket 广播 ─────────────────────────────────────────

function broadcast(msg: WSMessage): void {
  const data = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  });
}

// ─── REST API: PLC 通讯配置 (★新增需求) ────────────────────

// --- PLC 连接管理 ---
app.get('/api/plc/connections', (_req, res) => {
  res.json(varManager.getConnections());
});

app.post('/api/plc/connections', (req, res) => {
  const conn: PLCConnection = { id: uuidv4(), ...req.body };
  varManager.upsertConnection(conn);
  sqlite.writeAuditLog({
    user_id: req.body._userId || 'system',
    action: 'plc_config_change',
    target_type: 'plc_connection',
    target_id: conn.id,
    new_value: JSON.stringify(conn),
  });
  res.json(conn);
});

app.put('/api/plc/connections/:id', (req, res) => {
  const conn: PLCConnection = { ...req.body, id: req.params.id };
  varManager.upsertConnection(conn);
  res.json(conn);
});

app.delete('/api/plc/connections/:id', (req, res) => {
  varManager.deleteConnection(req.params.id);
  res.json({ success: true });
});

// PLC 连接测试
app.post('/api/plc/connections/:id/test', async (req, res) => {
  const conns = varManager.getConnections();
  const conn = conns.find(c => c.id === req.params.id);
  if (!conn) return res.status(404).json({ error: '连接不存在' });

  const testPlc = new PLCConnectionManager(conn);
  try {
    await testPlc.connect();
    const vars = varManager.getVariables(conn.id).slice(0, 5);
    testPlc.setVariables(vars);
    const values = vars.length > 0 ? await testPlc.readAll() : {};
    await testPlc.disconnect();
    res.json({ success: true, message: `连接成功 (IP: ${conn.ip})`, sampleValues: values });
  } catch (err) {
    res.json({ success: false, message: `连接失败: ${(err as Error).message}` });
  }
});

// --- PLC 变量映射 CRUD ---
app.get('/api/plc/variables', (req, res) => {
  const connectionId = req.query.connection_id as string | undefined;
  res.json(varManager.getVariables(connectionId));
});

app.post('/api/plc/variables', (req, res) => {
  const variable: PLCVariableMapping = { id: uuidv4(), ...req.body };
  varManager.upsertVariable(variable);
  res.json(variable);
});

app.put('/api/plc/variables/:id', (req, res) => {
  const variable: PLCVariableMapping = { ...req.body, id: req.params.id };
  varManager.upsertVariable(variable);
  res.json(variable);
});

app.delete('/api/plc/variables/:id', (req, res) => {
  varManager.deleteVariable(req.params.id);
  res.json({ success: true });
});

// 批量更新
app.put('/api/plc/variables', (req, res) => {
  const variables: PLCVariableMapping[] = req.body;
  const errors: string[] = [];
  for (const v of variables) {
    try { varManager.upsertVariable(v); }
    catch (e) { errors.push(`${v.tag_name}: ${(e as Error).message}`); }
  }
  res.json({ updated: variables.length - errors.length, errors });
});

// --- 导入/导出 ---
app.get('/api/plc/export/json', (_req, res) => {
  const data = varManager.exportToJSON();
  res.setHeader('Content-Disposition', 'attachment; filename=plc_config.json');
  res.json(data);
});

app.get('/api/plc/export/csv', (_req, res) => {
  const csv = varManager.exportToCSV();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=plc_variables.csv');
  res.send('\uFEFF' + csv); // BOM for Excel中文兼容
});

app.post('/api/plc/import/json', (req, res) => {
  const result = varManager.importFromJSON(req.body);
  res.json(result);
});

app.post('/api/plc/import/csv', (req, res) => {
  // CSV解析由前端完成, 传入已解析的数组
  const variables: PLCVariableMapping[] = req.body.variables;
  const errors: string[] = [];
  let imported = 0;
  for (const v of variables) {
    try {
      varManager.upsertVariable({ ...v, id: v.id || uuidv4() });
      imported++;
    } catch (e) {
      errors.push(`${v.tag_name}: ${(e as Error).message}`);
    }
  }
  res.json({ imported, errors });
});

// --- PLC 连接状态 (DEPRECATED) ---
// 此 standalone plc-driver server 未在生产部署: docker-compose 不启动,
// 0 caller 引用 :3002, 实际 PLC 状态查询走主 server (packages/server) 的
// plc-bridge.ts + scada-write-dispatcher.ts. endpoint 保留为 fixture stub,
// 不实现 PLCConnectionManager 状态聚合 (本可加 module-scoped Map + 在
// /test endpoint 维护, 但无消费者, 收益为零).
app.get('/api/plc/status', (_req, res) => {
  res.json({
    connections: [],
    deprecated: true,
    note: 'standalone plc-driver not in production; PLC status lives in main server',
  });
});

// ─── REST API: 批次管理 ────────────────────────────────────

app.get('/api/batches', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const offset = parseInt(req.query.offset as string) || 0;
  res.json(sqlite.listBatches(limit, offset));
});

app.get('/api/batches/:id', (req, res) => {
  const batch = sqlite.getBatch(req.params.id);
  if (!batch) return res.status(404).json({ error: '批次不存在' });
  res.json(batch);
});

// ─── REST API: 配方管理 ────────────────────────────────────

app.get('/api/recipes', (_req, res) => {
  res.json(sqlite.getApprovedRecipes());
});

// ─── REST API: AI ───────────────────────────────────────────

app.post('/api/ai/chat', async (req, res) => {
  const { messages } = req.body;
  try {
    const response = await llm.chat(messages);
    res.json({ response });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/ai/nl-to-flux', async (req, res) => {
  const { query } = req.body;
  const result = await nlToFlux.convert(query);
  if (result.error) return res.status(400).json(result);

  try {
    const data = await influx.executeFluxQuery(result.flux);
    res.json({ flux: result.flux, data });
  } catch (err) {
    res.json({ flux: result.flux, data: [], queryError: (err as Error).message });
  }
});

app.get('/api/ai/status', async (_req, res) => {
  const status = await llm.checkOllamaStatus();
  res.json(status);
});

// ─── REST API: InfluxDB 查询 ───────────────────────────────

app.get('/api/data/trend/:batchId', async (req, res) => {
  const fields = (req.query.fields as string || 'temperature,pH,DO').split(',');
  const range = req.query.range as string || '-24h';
  try {
    const data = await influx.queryBatchTrend(req.params.batchId, fields, range);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── 启动服务器 ─────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3001');
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';

if (BIND_HOST === '0.0.0.0' || BIND_HOST === '::') {
  console.warn('[plc-driver] WARNING: bound to all interfaces without auth — set AUTH_ENABLED=true on main server and route through it instead.');
}

server.listen(PORT, BIND_HOST, () => {
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║         BIOCore Server v0.1.0                ║
  ║         http://${BIND_HOST}:${PORT}               ║
  ║         WebSocket: ws://${BIND_HOST}:${PORT}/ws    ║
  ╠══════════════════════════════════════════════╣
  ║  SQLite:  ./data/biocore.db                  ║
  ║  InfluxDB: ${process.env.INFLUX_URL || 'http://localhost:8086'}     ║
  ║  Ollama:  http://localhost:11434             ║
  ╚══════════════════════════════════════════════╝
  `);
});

export { app, server, wss, broadcast };
