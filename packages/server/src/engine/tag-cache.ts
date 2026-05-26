// ============================================================
// tag-cache — in-memory OPC-style tag cache (SP-PLC-3 Phase 1, Commit 1)
// ============================================================
//
// 计划: docs/plans/SP-PLC-3-tag-cache-plan.md  §1 Commit 1
//
// 职责:
//   - 维护 reactor → tag → {value, ts, quality, lastChanged, prevValue}
//     的内存缓存, 作为 PLC 采集 / WS 广播 / Influx 写入 / CUSUM 检测
//     之间的解耦层 (OPC 风格).
//   - 提供同步 read API (write 后立即可见) + 同步 subscribe 回调
//     (避免 microtask 累积). 支持 deadband, 仅 value 真变化时 fan-out.
//   - 通讯故障时通过 markStale 把指定 tag 标 quality='bad', 但 value
//     保留上次良值 (last-known-good); InfluxDB writer 应跳过 bad 点,
//     WS 推送把 quality 透传给前端. 详见 plan §Q9.
//
// 不在 Phase 1 范围:
//   - 持久化 / crash recovery (plan §6 Q-ii: 不做)
//   - 客户端订阅过滤 (Phase 2)
//   - per-tag deadband (Phase 2)
//
// 实现约束:
//   - 内部 Map 不暴露给消费者; read* 返回 entry 的浅拷贝, 避免外部 mutation
//     污染缓存状态.
//   - subscribe 回调同步触发 (write 函数内直接遍历调用), 抛错被 try/catch
//     隔离: 一个 callback 抛错不影响其它 callback, 也不抛回 write 调用方.
//   - quality === 'bad' 时, value 字段不覆盖现存 good 值 (保留 last-known-good);
//     ts/quality 仍更新; lastChanged 不更新 (因 value 未真变).
// ============================================================

import { randomUUID } from 'node:crypto';

/** 缓存中单个 tag 的状态快照. */
export interface CacheEntry {
  /** 当前值. quality='bad' 时仍保留上次良值 (last-known-good). */
  value: number;
  /** 本次 write 携带的 ISO 时间戳 (PLC snapshot 时间). */
  ts: string;
  /** OPC 三态: 'good' 正常, 'bad' 通讯故障/采集失败, 'uncertain' 保留给将来. */
  quality: 'good' | 'bad' | 'uncertain';
  /** 上次 value 真变化 (超 deadband 且 quality 非 bad) 的 ts. */
  lastChanged: string;
  /** 上次写入前的 value, 用于 deadband 比较. */
  prevValue: number;
}

/** 订阅句柄. id 由 subscribe 生成返回. */
export interface CacheSubscription {
  id: string;
  /** '*' 表示所有 reactor. */
  reactorId: string | '*';
  /** Set<tagName> 表示订阅指定 tag 集合; '*' 表示所有 tag. */
  tags: Set<string> | '*';
  callback: (changes: CacheChange[]) => void;
}

/** 单次 write 产生的一条变化记录. */
export interface CacheChange {
  reactorId: string;
  tag: string;
  /** entry 的浅拷贝, 消费者修改不会影响 cache. */
  entry: CacheEntry;
}

/** PollingScheduler 风格的 snapshot, 与 plc-driver `snapshot` event 对齐. */
export interface SnapshotInput {
  timestamp: string;
  values: Record<string, number>;
  quality: Record<string, 'good' | 'bad' | 'uncertain'>;
}

/**
 * SP-PLC-3 P2.1 (2026-05-26): per-tag deadband 解析函数.
 *
 * 由调用方注入 (避免 tag-cache 直接 import plc-driver / sqlite-service 造成
 * 循环依赖). 返 undefined 表示该 tag 无 per-tag 配置, 回退到全局 deadband.
 *
 * 实施 P2.2 时 caller 从 plc_variable_mappings.deadband_abs/_pct 字段读.
 */
export type DeadbandResolver = (
  reactorId: string,
  tag: string,
) => { abs: number; pct: number } | undefined;

export interface WriteOptions {
  /** 全局 deadband fallback (per-tag resolver 返 undefined 时用). 默认 0 即全推. */
  deadband?: number;
  /** SP-PLC-3 P2.1: per-tag deadband 解析. 优先级高于 opts.deadband. */
  deadbandResolver?: DeadbandResolver;
  /**
   * SP-PLC-3 P3c.1: write 完成后 (含 fanOut) 调用一次的同步 hook.
   * caller 用作 Redis publish 钩子, 把 (reactorId, snapshot, changes)
   * 异步 publish 到跨实例 channel. snapshot 是原始 input, changes 是
   * 本次 write 实际产生的变化 (deadband 抑制后).
   *
   * 行为约定:
   *   - 同步调用, write 返 changes 前最后一步触发.
   *   - 抛错被 try/catch 隔离, 不影响 write 返值, 不影响 subscribe fanOut.
   *   - 不传 → 不调用 (兼容 Phase 1-3b 旧 caller).
   */
  onWrite?: (reactorId: string, snapshot: SnapshotInput, changes: CacheChange[]) => void;
}

