/** Also works on the HTTP lab URLs where the Clipboard API is unavailable. */
export async function copyText(text: string, trigger?: HTMLElement): Promise<void> {
  if (window.isSecureContext && navigator.clipboard) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* try legacy copy */ }
  }
  const focused = document.activeElement as HTMLElement | null;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  Object.assign(ta.style, { position: 'fixed', top: '0', left: '0', opacity: '0', pointerEvents: 'none' });
  // A modal makes the rest of the document inert, including a textarea
  // appended to body. Keep the fallback inside the active dialog.
  const dialog = trigger?.closest('dialog[open]') ?? focused?.closest('dialog[open]');
  (dialog ?? document.body).appendChild(ta);
  try {
    ta.select();
    if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');
  } finally {
    ta.remove();
    focused?.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      ranges.forEach(range => selection.addRange(range));
    }
  }
}

/** Copy without leaving the terminal prompt focused on the copy button.
 * Focus before starting the async write so a delayed result never steals
 * focus from another control the player selected in the meantime.
 */
export function copyTerminalText(text: string, trigger: HTMLElement): Promise<void> {
  const input = trigger.closest('.terminal')?.querySelector<HTMLInputElement>('[data-primary-input]:not(:disabled)');
  input?.focus({ preventScroll: true });
  return copyText(text, trigger);
}
