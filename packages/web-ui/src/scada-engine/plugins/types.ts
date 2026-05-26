// SP-FX-45: BiocorePlugin contract — Plugin SDK foundation
import type { GaugeMeta } from '../gauges/gauge-base';
import type { WidgetPropertySchema } from '../editor/properties/property-schema';

/**
 * BIOCore Plugin 接口规范.
 *
 * Plugin 作者实现此 interface 并通过 registerPlugin() 注入系统.
 * 禁止在 plugin 内部直接操作 PLC (plc-driver / writeTag 等).
 */
export interface BiocorePlugin {
  /** 全局唯一插件 ID，推荐 reverse-domain 格式: "com.example.my-widget" */
  id: string;
  /** 人类可读插件名称 */
  name: string;
  /** semver 版本号，如 "1.0.0" */
  version: string;
  /** 注入 gaugeRegistry 的 widget 元数据列表 */
  widgets: GaugeMeta[];
  /**
   * 可选: 注入 WIDGET_SCHEMAS 的属性 schema.
   * 数组顺序与 widgets 对应（第 i 个 schema 对应第 i 个 widget 类型）.
   */
  propertySchemas?: WidgetPropertySchema[];
  /**
   * 可选: plugin 自带 i18n 字典.
   * ✅ SP-FX-46: 注册时自动调用 i18n.addDictionary() 合并到全局字典.
   * 推荐 key 前缀 `plugin.<pluginId>.<key>`, 避免误覆盖系统 key.
   * 冲突时 console.warn 报告, 后注册覆盖先注册.
   */
  dictionaries?: {
    zh?: Record<string, string>;
    en?: Record<string, string>;
  };
  /** plugin 加载后回调 */
  onLoad?(): void;
  /** plugin 卸载前回调 */
  onUnload?(): void;
}
