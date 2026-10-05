import { useEffect, useRef, useState } from 'react';
import { AnchoredPopover } from './AnchoredPopover';
import { SCROLL_SPEEDS, SCROLL_SPEED_LABELS, type ScrollSpeed } from './scrollSpeeds';

/**
 * Auto-scroll speed, as a chip that opens a small menu: the same look as the
 * help setting of the Agents table. The menu names each speed and shows what it
 * is in pixels per second.
 */
export function ScrollSpeedMenu({
  value,
  disabled,
  onChange,
}: {
  value: ScrollSpeed;
  /** Only the auto-scroll mode uses a speed. */
  disabled: boolean;
  onChange: (value: ScrollSpeed) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const choose = (next: ScrollSpeed) => {
    setOpen(false);
    btnRef.current?.focus();
    if (next !== value) onChange(next);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`admin-help-chip admin-help-chip-default${open ? ' is-open' : ''}`}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Scroll speed: ${SCROLL_SPEED_LABELS[value]}`}
        title={disabled ? 'Only used by Auto-scroll' : `${value} px/s`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="admin-help-dot" aria-hidden="true" />
        {SCROLL_SPEED_LABELS[value]}
        <span className="admin-help-caret" aria-hidden="true">▾</span>
      </button>
      {open && !disabled && (
        <AnchoredPopover
          anchorRef={btnRef}
          onClose={() => setOpen(false)}
          width={184}
          role="menu"
          label="Scroll speed"
        >
          <SpeedItems value={value} onChoose={choose} />
        </AnchoredPopover>
      )}
    </>
  );
}

function SpeedItems({ value, onChoose }: { value: ScrollSpeed; onChoose: (value: ScrollSpeed) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = Math.max(0, SCROLL_SPEEDS.findIndex((s) => s === value));
  // Land on the current choice, so Enter alone keeps it and the arrows move from it.
  useEffect(() => {
    refs.current[selected]?.focus();
  }, [selected]);

  const move = (to: number) =>
    refs.current[(to + SCROLL_SPEEDS.length) % SCROLL_SPEEDS.length]?.focus();
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
      move(SCROLL_SPEEDS.length - 1);
    }
  };

  return (
    <div className="admin-help-menu" onKeyDown={onKeyDown}>
      {SCROLL_SPEEDS.map((speed, i) => (
        <button
          key={speed}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="menuitemradio"
          aria-checked={speed === value}
          className={`admin-help-item${speed === value ? ' is-selected' : ''}`}
          onClick={() => onChoose(speed)}
        >
          <span className="admin-help-check" aria-hidden="true">{speed === value ? '✓' : ''}</span>
          {SCROLL_SPEED_LABELS[speed]}
          <small>{speed} px/s</small>
        </button>
      ))}
    </div>
  );
}
