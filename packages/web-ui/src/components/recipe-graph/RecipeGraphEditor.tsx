// RecipeGraphEditor — react-flow DAG 编辑器 (M3.7)
'use client';

import React, { useCallback, useMemo, useState, useEffect } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap,
  Node, Edge, useNodesState, useEdgesState, addEdge, Connection,
  BackgroundVariant, NodeTypes, MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Button } from '@/components/ui/button';
import { Beaker, GitBranch, Wand2, Trash2, Save as SaveIcon, Plus, CornerDownRight, Repeat } from 'lucide-react';
import { PhaseNode } from './nodes/PhaseNode';
import { BranchNode } from './nodes/BranchNode';
import { GotoNode } from './nodes/GotoNode';
import { LoopNode } from './nodes/LoopNode';
import { StartNode, EndNode } from './nodes/StartEndNode';
import { NodeInspector, type APIPhaseTemplate, type APIPhaseInstance } from './NodeInspector';
import { applyDagreLayout } from './layout';
import { phaseLabel } from '@/lib/utils';
import { useLocale } from '@/i18n/useLocale';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// 与 server/src/recipe-dag.ts 的 RecipeDAG 对齐
export interface DAGNode {
  id: string;
  type: 'start' | 'end' | 'phase' | 'branch' | 'goto' | 'loop';
  position?: { x: number; y: number };
  phase_id?: string;
  phase_type?: string;
  params?: Record<string, any>;
  label?: string;                    // 节点显示名 (操作员视角)
  expression?: string;
  default_branch?: 'true' | 'false'; // branch: PV 字段缺失时的回退分支
  target?: string;                   // B1.3 goto: 跳转目标节点 id
  // B1.2 loop:
  exitExpression?: string;           // repeat-until 退出条件
  maxIterations?: number;            // fixed-N 硬上限
}
export interface DAGEdge {
  id: string;
  from: string;
  to: string;
  // branch 出边: 'true'|'false'; loop 出边 (B1.2): 'body'|'exit'
  label?: 'true' | 'false' | 'body' | 'exit';
}
export interface RecipeDAG {
  schema_version: 2;
  nodes: DAGNode[];
  edges: DAGEdge[];
  /** B1.3: recipe-level executor options (forwarded to DAGExecutor).
   *  SP-RG-2 (H-4): `_hasLayout` is a UI-only sentinel set by flowToDag once
   *  the editor has persisted positions; reload uses it to skip auto-layout
   *  instead of guessing from node positions. */
  options?: { maxRevisits?: number; _hasLayout?: boolean };
}

const nodeTypes: NodeTypes = {
  phase: PhaseNode,
  branch: BranchNode,
  goto: GotoNode,
  loop: LoopNode,
  start: StartNode,
  end: EndNode,
};

// DAG → react-flow 节点/边
export function dagToFlow(dag: RecipeDAG): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = dag.nodes.map(n => ({
    id: n.id,
    type: n.type,
    position: n.position || { x: 0, y: 0 },
    data: {
      phase_id: n.phase_id || '',
      phase_type: n.phase_type || '',
      label: n.label || n.phase_id || n.id,
      params: n.params || {},
      expression: n.expression || '',
      default_branch: n.default_branch, // SP-RG-1: round-trip branch fallback
      target: n.target || '',           // B1.3 goto target
      // B1.2 loop fields — pass through so LoopNode + inspector can render/edit them
      exitExpression: n.exitExpression || '',
      maxIterations: n.maxIterations,
    },
  }));
  const edges: Edge[] = dag.edges.map(e => ({
    id: e.id,
    source: e.from,
    target: e.to,
    sourceHandle: e.label || undefined, // branch true/false; loop body/exit
    label: e.label,
    labelStyle:
      e.label === 'true'  ? { fill: '#4ade80', fontWeight: 600 } :
      e.label === 'false' ? { fill: '#f87171', fontWeight: 600 } :
      e.label === 'body'  ? { fill: '#14b8a6', fontWeight: 600 } :
      e.label === 'exit'  ? { fill: '#fb923c', fontWeight: 600 } :
                            undefined,
    markerEnd: { type: MarkerType.ArrowClosed },
    style: { strokeWidth: 1.5 },
  }));
  return { nodes, edges };
}

