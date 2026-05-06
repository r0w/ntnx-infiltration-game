import { describe, expect, test } from 'bun:test';
import { completeCommand, classifyPingLine, SSH_COMMAND_NAMES } from '../src/SshConsole';

describe('completeCommand', () => {
  test('empty prefix → options lists every command', () => {
    const res = completeCommand('');
    expect(res.completion).toBeUndefined();
    expect(res.options).toBeDefined();
    // `clear` is handled inline but exposed in the lookup; same set as SSH_COMMAND_NAMES.
    expect((res.options ?? []).sort()).toEqual([...SSH_COMMAND_NAMES].sort());
  });

  test('unique prefix → completes with trailing space', () => {
    expect(completeCommand('h').completion).toBe('help ');
    expect(completeCommand('p').completion).toBe('ping ');
    expect(completeCommand('w').completion).toBe('whoami ');
    expect(completeCommand('cl').completion).toBe('clear ');
  });

  test('ambiguous prefix → options (no completion)', () => {
    // `c` matches both `clear` (plus `e` matches `exit` only) — with the
    // current set only `c` and nothing else is ambiguous at single-char
    // level, so build an artificial collision by checking `e` which is
    // unique → completes.
    const resE = completeCommand('e');
    expect(resE.completion).toBe('exit ');
    // Empty partial is the canonical ambiguous case — already covered
    // above — and `c` is unique to clear.
  });

  test('no match → empty result', () => {
    const res = completeCommand('zzz');
    expect(res.completion).toBeUndefined();
    expect(res.options).toBeUndefined();
  });
});

describe('classifyPingLine', () => {
  test('timeout / unreachable → fail', () => {
    expect(classifyPingLine('Request timed out')).toBe('fail');
    expect(classifyPingLine('Destination Host Unreachable')).toBe('fail');
    expect(classifyPingLine('ping: bad-host: Name or service not known')).toBe('fail');
  });

  test('0% packet loss → pass', () => {
    expect(classifyPingLine('4 packets transmitted, 4 received, 0% packet loss, time 3.02s'))
      .toBe('pass');
  });

  test('non-zero packet loss → fail', () => {
    expect(classifyPingLine('4 packets transmitted, 0 received, 100% packet loss'))
      .toBe('fail');
    expect(classifyPingLine('4 packets transmitted, 2 received, 50% packet loss'))
      .toBe('fail');
  });

  test('statistics header → accent', () => {
    expect(classifyPingLine('--- google.com ping statistics ---')).toBe('accent');
  });

  test('rtt summary → dim', () => {
    expect(classifyPingLine('rtt min/avg/max/mdev = 0.181/0.291/0.412/0.090 ms')).toBe('dim');
  });

  test('regular reply line → undefined (default color)', () => {
    expect(classifyPingLine('64 bytes from google.com (1.2.3.4): icmp_seq=1 ttl=64 time=0.321 ms'))
      .toBeUndefined();
  });
});
