import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from './api';

// Standalone sandbox terminal at /ssh. Fully agnostic of the game
// session — no auth, no stage/session/pack coupling, just a whitelisted
// command runner. Probes are real (backed by `packages/server/src/
// routes/ssh.ts`) because a lying reachability tool would be worse than
// no tool at all: `ping` spawns the system binary, `ssh` opens a TCP
// probe to port 22. Input is validated server-side before we hand it to
// `spawn` / `net.createConnection`, as defense-in-depth.
//
// Extensible via the COMMANDS registry below — add a handler, register
// it, mention it in `help`. Sync handlers return StreamedLine[]; async
// ones return Promise<StreamedLine[]>.

type LineColor = 'default' | 'dim' | 'accent' | 'pass' | 'fail';

interface Line {
  id: number;
  text: string;
  color: LineColor;
}

interface StreamedLine {
  /** Delay in ms before this line is appended to the buffer. */
  delayMs: number;
  text: string;
  color?: LineColor;
}

type CommandHandler = (
  args: string[],
  signal?: AbortSignal,
) => StreamedLine[] | Promise<StreamedLine[]>;

/** Scrollback buffer size — anything older is dropped to keep DOM light. */
const MAX_BUFFER = 400;

export function SshConsole() {
  const [lines, setLines] = useState<Line[]>(() => initialBanner());
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lineIdRef = useRef(lines.length);
  // Holds the AbortController for the in-flight command so Ctrl+C can
  // cancel both the fetch and the line-by-line streaming sleeps.
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    document.title = 'NIG - ssh';
  }, []);

  const appendLine = useCallback((text: string, color: LineColor = 'default') => {
    setLines((prev) => {
      lineIdRef.current += 1;
      const next = [...prev, { id: lineIdRef.current, text, color }];
      return next.length > MAX_BUFFER ? next.slice(next.length - MAX_BUFFER) : next;
    });
  }, []);

  const clearScreen = useCallback(() => {
    setLines([]);
    lineIdRef.current = 0;
  }, []);

  // Keep scroll pinned to bottom as new lines stream in — simulation feel
  // depends on the user reading the newest line first.
  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  // Keep focus on the input when we're idle (the input is unmounted while
  // busy — we show a running indicator instead — so focus restoration
  // only runs when we drop back to the idle branch).
  useEffect(() => {
    if (!busy) inputRef.current?.focus();
  }, [busy]);

  // Clicking anywhere in the terminal body should return focus to the
  // prompt — mirrors real terminal behaviour where the whole pane is
  // "the command line". Don't steal focus while the user is selecting
  // text: preserving copy/paste is important for a terminal.
  const handleBodyClick = useCallback((_e: MouseEvent<HTMLDivElement>) => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    inputRef.current?.focus();
  }, []);

  const runCommand = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      appendLine(`${PROMPT} ${trimmed}`, 'dim');
      if (!trimmed) return;
      const [name, ...args] = trimmed.split(/\s+/);
      // Built-in clear is special — it wipes the buffer instead of streaming.
      if (name === 'clear') {
        clearScreen();
        return;
      }
      const handler = COMMANDS[name];
      if (!handler) {
        appendLine(`${name}: command not found`, 'fail');
        appendLine(`type 'help' for a list of available commands`, 'dim');
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);
      try {
        const stream = await handler(args, controller.signal);
        for (const line of stream) {
          if (controller.signal.aborted) break;
          if (line.delayMs > 0) await sleep(line.delayMs, controller.signal);
          appendLine(line.text, line.color ?? 'default');
        }
      } catch (err) {
        // Ctrl+C printed the `^C` line already — swallow the AbortError.
        if (!isAbortError(err)) {
          appendLine(
            `${name}: ${err instanceof Error ? err.message : String(err)}`,
            'fail',
          );
        }
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [appendLine, clearScreen],
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (busy) return;
      const cmd = input;
      setInput('');
      setHistoryIdx(null);
      if (cmd.trim()) {
        setHistory((h) => (h[h.length - 1] === cmd ? h : [...h, cmd].slice(-100)));
      }
      void runCommand(cmd);
    },
    [busy, input, runCommand],
  );

  const handleKey = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (history.length === 0) return;
        const next = historyIdx === null ? history.length - 1 : Math.max(0, historyIdx - 1);
        setHistoryIdx(next);
        setInput(history[next]);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (historyIdx === null) return;
        const next = historyIdx + 1;
        if (next >= history.length) {
          setHistoryIdx(null);
          setInput('');
        } else {
          setHistoryIdx(next);
          setInput(history[next]);
        }
      } else if (e.key === 'Tab') {
        // Only complete the first word — if there's a space, the user is
        // typing an arg and completing the command name would be wrong.
        e.preventDefault();
        if (input.includes(' ')) return;
        const res = completeCommand(input);
        if (res.completion !== undefined) {
          setInput(res.completion);
        } else if (res.options && res.options.length > 0) {
          appendLine(res.options.join('  '), 'dim');
        }
      } else if (e.key === 'l' && e.ctrlKey) {
        // Ctrl+L: standard shell "clear the screen". Preserves input.
        e.preventDefault();
        clearScreen();
      } else if (e.key === 'c' && e.ctrlKey) {
        // Ctrl+C: if text is selected, let the browser copy (standard
        // expectation in any web terminal). Otherwise mirror a real shell:
        // while a command is running → interrupt; while idle → abandon
        // the current input line.
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) return;
        e.preventDefault();
        if (abortRef.current) {
          appendLine('^C', 'dim');
          abortRef.current.abort();
        } else {
          appendLine(`${PROMPT} ${input}^C`, 'dim');
          setInput('');
          setHistoryIdx(null);
        }
      }
    },
    [appendLine, clearScreen, history, historyIdx, input],
  );

  return (
    <div className="ssh-console">
      <header className="ssh-header">
        <Link to="/" className="ssh-back" aria-label="back to game">←</Link>
        <span className="ssh-title">sandbox · ntnx-lab</span>
        <span className="ssh-hint">'help' · tab · ↑/↓ · ctrl+l · ctrl+c</span>
      </header>
      <div className="ssh-body" ref={scrollerRef} onClick={handleBodyClick}>
        {lines.map((l) => (
          <div key={l.id} className={`ssh-line ssh-line-${l.color}`}>
            {l.text || ' '}
          </div>
        ))}
        {busy ? (
          <div className="ssh-running" onKeyDown={handleKey} tabIndex={0}>
            <span className="ssh-spinner">…</span>
            <span className="ssh-running-label">running</span>
            <span className="ssh-running-hint">(ctrl+c to cancel)</span>
          </div>
        ) : (
          <form className="ssh-input-line" onSubmit={handleSubmit}>
            <span className="ssh-prompt">{PROMPT}</span>
            <input
              ref={inputRef}
              className="ssh-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKey}
              autoComplete="off"
              spellCheck={false}
              aria-label="terminal input"
              // Same nukes as the game terminal to stop password managers
              // from suggesting anything for these commands.
              data-lpignore="true"
              data-1p-ignore="true"
              data-bwignore="true"
              data-form-type="other"
            />
          </form>
        )}
      </div>
    </div>
  );
}

