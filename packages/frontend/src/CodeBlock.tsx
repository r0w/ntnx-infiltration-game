import { useEffect, useRef, useState } from 'react';

export interface CodeBlockProps {
  text: string;
  lang?: string;
  /** True when the terminal sequencer has reached this block. Drives onDone. */
  isActive: boolean;
  /** Called the moment this block becomes active (no animation gating — the
   *  reveal is purely visual, the sequencer shouldn't wait on it). */
  onDone: () => void;
}

/**
 * Opaque pre-formatted content with a clipboard button. Engine emits
 * `{ kind: 'code' }` MessageUnits via `<code lang='…'>…</code>` in the
 * source; this is where they render. Content is rendered verbatim inside a
 * `<pre>` — no typewriter (multi-line YAML/JSON would be painful char by
 * char). The staggered entrance animation is defined in
 * `styles/terminal.css` under `.code-block` / `.code-body` / `.code-copy`.
 */
export function CodeBlock({ text, lang, isActive, onDone }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (isActive) onDoneRef.current();
  }, [isActive]);

  const copy = async () => {
    try {
      // navigator.clipboard requires a secure context (https or localhost).
      // Game is served at http://<vm>:3000 on HPoCs → clipboard API is
      // undefined and the optional chain falls through to the textarea
      // + execCommand fallback (deprecated but still universally
      // implemented; the only available path in insecure contexts).
      if (window.isSecureContext && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '0';
        ta.style.left = '0';
        ta.style.opacity = '0';
        ta.style.pointerEvents = 'none';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (!ok) throw new Error('execCommand("copy") returned false');
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn('clipboard write failed', err);
    }
  };

  return (
    <div className="code-block" data-lang={lang ?? ''}>
      <button
        type="button"
        className={`code-copy${copied ? ' is-copied' : ''}`}
        // Don't bubble to the terminal's click-to-focus, which scrolls the input into view.
        onClick={(e) => {
          e.stopPropagation();
          void copy();
        }}
        aria-label={copied ? 'Copied' : 'Copy to clipboard'}
        title={copied ? 'Copied' : 'Copy'}
      >
        {copied ? <CheckIcon /> : <ClipboardIcon />}
      </button>
      <pre className="code-body">{text}</pre>
    </div>
  );
}

function ClipboardIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="3" width="10" height="4" rx="1" />
      <path d="M9 5H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-4" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="5 12 10 17 19 7" />
    </svg>
  );
}