// react-flow → DAG
// SP-RG-2 (H-4): accepts prevOptions so editor-managed flags (maxRevisits) survive
// the round-trip; always stamps `_hasLayout: true` so subsequent loads skip dagre.
export function flowToDag(
  nodes: Node[],
  edges: Edge[],
  prevOptions?: RecipeDAG['options'],
): RecipeDAG {
  return {
    schema_version: 2,
    options: { ...(prevOptions || {}), _hasLayout: true },
    nodes: nodes.map(n => {
      const d = n.data as any;
      const base: DAGNode = {
        id: n.id,
        type: n.type as any,
        position: n.position,
      };
      if (n.type === 'phase') {
        base.phase_id = d.phase_id;
        base.phase_type = d.phase_type;
        base.label = d.label;        // 修复: 之前遗漏了 label, 重新加载后"显示名"会丢
        base.params = d.params;
      }
      if (n.type === 'branch') {
        base.expression = d.expression;
        // SP-RG-1 (H-2): persist branch fallback. Without this the operator-
        // configured default_branch silently resets on every save.
        if (d.default_branch === 'true' || d.default_branch === 'false') {
          base.default_branch = d.default_branch;
        }
      }
      if (n.type === 'goto') {
        // B1.3: keep target in sync with the (single) outgoing edge.
        // If the user wired a connection from this goto, prefer the edge's
        // target; otherwise fall back to whatever the inspector last set.
        const outEdge = edges.find(e => e.source === n.id);
        base.target = outEdge?.target || d.target || '';
      }
      if (n.type === 'loop') {
        // B1.2: persist exitExpression / maxIterations from inspector data
        if (d.exitExpression && String(d.exitExpression).trim().length > 0) {
          base.exitExpression = String(d.exitExpression).trim();
        }
        // SP-RG-2 (H-3): strip non-positive maxIterations so the BV-22 guard in
        // recipe-validator cannot be bypassed via inspector min={1} circumvention.
        if (
          d.maxIterations != null &&
          Number.isFinite(d.maxIterations) &&
          Number(d.maxIterations) > 0
        ) {
          base.maxIterations = Number(d.maxIterations);
        }
      }
      return base;
    }),
    edges: edges.map(e => ({
      id: e.id,
      from: e.source,
      to: e.target,
      // B1.2: preserve sourceHandle for loop edges (body|exit) as well as branch (true|false)
      label: (e.sourceHandle as 'true' | 'false' | 'body' | 'exit' | undefined) || undefined,
    })),
  };
}

interface Props {
  initialDag: RecipeDAG;
  onSave: (dag: RecipeDAG) => void;
  saving?: boolean;
}

