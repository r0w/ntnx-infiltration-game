import { useEffect, useId, type ReactNode } from 'react';

type ModalProps = {
  title: ReactNode;
  onClose: () => void;
  busy?: boolean;
  children: ReactNode;
};

export function Modal({ title, onClose, busy = false, children }: ModalProps) {
  const titleId = useId();

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!busy && ev.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget && !busy) onClose();
      }}
    >
      <div className="modal-card">
        <h2 id={titleId} className="modal-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

type ConfirmModalProps = {
  title: ReactNode;
  children: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel?: ReactNode;
  /** Optional 3rd button between cancel and confirm — useful when the
   *  dialog needs to offer a middle-ground action (e.g. "just this
   *  one" vs "with cascade"). When set, cancel reverts to its plain
   *  "close without doing anything" semantics; the previous 2-button
   *  hack of repurposing cancel as a secondary action loses the real
   *  bail-out path. Omit to keep the 2-button layout. */
  onSecondary?: () => void;
  secondaryLabel?: ReactNode;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmModal({
  title,
  children,
  confirmLabel,
  cancelLabel = 'cancel',
  onSecondary,
  secondaryLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  // Enter triggers the primary action — natural for one-shot confirms.
  // ESC + click-outside are handled by the underlying Modal.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!busy && ev.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onConfirm]);

  return (
    <Modal title={title} onClose={onCancel} busy={busy}>
      <div className="modal-body">{children}</div>
      <div className="modal-actions">
        <button
          type="button"
          className="modal-btn"
          onClick={onCancel}
          disabled={busy}
          autoFocus
        >
          {cancelLabel}
        </button>
        {onSecondary && (
          <button
            type="button"
            className="modal-btn"
            onClick={onSecondary}
            disabled={busy}
          >
            {secondaryLabel}
          </button>
        )}
        <button
          type="button"
          className={danger ? 'modal-btn modal-btn-danger' : 'modal-btn'}
          onClick={onConfirm}
          disabled={busy}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
