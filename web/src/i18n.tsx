import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { I18nProvider } from "@heroui/react";
import { zhCN } from "./locales/zh-CN";
import type { MessageKey, MessageValue } from "./locales/zh-CN";
import { enUS } from "./locales/en-US";
import { ruRU } from "./locales/ru-RU";
import { labelKeys } from "./locales/labels";

export type Locale = "zh-CN" | "en-US" | "ru-RU";
export const localeStorageKey = "accp.locale";
type Parameters = Record<string, string | number>;
const catalogs: Record<Locale, Record<MessageKey, MessageValue>> = {
  "zh-CN": zhCN,
  "en-US": enUS,
  "ru-RU": ruRU,
};

function isLocale(value: unknown): value is Locale {
  return value === "zh-CN" || value === "en-US" || value === "ru-RU";
}

// Prefer a saved explicit choice, then the first supported browser language.
// Unsupported languages fall back to the source language (Simplified Chinese).
function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(localeStorageKey);
    if (isLocale(saved)) return saved;
  } catch {
    // Browsers may block storage; language switching still works in memory.
  }
  for (const language of navigator.languages?.length
    ? navigator.languages
    : [navigator.language]) {
    if (/^zh(?:-|$)/i.test(language)) return "zh-CN";
    if (/^en(?:-|$)/i.test(language)) return "en-US";
    if (/^ru(?:-|$)/i.test(language)) return "ru-RU";
  }
  return "zh-CN";
}

export function createTranslator(locale: Locale) {
  const numbers = new Intl.NumberFormat(locale);
  const plurals = new Intl.PluralRules(locale);
  const dateTime = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const clock = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  function translate(key: MessageKey, parameters: Parameters = {}): string {
    const message = catalogs[locale][key] ?? zhCN[key];
    const template =
      typeof message === "string"
        ? message
        : (message[plurals.select(Number(parameters.count))] ?? message.other);
    return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
      const value = parameters[name];
      return value === undefined
        ? placeholder
        : typeof value === "number"
          ? numbers.format(value)
          : value;
    });
  }
  function formatDate(
    value: string | undefined,
    formatter: Intl.DateTimeFormat,
  ) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : formatter.format(date);
  }
  return {
    translate,
    label: (value: string) =>
      Object.hasOwn(labelKeys, value) ? translate(labelKeys[value]) : value,
    number: (value: number) => numbers.format(value),
    stamp: (value?: string) => formatDate(value, dateTime),
    time: (value?: string) => formatDate(value, clock),
  };
}

type LocaleContextValue = ReturnType<typeof createTranslator> & {
  locale: Locale;
  setLocale: (locale: Locale) => void;
};
const LocaleContext = createContext<LocaleContextValue | undefined>(undefined);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, updateLocale] = useState<Locale>(initialLocale);
  const value = useMemo(
    () => ({
      ...createTranslator(locale),
      locale,
      setLocale(next: Locale) {
        if (!isLocale(next)) return;
        updateLocale(next);
        try {
          localStorage.setItem(localeStorageKey, next);
        } catch {
          // A blocked or full storage area must not prevent using the console.
        }
      },
    }),
    [locale],
  );
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = "ltr";
    document.title = value.translate("ACCP · 协作控制台");
  }, [locale, value]);
  return (
    <LocaleContext.Provider value={value}>
      <I18nProvider locale={locale}>{children}</I18nProvider>
    </LocaleContext.Provider>
  );
}

export function useI18n() {
  const value = useContext(LocaleContext);
  if (!value) throw new Error("useI18n requires LocaleProvider");
  return value;
}

export function LanguageSwitcher() {
  const { locale, setLocale, translate } = useI18n();
  return (
    <select
      aria-label={translate("语言")}
      value={locale}
      onChange={(event) => {
        if (isLocale(event.target.value)) setLocale(event.target.value);
      }}
      className="h-9 w-28 shrink-0 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-700 outline-offset-2 focus-visible:outline-2 focus-visible:outline-indigo-600"
    >
      <option value="zh-CN" lang="zh-CN">
        简体中文
      </option>
      <option value="en-US" lang="en-US">
        English
      </option>
      <option value="ru-RU" lang="ru-RU">
        Русский
      </option>
    </select>
  );
}

// Store a message ID, so an existing error also updates when locale changes.
export class LocalizedError extends Error {
  constructor(public key: MessageKey) {
    super(key);
  }
}