const PROMPT = 'agent@ntnx-sandbox:~$';

// Rotating MOTD — picks one at each page load so the terminal doesn't
// feel like a static screenshot. All kept short: first-line impression
// only, the `type 'help'` hint below carries the useful info.
const MOTDS = [
  'ntnx sandbox terminal v0.1 — restricted command set',
  'ntnx ops console · authorized infiltrations only',
  'terminal online. every packet is logged (somewhere).',
  'nutanix uplink established. stay on the happy path.',
  'sandbox session active — no shell, no secrets, no regrets.',
] as const;

function initialBanner(): Line[] {
  const motd = MOTDS[Math.floor(Math.random() * MOTDS.length)];
  const text = [
    `* ${motd}`,
    "* type 'help' for the list of available commands",
    '',
  ];
  return text.map((t, i): Line => ({
    id: i + 1,
    text: t,
    color: i === 0 ? 'accent' : 'dim',
  }));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

// -- Command registry --------------------------------------------------------
// Each handler returns the full stream (timing + text) as StreamedLine[]
// (sync) or Promise<StreamedLine[]> (async handlers — ping/ssh talk to
// packages/server/src/routes/ssh.ts for real reachability probes).
// Adding a new command: (1) write the handler, (2) register here, (3)
// mention it in `help`. For a new server primitive (raw sockets, DNS,
// etc.), extend routes/ssh.ts and call via `api`.

const COMMANDS: Record<string, CommandHandler> = {
  help: cmdHelp,
  ping: cmdPing,
  ssh: cmdSsh,
  whoami: cmdWhoami,
  exit: cmdExit,
  // `clear` is handled inline in runCommand (needs access to state setters).
};

/**
 * Tab-completion lookup. Matches the first word against the command
 * registry (+ `clear`):
 *   - one match → returns `{completion: "<cmd> "}`  (trailing space is
 *     the standard shell nudge "you're ready to type an arg")
 *   - multiple matches → returns `{options: [...]}` so the caller can
 *     print them as a hint without mutating the input
 *   - zero matches → empty object
 * Exported for unit tests; the command set is the source of truth.
 */
export function completeCommand(partial: string): { completion?: string; options?: string[] } {
  const names = [...Object.keys(COMMANDS), 'clear'].sort();
  if (partial === '') return { options: names };
  const matches = names.filter((n) => n.startsWith(partial));
  if (matches.length === 0) return {};
  if (matches.length === 1) return { completion: `${matches[0]} ` };
  return { options: matches };
}

function cmdHelp(): StreamedLine[] {
  return [
    { delayMs: 0, text: 'available commands:', color: 'accent' },
    { delayMs: 0, text: '  ping <target>         real ICMP ping (4 packets)' },
    { delayMs: 0, text: '  ssh [user@]<target>   real TCP probe of port 22' },
    { delayMs: 0, text: '  whoami                who you are (spoiler: classified)' },
    { delayMs: 0, text: '  clear                 wipe the screen' },
    { delayMs: 0, text: '  help                  this message' },
    { delayMs: 0, text: '  exit                  print a goodbye' },
    { delayMs: 0, text: '' },
    { delayMs: 0, text: 'keyboard: tab completes · ↑/↓ history · ctrl+l clear · ctrl+c cancel', color: 'dim' },
    {
      delayMs: 0,
      text: 'probes run from the game server, so results reflect that host\'s',
      color: 'dim',
    },
    {
      delayMs: 0,
      text: 'network viewpoint — useful for firewall, microseg, or routing checks.',
      color: 'dim',
    },
  ];
}

async function cmdPing(args: string[], signal?: AbortSignal): Promise<StreamedLine[]> {
  if (args.length === 0) {
    return [{ delayMs: 0, text: 'usage: ping <target>', color: 'fail' }];
  }
  const target = args[0];
  let result;
  try {
    result = await api.sshPing(target, signal);
  } catch (err) {
    if (isAbortError(err)) throw err; // bubble up so runCommand swallows it
    return [
      { delayMs: 0, text: `ping: ${err instanceof Error ? err.message : String(err)}`, color: 'fail' },
    ];
  }
  // Real output, one line at a time with a gentle delay so it feels like
  // tailing the process. Colors carry the semantics: red for timeouts and
  // the "N% packet loss" line when N > 0, green for the packet-loss line
  // when it's 0%, cyan for section headers, dim for rtt stats.
  const out: StreamedLine[] = result.output.map((line, i) => ({
    delayMs: i === 0 ? 0 : 900 + Math.floor(Math.random() * 120),
    text: line,
    color: classifyPingLine(line),
  }));
  // Only synthesise an error line when the backend gave us nothing to
  // show — otherwise the real ping stderr already explains the failure
  // (e.g. "Name or service not known") and a trailing "ping: exit 2"
  // would just be noise.
  if (!result.ok && result.output.length === 0) {
    out.push({
      delayMs: 0,
      text: `ping: ${result.error ?? 'target unreachable'}`,
      color: 'fail',
    });
  }
  return out;
}

function classifyPingLine(line: string): LineColor | undefined {
  if (/Destination (Host|Net) Unreachable|Request timed? out|Name or service not known|unreachable/i.test(line)) return 'fail';
  // "4 packets transmitted, 4 received, 0% packet loss" — green when all
  // four got through, red when any are missing.
  const lossMatch = /(\d+)% packet loss/i.exec(line);
  if (lossMatch) return Number(lossMatch[1]) === 0 ? 'pass' : 'fail';
  if (/ping statistics|^---/i.test(line)) return 'accent';
  if (/rtt |min\/avg\/max/i.test(line)) return 'dim';
  return undefined;
}

async function cmdSsh(args: string[], signal?: AbortSignal): Promise<StreamedLine[]> {
  if (args.length === 0) {
    return [{ delayMs: 0, text: 'usage: ssh [user@]<target>', color: 'fail' }];
  }
  const spec = args[0];
  const [, hostPart] = spec.includes('@') ? spec.split('@') : [null, spec];
  const target = hostPart || spec;
  let result;
  try {
    result = await api.sshTcp(target, 22, signal);
  } catch (err) {
    if (isAbortError(err)) throw err;
    return [
      { delayMs: 0, text: `ssh: ${err instanceof Error ? err.message : String(err)}`, color: 'fail' },
    ];
  }
  const display = result.ip && result.ip !== target ? `${target} (${result.ip})` : target;
  if (!result.ok) {
    return [
      { delayMs: 0, text: `connecting to ${display} port 22…`, color: 'dim' },
      {
        delayMs: 200,
        text: `ssh: connect to host ${target} port 22: ${result.error ?? 'unreachable'}`,
        color: 'fail',
      },
    ];
  }
  return [
    { delayMs: 0, text: `connecting to ${display} port 22…`, color: 'dim' },
    {
      delayMs: 200,
      text: `port 22 open — handshake would succeed (${result.durationMs} ms)`,
      color: 'pass',
    },
    {
      delayMs: 300,
      text: 'sandbox: reachability probe only; no interactive shell opens here.',
      color: 'dim',
    },
    {
      delayMs: 0,
      text: 'run `ssh admin@' + target + '` from your real terminal to actually log in.',
      color: 'dim',
    },
  ];
}

function cmdWhoami(): StreamedLine[] {
  const tags = [
    'identity classified. stay sharp.',
    'an infiltrator in good standing.',
    'not the person Rowien thinks you are.',
    'you are who you pretend to be.',
    'undercover. do not log anything incriminating.',
  ];
  return [
    { delayMs: 0, text: 'agent', color: 'accent' },
    { delayMs: 0, text: `* ${tags[Math.floor(Math.random() * tags.length)]}`, color: 'dim' },
  ];
}

function cmdExit(): StreamedLine[] {
  return [
    { delayMs: 0, text: 'there is no exit — use the ← back arrow to return to the game.', color: 'dim' },
  ];
}

// Exports for unit tests / future help rendering.
export const SSH_COMMAND_NAMES = [...Object.keys(COMMANDS), 'clear'] as const;
export { classifyPingLine };
