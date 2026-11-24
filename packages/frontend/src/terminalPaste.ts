/** Match the existing text-input constraints, including single-line paste. */
export function normalizeTerminalInput(value: string, variable: string | null): string {
  const singleLine = value.replace(/[\r\n]/g, '');
  if (variable === 'Trigram') return singleLine.replace(/[^A-Za-z0-9]/g, '').slice(0, 3);
  if (variable === 'PIN') return singleLine.replace(/\D/g, '').slice(0, 4);
  return singleLine;
}

export function insertTerminalPaste(value: string, text: string, start: number, end: number, variable: string | null) {
  let inserted = normalizeTerminalInput(text, variable);
  const limit = variable === 'Trigram' ? 3 : variable === 'PIN' ? 4 : Infinity;
  inserted = inserted.slice(0, Math.max(0, limit - value.length + end - start));
  return { value: value.slice(0, start) + inserted + value.slice(end), caret: start + inserted.length };
}

const LABELS: Record<string, { paste: string; denied: string }> = {
  en: { paste: 'Paste', denied: 'Paste unavailable. Click the input and use Ctrl+V / ⌘V.' },
  fr: { paste: 'Coller', denied: 'Collage indisponible. Cliquez dans le champ puis utilisez Ctrl+V / ⌘V.' },
  de: { paste: 'Einfügen', denied: 'Einfügen nicht verfügbar. Klicken Sie ins Eingabefeld und verwenden Sie Strg+V / ⌘V.' },
  es: { paste: 'Pegar', denied: 'No se puede pegar. Haga clic en el campo y use Ctrl+V / ⌘V.' },
  it: { paste: 'Incolla', denied: 'Impossibile incollare. Faccia clic nel campo e usi Ctrl+V / ⌘V.' },
};
export const terminalPasteLabels = (locale: string) => LABELS[locale] ?? LABELS.en!;
