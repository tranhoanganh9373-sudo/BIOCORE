# BIOCore Plugin SDK 开发者指南

**Sprint**: SP-FX-45 + SP-FX-46 (i18n 集成)  
**版本**: 1.1.0  
**路径**: `packages/web-ui/src/scada-engine/plugins/`

---

## 1. 概述

BIOCore Plugin SDK 允许第三方开发者在不修改核心代码的情况下扩展 SCADA Widget 库。Plugin 通过标准接口注入 widget、属性 schema 和 i18n 字典。

---

## 2. Plugin 接口规范

```typescript
interface BiocorePlugin {
  id: string;                          // 全局唯一 ID（reverse-domain 格式）
  name: string;                        // 人类可读名称
  version: string;                     // semver，如 "1.0.0"
  widgets: GaugeMeta[];                // widget 元数据列表
  propertySchemas?: WidgetPropertySchema[]; // 属性 schema（与 widgets 位置对应）
  dictionaries?: {
    zh?: Record<string, string>;
    en?: Record<string, string>;
  };
  onLoad?(): void;                     // 加载后回调
  onUnload?(): void;                   // 卸载前回调
}
```

### GaugeMeta 接口

```typescript
interface GaugeMeta {
  widgetType: string;          // 唯一 widget 类型标识，如 "com-example-my-gauge"
  create: () => GaugeBase;     // 工厂函数
  getSignals: GetSignalsFn;    // 返回 widget 订阅的 tag ID 列表
  version?: string;            // semver
}
```

### GaugeBase 接口

```typescript
interface GaugeBase {
  onMount(widget: FuxaWidget, ctx: GaugeContext): void;
  onUnmount(): void;
  onProcess(value: GaugeValue): void;
  onPropertyChange(change: GaugePropChange): void;
  onResize(w: number, h: number): void;
  onClick?(event: MouseEvent, ctx: GaugeClickContext): void;
}
```

---

## 3. 加载流程

```
registerPlugin(plugin)
  1. 安全检查: id/widgetType 不含 plc-driver/writeTag/modbus-serial/node-snap7
  2. 重复检查: 同 id 已注册则 throw
  3. gaugeRegistry.register(meta) × len(widgets)
  4. WIDGET_SCHEMAS[widgetType] = schema × len(propertySchemas)
  5. ✅ SP-FX-46: addDictionary('zh'|'en', dict, { source: `plugin:${id}` })
  6. plugin.onLoad?.()
  7. pluginStore.set(id, plugin)
```

**注意**: `unregisterPlugin` 仅从 pluginStore 移除，widget/字典仍留在 gaugeRegistry/i18n DICTS（已知限制，待后续 sprint 修复 gaugeRegistry.unregister + addDictionary 配套 removal API）。

---

## 4. 示例 Plugin — ClockWidget

文件: `packages/web-ui/src/scada-engine/plugins/samples/clock-widget-plugin.ts`

```typescript
import { registerPlugin } from '@/scada-engine/plugins';
import { clockWidgetPlugin } from '@/scada-engine/plugins/samples/clock-widget-plugin';

// 手动注册（sample 不自动注册）
registerPlugin(clockWidgetPlugin);
```

**ClockWidget 特性**:
- widgetType: `sample-clock`
- 每秒更新显示当前时间
- 支持属性 `format` (如 `HH:mm:ss`)
- 不订阅任何 PLC tag，纯展示

---

## 5. 编写自定义 Plugin

### 5.1 实现 GaugeBase

```typescript
import type { GaugeBase, GaugeContext, GaugeValue, GaugePropChange } from '@/scada-engine/gauges/gauge-base';
import type { FuxaWidget } from '@/scada-engine/models/widget';

class MyGauge implements GaugeBase {
  onMount(widget: FuxaWidget, ctx: GaugeContext): void {
    // 初始化 SVG 元素
  }
  onUnmount(): void {
    // 清理定时器/事件监听
  }
  onProcess(value: GaugeValue): void {
    // 处理 tag 值更新
  }
  onPropertyChange(change: GaugePropChange): void {
    // 处理属性变更
  }
  onResize(w: number, h: number): void {
    // 响应尺寸变化
  }
}
```

### 5.2 定义 Plugin

