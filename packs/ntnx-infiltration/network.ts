/** Default HPoC names remain compatible; custom names match exactly. */
export function isSecondarySubnet(name: unknown, configured = 'secondary'): boolean {
  const target = configured.trim().toLowerCase() || 'secondary';
  const actual = typeof name === 'string' ? name.toLowerCase() : '';
  return actual === target || (target === 'secondary' && actual.startsWith('secondary-'));
}

export function selectSecondarySubnet<T extends { name?: unknown }>(
  subnets: T[], configured = 'secondary',
): T {
  const target = configured.trim() || 'secondary';
  const exact = subnets.filter(s => typeof s.name === 'string' && s.name.toLowerCase() === target.toLowerCase());
  const matches = exact.length ? exact : subnets.filter(s => isSecondarySubnet(s.name, target));
  if (matches.length !== 1) {
    throw new Error(`Network '${target}': ${matches.length ? 'multiple matches; configure its exact name' : 'not found'}.`);
  }
  return matches[0];
}
