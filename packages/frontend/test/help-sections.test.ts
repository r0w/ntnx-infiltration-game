import { expect, test } from 'bun:test';
import { helpSections } from '../src/helpSections';
import type { MessageUnit } from '@ntnx-game/shared';

test('recognizes all localized step headings and preserves rich instructions and images', () => {
  for (const word of ['Step', 'Étape', 'Schritt', 'Paso', 'Passo', 'Passaggio']) {
    const content: MessageUnit[] = [
      { kind: 'text', text: 'Copy this: ' },
      { kind: 'text', text: 'rbo-subnet', copyable: true },
      { kind: 'image', src: 'capture.png', alt: 'Configuration' },
      { kind: 'code', text: 'ping 10.0.0.1' },
    ];
    const sections = helpSections([
      { kind: 'text', color: 'white', text: `${word} 1 · Configure.` },
      ...content,
      { kind: 'text', color: 'white', text: `${word} 2 · Verify.` },
    ]);
    expect(sections).toHaveLength(2);
    expect(sections[0]!.units).toEqual(content);
  }
});

test('keeps legacy help, introductory text, and incidental copy/link values intact', () => {
  const units: MessageUnit[] = [
    { kind: 'text', text: 'Instructions without step headings.\n' },
    { kind: 'text', color: 'white', text: 'Step 1 · Copy value', copyable: true },
    { kind: 'text', color: 'white', text: 'Step 2 · Link', href: '/ssh' },
    { kind: 'image', src: 'capture.png' },
  ];
  expect(helpSections(units)).toEqual([{ units }]);
  expect(helpSections([...units, { kind: 'text', color: 'white', text: 'Step 1 · Begin.' }])[0]!.units).toEqual(units);
  expect(helpSections([])).toEqual([]);
});
