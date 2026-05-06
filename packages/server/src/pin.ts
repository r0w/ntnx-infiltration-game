export function hashPin(pin: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(pin);
  return hasher.digest('hex');
}

export function verifyPin(pin: string, hash: string): boolean {
  return hashPin(pin) === hash;
}
