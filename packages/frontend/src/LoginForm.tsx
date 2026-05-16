import { useEffect, useRef, useState } from 'react';

export interface LoginFormProps {
  busy: boolean;
  error: string | null;
  defaultLocale: string;
  supportedLocales: readonly string[];
  onSubmit: (input: { locale: string }) => void;
}

const LOCALE_LABELS: Record<string, string> = {
  en: 'English',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  it: 'Italiano',
  pt: 'Português',
  ja: '日本語',
  zh: '中文',
};

function labelFor(code: string): string {
  return LOCALE_LABELS[code] ?? code;
}

export function LoginForm({
  busy,
  error,
  defaultLocale,
  supportedLocales,
  onSubmit,
}: LoginFormProps) {
  const [locale, setLocale] = useState<string>(defaultLocale);

  useEffect(() => {
    if (!supportedLocales.includes(locale)) setLocale(defaultLocale);
  }, [defaultLocale, supportedLocales, locale]);

  return (
    <div className="login">
      <div className="login-card">
        <h1 className="login-title">ntnx infiltration game</h1>
        <p className="login-subtitle">Pick a language.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit({ locale });
          }}
        >
          {supportedLocales.length > 1 && (
            <div className="login-field">
              <span>Language</span>
              <LocaleDropdown
                value={locale}
                options={supportedLocales}
                onChange={setLocale}
              />
            </div>
          )}
          {error && <div className="login-error">{error}</div>}
          <button type="submit" className="login-submit" disabled={busy}>
            <span className="login-submit-prompt" aria-hidden>&gt;</span>
            <span className="login-submit-cmd">{busy ? 'connecting' : 'start'}</span>
            <span className="login-submit-cursor" aria-hidden>▌</span>
          </button>
        </form>
      </div>
    </div>
  );
}

/**
 * Custom dropdown — replaces the browser-native `<select>` so the styling
 * matches the terminal theme and scales beyond a few options. Behavior:
 *   - click trigger → toggle open
 *   - click outside / Escape → close
 *   - ↑ / ↓ → move active option (wrapping)
 *   - Enter / Space on an option → select + close
 *   - Tab leaves the open dropdown without selecting
 */
function LocaleDropdown({
  value,
  options,
  onChange,
}: {
  value: string;
  options: readonly string[];
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(() =>
    Math.max(0, options.indexOf(value)),
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    setActiveIdx(Math.max(0, options.indexOf(value)));
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, options, value]);

  const commit = (code: string) => {
    onChange(code);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const handleTriggerKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
    }
  };

  const handleListKey = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % options.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + options.length) % options.length);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      commit(options[activeIdx]!);
    }
  };

  return (
    <div className="locale-dd" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`locale-dd-trigger${open ? ' is-open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={handleTriggerKey}
      >
        <span className="locale-dd-code">{value.toUpperCase()}</span>
        <span className="locale-dd-label">{labelFor(value)}</span>
        <span className="locale-dd-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <ul
          className="locale-dd-list"
          role="listbox"
          tabIndex={-1}
          onKeyDown={handleListKey}
          ref={(el) => el?.focus()}
        >
          {options.map((code, idx) => {
            const selected = code === value;
            const active = idx === activeIdx;
            return (
              <li
                key={code}
                role="option"
                aria-selected={selected}
                className={`locale-dd-option${active ? ' is-active' : ''}${
                  selected ? ' is-selected' : ''
                }`}
                onMouseEnter={() => setActiveIdx(idx)}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep focus on the list
                  commit(code);
                }}
              >
                <span className="locale-dd-code">{code.toUpperCase()}</span>
                <span className="locale-dd-label">{labelFor(code)}</span>
                {selected && <span className="locale-dd-check" aria-hidden>✓</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
