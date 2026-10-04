// Core helpers (no DSH needed): node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveConfig, protectedSeqs, scanLarge, renderLargeList, labelOf, toolNamesOf,
  exportMarker, deleteMarker, sanitizeInline, exportFileName, renderExport,
  writeExport, listExports, deleteExports, removeExportFile, sessionDir, widenForPairing,
} from '../lib/core.js';

// Minimal session: surface = every message event seq.
function makeSession(events) {
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  return {
    surface: { nodes: events.filter((e) => /message|tool\/result/.test(e.type)).map((e) => e.seq) },
    eventAt: (seq) => bySeq.get(seq),
  };
}
const user = (seq, text) => ({ seq, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } });
const plugin = (seq, text, kind = 'plugin:dsh-keyword-injector') => ({ seq, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }], source: { kind } } });
const call = (seq, id, name) => ({ seq, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'tool-call', id, name, arguments: '{}' }] } } });
const result = (seq, id, text) => ({ seq, type: 'tool/result', data: { message: { role: 'tool', toolCallId: id, content: [{ type: 'text', text }] } } });

const cfg = resolveConfig({});

test('config: unknown keys ignored, types enforced', () => {
  const c = resolveConfig({ largeMessageTokens: 100, bogus: 1, advisorEnabled: 'yes', minUsagePct: -1 });
  assert.equal(c.largeMessageTokens, 100);
  assert.equal(c.advisorEnabled, true);
  assert.equal(c.minUsagePct, 0.40);
  assert.equal('bogus' in c, false);
});

test('protected zone covers last 5 messages, last 5K tokens and latest real user message', () => {
  const events = [user(1, 'start'), ...Array.from({ length: 10 }, (_, i) => plugin(2 + i, 'x'))];
  const s = makeSession(events);
  const guarded = protectedSeqs(s, () => 100);
  for (const seq of [7, 8, 9, 10, 11]) assert.ok(guarded.has(seq), `seq ${seq} protected (recent)`);
  assert.ok(guarded.has(1), 'latest real user message protected');
  // 5K-token rule: with 2000-token messages only the last 3 fit in 5K → still ≥5 by count
  const heavy = protectedSeqs(s, () => 2000);
  assert.ok(heavy.has(7) && !heavy.has(6));
});

test('scanLarge lists oversized messages, turns and ACP blocks outside the protected zone', () => {
  const events = [
    user(1, 'go'),
    call(2, 'c1', 'bash'), result(3, 'c1', 'huge log'),
    plugin(4, 'snapshot', 'runtime-context'),
    { seq: 5, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'summary' }], source: { kind: 'compact-checkpoint' } } },
    user(6, 'next'), call(7, 'c2', 'read'), result(8, 'c2', 'small'),
    ...Array.from({ length: 6 }, (_, i) => plugin(9 + i, 'recent')),
  ];
  const s = makeSession(events);
  // recent filler (seqs 9–14) is 1K each, so the last-5K-token rule stops at seq 10
  const price = { 3: 9000, 4: 4200, 5: 3500, 2: 50, 9: 1000, 10: 1000, 11: 1000, 12: 1000, 13: 1000, 14: 1000 };
  const turnOf = (seq) => (seq <= 5 ? 1 : 2);
  const { items } = scanLarge(s, { priceOf: (seq) => price[seq] ?? 10, turnOf, cfg, currentTurn: 2 });
  const kinds = items.map((i) => `${i.kind}:${i.start}-${i.end}:${i.label}`);
  assert.deepEqual(kinds, [
    'turn:1-5:turn 1 (5 msgs)',
    'message:3-3:tool bash',
    'message:4-4:runtime-context snapshot',
    'block:5-5:ACP summary block',
  ]);
  const text = renderLargeList(items, { maxItems: 2, currentTurn: 2, usagePct: 0.61 });
  assert.match(text, /seqs 1–5 · turn 1/);
  assert.match(text, /…and 2 more/);
  assert.match(text, /usage 61%/);
});

