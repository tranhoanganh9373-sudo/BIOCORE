// SP-FX-45: Plugin loader — 注册/注销/列举 BIOCore plugins
import type { BiocorePlugin } from './types';
import { gaugeRegistry } from '../gauges/gauge-registry';
import { WIDGET_SCHEMAS } from '../editor/properties/widget-schemas';
import { addDictionary } from '../../i18n/useLocale';

/**
 * 禁止 plugin 使用的词汇（防止绕过 PLC 安全约束）.
 * plugin id 或 widgetType 中含任意一词即拒绝注册.
 */
const FORBIDDEN_TERMS = [
  'plc-driver',
  'writeTag',
  'modbus-serial',
  'node-snap7',
];

function assertNoForbiddenTerms(text: string): void {
  for (const term of FORBIDDEN_TERMS) {
    if (text.includes(term)) {
      throw new Error(
        `[PluginLoader] forbidden term "${term}" detected in "${text}". ` +
        'Plugin must not interact with PLC drivers directly.',
      );
    }
  }
}

/** 内存 plugin 注册表 */
const pluginStore = new Map<string, BiocorePlugin>();

/**
 * 注册 plugin 到 BIOCore 系统.
 *
 * 流程:
 * 1. 安全检查 (id + widgetType 不含禁止词)
 * 2. 重复注册检查
 * 3. 注入 widgets → gaugeRegistry
 * 4. 注入 propertySchemas → WIDGET_SCHEMAS
 * 5. ✅ SP-FX-46: 注入 dictionaries → i18n.addDictionary
 * 6. 调用 onLoad()
 * 7. 存入 pluginStore
 */
export function registerPlugin(plugin: BiocorePlugin): void {
  // 安全检查
  assertNoForbiddenTerms(plugin.id);
  for (const w of plugin.widgets) {
    assertNoForbiddenTerms(w.widgetType);
  }

  // 重复注册检查
  if (pluginStore.has(plugin.id)) {
    throw new Error(
      `[PluginLoader] plugin "${plugin.id}" is already registered. ` +
      'Call unregisterPlugin() first to replace it.',
    );
  }

  // 注入 widgets
  for (const meta of plugin.widgets) {
    gaugeRegistry.register(meta, { replace: false });
  }

  // 注入 propertySchemas（按位置与 widgets 对应）
  if (plugin.propertySchemas) {
    plugin.propertySchemas.forEach((schema, i) => {
      const widgetType = plugin.widgets[i]?.widgetType;
      if (widgetType) {
        WIDGET_SCHEMAS[widgetType] = schema;
      }
    });
  }

  // ✅ SP-FX-46: 注入 plugin 字典到全局 i18n
  const dictSource = `plugin:${plugin.id}`;
  if (plugin.dictionaries?.zh) {
    addDictionary('zh', plugin.dictionaries.zh, { source: dictSource });
  }
  if (plugin.dictionaries?.en) {
    addDictionary('en', plugin.dictionaries.en, { source: dictSource });
  }

  // 生命周期回调
  plugin.onLoad?.();

  // 存入注册表
  pluginStore.set(plugin.id, plugin);
}

/**
 * 注销 plugin.
 *
 * 注意: gaugeRegistry 无 unregister API，widget 仍留在 registry.
 * 此调用仅从 pluginStore 移除，并调用 onUnload().
 * 不存在的 id 静默返回.
 */
export function unregisterPlugin(id: string): void {
  const plugin = pluginStore.get(id);
  if (!plugin) return;

  plugin.onUnload?.();
  pluginStore.delete(id);
}

/**
 * 列出已加载的所有 plugin（只读视图）.
 */
export function listPlugins(): ReadonlyArray<BiocorePlugin> {
  return Array.from(pluginStore.values());
}