```typescript
import type { BiocorePlugin } from '@/scada-engine/plugins';

export const myPlugin: BiocorePlugin = {
  id: 'com.example.my-plugin',    // 全局唯一
  name: 'My Custom Plugin',
  version: '1.0.0',
  widgets: [
    {
      widgetType: 'com-example-my-gauge',
      create: () => new MyGauge(),
      getSignals: (widget) => [widget.property['variableId'] as string].filter(Boolean),
    },
  ],
  dictionaries: {
    zh: { 'my-gauge.label': '自定义仪表' },
    en: { 'my-gauge.label': 'Custom Gauge' },
  },
};
```

### 5.3 注册 Plugin

```typescript
import { registerPlugin } from '@/scada-engine/plugins';
import { myPlugin } from './my-plugin';

registerPlugin(myPlugin);
```

### 5.4 i18n 字典 (SP-FX-46)

Plugin 可在 `dictionaries.zh` / `dictionaries.en` 中提供翻译，registerPlugin 时自动调用
`i18n.addDictionary(locale, dict, { source: 'plugin:<id>' })` 合并到全局字典。已挂载组件
通过 `useLocale().t(key)` 即可读取。

**Key 前缀约定** (强烈推荐, 但不强制):

```
plugin.<pluginId>.<key>          ← 推荐, 隔离 plugin 命名空间
my-gauge.label                   ← 不推荐, 易与系统 key 冲突
```

例: plugin id `com.example.clock` 的字典 key 建议形如 `plugin.com.example.clock.title`。

**冲突策略**:

| 场景 | 行为 |
|------|------|
| 与系统字典 (`dict-zh.json` / `dict-en.json`) 同 key | plugin 覆盖系统, console.warn 报告 |
| 两 plugin 同 key | 后注册 plugin 覆盖先注册, console.warn 报告 |
| 同一 plugin 多次 addDictionary 同 key | 后调用覆盖, console.warn 报告 |

**冲突日志格式**:

```
[i18n.addDictionary] key conflict locale="zh" key="<the key>" source="plugin:<id>" — overriding previous value
```

**调用时机**: registerPlugin 时一次性注入。由于 `useLocale().t` 被 `useCallback` 缓存 (deps=[locale])，
已挂载组件的 `t` 引用不变；下一次 locale 切换 / 组件 re-mount / props 触发的 re-render 即可读到新 key。
建议 plugin 在用户进入相关页面前 (启动阶段) 注册，避免运行时再注册导致部分组件读不到。

**SSR 注意**: 字典内容应在 server + client 共享的入口注册以避免 hydration mismatch。若 plugin 仅
客户端注册，服务端首屏会 fallback key 自身，客户端 hydrate 时可能触发 React warn。

---

## 6. 安全约束

Plugin 遵守以下安全规则（由 loader 自动检查）：

| 规则 | 说明 |
|------|------|
| 禁止 `plc-driver` | plugin id/widgetType 中不得含此词 |
| 禁止 `writeTag` | 不得绕过 WriteIntentDialog 直接写 PLC |
| 禁止 `modbus-serial` | Modbus 驱动只能由核心层使用 |
| 禁止 `node-snap7` | S7 驱动只能由核心层使用 |

违反以上规则时 `registerPlugin` 抛出错误。

**HMI 写入**: 如需 Widget 触发写操作，必须通过 `ctx.onWriteIntent()` 走 WriteIntentDialog 确认流程。

---

## 7. Admin UI

访问 `/scada2/plugins` 可：
- 查看已加载 plugin 列表（ID / 名称 / 版本 / widget 数量）
- 加载示例 ClockWidget
- 卸载已加载 plugin

---

## 8. 后续路线 (Future Work)

### ✅ SP-FX-46: i18n 集成 (已完成)
`addDictionary(locale, dict, opts?)` API 已开放 (导出位置 `@/i18n/useLocale`)，
plugin 字典在 `registerPlugin` 时自动注入全局 `useLocale` hook。详见 § 5.4。

### addDictionary removal API
当前 `unregisterPlugin` 不会从全局字典移除该 plugin 注入的 key。需配套实现
`removeDictionary(locale, keys, opts?)` 才能完整支持 plugin 热卸载的 i18n 清理。

### 远程 Plugin / npm 安装
生产环境需要：
1. Plugin upload API（上传 plugin bundle）
2. 服务器端 plugin 存储与版本管理
3. 动态 `import()` 加载远程 bundle
4. Plugin 沙箱隔离（CSP / Web Worker）

### Plugin 卸载完整支持
需要在 `gaugeRegistry` 实现 `unregister(widgetType)` API 后，才能完整清除已注册 widget。

### Plugin Marketplace
未来可建立 npm-based plugin registry，允许 `npm install @biocore-plugin/xxx` 后通过配置文件自动加载。
