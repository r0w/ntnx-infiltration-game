import { useEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { insertTerminalPaste } from './terminalPaste';

/** A clipboard permission prompt may outlive the input it was opened for. */
export function useTerminalPaste(
  inputRef: RefObject<HTMLInputElement>, enabled: boolean, promptKey: string,
  variable: string | null, onChange: (value: string) => void,
) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [denied, setDenied] = useState(false);
  const latest = useRef({ enabled, promptKey, variable, onChange });
  latest.current = { enabled, promptKey, variable, onChange };
  const pending = useRef(false);
  const target = useRef<{ input: HTMLInputElement; value: string; start: number; end: number; promptKey: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMenu(null);
    setDenied(false);
    target.current = null;
  }, [enabled, promptKey]);
  useEffect(() => () => { target.current = null; }, []);

  useEffect(() => {
    if (!menu) return;
    const dismiss = () => setMenu(null);
    const outside = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) dismiss();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Tab') {
        dismiss();
        if (e.key === 'Escape') inputRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
    };
  }, [menu, inputRef]);

  const onContextMenu = (e: MouseEvent) => {
    setMenu(null);
    // Keep native Copy, link/image actions and input editing available.
    if (!enabled || pending.current || window.getSelection()?.toString() ||
      (e.target as Element).closest('input, textarea, button, a, img, [contenteditable="true"], [role="button"]')) return;
    const input = inputRef.current;
    if (!input || input.disabled) return;
    e.preventDefault();
    target.current = { input, value: input.value, start: input.selectionStart ?? input.value.length,
      end: input.selectionEnd ?? input.value.length, promptKey };
    setMenu({ x: Math.max(0, Math.min(e.clientX, window.innerWidth - 170)),
      y: Math.max(0, Math.min(e.clientY, window.innerHeight - 48)) });
  };

  const paste = async () => {
    const captured = target.current;
    setMenu(null);
    if (!captured || pending.current) return;
    pending.current = true;
    const stillCurrent = () => target.current === captured && latest.current.enabled &&
      latest.current.promptKey === captured.promptKey && inputRef.current === captured.input &&
      captured.input.isConnected && captured.input.value === captured.value;
    try {
      // Invoked directly from the Paste button to retain browser user activation.
      const text = await navigator.clipboard.readText();
      if (!stillCurrent()) return;
      const next = insertTerminalPaste(captured.value, text, captured.start, captured.end, latest.current.variable);
      setDenied(false);
      if (text) latest.current.onChange(next.value);
      captured.input.focus();
      requestAnimationFrame(() => {
        if (latest.current.promptKey === captured.promptKey && inputRef.current === captured.input) {
          captured.input.setSelectionRange(next.caret, next.caret);
        }
      });
    } catch {
      if (stillCurrent()) {
        setDenied(true);
        captured.input.focus();
      }
    } finally {
      pending.current = false;
    }
  };
  return { menu, menuRef, denied, clearNote: () => setDenied(false), onContextMenu, paste };
}