/**
 * SP-PLC-3 P2.1: 同值判断 (per-tag 优先, fallback 全局).
 *
 * - perTag.abs > 0 或 perTag.pct > 0 任一非零 → per-tag 模式 (OR 关系):
 *   - abs > 0 且 |Δ| > abs → 视为变化
 *   - pct > 0 且 |prev| > 0 且 |Δ|/|prev|*100 > pct → 视为变化
 *   - prev=0 时除零守卫: 仅看 abs 维度 (pct 不可用)
 * - perTag undefined 或全 0 → fallback 全局 deadband
 *
 * 边界: |Δ| == abs (或 Δ% == pct) 视为同值, 与 Phase 1 全局 deadband
 * "<= deadband 视为同值" 语义一致.
 */
function isChange(
  prev: number,
  curr: number,
  perTag: { abs: number; pct: number } | undefined,
  globalDeadband: number,
): boolean {
  if (perTag && (perTag.abs > 0 || perTag.pct > 0)) {
    if (perTag.abs > 0 && Math.abs(curr - prev) > perTag.abs) return true;
    if (perTag.pct > 0 && Math.abs(prev) > 0) {
      if ((Math.abs(curr - prev) / Math.abs(prev)) * 100 > perTag.pct) return true;
    }
    return false;
  }
  return Math.abs(curr - prev) > globalDeadband;
}

/**
 * 内存型 tag 缓存. 单例实例由 server 启动期持有, 全 reactor 共享.
 * 详细行为见模块顶部 JSDoc.
 */
export class TagCache {
  private readonly store: Map<string, Map<string, CacheEntry>> = new Map();
  private readonly subs: Map<string, CacheSubscription> = new Map();

  /**
   * 写入 snapshot. 内部按 tag 逐一比较 deadband 与 quality, 仅 value 真变化的
   * tag 才更新 lastChanged 并加入返回的 CacheChange 列表.
   *
   * 行为细节:
   *   - quality='bad' + 现存 entry.quality 在 ('good' | 'uncertain'): value 保留
   *     现存值 (last-known-good), 只更新 ts / quality / prevValue; 不算 change.
   *   - 同值 (|new - prev| <= deadband) 且 quality 非 bad: 更新 prevValue/ts,
   *     不更新 lastChanged, 不算 change.
   *   - 值真变化: 更新所有字段含 lastChanged, 算 change.
   *
   * 写入完成后, 同步遍历 subscriptions, 把匹配的 changes 分发给 callback;
   * callback 抛错被 try/catch 隔离, 不影响其它订阅者, 也不抛回调用方.
   *
   * @returns 本次真正变化的 tags. 调用方 (broadcaster) 据此 fan-out.
   */
  write(reactorId: string, snapshot: SnapshotInput, opts?: WriteOptions): CacheChange[] {
    const deadband = opts?.deadband ?? 0;
    const resolver = opts?.deadbandResolver;
    let reactorMap = this.store.get(reactorId);
    if (!reactorMap) {
      reactorMap = new Map();
      this.store.set(reactorId, reactorMap);
    }

    const changes: CacheChange[] = [];

    for (const tag of Object.keys(snapshot.values)) {
      const newValue = snapshot.values[tag];
      const newQuality = snapshot.quality[tag] ?? 'good';
      const existing = reactorMap.get(tag);

      if (!existing) {
        // 首次写入: lastChanged = ts; prevValue = newValue (无历史).
        // 即便 quality='bad' 也接受 newValue (无 last-known-good 可保留).
        const entry: CacheEntry = {
          value: newValue,
          ts: snapshot.timestamp,
          quality: newQuality,
          lastChanged: snapshot.timestamp,
          prevValue: newValue,
        };
        reactorMap.set(tag, entry);
        changes.push({ reactorId, tag, entry: { ...entry } });
        continue;
      }

      // quality='bad' 时保留 last-known-good value, 仅更新 ts/quality/prevValue.
      // 不算 change (value 未变), lastChanged 不动.
      if (newQuality === 'bad' && existing.quality !== 'bad') {
        const entry: CacheEntry = {
          value: existing.value,
          ts: snapshot.timestamp,
          quality: 'bad',
          lastChanged: existing.lastChanged,
          prevValue: existing.value,
        };
        reactorMap.set(tag, entry);
        continue;
      }

      // SP-PLC-3 P2.1: per-tag deadband 优先, fallback opts.deadband (Phase 1).
      const perTag = resolver?.(reactorId, tag);
      const sameValue = !isChange(existing.value, newValue, perTag, deadband);

      if (sameValue) {
        // 同值: ts/prevValue 更新便于 deadband 链路, lastChanged 不动, 不 fan-out.
        const entry: CacheEntry = {
          value: existing.value,
          ts: snapshot.timestamp,
          quality: newQuality,
          lastChanged: existing.lastChanged,
          prevValue: existing.value,
        };
        reactorMap.set(tag, entry);
        continue;
      }

      // 值真变化: 全字段更新, 算 change.
      const entry: CacheEntry = {
        value: newValue,
        ts: snapshot.timestamp,
        quality: newQuality,
        lastChanged: snapshot.timestamp,
        prevValue: existing.value,
      };
      reactorMap.set(tag, entry);
      changes.push({ reactorId, tag, entry: { ...entry } });
    }

    if (changes.length > 0) {
      this.fanOut(changes);
    }

    // SP-PLC-3 P3c.1: 同步 onWrite hook (Redis publish 入口).
    // 抛错被隔离: 一个失败的 publish 不影响 write 返值, 也不影响下游
    // subscribe 回调 (fanOut 已先于 hook 完成).
    if (opts?.onWrite) {
      try {
        opts.onWrite(reactorId, snapshot, changes);
      } catch (err) {
        console.error('[tag-cache] onWrite hook error:', err);
      }
    }

    return changes;
  }

