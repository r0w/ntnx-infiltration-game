const KNOWN_COLORS = new Set([
  'red', 'green', 'yellow', 'cyan', 'blue', 'magenta', 'white', 'dim', 'prompt',
]);
const KNOWN_STYLES = new Set(['bold', 'dim']);

/**
 * Compose class names for a text run. `color` is exclusive (whichever tag is
 * topmost in the parser's color stack); `styles` are cumulative modifiers
 * like `bold` or `dim`. Unknown values are dropped — they won't have a
 * matching `.c-*` rule anyway.
 */
export function textClasses(color: string | undefined, styles: string[] | undefined): string {
  const out: string[] = [];
  if (color && KNOWN_COLORS.has(color)) out.push(`c-${color}`);
  else out.push('c-default');
  if (styles) {
    for (const s of styles) {
      if (KNOWN_STYLES.has(s)) out.push(`c-${s}`);
    }
  }
  return out.join(' ');
}