function RecipeGraphEditorInner({ initialDag, onSave, saving }: Props) {
  const { nodes: initNodes, edges: initEdges } = useMemo(() => {
    // SP-RG-2 (H-4): use the explicit `_hasLayout` sentinel set by flowToDag.
    // The old heuristic ("all nodes at origin?") destroyed user-arranged
    // positions whenever the inverse held (any node legitimately near 0,0).
    // First load of a pre-sentinel legacy DAG still triggers one auto-layout,
    // after which save stamps the sentinel and the layout becomes sticky.
    const flow = dagToFlow(initialDag);
    const needsLayout = !initialDag.options?._hasLayout;
    return needsLayout ? applyDagreLayout(flow.nodes, flow.edges) : flow;
  }, [initialDag]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initEdges);
  // SP-RG-1 (H-1): useNodesState/useEdgesState only honour the initial arg.
  // When initialDag arrives via async fetch (the common case), the recomputed
  // initNodes/initEdges from useMemo never reach React-Flow state — user
  // would see an empty graph and overwrite the stored recipe on save.
  useEffect(() => {
    setNodes(initNodes);
    setEdges(initEdges);
  }, [initNodes, initEdges, setNodes, setEdges]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // Phase 模板库 (从 /api/phase-templates 加载) — 用作"添加 Phase 时的快捷模板"
  const [apiTemplates, setApiTemplates] = useState<APIPhaseTemplate[]>([]);
  // SP-RG-3 (M-3): expose phase-template fetch failure instead of silently
  // falling back to a hardcoded `phase_type: 'heating'` blank node.
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  // SP-RG-4: phase instances (phase class 绑到 reactor 的中间层) for inspector dropdown
  const [phaseInstances, setPhaseInstances] = useState<APIPhaseInstance[]>([]);
  // DAG 校验错误
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  useEffect(() => {
    fetch(`${API}/api/phase-templates`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        if (Array.isArray(data)) {
          setApiTemplates(data);
          setTemplatesError(null);
        } else {
          throw new Error('响应不是数组');
        }
      })
      .catch(err => {
        setTemplatesError(`模板库加载失败: ${err.message ?? err}`);
      });
  }, []);

  // SP-RG-4: 加载 phase instances (NodeInspector 用于绑定下拉)
  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('biocore_token') : null;
    fetch(`${API}/api/v1/phase-instances`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(j => {
        const data = j && typeof j === 'object' && 'data' in j ? j.data : j;
        if (Array.isArray(data)) setPhaseInstances(data);
      })
      .catch(() => { /* 静默 — instance 列表为空不阻止编辑器使用 */ });
  }, []);

  const findTemplate = useCallback(
    (type: string) => apiTemplates.find(t => t.type === type),
    [apiTemplates],
  );

  const selectedNode = nodes.find(n => n.id === selectedNodeId) || null;

  const onConnect = useCallback((params: Connection) => {
    setEdges(prev => addEdge({
      ...params,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { strokeWidth: 1.5 },
      label: params.sourceHandle as string | undefined,
    }, prev));
  }, [setEdges]);

  // 从 Phase 模板添加节点 — 自动填充 phase_type / label / 默认 params
  const addPhaseFromTemplate = useCallback((template: APIPhaseTemplate) => {
    const id = `n_${Date.now()}`;
    // 合并默认参数: default_params + param_schema 中的 default_value
    const params: Record<string, any> = { ...(template.default_params || {}) };
    (template.param_schema || []).forEach((f: any) => {
      const key = f.key || f.plc_tag;
      if (key && f.default_value !== undefined && !(key in params)) {
        params[key] = f.default_value;
      }
    });
    const sameTypeCount = nodes.filter(n => (n.data as any)?.phase_type === template.type).length;
    const phaseId = `${template.type.toUpperCase()}_${String(sameTypeCount + 1).padStart(2, '0')}`;
    const newNode: Node = {
      id,
      type: 'phase',
      position: { x: 260, y: 120 + nodes.length * 40 },
      data: {
        phase_id: phaseId,
        phase_type: template.type,
        label: sameTypeCount > 0 ? `${template.label} ${sameTypeCount + 1}` : template.label,
        params,
      },
    };
    setNodes(prev => [...prev, newNode]);
    setSelectedNodeId(id);
  }, [nodes, setNodes]);

  // 兜底: 无模板时添加空白 Phase
  const addBlankPhaseNode = useCallback(() => {
    const id = `n_${Date.now()}`;
    const newNode: Node = {
      id,
      type: 'phase',
      position: { x: 200, y: 150 + nodes.length * 30 },
      data: { phase_id: `PHASE_${nodes.length + 1}`, phase_type: 'heating', label: '新 Phase', params: {} },
    };
    setNodes(prev => [...prev, newNode]);
    setSelectedNodeId(id);
  }, [nodes, setNodes]);

  const addBranchNode = useCallback(() => {
    const id = `n_${Date.now()}`;
    const newNode: Node = {
      id,
      type: 'branch',
      position: { x: 400, y: 150 + nodes.length * 30 },
      data: { expression: 'OD600 > 5' },
    };
    setNodes(prev => [...prev, newNode]);
    setSelectedNodeId(id);
  }, [nodes, setNodes]);

  // B1.3: 添加 Goto 节点 (单出边跳转节点)
  const addGotoNode = useCallback(() => {
    const id = `n_${Date.now()}`;
    const newNode: Node = {
      id,
      type: 'goto',
      position: { x: 400, y: 150 + nodes.length * 30 },
      data: { target: '' },
    };
    setNodes(prev => [...prev, newNode]);
    setSelectedNodeId(id);
  }, [nodes, setNodes]);

  // B1.2: 添加 Loop 节点 (双出边 body/exit)
  const addLoopNode = useCallback(() => {
    const id = `n_${Date.now()}`;
    const newNode: Node = {
      id,
      type: 'loop',
      position: { x: 400, y: 150 + nodes.length * 30 },
      data: { exitExpression: '', maxIterations: 5 },
    };
    setNodes(prev => [...prev, newNode]);
    setSelectedNodeId(id);
  }, [nodes, setNodes]);

  // DAG 校验: 入口/出口 + 孤立节点 + 未连接 Phase (保存前检查)
  const validateDag = useCallback((): string[] => {
    const errs: string[] = [];
    const starts = nodes.filter(n => n.type === 'start');
    const ends = nodes.filter(n => n.type === 'end');
    if (starts.length === 0) errs.push('缺少 Start 节点 (DAG 入口)');
    if (starts.length > 1) errs.push(`Start 节点应只有 1 个, 当前 ${starts.length} 个`);
    if (ends.length === 0) errs.push('缺少 End 节点 (DAG 出口)');
    // 每个 Phase 必须至少有 1 条入边和 1 条出边 (start 只出, end 只入)
    nodes.forEach(n => {
      const inEdges = edges.filter(e => e.target === n.id);
      const outEdges = edges.filter(e => e.source === n.id);
      if (n.type !== 'start' && inEdges.length === 0) {
        errs.push(`节点 ${(n.data as any)?.label || n.id} 无入边 (不可达)`);
      }
      if (n.type !== 'end' && outEdges.length === 0) {
        errs.push(`节点 ${(n.data as any)?.label || n.id} 无出边 (死胡同)`);
      }
      if (n.type === 'branch') {
        const hasTrue = outEdges.some(e => e.sourceHandle === 'true');
        const hasFalse = outEdges.some(e => e.sourceHandle === 'false');
        if (!hasTrue || !hasFalse) {
          errs.push(`分支节点 ${n.id} 必须同时有 true/false 两条出边`);
        }
      }
      if (n.type === 'phase') {
        const d = n.data as any;
        if (!d.phase_id?.trim()) errs.push(`Phase 节点 ${d.label || n.id} 缺少 phase_id`);
        if (!d.phase_type?.trim()) errs.push(`Phase 节点 ${d.label || n.id} 缺少 phase_type`);
      }
      if (n.type === 'goto') {
        // B1.3: Goto 必须恰好 1 条出边, 且 target 必须等于该边 to.
        if (outEdges.length !== 1) {
          errs.push(`Goto 节点 ${n.id} 必须恰好 1 条出边 (实际 ${outEdges.length})`);
        }
        const d = n.data as any;
        const edgeTo = outEdges[0]?.target;
        const inspectorTarget = d.target?.trim() || '';
        // SP-RG-3 (M-5): when inspector target ≠ edge target, only emit the
        // mismatch error. The downstream "unknown target" check would otherwise
        // double-report the same fix (resolving the mismatch fixes both).
        if (!inspectorTarget && !edgeTo) {
          errs.push(`Goto 节点 ${n.id} 缺少 target 目标`);
        } else if (edgeTo && inspectorTarget && inspectorTarget !== edgeTo) {
          errs.push(`Goto 节点 ${n.id} 的 target "${inspectorTarget}" 与连接 to "${edgeTo}" 不一致`);
        } else {
          const canonicalTarget = edgeTo || inspectorTarget;
          const targetNode = nodes.find(x => x.id === canonicalTarget);
          if (!targetNode) {
            errs.push(`Goto 节点 ${n.id} 的 target "${canonicalTarget}" 不是 DAG 内已知节点`);
          } else if (targetNode.type === 'start') {
            errs.push(`Goto 节点 ${n.id} 不能跳到 start 节点`);
          }
        }
      }
      if (n.type === 'loop') {
        // B1.2 client-side mirror of recipe-validator BV-22..25.
        const d = n.data as any;
        const exitExpr = (d.exitExpression || '').trim();
        const maxIter = d.maxIterations;
        const hasMax = maxIter != null && Number.isFinite(maxIter) && maxIter > 0;
        // BV-22: at least one of {exitExpression, maxIterations>0}
        if (!exitExpr && !hasMax) {
          errs.push(`Loop 节点 ${n.id} 必须至少设置 exitExpression 或 maxIterations 之一`);
        }
        // BV-23: exactly 2 out-edges with labels {body, exit}
        if (outEdges.length !== 2) {
          errs.push(`Loop 节点 ${n.id} 必须恰好 2 条出边 (实际 ${outEdges.length})`);
        } else {
          const labels = new Set(outEdges.map(e => e.sourceHandle || e.label));
          if (!labels.has('body')) {
            errs.push(`Loop 节点 ${n.id} 缺少 'body' 出边 (从 body handle 拉线)`);
          }
          if (!labels.has('exit')) {
            errs.push(`Loop 节点 ${n.id} 缺少 'exit' 出边 (从 exit handle 拉线)`);
          }
        }
        // Compute body-reachable set via BFS from the body out-edge target.
        // Stop at: this loop node (back-edge), other end nodes, or visited.
        const bodyEdge = outEdges.find(e => (e.sourceHandle || e.label) === 'body');
        const bodyReachable = new Set<string>();
        if (bodyEdge?.target) {
          const queue: string[] = [bodyEdge.target];
          while (queue.length > 0) {
            const cur = queue.shift()!;
            if (cur === n.id) continue;             // reached loop again — back-edge boundary
            if (bodyReachable.has(cur)) continue;
            bodyReachable.add(cur);
            const next = edges.filter(e => e.source === cur);
            for (const ne of next) {
              if (ne.target && !bodyReachable.has(ne.target) && ne.target !== n.id) {
                queue.push(ne.target);
              }
            }
          }
        }
        // BV-24: no nested loop in body subgraph
        for (const reachableId of bodyReachable) {
          const rn = nodes.find(x => x.id === reachableId);
          if (rn?.type === 'loop' && rn.id !== n.id) {
            errs.push(`Loop 节点 ${n.id} 的 body 子图包含嵌套 Loop ${rn.id} (depth>1 不支持)`);
          }
        }
        // BV-25: at least one back-edge from body subgraph back to this loop node
        const hasBackEdge = edges.some(e => bodyReachable.has(e.source) && e.target === n.id);
        if (!hasBackEdge && bodyEdge) {
          errs.push(`Loop 节点 ${n.id} 缺少 back-edge (body 子图必须至少有 1 条边回到 loop)`);
        }
      }
    });
    return errs;
  }, [nodes, edges]);

  const deleteSelected = useCallback(() => {
    if (!selectedNodeId) return;
    // 不允许删除 start 和 end
    const node = nodes.find(n => n.id === selectedNodeId);
    if (node?.type === 'start' || node?.type === 'end') return;
    setNodes(prev => prev.filter(n => n.id !== selectedNodeId));
    setEdges(prev => prev.filter(e => e.source !== selectedNodeId && e.target !== selectedNodeId));
    setSelectedNodeId(null);
  }, [selectedNodeId, nodes, setNodes, setEdges]);

  const autoLayout = useCallback(() => {
    const { nodes: layouted } = applyDagreLayout(nodes, edges);
    setNodes(layouted);
  }, [nodes, edges, setNodes]);

  const handleSave = useCallback(() => {
    const errs = validateDag();
    setValidationErrors(errs);
    if (errs.length > 0) return;  // 校验失败时不保存, 让用户看到错误
    // SP-RG-2 (H-4): forward initialDag.options so executor flags survive the round-trip.
    onSave(flowToDag(nodes, edges, initialDag.options));
  }, [nodes, edges, onSave, validateDag, initialDag.options]);

  const updateNodeData = useCallback((nodeId: string, patch: Record<string, any>) => {
    setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n));
  }, [setNodes]);

  // 已在画布上的 instance_id — palette 中标灰禁止重复添加
  const usedInstanceIds = useMemo(
    () => new Set(nodes
      .filter(n => n.type === 'phase')
      .map(n => (n.data as any)?.instance_id as string | undefined)
      .filter((x): x is string => !!x)),
    [nodes],
  );

  // Phase Instance 按 reactor 分组 (侧栏快捷添加 — 配方编辑直接绑实例,不暴露模板库)
  const instanceGroups = useMemo(() => {
    const map = new Map<string, APIPhaseInstance[]>();
    for (const inst of phaseInstances) {
      const key = inst.reactor_id || '未绑定 reactor';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(inst);
    }
    return [...map.entries()].map(([title, items]) => ({ title, items }));
  }, [phaseInstances]);

  // 从 Phase Instance 添加节点 — 推断 phase_type, 合并模板默认参数 + instance.params_override
  const addPhaseFromInstance = useCallback((inst: APIPhaseInstance) => {
    // 防御: 配方中同一 instance 不可重复
    if (nodes.some(n => n.type === 'phase' && (n.data as any)?.instance_id === inst.instance_id)) {
      return;
    }
    const id = `n_${Date.now()}`;
    const tmpl = apiTemplates.find(t => t.type === inst.phase_class);
    const params: Record<string, any> = { ...(tmpl?.default_params || {}) };
    (tmpl?.param_schema || []).forEach((f: any) => {
      const key = f.key || f.plc_tag;
      if (key && f.default_value !== undefined && !(key in params)) {
        params[key] = f.default_value;
      }
    });
    Object.assign(params, inst.params_override || {});
    const newNode: Node = {
      id,
      type: 'phase',
      position: { x: 260, y: 120 + nodes.length * 40 },
      data: {
        phase_id: inst.instance_id,
        phase_type: inst.phase_class,
        instance_id: inst.instance_id,
        label: inst.label || tmpl?.label || inst.instance_id,
        params,
      },
    };
    setNodes(prev => [...prev, newNode]);
    setSelectedNodeId(id);
  }, [apiTemplates, phaseInstances, nodes, setNodes]);

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* 左侧: 模板库 + 操作 */}
      <div className="w-56 border-r border-border flex flex-col">
        <div className="p-2 border-b border-border space-y-1.5">
          <div className="text-sm font-semibold text-muted-foreground uppercase">添加节点</div>
          <Button variant="outline" size="sm" className="w-full justify-start" onClick={addBranchNode}>
            <GitBranch className="w-3.5 h-3.5 mr-1.5" />IF/ELSE 分支
          </Button>
          <Button variant="outline" size="sm" className="w-full justify-start" onClick={addGotoNode}>
            <CornerDownRight className="w-3.5 h-3.5 mr-1.5" />Goto 跳转
          </Button>
          <Button variant="outline" size="sm" className="w-full justify-start" onClick={addLoopNode}>
            <Repeat className="w-3.5 h-3.5 mr-1.5" />Loop 循环
          </Button>
          {phaseInstances.length === 0 && (
            <Button variant="outline" size="sm" className="w-full justify-start" onClick={addBlankPhaseNode}>
              <Beaker className="w-3.5 h-3.5 mr-1.5" />空白 Phase
            </Button>
          )}
        </div>

        {/* Phase Instance 库 (点击添加节点) */}
        <div className="flex-1 overflow-y-auto p-2">
          <div className="text-sm font-semibold text-muted-foreground uppercase mb-2">
            Phase Instance <span className="text-muted-foreground/60">({phaseInstances.length})</span>
          </div>
          {instanceGroups.map(group => (
            <div key={group.title} className="mb-3 space-y-1">
              <div className="text-[12px] font-medium text-muted-foreground/70 uppercase tracking-wider px-1 font-mono">
                {group.title}
              </div>
              {group.items.map(inst => {
                const tmpl = apiTemplates.find(t => t.type === inst.phase_class);
                const used = usedInstanceIds.has(inst.instance_id);
                return (
                  <button
                    key={inst.instance_id}
                    type="button"
                    onClick={() => !used && addPhaseFromInstance(inst)}
                    disabled={used}
                    className={`w-full flex items-center gap-1.5 px-2 py-1.5 rounded border border-transparent text-left text-[12px] group ${
                      used
                        ? 'opacity-40 cursor-not-allowed'
                        : 'hover:border-border hover:bg-muted/50'
                    }`}
                    title={used ? `${inst.instance_id} 已在配方中` : `添加 ${inst.instance_id} (${inst.phase_class} @ ${inst.reactor_id})`}
                  >
                    <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: 'var(--primary, #1677ff)' }} />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate font-mono">{inst.instance_id}</div>
                      <div className="text-[12px] text-muted-foreground truncate">
                        {used ? '已添加' : (inst.label || phaseLabel(inst.phase_class, tmpl?.label))}
                      </div>
                    </div>
                    {!used && <Plus className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 flex-shrink-0" />}
                  </button>
                );
              })}
            </div>
          ))}
          {phaseInstances.length === 0 && (
            <div className="text-sm text-muted-foreground italic px-1">
              暂无 Phase Instance — 到 <a href="/phase-instances" target="_blank" className="text-blue-500 underline">/phase-instances</a> 创建
            </div>
          )}
          {templatesError && (
            <div className="text-sm text-red-600 bg-red-500/10 border border-red-500/40 rounded px-2 py-1.5 mt-2">
              {templatesError}
            </div>
          )}
        </div>

        {/* 底部: 操作按钮 */}
        <div className="p-2 border-t border-border space-y-1.5">
          <Button variant="outline" size="sm" className="w-full justify-start" onClick={autoLayout}>
            <Wand2 className="w-3.5 h-3.5 mr-1.5" />自动布局
          </Button>
          <Button variant="outline" size="sm" className="w-full justify-start"
            onClick={deleteSelected}
            disabled={!selectedNodeId || nodes.find(n => n.id === selectedNodeId)?.type === 'start' || nodes.find(n => n.id === selectedNodeId)?.type === 'end'}
          >
            <Trash2 className="w-3.5 h-3.5 mr-1.5" />删除选中
          </Button>
          <Button size="sm" className="w-full justify-start" onClick={handleSave} disabled={saving}>
            <SaveIcon className="w-3.5 h-3.5 mr-1.5" />{saving ? '保存中...' : '保存 DAG'}
          </Button>
          <div className="text-sm text-muted-foreground space-y-0.5 pt-1">
            <div>节点: {nodes.length} · 边: {edges.length}</div>
          </div>
        </div>
      </div>

      {/* react-flow 画布 */}
      <div className="flex-1 relative">
        {validationErrors.length > 0 && (
          <div className="absolute top-2 left-2 right-2 z-10 bg-red-500/15 border border-red-500/40 rounded-md p-2 text-[12px] text-red-600 max-h-32 overflow-y-auto">
            <div className="font-semibold mb-1 flex items-center justify-between">
              <span>DAG 校验未通过 ({validationErrors.length})</span>
              <button onClick={() => setValidationErrors([])} className="text-red-600/70 hover:text-red-600">✕</button>
            </div>
            <ul className="list-disc list-inside space-y-0.5">
              {validationErrors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          </div>
        )}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={(_, n) => setSelectedNodeId(n.id)}
          onPaneClick={() => setSelectedNodeId(null)}
          nodeTypes={nodeTypes}
          fitView
          style={{ background: 'hsl(var(--background))' }}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
          <Controls />
          <MiniMap
            nodeColor={n => {
              if (n.type === 'start') return '#16a34a';
              if (n.type === 'end') return '#dc2626';
              if (n.type === 'branch') return '#f59e0b';
              if (n.type === 'goto') return '#8b5cf6';
              if (n.type === 'loop') return '#14b8a6';
              return '#3b82f6';
            }}
            maskColor="rgba(0, 0, 0, 0.6)"
          />
        </ReactFlow>
      </div>

      {/* 右侧节点检查器 — 传入模板库支持基于 schema 的参数表单 */}
      {selectedNode && (
        <NodeInspector
          node={selectedNode}
          template={findTemplate((selectedNode.data as any)?.phase_type || '')}
          allTemplates={apiTemplates}
          phaseInstances={phaseInstances}
          allNodes={nodes}
          onChange={updateNodeData}
          onClose={() => setSelectedNodeId(null)}
        />
      )}
    </div>
  );
}

export function RecipeGraphEditor(props: Props) {
  return (
    <ReactFlowProvider>
      <RecipeGraphEditorInner {...props} />
    </ReactFlowProvider>
  );
}
