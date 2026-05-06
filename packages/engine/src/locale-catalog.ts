import type { Locale, LocaleBundle, LocaleCatalog } from './types';

export interface ResolveOptions {
  /** Called when a key is missing from every catalog. Default: no-op. */
  onMissing?: (key: string, locale: Locale) => void;
}

/**
 * Resolve a message key against a locale bundle.
 *
 * Fallback chain: requested locale → bundle.defaultLocale → the key itself.
 * Returning the key on complete miss is deliberate: translators see the
 * untranslated marker in-game and can grep the catalog for it.
 */
export function resolveKey(
  key: string,
  locale: Locale,
  bundle: LocaleBundle,
  opts: ResolveOptions = {},
): string {
  const primary = bundle.catalogs[locale];
  if (primary && Object.prototype.hasOwnProperty.call(primary, key)) return primary[key];

  if (locale !== bundle.defaultLocale) {
    const fallback = bundle.catalogs[bundle.defaultLocale];
    if (fallback && Object.prototype.hasOwnProperty.call(fallback, key)) return fallback[key];
  }

  opts.onMissing?.(key, locale);
  return key;
}

/** Produce an empty bundle, useful for tests and stages with no messages. */
export function emptyBundle(defaultLocale: Locale = 'en'): LocaleBundle {
  return { defaultLocale, supported: [defaultLocale], catalogs: { [defaultLocale]: {} } };
}

/** Build a bundle from inline catalogs — handy for tests. */
export function makeBundle(
  defaultLocale: Locale,
  catalogs: Record<Locale, LocaleCatalog>,
): LocaleBundle {
  return { defaultLocale, supported: Object.keys(catalogs), catalogs };
}
