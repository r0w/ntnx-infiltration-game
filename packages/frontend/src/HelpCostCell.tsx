import { useRef, useState } from 'react';
import type { AdminPackStageEntry } from './api';
import { AnchoredPopover } from './AnchoredPopover';
import { formatCost, HELP_COST_PRESETS, splitSeconds, validateCost } from './helpCost';

/**
 * "Help cost" cell of the Pack table: what showing this stage's step-by-step
 * help for the first time adds to a player's finish time. A pill shows the
 * value (the yellow dot marks a value the operator changed, like the active
 * and gate pills); clicking it opens a small editor. Stages without a help
 * block have nothing to price.
 */
export function HelpCostCell({
  stage,
  busy,
  onSave,
}: {
  stage: AdminPackStageEntry;
  busy: boolean;
  /** Resolve `true` when the server accepted the value, so the editor can close. */
  onSave: (seconds: number | null) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  if (!stage.hasHelp) {
    return (
      <span className="c-dim pack-vars-none" title="this stage has no step-by-step help">
        —
      </span>
    );
  }
  const save = async (seconds: number | null) => {
    if (await onSave(seconds)) setOpen(false);
  };
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`pack-toggle pack-toggle-help${open ? ' is-open' : ''}`}
        disabled={busy}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={
          stage.helpPenaltyOverridden
            ? `you changed this (pack: ${formatCost(stage.helpPenaltyDefaultSec)}), click to edit`
            : 'as declared in the pack files, click to edit'
        }
        onClick={() => setOpen((v) => !v)}
      >
        {formatCost(stage.helpPenaltySec)}
        {stage.helpPenaltyOverridden && <span className="pack-toggle-mark">·</span>}
      </button>
      {open && (
        <AnchoredPopover
          anchorRef={btnRef}
          onClose={() => setOpen(false)}
          width={300}
          label={`help cost of ${stage.stageName}`}
        >
          <HelpCostEditor stage={stage} onSave={save} onCancel={() => setOpen(false)} />
        </AnchoredPopover>
      )}
    </>
  );
}

function HelpCostEditor({
  stage,
  onSave,
  onCancel,
}: {
  stage: AdminPackStageEntry;
  onSave: (seconds: number | null) => Promise<void>;
  onCancel: () => void;
}) {
  const start = splitSeconds(stage.helpPenaltySec);
  const [min, setMin] = useState(String(start.min));
  const [sec, setSec] = useState(String(start.sec));
  const [saving, setSaving] = useState(false);
  const result = validateCost(min, sec);
  const seconds = 'seconds' in result ? result.seconds : null;
  const error = 'error' in result ? result.error : null;
  const changed = seconds !== null && seconds !== stage.helpPenaltySec;
  const defaultText = formatCost(stage.helpPenaltyDefaultSec);

  const run = async (value: number | null) => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave(value);
    } finally {
      setSaving(false);
    }
  };
  const pick = (value: number) => {
    const parts = splitSeconds(value);
    setMin(String(parts.min));
    setSec(String(parts.sec));
  };

  return (
    <form
      className="admin-help-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (seconds !== null && changed) void run(seconds);
      }}
    >
      <h4 className="admin-pop-title">help cost · {stage.stageName}</h4>
      <div className="admin-help-fields">
        <input
          className="admin-help-input"
          inputMode="numeric"
          aria-label="minutes"
          value={min}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setMin(e.target.value)}
        />
        <span className="admin-help-unit">min</span>
        <input
          className="admin-help-input"
          inputMode="numeric"
          aria-label="seconds"
          value={sec}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setSec(e.target.value)}
        />
        <span className="admin-help-unit">s</span>
      </div>
      {error && (
        <div className="admin-help-error" role="alert">
          {error}
        </div>
      )}
      <div className="admin-help-presets">
        {HELP_COST_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            className={`admin-help-preset${seconds === p ? ' is-active' : ''}`}
            onClick={() => pick(p)}
          >
            {formatCost(p)}
          </button>
        ))}
      </div>
      <p className="admin-help-note">
        Pack default: {defaultText}. Applies to the next displays only: players who already used
        this help keep what they were charged.
      </p>
      <div className="admin-help-actions">
        {stage.helpPenaltyOverridden && (
          <button
            type="button"
            className="admin-help-reset"
            disabled={saving}
            onClick={() => void run(null)}
          >
            reset to {defaultText}
          </button>
        )}
        <button type="button" className="modal-btn" onClick={onCancel}>
          cancel
        </button>
        <button type="submit" className="modal-btn admin-help-save" disabled={!changed || saving}>
          save
        </button>
      </div>
    </form>
  );
}
