# SCADA Tag Subscription Hooks

为 SCADA widget (子项目 3+) 提供 React hook, 把 BIOCore 实时 PLC tag 流投影成 widget 可消费的当下值/历史。

## API

### useTag

```tsx
const { value, isStale, ageMs, quality } = useTag('F01.AI-0');
const { value } = useTag('F01.AI-0', { staleMs: 10_000 });
```

返 `TagSnapshot`:
- `value: number | null` — 当下值, null 表 tag 不存在 / reactor 未连 / 从未收到 pv
- `isStale: boolean` — true 当 age > staleMs (默认 5000) 或 value=null 或 WS 断
- `ageMs: number` — 距 processValues.timestamp 毫秒数, Infinity 当无值
- `quality?: 'good' | 'bad' | 'uncertain'` — SP-PLC-3 P3+ cache 三态. `undefined`
  表示 quality 信息缺失 (legacy server, 或 field 不在 FIELD_TO_QUALITY_TAG 映射表里).
  通讯断时 cache 会保 last-known-good value 但 quality 翻 'bad', widget 应用此字段
  做视觉提示 (灰色/划线/红框) 而非把 bad 值当 good 显示.

**Quality 映射 (Patch A 范围)**: `AI-0→TEMP_PV`, `AI-2→PH_PV`, `AI-3→DO_PV`,
`AI-4→PRESSURE_PV`, `rpm→VFD_ACTUAL_FREQ`. 其它字段 quality undefined.

### useTagHistory

```tsx
const { points, isStale } = useTagHistory('F01.AI-0', { windowSec: 300 });
const { points, isStale } = useTagHistory('F01.AI-0', { windowSec: 300, staleMs: 70_000 });
```

返 `TagHistory`:
- `points: Array<{ t: number; v: number }>` — 升序 by t (ms epoch), 仅返时间窗口内
- `isStale: boolean` — true 当 `!wsConnected` 或 `ageMs > staleMs` (默认 5000ms), ageMs 取自 `processValues.timestamp`

Options:
- `windowSec?: number` — 历史时间窗口, 默认 60s
- `staleMs?: number` — 数据年龄阈值, 默认 5000ms; 超出则 isStale=true

**SP-PLC-3 Patch B (2026-05-26)**: `realtime-store.trendBuffer` 内部从裸数组改成
`RingBuffer` 实例 (write 端 O(1) push, 不再触发 5×3600 spread+slice). `useTagHistory`
内部自动调 `toArray()` 物化, 返值 shape (`{ points, isStale }`) 不变, 调用者零改动.

## 生产 staleMs 设置

`DEFAULT_STALE_MS = 5000`. **SP-PLC-3 P3 (2026-05-25)** 之后 broadcaster 改 5Hz
dirty-only fan-out (旧 reactor-wiring.ts 60s tick 已废), 默认值在生产环境合理 —
约 5 个 tick + 4s 缓冲, widget 不传 staleMs 即可。

**旧建议 `{ staleMs: 70_000 }` 已过时**, 不要再传 70s, 否则通讯断后 widget 还会
继续显示 stale=false 12 个 tick.

```tsx
// 推荐 — 用默认 staleMs
const { value, isStale, quality } = useTag('F01.AI-0');
const { points, isStale: histStale } = useTagHistory('F01.AI-0', { windowSec: 300 });
```

### Widget 按 quality 渲染示例

```tsx
const { value, isStale, quality } = useTag('F01.AI-0');

// quality 三态视觉提示 (cache 保 last-known-good 时 quality='bad')
const cls = quality === 'bad'
  ? 'opacity-40 line-through text-red-500'      // 通讯故障
  : quality === 'uncertain'
    ? 'opacity-70 text-amber-500'                // 不确定
    : isStale
      ? 'opacity-50'                              // 数据陈旧
      : '';                                       // 正常

return <span className={cls}>{value?.toFixed(1) ?? '—'}</span>;
```

## Tag Namespace

格式: `<reactor_id>.<field>`.

### 支持的 useTag field

| 类别 | Field | 含义 |
|---|---|---|
| 模拟输入 | `AI-0` | 罐温 °C |
| 模拟输入 | `AI-1` | 夹套温度 °C |
| 模拟输入 | `AI-2` | pH |
| 模拟输入 | `AI-3` | DO % |
| 模拟输入 | `AI-4` | 罐压 bar |
| 模拟输入 | `AI-5` | 空气流量 NL/min |
| 模拟输入 | `AI-6` | 称重 kg |
| 模拟输出 cv | `AO-0_cv` | 蒸汽阀开度 % |
| 模拟输出 cv | `AO-1_cv` | 冷却阀开度 % |
| 模拟输出 cv | `AO-2_cv` | 空气阀开度 % |
| 泵速率 | `P01_rate` | 碱泵速率 |
| 泵速率 | `P02_rate` | 补料泵速率 |
| 泵速率 | `P03_rate` | 氮源泵速率 |
| 泵速率 | `P04_rate` | 酸泵速率 |
| 标量 | `rpm` | 搅拌转速 |
| 标量 | `vfd_current` | 变频器电流 |
| 标量 | `temp_sv` | 温度设定值 °C |
| 标量 | `temp_mode` | 0=保温 1=加热 2=冷却 |

### 支持的 useTagHistory field

仅 5 个核心 tag (复用现有 store trendBuffer):
- `AI-0` (罐温)
- `AI-2` (pH)
- `AI-3` (DO)
- `AI-5` (空气流量)
- `rpm`

其它 field 用 useTagHistory 返 `{ points: [], isStale: !wsConnected }`. 不抛错, 只是无数据。

## 边界

- TagId 必须含恰好一个 `.` — 不然返 null + stale
- field 必须在白名单 — 不然返 null + stale
- reactor 从未连接 → null + stale
- WS 断 → value 冻最后, isStale=true (1Hz tick 重新评估)

## 不做

- state_update / alarm / cusum / soft_sensor 派生 tag (后续按需扩)
- transform 表达式 (留给 widget 渲染层)
- 写 PLC tag (永远走"建议缓冲区"-engine, 非 widget 责任)

## Examples

```tsx
// Tank widget — 称重 → 液位
import { useTag } from '@/hooks';
function Tank({ tag }: { tag: string }) {
  const { value, isStale } = useTag(tag);
  return <div className={isStale ? 'opacity-50' : ''}>{value?.toFixed(1) ?? '—'} kg</div>;
}
<Tank tag="F01.AI-6" />;
```

```tsx
// Trend chart — 5 分钟窗口
import { useTagHistory } from '@/hooks';
function TempTrend({ tag }: { tag: string }) {
  const { points } = useTagHistory(tag, { windowSec: 300 });
  return <Line data={points} />;
}
<TempTrend tag="F01.AI-0" />;
```
