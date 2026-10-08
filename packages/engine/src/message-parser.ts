import type { MessageUnit } from '@ntnx-game/shared';
import type { Variables } from './types';

export interface ParsedMessage {
  units: MessageUnit[];
  actions: string[];
  /** Index of the first await-input unit within {@link units}, or -1 if none. */
  firstAwaitInputIdx: number;
  finalColor: string;
}

/**
 * Tag grammar, JSX-ish and deliberately tiny:
 *
 *   {Name}                          — variable substitution
 *   <pause sec='3'/>                — pause (decimals OK, e.g. sec='0.5')
 *   <input/>                        — await input without capture ("press Enter")
 *   <input var='Name'/>             — await input, capture value into `Name`
 *   <action name='foo'/>            — fire a server action, emits no text
 *   <clear/>                        — wipe the scrollback (destructive)
 *   <pagebreak/>                    — scroll-preserving visual separator
 *   <image src='foo.png' alt='…'/>  — inline image from the pack's assets dir
 *   <red>text</red>, <green>, ...   — foreground color (one active at a time)
 *   <dim>text</dim>, <bold>text</bold>  — style modifiers (stackable with colors + each other)
 *   <a href='url'>text</a>          — clickable link (renders target=_blank)
 *   &lt; &gt; &amp;              — literal `<`, `>`, `&`
 *
 * A bare `<` starts a tag, so prose that needs a literal angle bracket (a
 * placeholder like `<any_node_IP>`) writes it escaped. Decoding happens inside
 * code blocks too: they are opaque to *tags*, but an undecoded `&lt;` there
 * would be copied straight into the learner's terminal.
 *
 * Colors are exclusive: nesting `<red><green>x</green></red>` makes "x" green;
 * the outer red resumes after the inner close. Styles (dim, bold) stack
 * independently and all active ones apply simultaneously.
 *
 * Malformed input never throws. Unknown tags and orphan closes are dropped
 * silently; what we can parse, we parse, the rest is rendered as plain text.
 */
