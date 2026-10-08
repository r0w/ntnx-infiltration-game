import { describe, expect, test } from 'bun:test';
import { parseMessage } from '../src/message-parser';
import { VariableStore } from '../src/variables';

describe('parseMessage', () => {
  test('emits plain text', () => {
    const r = parseMessage('Hello world', new VariableStore());
    expect(r.units).toEqual([{ kind: 'text', text: 'Hello world', color: 'default' }]);
    expect(r.actions).toEqual([]);
    expect(r.firstAwaitInputIdx).toBe(-1);
  });

  test('substitutes {Name}', () => {
    const vars = new VariableStore({ Trigram: 'ABC' });
    const r = parseMessage('Hi {Trigram}, welcome.', vars);
    expect(r.units).toEqual([{ kind: 'text', text: 'Hi ABC, welcome.', color: 'default' }]);
  });

  test('drops {Name} when variable missing', () => {
    const r = parseMessage('Hi {Ghost}!', new VariableStore());
    expect(r.units).toEqual([{ kind: 'text', text: 'Hi !', color: 'default' }]);
  });

  test('literal `{` passes through when not a valid variable reference', () => {
    const r = parseMessage('a { b', new VariableStore());
    expect(r.units).toEqual([{ kind: 'text', text: 'a { b', color: 'default' }]);
  });

  test('<pause sec="3"/> emits a pause unit', () => {
    const r = parseMessage("Wait<pause sec='3'/>done", new VariableStore());
    expect(r.units).toEqual([
      { kind: 'text', text: 'Wait', color: 'default' },
      { kind: 'pause', ms: 3000 },
      { kind: 'text', text: 'done', color: 'default' },
    ]);
  });

  test('<pause sec="0.5"/> accepts decimals', () => {
    const r = parseMessage("<pause sec='0.5'/>", new VariableStore());
    expect(r.units).toEqual([{ kind: 'pause', ms: 500 }]);
  });

  test('<input var="Name"/> emits an await-input unit', () => {
    const r = parseMessage("Trigram: <input var='Trigram'/> next", new VariableStore());
    expect(r.units).toEqual([
      { kind: 'text', text: 'Trigram: ', color: 'default' },
      { kind: 'await-input', variable: 'Trigram' },
      { kind: 'text', text: ' next', color: 'default' },
    ]);
    expect(r.firstAwaitInputIdx).toBe(1);
  });

  test('<input/> (no var) maps to a continue sentinel', () => {
    const r = parseMessage('press enter: <input/>', new VariableStore());
    expect(r.units).toEqual([
      { kind: 'text', text: 'press enter: ', color: 'default' },
      { kind: 'await-input', variable: '$continue' },
    ]);
  });

  test('<action name="foo"/> collects an action without emitting a unit', () => {
    const r = parseMessage("Boom<action name='deleteVM'/>OK", new VariableStore());
    expect(r.units).toEqual([{ kind: 'text', text: 'BoomOK', color: 'default' }]);
    expect(r.actions).toEqual(['deleteVM']);
  });

  test('<clear/> emits a clear unit', () => {
    const r = parseMessage('old<clear/>new', new VariableStore());
    expect(r.units).toEqual([
      { kind: 'text', text: 'old', color: 'default' },
      { kind: 'clear' },
      { kind: 'text', text: 'new', color: 'default' },
    ]);
  });

  test('<red>text</red> switches color within the span only', () => {
    const r = parseMessage('a<red>b</red>c', new VariableStore());
    expect(r.units).toEqual([
      { kind: 'text', text: 'a', color: 'default' },
      { kind: 'text', text: 'b', color: 'red' },
      { kind: 'text', text: 'c', color: 'default' },
    ]);
  });

  test('color tags respect the stage default when closing', () => {
    const r = parseMessage('a<red>b</red>c', new VariableStore(), 'white');
    expect(r.units).toEqual([
      { kind: 'text', text: 'a', color: 'white' },
      { kind: 'text', text: 'b', color: 'red' },
      { kind: 'text', text: 'c', color: 'white' },
    ]);
  });

  test('nested color tags: inner overrides, outer resumes after close', () => {
    const r = parseMessage('<red>a<green>b</green>c</red>', new VariableStore());
    expect(r.units).toEqual([
      { kind: 'text', text: 'a', color: 'red' },
      { kind: 'text', text: 'b', color: 'green' },
      { kind: 'text', text: 'c', color: 'red' },
    ]);
  });

  test('style tags stack with color and with each other', () => {
    const r = parseMessage('<red><bold>a<dim>b</dim></bold></red>', new VariableStore());
    expect(r.units).toEqual([
      { kind: 'text', text: 'a', color: 'red', styles: ['bold'] },
      { kind: 'text', text: 'b', color: 'red', styles: ['bold', 'dim'] },
    ]);
  });

  test('unknown tag passes through as literal text', () => {
    const r = parseMessage('a</orange>b', new VariableStore());
    expect(r.units).toEqual([
      { kind: 'text', text: 'a</orange>b', color: 'default' },
    ]);
  });

  test('orphan color close (no matching open) is consumed without error', () => {
    const r = parseMessage('a</red>b', new VariableStore());
    expect(r.units).toEqual([{ kind: 'text', text: 'ab', color: 'default' }]);
  });

  test('unterminated tag renders as literal text', () => {
    const r = parseMessage('a <pause sec= oops', new VariableStore());
    expect(r.units).toEqual([{ kind: 'text', text: 'a <pause sec= oops', color: 'default' }]);
  });

  test('variables inside color spans substitute correctly', () => {
    const vars = new VariableStore({ Name: 'Neo' });
    const r = parseMessage('<green>hi {Name}</green><pause sec=\'1\'/>bye', vars);
    expect(r.units).toEqual([
      { kind: 'text', text: 'hi Neo', color: 'green' },
      { kind: 'pause', ms: 1000 },
      { kind: 'text', text: 'bye', color: 'default' },
    ]);
  });

  test('double-quoted attributes work the same as single-quoted', () => {
    const r = parseMessage('<pause sec="2"/>', new VariableStore());
    expect(r.units).toEqual([{ kind: 'pause', ms: 2000 }]);
  });

  test('<code>...</code> emits a code unit with content raw and untouched', () => {
    const r = parseMessage(
      "Paste this:\n<code>\n#cloud-config\nusers: [{name: 'foo'}]\n</code>\ndone",
      new VariableStore(),
    );
    expect(r.units).toEqual([
      { kind: 'text', text: 'Paste this:\n', color: 'default' },
      { kind: 'code', text: "#cloud-config\nusers: [{name: 'foo'}]" },
      { kind: 'text', text: '\ndone', color: 'default' },
    ]);
  });

  test('<code> content is NOT re-parsed — braces and tags inside stay literal', () => {
    const r = parseMessage('<code>{not-a-var} <red>not a tag</red></code>', new VariableStore({ x: 'X' }));
    expect(r.units).toEqual([
      { kind: 'code', text: '{not-a-var} <red>not a tag</red>' },
    ]);
  });
  test('&lt; and &gt; decode to literal angle brackets in prose', () => {
    const r = parseMessage('Replace &lt;any_node_IP&gt; with a node IP.', new VariableStore());
    expect(r.units).toEqual([
      { kind: 'text', text: 'Replace <any_node_IP> with a node IP.', color: 'default' },
    ]);
  });

  test('a decoded &lt; does not start a tag', () => {
    const r = parseMessage('&lt;red&gt;stays text&lt;/red&gt;', new VariableStore());
    expect(r.units).toEqual([
      { kind: 'text', text: '<red>stays text</red>', color: 'default' },
    ]);
  });

  test('entities decode inside <code> too — the learner copies the real YAML', () => {
    const r = parseMessage('<code lang=\'yaml\'>host: user01.&lt;ingress_lb_ip&gt;.sslip.io</code>', new VariableStore());
    expect(r.units).toEqual([
      { kind: 'code', text: 'host: user01.<ingress_lb_ip>.sslip.io', lang: 'yaml' },
    ]);
  });

  test('&amp; decodes, and a bare & is left alone', () => {
    const r = parseMessage('a &amp; b, x=1&y=2', new VariableStore());
    expect(r.units).toEqual([
      { kind: 'text', text: 'a & b, x=1&y=2', color: 'default' },
    ]);
  });
});
