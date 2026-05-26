'use client';

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type Locale, DEFAULT_LOCALE, LOCALE_STORAGE_KEY, isValidLocale } from './locale';
import dictZh from './dict-zh.json';
import dictEn from './dict-en.json';

// ── 字典 ──────────────────────────────────────────────────────────────────
// 注意: 字典对象引用稳定 (module-scoped), 但内容可通过 addDictionary 扩展.
// 改成 spread copy 而非直接持有 JSON import 引用, 让 mutation 不会污染 JSON modules.
const DICTS: Record<Locale, Record<string, string>> = {
  zh: { ...(dictZh as Record<string, string>) },
  en: { ...(dictEn as Record<string, string>) },
};

/**
 * SP-FX-46: 向全局字典追加 plugin / 外部模块提供的翻译.
 *
 * 设计要点:
 *  - module-scoped mutation: 直接合并到 DICTS[locale], 引用稳定.
 *  - 冲突策略: 后注册覆盖先注册, 与系统 key 冲突时也覆盖, 并 console.warn 报告冲突 key + source.
 *  - 推荐 key 前缀约定: `plugin.<pluginId>.<key>`, 避免误覆盖系统 key (doc-only, 不强制).
 *  - 调用时机: plugin 加载阶段一次性注入. 已挂载组件因 `t` 被 useCallback 缓存 (deps=[locale])
 *    不会自动 re-render, 但下一次 locale 切换 / re-mount / 普通 re-render 即可读到新 key.
 *  - SSR: 字典内容服务端与客户端一致 (plugin 注册流程同步执行), 不会引入 hydration mismatch;
 *    若 plugin 仅在客户端注册, 服务端渲染期间 key fallback 到自身, 客户端 hydrate 时若值不同可能 warn —
 *    建议 plugin 在 server + client 共享的入口注册.
 *
 * @param locale  目标 locale ('zh' | 'en')
 * @param dict    要合并的 key→translation 字典
 * @param opts.source  冲突日志中标识来源 (默认 'unknown', plugin loader 调用时传 `plugin:${pluginId}`)
 */
export function addDictionary(
  locale: Locale,
  dict: Record<string, string>,
  opts?: { source?: string },
): void {
  const source = opts?.source ?? 'unknown';
  const target = DICTS[locale];
  for (const key of Object.keys(dict)) {
    if (Object.prototype.hasOwnProperty.call(target, key)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[i18n.addDictionary] key conflict locale="${locale}" key="${key}" ` +
        `source="${source}" — overriding previous value`,
      );
    }
    target[key] = dict[key];
  }
}

// ── 工具函数 ───────────────────────────────────────────────────────────────
function interpolate(str: string, params?: Record<string, string>): string {
  if (!params) return str;
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) => params[k] ?? `{{${k}}}`);
}

function readStored(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  const v = localStorage.getItem(LOCALE_STORAGE_KEY);
  return isValidLocale(v) ? v : DEFAULT_LOCALE;
}

// ── Context ───────────────────────────────────────────────────────────────
interface LocaleContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string, params?: Record<string, string>) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

// ── Provider ──────────────────────────────────────────────────────────────
export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // 初次挂载: URL ?lang= > localStorage > 默认 zh
  useEffect(() => {
    const urlLang = searchParams.get('lang');
    if (isValidLocale(urlLang)) {
      setLocaleState(urlLang);
      try { localStorage.setItem(LOCALE_STORAGE_KEY, urlLang); } catch { /* private mode */ }
    } else {
      setLocaleState(readStored());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try { localStorage.setItem(LOCALE_STORAGE_KEY, l); } catch { /* private mode */ }
    // URL 双向同步
    const params = new URLSearchParams(searchParams.toString());
    if (l === DEFAULT_LOCALE) {
      params.delete('lang');
    } else {
      params.set('lang', l);
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  }, [router, pathname, searchParams]);

  const t = useCallback((key: string, params?: Record<string, string>): string => {
    const dict = DICTS[locale];
    const raw = dict[key] ?? key;
    return interpolate(raw, params);
  }, [locale]);

  const value: LocaleContextValue = { locale, setLocale, t };
  return React.createElement(LocaleContext.Provider, { value }, children);
}

// ── Hook ──────────────────────────────────────────────────────────────────
export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) {
    // 在 Provider 外使用时返回 zh 默认值 (graceful degradation)
    const t = (key: string, params?: Record<string, string>) => {
      const raw = DICTS['zh'][key] ?? key;
      return interpolate(raw, params);
    };
    return { locale: 'zh', setLocale: () => {}, t };
  }
  return ctx;
}

export type { Locale, LocaleContextValue };
