import { describe, expect, test } from 'bun:test';
import { isSecondarySubnet } from '../../../packs/ntnx-infiltration/acts/helpers';

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
