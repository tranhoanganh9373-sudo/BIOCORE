// SP-FX-45: Plugin loader 测试 (TDD RED-first)
// SP-FX-46: 追加 i18n.addDictionary 集成测试
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { BiocorePlugin } from '../types';

// next/navigation mock (SP-FX-46 集成测试中 useLocale → LocaleProvider 依赖)
vi.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: (_k: string) => null }),
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/',
}));

// 构造测试用 plugin
function makePlugin(overrides: Partial<BiocorePlugin> = {}): BiocorePlugin {
  return {
    id: 'com.test.widget',
    name: 'Test Widget',
    version: '1.0.0',
    widgets: [],
    ...overrides,
  };
}

describe('Plugin Loader', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('1. registerPlugin 后 listPlugins 包含该 plugin', async () => {
    const { registerPlugin, listPlugins } = await import('../loader');
    const plugin = makePlugin();
    registerPlugin(plugin);
    const list = listPlugins();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('com.test.widget');
  });

  it('2. unregisterPlugin 后 listPlugins 不再包含该 plugin', async () => {
    const { registerPlugin, unregisterPlugin, listPlugins } = await import('../loader');
    const plugin = makePlugin();
    registerPlugin(plugin);
    unregisterPlugin('com.test.widget');
    expect(listPlugins()).toHaveLength(0);
  });

  it('3. 重复 registerPlugin 同一 id 抛出错误', async () => {
    const { registerPlugin } = await import('../loader');
    const plugin = makePlugin();
    registerPlugin(plugin);
    expect(() => registerPlugin(plugin)).toThrow(/already registered/i);
  });

  it('4. id 含禁止词 plc-driver 时 registerPlugin 抛出安全错误', async () => {
    const { registerPlugin } = await import('../loader');
    const bad = makePlugin({ id: 'com.bad.plc-driver.widget' });
    expect(() => registerPlugin(bad)).toThrow(/forbidden/i);
  });

  it('5. widgetType 含禁止词 writeTag 时 registerPlugin 抛出安全错误', async () => {
    const { registerPlugin } = await import('../loader');
    const bad = makePlugin({
      id: 'com.bad.widget',
      widgets: [{
        widgetType: 'writeTag-custom',
        create: () => ({
          onMount: vi.fn(),
          onUnmount: vi.fn(),
          onProcess: vi.fn(),
          onPropertyChange: vi.fn(),
          onResize: vi.fn(),
        }),
        getSignals: () => [],
      }],
    });
    expect(() => registerPlugin(bad)).toThrow(/forbidden/i);
  });

  it('6. unregisterPlugin 不存在 id 时静默返回（不抛出）', async () => {
    const { unregisterPlugin } = await import('../loader');
    expect(() => unregisterPlugin('non.existent.id')).not.toThrow();
  });

  it('7. plugin 加载时调用 onLoad 回调', async () => {
    const { registerPlugin } = await import('../loader');
    const onLoad = vi.fn();
    const plugin = makePlugin({ onLoad });
    registerPlugin(plugin);
    expect(onLoad).toHaveBeenCalledOnce();
  });

  it('8. unregisterPlugin 时调用 onUnload 回调', async () => {
    const { registerPlugin, unregisterPlugin } = await import('../loader');
    const onUnload = vi.fn();
    const plugin = makePlugin({ onUnload });
    registerPlugin(plugin);
    unregisterPlugin('com.test.widget');
    expect(onUnload).toHaveBeenCalledOnce();
  });

  // ── SP-FX-46: dictionaries 集成 ─────────────────────────────────────────
  it('9. plugin 带 dictionaries.zh 注册后 useLocale.t 能读到', async () => {
    const { registerPlugin } = await import('../loader');
    const { useLocale, LocaleProvider } = await import('../../../i18n/useLocale');
    const plugin = makePlugin({
      id: 'com.test.dict.zh',
      dictionaries: { zh: { 'plugin.test.foo': '插件 Foo 中文' } },
    });
    registerPlugin(plugin);
    const { result } = renderHook(() => useLocale(), { wrapper: LocaleProvider });
    expect(result.current.t('plugin.test.foo')).toBe('插件 Foo 中文');
  });

  it('10. plugin 带 dictionaries.en 注册并切到 en 后能读到', async () => {
    localStorage.setItem('biocore.locale', 'en');
    const { registerPlugin } = await import('../loader');
    const { useLocale, LocaleProvider } = await import('../../../i18n/useLocale');
    const plugin = makePlugin({
      id: 'com.test.dict.en',
      dictionaries: { en: { 'plugin.test.bar': 'Plugin Bar EN' } },
    });
    registerPlugin(plugin);
    const { result } = renderHook(() => useLocale(), { wrapper: LocaleProvider });
    expect(result.current.locale).toBe('en');
    expect(result.current.t('plugin.test.bar')).toBe('Plugin Bar EN');
  });

  it('11. plugin 无 dictionaries 字段时 registerPlugin 仍正常 (向后兼容)', async () => {
    const { registerPlugin, listPlugins } = await import('../loader');
    const plugin = makePlugin({ id: 'com.test.no.dict' });
    expect(() => registerPlugin(plugin)).not.toThrow();
    expect(listPlugins().some((p) => p.id === 'com.test.no.dict')).toBe(true);
  });

  it('12. plugin dictionaries 冲突时 console.warn 含 plugin:<id> source', async () => {
    const { registerPlugin } = await import('../loader');
    const { addDictionary } = await import('../../../i18n/useLocale');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 先种一个 key
    addDictionary('zh', { 'plugin.test.conflict': 'pre' }, { source: 'pre' });
    // plugin 注册同 key
    registerPlugin(makePlugin({
      id: 'com.test.conflict',
      dictionaries: { zh: { 'plugin.test.conflict': 'plugin-value' } },
    }));
    expect(warnSpy).toHaveBeenCalled();
    const msg = warnSpy.mock.calls[warnSpy.mock.calls.length - 1][0] as string;
    expect(msg).toContain('source="plugin:com.test.conflict"');
    warnSpy.mockRestore();
  });
});
