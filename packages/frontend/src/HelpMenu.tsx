import { useEffect, useRef, useState } from 'react';
import { AnchoredPopover } from './AnchoredPopover';

type HelpChoice = boolean | null;

/**
 * Per-player step-by-step help setting, as a chip that opens a small menu:
 * follow the global switch, forced on, or forced off. The player-level
 * choice wins over the global switch in both directions.
 */
export function HelpMenu({
  value,
  globalOn,
  label,
  onChange,
}: {
  /** `null` = follows the global switch. */
  value: HelpChoice;
  globalOn: boolean;
  /** Accessible name, e.g. `help for abc`. */
  label: string;
  onChange: (value: HelpChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const state = value === null ? 'default' : value ? 'on' : 'off';
  const text = state === 'default' ? 'default' : state === 'on' ? 'forced on' : 'forced off';

  const choose = (next: HelpChoice) => {
    setOpen(false);
    btnRef.current?.focus();
    if (next !== value) onChange(next);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`admin-help-chip admin-help-chip-${state}${open ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: ${text}${state === 'default' ? ` (${globalOn ? 'on' : 'off'})` : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="admin-help-dot" aria-hidden="true" />
        {text}{' '}
        {state === 'default' && <i className="admin-help-chip-hint">({globalOn ? 'on' : 'off'})</i>}
        <span className="admin-help-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <AnchoredPopover
          anchorRef={btnRef}
          onClose={() => setOpen(false)}
          width={212}
          role="menu"
          label={label}
        >
          <HelpMenuItems value={value} globalOn={globalOn} onChoose={choose} />
        </AnchoredPopover>
      )}
    </>
  );
}

function HelpMenuItems({
  value,
  globalOn,
  onChoose,
}: {
  value: HelpChoice;
  globalOn: boolean;
  onChoose: (value: HelpChoice) => void;
}) {
  const items: Array<{ value: HelpChoice; label: string; hint?: string }> = [
    { value: null, label: 'Follow global', hint: globalOn ? 'on' : 'off' },
    { value: true, label: 'Forced on' },
    { value: false, label: 'Forced off' },
  ];
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = Math.max(0, items.findIndex((i) => i.value === value));
  // Land on the current choice, so Enter alone keeps it and the arrows move from it.
  useEffect(() => {
    refs.current[selected]?.focus();
  }, [selected]);

  const move = (to: number) => refs.current[(to + items.length) % items.length]?.focus();
  const onKeyDown = (e: React.KeyboardEvent) => {
    const at = refs.current.findIndex((el) => el === document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(at + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(at - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      move(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      move(items.length - 1);
    }
  };

  return (
    <div className="admin-help-menu" onKeyDown={onKeyDown}>
      {items.map((item, i) => (
        <button
          key={String(item.value)}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="menuitemradio"
          aria-checked={item.value === value}
          className={`admin-help-item${item.value === value ? ' is-selected' : ''}`}
          onClick={() => onChoose(item.value)}
        >
          <span className="admin-help-check" aria-hidden="true">{item.value === value ? '✓' : ''}</span>
          {item.label}
          {item.hint && <small>{item.hint}</small>}
        </button>
      ))}
    </div>
  );
}
