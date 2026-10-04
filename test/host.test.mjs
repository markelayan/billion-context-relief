// Host wiring against a fake ACP module + fake session (no DSH needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, __setAcpModuleForTests } from '../lib/index.js';

function harness({ compressResult = 'Compressed 1 block(s), ~900 tokens reclaimed.', usage = 0.6, sizes = {} } = {}) {
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] } } },
    { seq: 3, type: 'tool/result', data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'BIG LOG LINE' }] } } },
    { seq: 4, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '[KEYWORD-INJECTOR REMINDER]' }], source: { kind: 'plugin:dsh-keyword-injector' } } },
    { seq: 5, type: 'turn/end', data: { turn: 1 } },
    { seq: 6, type: 'turn/start', data: { turn: 2 } },
    ...Array.from({ length: 7 }, (_, i) => ({ seq: 7 + i, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'recent' }], source: { kind: i === 0 ? 'user' : 'plugin:x' } } })),
  ];
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const nodes = events.filter((e) => /message|tool\/result/.test(e.type)).map((e) => e.seq);
  const session = { id: 'session-test', surface: { nodes }, eventAt: (s) => bySeq.get(s), snapshotEvents: () => events };
  const price = { 3: 9000, 4: 600, 7: 1000, 8: 1000, 9: 1000, 10: 1000, 11: 1000, 12: 1000, 13: 1000, ...sizes };
  const meter = { measure: () => ({ totalTokens: 20000, nodes: nodes.map((seq) => ({ seq, tokens: price[seq] ?? 20, heuristicTokens: price[seq] ?? 20 })) }) };
  const compressCalls = [];
  const engine = {
    env: { kernel: {}, store: { stateFor: () => ({ messageRefs: { byRef: { m00003: '3' } } }) }, coreOverrides: { compress: { minCompressRange: 5000 } }, compressCallIdsToHide: new Set() },
    windowFor: async () => ({ limit: 20000 / usage }),
  };
  const fakeAcp = {
    resolveSurfaceRange: (_s, start, end) => ({ start, end }),
    shadowedSeqsOf: (_s, start, end) => nodes.filter((n) => n >= start && n <= end),
    AlreadyCompressedRangeError: class extends Error {},
    makeTools: (env) => [{ name: 'compress', execute: async (args, exec) => { compressCalls.push({ env, args, exec }); return { text: compressResult }; } }],
  };
  __setAcpModuleForTests(fakeAcp);
  const injected = [];
  const agent = { id: 'session-test', session, inject: (m) => injected.push(m), ctx: { get: (n) => (n === 'compaction' ? engine : n === 'tokenMeter' ? meter : undefined) } };
  const tools = {};
  const listeners = {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bcr-host-'));
  const ctx = {
    get: (n) => (n === 'tools' ? { register: (t) => { tools[t.name] = t; return () => {}; } } : undefined),
    on: (name, fn) => { listeners[name] = fn; return () => {}; },
  };
  apply(ctx, { exportRoot: root, advisorCooldownSteps: 2 });
  const run = (name, args) => tools[name].execute(args, { agent, callId: 'call-x' }).then((r) => r.text);
  return { run, compressCalls, injected, listeners, agent, root, engine };
}

test('context_export writes the file first, then calls ACP compress with the pointer and minCompressRange 0', async () => {
  const h = harness();
  const text = await h.run('context_export', { startSeq: 'm00003', endSeq: 4, name: 'big log', note: 'bash output' });
  assert.match(text, /^Exported 2 messages \(seqs 3–4/);
  assert.equal(h.compressCalls.length, 1);
  const { env, args } = h.compressCalls[0];
  assert.equal(env.coreOverrides.compress.minCompressRange, 0, 'per-call override');
  assert.equal(h.engine.env.coreOverrides.compress.minCompressRange, 5000, 'engine config untouched');
  assert.equal(env.compressCallIdsToHide, undefined, 'our tool call is not hidden');
  const summary = args.content[0].summary;
  assert.match(summary, /^\[CONTEXT EXPORTED \(temp file\) → .*big-log\.md · 2 msgs · seqs 3–4 .*note: bash output/);
  const file = summary.match(/→ (\S+\.md)/)[1];
  assert.match(fs.readFileSync(file, 'utf8'), /BIG LOG LINE/);
  assert.equal(text.includes('BIG LOG LINE'), false, 'tool result never contains the content');
});

test('context_export removes its file when ACP refuses', async () => {
  const h = harness({ compressResult: 'Compressed 0 block(s), ~0 tokens reclaimed.' });
  const text = await h.run('context_export', { startSeq: 3, endSeq: 4 });
  assert.match(text, /ACP refused the range/);
  assert.match(await h.run('context_exports', { action: 'list' }), /^No exports/);
});

test('protected zone and open turn are refused before ACP is called', async () => {
  const h = harness();
  assert.match(await h.run('context_delete', { startSeq: 12, endSeq: 13, reason: 'x' }), /open\) turn|protected zone/);
  assert.equal(h.compressCalls.length, 0);
});

test('context_delete needs a reason, and confirm above the token threshold', async () => {
  const h = harness();
  assert.match(await h.run('context_delete', { startSeq: 3, endSeq: 4, reason: '  ' }), /reason is required/);
  assert.match(await h.run('context_delete', { startSeq: 3, endSeq: 4, reason: 'dead-end log' }), /confirm:true/);
  assert.equal(h.compressCalls.length, 0);
  const ok = await h.run('context_delete', { startSeq: 3, endSeq: 4, reason: 'dead-end log', confirm: true });
  assert.match(ok, /^Deleted 2 messages/);
  assert.equal(h.compressCalls[0].args.content[0].summary, '[DELETED REFERENCES · seqs 3–4 · 2 msgs · ~9.6K tok · reason: dead-end log]');
});

test('small rows can be deleted alone (no 5,000-char floor)', async () => {
  const h = harness();
  assert.match(await h.run('context_delete', { startSeq: 4, endSeq: 4, reason: 'stale reminder' }), /^Deleted 1 messages/);
});

test('context_exports lists names and deletes only on request', async () => {
  const h = harness();
  await h.run('context_export', { startSeq: 3, endSeq: 3, name: 'one' });
  const list = await h.run('context_exports', { action: 'list' });
  assert.match(list, /1 export\(s\)/);
  assert.equal(list.includes('BIG LOG LINE'), false);
  const name = list.match(/· (\S+\.md)/)[1];
  assert.match(await h.run('context_exports', { action: 'delete' }), /names:\[\.\.\.\] or all:true/);
  assert.match(await h.run('context_exports', { action: 'delete', names: [name] }), /Deleted 1 export/);
});

test('advisor informs once per change, respects cooldown and usage floor, never modifies', async () => {
  const h = harness();
  const step = () => h.listeners['agent/pre-step']({ agent: h.agent, turn: 2, step: 1 }, async () => ({ kind: 'enter' }));
  for (let i = 0; i < 6; i++) await step();
  assert.equal(h.injected.length, 1, 'same oversized set → one notice only');
  assert.match(h.injected[0].content[0].text, /seq 3 · tool bash · ~9\.0K tok/);
  assert.equal(h.injected[0].source.kind, 'plugin:billion-context-relief');
  assert.equal(h.compressCalls.length, 0, 'advisor never compresses or deletes');

  const low = harness({ usage: 0.2 });
  for (let i = 0; i < 6; i++) await low.listeners['agent/pre-step']({ agent: low.agent, turn: 2, step: 1 }, async () => ({ kind: 'enter' }));
  assert.equal(low.injected.length, 0, 'below minUsagePct → silent');
});
