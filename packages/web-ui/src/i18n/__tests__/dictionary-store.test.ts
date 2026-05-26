// SP-FX-46: addDictionary API 测试
// 注意: DICTS 是 module-scoped state, 必须用 vi.resetModules() 隔离每个 case.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

// Mock next/navigation (LocaleProvider 依赖)
vi.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: (_k: string) => null }),
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/',
}));

describe('i18n.addDictionary (SP-FX-46)', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it('1. addDictionary 后 useLocale.t 能查到新 key', async () => {
    const { addDictionary, useLocale, LocaleProvider } = await import('../useLocale');
    addDictionary('zh', { 'plugin.test.foo': '插件测试 Foo' }, { source: 'plugin:com.test' });
    const { result } = renderHook(() => useLocale(), { wrapper: LocaleProvider });
    expect(result.current.t('plugin.test.foo')).toBe('插件测试 Foo');
  });

  it('2. en locale 独立注入, 不影响 zh', async () => {
    const { addDictionary, useLocale, LocaleProvider } = await import('../useLocale');
    addDictionary('en', { 'plugin.test.bar': 'Bar EN' }, { source: 'plugin:com.test' });
    const { result } = renderHook(() => useLocale(), { wrapper: LocaleProvider });
    // zh 未注入该 key → fallback 自身
    expect(result.current.t('plugin.test.bar')).toBe('plugin.test.bar');
  });

  it('3. 重复 addDictionary 同 key 后注册覆盖先注册', async () => {
    const { addDictionary, useLocale, LocaleProvider } = await import('../useLocale');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    addDictionary('zh', { 'plugin.test.dup': 'First' }, { source: 'plugin:com.a' });
    addDictionary('zh', { 'plugin.test.dup': 'Second' }, { source: 'plugin:com.b' });
    const { result } = renderHook(() => useLocale(), { wrapper: LocaleProvider });
    expect(result.current.t('plugin.test.dup')).toBe('Second');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('4. 冲突时 console.warn 含 locale + key + source', async () => {
    const { addDictionary } = await import('../useLocale');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    addDictionary('zh', { 'plugin.test.warn': 'A' }, { source: 'plugin:com.x' });
    addDictionary('zh', { 'plugin.test.warn': 'B' }, { source: 'plugin:com.y' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0][0] as string;
    expect(msg).toContain('[i18n.addDictionary]');
    expect(msg).toContain('locale="zh"');
    expect(msg).toContain('key="plugin.test.warn"');
    expect(msg).toContain('source="plugin:com.y"');
    warnSpy.mockRestore();
  });

  it('5. 第一次注入无冲突, 第二次同 key 才 warn', async () => {
    const { addDictionary, useLocale, LocaleProvider } = await import('../useLocale');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    addDictionary('zh', { 'plugin.test.sys': 'Plugin-Set' }, { source: 'plugin:com.a' });
    expect(warnSpy).not.toHaveBeenCalled();
    addDictionary('zh', { 'plugin.test.sys': 'Plugin-Override' }, { source: 'plugin:com.b' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const { result } = renderHook(() => useLocale(), { wrapper: LocaleProvider });
    expect(result.current.t('plugin.test.sys')).toBe('Plugin-Override');
    warnSpy.mockRestore();
  });

  it('6. source 缺省时 warn 显示 "unknown"', async () => {
    const { addDictionary } = await import('../useLocale');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    addDictionary('zh', { 'plugin.test.nosrc': 'A' });
    addDictionary('zh', { 'plugin.test.nosrc': 'B' });
    const msg = warnSpy.mock.calls[0][0] as string;
    expect(msg).toContain('source="unknown"');
    warnSpy.mockRestore();
  });

  it('7. addDictionary 不影响其他 key 的 fallback 行为', async () => {
    const { addDictionary, useLocale, LocaleProvider } = await import('../useLocale');
    addDictionary('zh', { 'plugin.test.extra': 'X' }, { source: 'plugin:com.test' });
    const { result } = renderHook(() => useLocale(), { wrapper: LocaleProvider });
    expect(result.current.t('nonexistent.completely.foo')).toBe('nonexistent.completely.foo');
  });
});