export function parseMessage(
  template: string,
  variables: Variables,
  defaultColor = 'default',
): ParsedMessage {
  const units: MessageUnit[] = [];
  const actions: string[] = [];
  let firstAwaitInputIdx = -1;
  let textBuf = '';

  const colorStack: string[] = [];
  const styleStack: string[] = [];
  const hrefStack: string[] = [];

  const currentColor = () => colorStack[colorStack.length - 1] ?? defaultColor;
  const currentHref = () => hrefStack[hrefStack.length - 1];

  const flushText = () => {
    if (textBuf.length === 0) return;
    const color = currentColor();
    const styles = styleStack.length > 0 ? [...styleStack] : undefined;
    const href = currentHref();
    units.push({
      kind: 'text',
      text: textBuf,
      color,
      ...(styles ? { styles } : {}),
      ...(href ? { href } : {}),
    });
    textBuf = '';
  };

  const pushVoidUnit = (u: MessageUnit) => {
    flushText();
    units.push(u);
  };

  const COLOR_TAGS = new Set(['red', 'green', 'yellow', 'blue', 'cyan', 'magenta', 'white']);
  const STYLE_TAGS = new Set(['dim', 'bold']);

  let i = 0;
  const n = template.length;
  while (i < n) {
    const ch = template[i];

    // Variable: {Name}
    if (ch === '{') {
      const end = template.indexOf('}', i + 1);
      if (end !== -1) {
        const name = template.slice(i + 1, end).trim();
        if (/^[A-Za-z_][\w]*$/.test(name)) {
          const val = variables.get(name);
          if (val !== undefined && val !== null) textBuf += String(val);
          i = end + 1;
          continue;
        }
      }
      textBuf += ch;
      i++;
      continue;
    }

    // Entity: &lt; &gt; &amp;
    if (ch === '&') {
      const entity = decodeEntityAt(template, i);
      if (entity) {
        textBuf += entity.char;
        i = entity.end;
        continue;
      }
      textBuf += ch;
      i++;
      continue;
    }

    // Tag: <tagname .../>  or <tagname>  or </tagname>
    if (ch === '<') {
      const tag = parseTagAt(template, i);
      if (tag) {
        // <code>…</code> is opaque to TAGS (so users can paste YAML / JSON /
        // shell with `<` / `:` / `{` without collisions), but `{Var}`
        // substitution still applies — packs need to embed dynamic values
        // like `{ImageURL}` or `{Trigram}-vm` inside copyable blocks.
        // Replace `{Name}` patterns against the live variables map; leave
        // unmatched `{...}` literals untouched (matches the stricter
        // identifier regex used in the main loop above).
        if (tag.kind === 'open' && tag.name === 'code') {
          const closeMatch = findCloseTag(template, tag.end, 'code');
          if (closeMatch) {
            flushText();
            const raw = template.slice(tag.end, closeMatch.start);
            const interpolated = raw.replace(
              /\{([A-Za-z_][\w]*)\}/g,
              (m, name: string) => {
                const val = variables.get(name);
                return val !== undefined && val !== null ? String(val) : m;
              },
            );
            const lang = tag.attrs.lang;
            units.push({
              kind: 'code',
              text: decodeEntities(stripSurroundingNewlines(interpolated)),
              ...(lang ? { lang } : {}),
            });
            i = closeMatch.end;
            continue;
          }
        }
        if (tag.kind === 'open' && tag.name === 'a') {
          // `<a href='...'>text</a>` — wrap the inner text in an href so the
          // renderer emits a clickable link. Inner content still respects
          // nested color/style tags; href applies to every flushed text unit
          // until </a>. Substitute `{Var}` patterns in the href so packs can
          // embed dynamic URLs (e.g. `<a href='https://{OldPC}:9440'>`) —
          // otherwise the browser navigates to a literal `{OldPC}` host.
          const rawHref = tag.attrs.href;
          if (rawHref) {
            const href = rawHref.replace(
              /\{([A-Za-z_][\w]*)\}/g,
              (m, name: string) => {
                const val = variables.get(name);
                return val !== undefined && val !== null ? String(val) : m;
              },
            );
            flushText();
            hrefStack.push(href);
            i = tag.end;
            continue;
          }
        }
        const handled = handleTag(tag);
        if (handled) {
          i = tag.end;
          continue;
        }
      }
      textBuf += ch;
      i++;
      continue;
    }

    textBuf += ch;
    i++;
  }

  flushText();

  return {
    units,
    actions,
    firstAwaitInputIdx,
    finalColor: currentColor(),
  };

  function handleTag(tag: ParsedTag): boolean {
    if (tag.kind === 'void') {
      return handleVoidTag(tag);
    }
    if (tag.kind === 'open') {
      return handleOpenTag(tag.name);
    }
    return handleCloseTag(tag.name);
  }

  function handleVoidTag(tag: VoidTag): boolean {
    switch (tag.name) {
      case 'pause': {
        const seconds = parseFloat(tag.attrs.sec ?? '');
        if (Number.isFinite(seconds) && seconds > 0) {
          pushVoidUnit({ kind: 'pause', ms: Math.round(seconds * 1000) });
        }
        return true;
      }
      case 'input': {
        flushText();
        if (firstAwaitInputIdx === -1) firstAwaitInputIdx = units.length;
        units.push({ kind: 'await-input', variable: tag.attrs.var ?? '$continue' });
        return true;
      }
      case 'action': {
        if (tag.attrs.name) actions.push(tag.attrs.name);
        return true;
      }
      case 'clear': {
        pushVoidUnit({ kind: 'clear' });
        return true;
      }
      case 'pagebreak': {
        pushVoidUnit({ kind: 'page-break' });
        return true;
      }
      case 'image': {
        const src = tag.attrs.src;
        if (!src) return true; // drop silently when malformed
        const alt = tag.attrs.alt;
        pushVoidUnit({ kind: 'image', src, ...(alt ? { alt } : {}) });
        return true;
      }
      case 'demo': {
        const src = tag.attrs.src;
        if (!src) return true; // same silent drop as a malformed image
        const poster = tag.attrs.poster;
        const label = tag.attrs.label;
        pushVoidUnit({
          kind: 'demo',
          src,
          ...(poster ? { poster } : {}),
          ...(label ? { label } : {}),
        });
        return true;
      }
      default:
        return false;
    }
  }

  function handleOpenTag(name: string): boolean {
    if (COLOR_TAGS.has(name)) {
      flushText();
      colorStack.push(name);
      return true;
    }
    if (STYLE_TAGS.has(name)) {
      flushText();
      styleStack.push(name);
      return true;
    }
    return false;
  }

  function handleCloseTag(name: string): boolean {
    if (COLOR_TAGS.has(name)) {
      const topIdx = colorStack.lastIndexOf(name);
      if (topIdx === -1) return true; // orphan close — consume and ignore
      flushText();
      colorStack.splice(topIdx, 1);
      return true;
    }
    if (STYLE_TAGS.has(name)) {
      const topIdx = styleStack.lastIndexOf(name);
      if (topIdx === -1) return true;
      flushText();
      styleStack.splice(topIdx, 1);
      return true;
    }
    if (name === 'a') {
      if (hrefStack.length === 0) return true;
      flushText();
      hrefStack.pop();
      return true;
    }
    return false;
  }
}