  /** 读取单 tag. 返 undefined 表示不存在. 返回浅拷贝, 修改不影响缓存. */
  read(reactorId: string, tag: string): CacheEntry | undefined {
    const entry = this.store.get(reactorId)?.get(tag);
    return entry ? { ...entry } : undefined;
  }

  /**
   * 批量读取. 仅返回存在的 tag (缺失 tag 不出现在结果 key 中, 不放 undefined).
   * 每个 value 是浅拷贝.
   */
  readMany(reactorId: string, tags: string[]): Record<string, CacheEntry> {
    const reactorMap = this.store.get(reactorId);
    const out: Record<string, CacheEntry> = {};
    if (!reactorMap) return out;
    for (const tag of tags) {
      const entry = reactorMap.get(tag);
      if (entry) out[tag] = { ...entry };
    }
    return out;
  }

  /** 读取该 reactor 全部 tag (浅拷贝 entry). reactor 不存在返空对象. */
  readAll(reactorId: string): Record<string, CacheEntry> {
    const reactorMap = this.store.get(reactorId);
    const out: Record<string, CacheEntry> = {};
    if (!reactorMap) return out;
    for (const [tag, entry] of reactorMap) {
      out[tag] = { ...entry };
    }
    return out;
  }

  /**
   * 注册订阅. 返回 subscription id 供 unsubscribe 使用.
   * callback 在 write 内部同步触发, 收到本次 write 产生的、匹配 reactor+tag
   * 过滤条件的 changes 数组.
   */
  subscribe(sub: Omit<CacheSubscription, 'id'>): string {
    const id = randomUUID();
    this.subs.set(id, { id, ...sub });
    return id;
  }

  /** 取消订阅. 返 true 表示存在并已删除, false 表示 id 未知. */
  unsubscribe(id: string): boolean {
    return this.subs.delete(id);
  }

  /**
   * 主动把指定 reactor 的某些 (或全部) tag 标 quality='bad', value 保留.
   * 用于 PollingScheduler emit 'error' 时上游通知 cache 通讯故障.
   *
   * - 未传 tags 或传 undefined: 标该 reactor 全部 tag.
   * - 传空数组 []: 不动 (语义上 = 标 0 个 tag).
   * - 指定 tag 不存在: silently skip (不创建空 entry).
   *
   * 不触发 fan-out (订阅者按需用 read 自查 quality).
   */
  markStale(reactorId: string, tags?: string[]): void {
    const reactorMap = this.store.get(reactorId);
    if (!reactorMap) return;
    const targets = tags === undefined ? Array.from(reactorMap.keys()) : tags;
    for (const tag of targets) {
      const existing = reactorMap.get(tag);
      if (!existing) continue;
      reactorMap.set(tag, { ...existing, quality: 'bad' });
    }
  }

  /**
   * 调试/测试用. reactorId 缺省返全 reactor entry 总数; 指定则返该 reactor
   * 的 tag 数 (reactor 不存在返 0).
   */
  size(reactorId?: string): number {
    if (reactorId !== undefined) {
      return this.store.get(reactorId)?.size ?? 0;
    }
    let total = 0;
    for (const m of this.store.values()) total += m.size;
    return total;
  }

  /** reactorId 缺省清全部; 指定则只清该 reactor. 订阅不变. */
  clear(reactorId?: string): void {
    if (reactorId === undefined) {
      this.store.clear();
      return;
    }
    this.store.delete(reactorId);
  }

  /**
   * 内部 fan-out. 遍历所有订阅, 按 reactor+tag 过滤后调 callback.
   * 每个 callback 用 try/catch 隔离, 失败仅 console.error, 不阻塞其它订阅者
   * 也不抛回 write 调用方.
   */
  private fanOut(changes: CacheChange[]): void {
    for (const sub of this.subs.values()) {
      const matched: CacheChange[] = [];
      for (const change of changes) {
        if (sub.reactorId !== '*' && sub.reactorId !== change.reactorId) continue;
        if (sub.tags !== '*' && !sub.tags.has(change.tag)) continue;
        matched.push(change);
      }
      if (matched.length === 0) continue;
      try {
        sub.callback(matched);
      } catch (err) {
        console.error(`[tag-cache] subscription ${sub.id} callback threw:`, err);
      }
    }
  }
}
