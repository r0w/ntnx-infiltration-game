import { useRef } from 'react';
import { MAX_DEMO_AGENTS } from './scoreboardDemo';

const DEMO_PRESETS = [5, 12, 21, 32, 40, 50] as const;

export function ScoreboardDemoControls({
  current,
  combined,
  onToggleCombined,
  onPick,
}: {
  /** Current demo preset, or `null` when running on live data. */
  current: number | null;
  combined: boolean;
  onToggleCombined: () => void;
  onPick: (n: number) => void;
}) {
  const isCustom = current !== null && !DEMO_PRESETS.some((n) => n === current);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <nav className="scoreboard-demo-switch" aria-label="demo preset">
        <span className="scoreboard-demo-label">demo</span>
        {DEMO_PRESETS.map((n) => (
          <button
            key={n}
            type="button"
            className={`scoreboard-demo-btn${n === current ? ' is-active' : ''}`}
            aria-pressed={n === current}
            onClick={() => onPick(n)}
          >
            {n}
          </button>
        ))}
        <button
          type="button"
          className={`scoreboard-demo-btn${isCustom ? ' is-active' : ''}`}
          onClick={() => {
            if (inputRef.current) inputRef.current.value = String(current ?? 50);
            dialogRef.current?.showModal();
            inputRef.current?.select();
          }}
        >
          custom{isCustom ? ` (${current})` : ''}…
        </button>
        {current !== null && (
          <button type="button" className="scoreboard-demo-btn" aria-pressed={combined} onClick={onToggleCombined}>
            {combined ? '☑' : '☐'} multiple clusters
          </button>
        )}
      </nav>
      <dialog className="scoreboard-demo-dialog modal-card" ref={dialogRef} aria-labelledby="demo-count-title">
        <form onSubmit={(event) => {
          event.preventDefault();
          const n = inputRef.current?.valueAsNumber;
          if (n === undefined || !Number.isInteger(n) || n < 1 || n > MAX_DEMO_AGENTS) return;
          onPick(n);
          dialogRef.current?.close();
        }}>
          <h2 id="demo-count-title" className="modal-title">Preview the scoreboard</h2>
          <label htmlFor="demo-agent-count">Number of agents</label>
          <input ref={inputRef} id="demo-agent-count" type="number" min={1} max={MAX_DEMO_AGENTS} step={1} required autoFocus aria-describedby="demo-count-hint" />
          <p id="demo-count-hint">Choose 1–{MAX_DEMO_AGENTS} agents. This preview uses fictional players.</p>
          <div className="modal-actions">
            <button type="button" className="modal-btn" onClick={() => dialogRef.current?.close()}>cancel</button>
            <button type="submit" className="modal-btn">preview</button>
          </div>
        </form>
      </dialog>
    </>
  );
}
