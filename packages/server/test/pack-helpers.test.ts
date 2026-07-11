import { describe, expect, test } from 'bun:test';
import { isSecondarySubnet } from '../../../packs/ntnx-infiltration/acts/helpers';
import { justFinishedInventory } from '../../../packs/ntnx-infiltration/checks/helpers';

// Stage 29 defers its verdict for a few minutes after an LCM inventory lands:
// the number the player counted came off a list that was still rebuilding.
// `lastInventoryAt` is PC's clock and `now` is ours — they drift on an HPoC.
describe('justFinishedInventory', () => {
  const now = Date.parse('2026-07-11T16:00:00Z');

  test('an inventory that just landed defers the verdict', () => {
    expect(justFinishedInventory(now - 30_000, now)).toBe(true);
  });

  test('an old inventory does not', () => {
    expect(justFinishedInventory(now - 10 * 60_000, now)).toBe(false);
  });

  test('no inventory time at all does not', () => {
    expect(justFinishedInventory(null, now)).toBe(false);
  });

  // A PC clock running ahead makes the age negative. Read naively, "negative <
  // 3 min" is true forever, so EVERY wrong answer would be deferred and the
  // stage would silently stop failing anyone (PR #63 review).
  test('a PC clock running ahead of ours never reads as recent', () => {
    expect(justFinishedInventory(now + 60 * 60_000, now)).toBe(false);
  });
});

// Regression for the stage-12 single-NIC bug: HPoCs name the routable
// subnet `secondary-<cluster>` (e.g. `secondary-DM3-POC013`), not bare
// `secondary`. A strict match left the VM with 1 NIC → CheckVM (2 NICs)
// failed. isSecondarySubnet must accept both forms (case-insensitive).
describe('isSecondarySubnet', () => {
  test('matches the bare name', () => {
    expect(isSecondarySubnet('secondary')).toBe(true);
    expect(isSecondarySubnet('Secondary')).toBe(true);
  });

  test('matches the secondary-<cluster> form HPoCs ship', () => {
    expect(isSecondarySubnet('secondary-DM3-POC013')).toBe(true);
    expect(isSecondarySubnet('SECONDARY-PHX-POC042')).toBe(true);
  });

  test('does not match unrelated subnets', () => {
    expect(isSecondarySubnet('primary-DM3-POC013')).toBe(false);
    expect(isSecondarySubnet('rbo-subnet')).toBe(false);
    expect(isSecondarySubnet('TestNetwork')).toBe(false);
    expect(isSecondarySubnet('secondaryish')).toBe(false); // no bare/prefixed match
    expect(isSecondarySubnet(undefined)).toBe(false);
    expect(isSecondarySubnet('')).toBe(false);
  });
});