test('labels never include content', () => {
  const s = makeSession([call(1, 'a', 'grep'), result(2, 'a', 'SECRET=abc')]);
  const names = toolNamesOf(s);
  assert.equal(labelOf(s.eventAt(2), names), 'tool grep');
  assert.equal(labelOf(plugin(3, 'x', 'plugin:agents-in-the-loop')), 'plugin:agents-in-the-loop');
});

test('markers are single-line and carry the exact span', () => {
  const reason = sanitizeInline('dead\nend   grep\tloop', 120);
  assert.equal(reason, 'dead end grep loop');
  const d = deleteMarker({ count: 14, start: 120, end: 188, tokens: 9200, reason });
  assert.equal(d, '[DELETED REFERENCES · seqs 120–188 · 14 msgs · ~9.2K tok · reason: dead end grep loop]');
  const e = exportMarker({ file: '/tmp/x.md', count: 3, start: 1, end: 4, tokens: 512 });
  assert.match(e, /^\[CONTEXT EXPORTED \(temp file\) → \/tmp\/x\.md · 3 msgs · seqs 1–4 · ~512 tok/);
  assert.equal(e.includes('\n'), false);
});

test('export store: write, list by name only, delete, path escapes refused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bcr-test-'));
  const c = resolveConfig({ exportRoot: root });
  const sid = 'session-abc';
  const s = makeSession([call(1, 'a', 'bash'), result(2, 'a', 'line1\nline2')]);
  const name = exportFileName({ name: 'Pytest Run #3!', start: 1, end: 2, now: new Date(2026, 9, 4, 15, 32, 7) });
  assert.equal(name, '2026-10-04_153207_pytest-run-3.md');
  const content = renderExport({ sessionId: sid, start: 1, end: 2, events: [s.eventAt(1), s.eventAt(2)], toolNames: toolNamesOf(s), tokens: 40 });
  assert.match(content, /## seq 2 · tool bash\n\nline1\nline2/);
  const file = writeExport(c, sid, name, content, { createdAt: 'now', start: 1, end: 2, count: 2, tokens: 40, note: 'pytest' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.throws(() => writeExport(c, sid, name, 'again', {}), /EEXIST/);

  const listed = listExports(c, sid);
  assert.deepEqual(listed.exports.map((e) => [e.name, e.seqs, e.note]), [[name, '1–2', 'pytest']]);
  assert.equal(JSON.stringify(listed).includes('line1'), false, 'listing never exposes content');

  assert.throws(() => sessionDir(c, '../escape'), /invalid session id/);
  const r1 = deleteExports(c, sid, { names: ['../../etc/passwd', 'nope.md'] });
  assert.deepEqual(r1, { deleted: [], missing: ['../../etc/passwd', 'nope.md'] });
  const r2 = deleteExports(c, sid, { names: [name] });
  assert.deepEqual(r2.deleted, [name]);
  assert.equal(fs.existsSync(file), false);

  writeExport(c, sid, 'a.md', 'x', {});
  writeExport(c, sid, 'b.md', 'y', {});
  removeExportFile(c, sid, 'a.md');
  assert.deepEqual(listExports(c, sid).exports.map((e) => e.name), ['b.md']);
  const r3 = deleteExports(c, sid, { all: true });
  assert.deepEqual(r3.deleted, ['b.md']);
  assert.equal(fs.existsSync(path.join(root, sid)), false, 'all:true removes the session dir');
  fs.rmSync(root, { recursive: true, force: true });
});

test('widenForPairing pulls in the call of an edge result and the result of an edge call', () => {
  const s = makeSession([
    user(1, 'go'),
    call(2, 'a', 'web_fetch'), result(3, 'a', 'page A'),
    call(4, 'b', 'web_fetch'), result(5, 'b', 'page B'),
    call(6, 'c', 'bash'), result(7, 'c', 'out'),
  ]);
  // start on result 3 (call at 2), end on call 6 (result at 7)
  assert.deepEqual(widenForPairing(s, 3, 6), { start: 2, end: 7 });
  // already balanced range is unchanged
  assert.deepEqual(widenForPairing(s, 4, 5), { start: 4, end: 5 });
  // a plain user message stays as is
  assert.deepEqual(widenForPairing(s, 1, 1), { start: 1, end: 1 });
});
