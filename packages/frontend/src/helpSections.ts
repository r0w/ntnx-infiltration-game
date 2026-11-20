import type { MessageUnit } from '@ntnx-game/shared';

export interface HelpSection {
  heading?: string;
  number?: string;
  label?: string;
  units: MessageUnit[];
}

/** Promote the packs' existing localized step headings without rewriting content.
 * Unstructured help remains a single continuous section.
 */
export function helpSections(units: MessageUnit[]): HelpSection[] {
  const sections: HelpSection[] = [];
  let current: HelpSection = { units: [] };
  for (const unit of units) {
    if (unit.kind === 'text' && unit.color === 'white' && !unit.copyable && !unit.href &&
      /^(?:Step|Étape|Schritt|Paso|Passo|Passaggio)\s+\d+\s*·\s*\S/u.test(unit.text.trim())) {
      if (current.heading || current.units.some(u => u.kind !== 'text' || u.text.trim())) sections.push(current);
      const heading = unit.text.trim();
      const [, number, label] = heading.match(/\s(\d+)\s*·\s*(.+)/u)!;
      current = { heading, number, label: label!.replace(/\.$/, ''), units: [] };
    } else current.units.push(unit);
  }
  if (current.heading || current.units.length) sections.push(current);
  return sections;
}