type VoidTag = { kind: 'void'; name: string; attrs: Record<string, string>; end: number };
type OpenTag = { kind: 'open'; name: string; attrs: Record<string, string>; end: number };
type CloseTag = { kind: 'close'; name: string; end: number };
type ParsedTag = VoidTag | OpenTag | CloseTag;

/**
 * Parse `<tagname attr='v'/>` / `<tagname>` / `</tagname>` starting at
 * `template[start]` (which must be `<`). Returns the parsed tag and the
 * absolute index after the closing `>`, or null if the slice is not a
 * well-formed tag.
 */
function parseTagAt(template: string, start: number): ParsedTag | null {
  if (template[start] !== '<') return null;
  const gt = template.indexOf('>', start + 1);
  if (gt === -1) return null;
  const inner = template.slice(start + 1, gt);
  if (inner.length === 0) return null;

  const isClose = inner.startsWith('/');
  const body = isClose ? inner.slice(1) : inner;
  const selfClosing = body.endsWith('/');
  const trimmed = selfClosing ? body.slice(0, -1).trim() : body.trim();
  if (trimmed.length === 0) return null;

  // First whitespace splits name from attributes.
  const nameMatch = /^([A-Za-z][\w-]*)/.exec(trimmed);
  if (!nameMatch) return null;
  const name = nameMatch[1].toLowerCase();
  const attrsSrc = trimmed.slice(name.length).trim();

  if (isClose) {
    if (attrsSrc.length > 0) return null; // `</red x='1'>` not allowed
    return { kind: 'close', name, end: gt + 1 };
  }

  const attrs = attrsSrc.length > 0 ? parseAttributes(attrsSrc) : {};
  if (!attrs) return null;

  if (!selfClosing) {
    return { kind: 'open', name, attrs, end: gt + 1 };
  }

  return { kind: 'void', name, attrs, end: gt + 1 };
}

function parseAttributes(src: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  const re = /([A-Za-z][\w-]*)\s*=\s*(?:'([^']*)'|"([^"]*)")/g;
  let consumed = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    out[m[1]] = m[2] ?? m[3] ?? '';
    consumed = re.lastIndex;
  }
  if (src.slice(consumed).trim().length > 0) return null;
  return out;
}

/**
 * Locate the next `</name>` tag (exact, whole-word, case-insensitive) starting
 * at `from`, returning its [start, end] indices or null if missing.
 */
function findCloseTag(template: string, from: number, name: string): { start: number; end: number } | null {
  const needle = `</${name}>`;
  const idx = template.toLowerCase().indexOf(needle.toLowerCase(), from);
  if (idx === -1) return null;
  return { start: idx, end: idx + needle.length };
}

/**
 * The three entities worth supporting: the two that the tag grammar makes
 * unwritable, plus `&amp;` so an author can write a literal `&lt;` if they
 * ever need to show the escape itself. Longest first is unnecessary here —
 * none is a prefix of another.
 */
const ENTITIES: ReadonlyArray<readonly [string, string]> = [
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&amp;', '&'],
];

/** Match an entity at `start` (which must be `&`), or null if none fits. */
function decodeEntityAt(template: string, start: number): { char: string; end: number } | null {
  for (const [entity, char] of ENTITIES) {
    if (template.startsWith(entity, start)) return { char, end: start + entity.length };
  }
  return null;
}

/** Same decoding for a whole string — used on code blocks, which skip the loop. */
function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '&') {
      const entity = decodeEntityAt(s, i);
      if (entity) {
        out += entity.char;
        i = entity.end;
        continue;
      }
    }
    out += s[i];
    i++;
  }
  return out;
}

/**
 * Trim a single leading and a single trailing newline from a raw code block.
 * `<code>\ncontent\n</code>` is the idiomatic formatting in the source, but
 * the surrounding newlines are presentational and we don't want them in the
 * rendered output.
 */
function stripSurroundingNewlines(s: string): string {
  let start = 0;
  let end = s.length;
  if (s.startsWith('\n')) start = 1;
  if (end > start && s.endsWith('\n')) end -= 1;
  return s.slice(start, end);
}
