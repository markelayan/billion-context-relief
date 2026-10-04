// lib/core.js — pure helpers for billion-context-relief (no DSH imports).
//
// Everything here works on plain session-shaped objects so it can be unit
// tested without a running harness:
//   session.surface.nodes      → model-visible event seqs, in order
//   session.eventAt(seq)        → durable event { seq, type, data }
// and a `priceOf(seq)` callback that returns the host token-meter price.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PLUGIN = 'billion-context-relief';

export const DEFAULTS = Object.freeze({
  largeMessageTokens: 4000,
  largeTurnTokens: 12000,
  largeBlockTokens: 3000,
  minUsagePct: 0.40,
  advisorEnabled: true,
  advisorCooldownSteps: 8,
  maxItems: 5,
  deleteConfirmTokens: 8000,
  reasonMaxChars: 120,
  exportRoot: '', // '' → <os tmpdir>/billion-context-relief
});

export function resolveConfig(config) {
  const cfg = { ...DEFAULTS };
  for (const [key, value] of Object.entries(config ?? {})) {
    if (!(key in DEFAULTS)) continue;
    if (typeof DEFAULTS[key] === 'number' && typeof value === 'number' && Number.isFinite(value) && value >= 0) cfg[key] = value;
    else if (typeof DEFAULTS[key] === 'boolean' && typeof value === 'boolean') cfg[key] = value;
    else if (typeof DEFAULTS[key] === 'string' && typeof value === 'string') cfg[key] = value;
  }
  if (cfg.exportRoot.startsWith('~/')) cfg.exportRoot = path.join(os.homedir(), cfg.exportRoot.slice(2));
  return cfg;
}

// --- event inspection -------------------------------------------------------

const MESSAGE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result', 'system/message']);

export function messageOf(event) {
  if (!event) return undefined;
  return event.type === 'user/message' ? event.data : event.data?.message;
}

function blocksOf(event) {
  const content = messageOf(event)?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

export function textOf(event) {
  const parts = [];
  for (const block of blocksOf(event)) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'reasoning' && typeof block.text === 'string') parts.push(`(reasoning) ${block.text}`);
    else if (block.type === 'tool-call') parts.push(`(tool call ${block.name ?? '?'}) ${typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {})}`);
    else if (block.type === 'image') parts.push(`[image ${block.mediaType ?? ''}]`.trim());
    else if (block.type === 'file') parts.push(`[file ${block.name ?? block.filename ?? ''}]`.trim());
  }
  return parts.join('\n');
}

// toolCallId → tool name, from assistant tool-call blocks on the surface.
export function toolNamesOf(session) {
  const names = new Map();
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event?.type !== 'assistant/message') continue;
    for (const block of blocksOf(event)) {
      if (block?.type === 'tool-call' && block.id) names.set(block.id, block.name ?? 'tool');
    }
  }
  return names;
}

// Widen [start, end] so no tool call/result pair is cut at either edge: a
// result inside the range pulls in its call, a call inside pulls in its
// result. ACP's range resolver otherwise SHRINKS to a balanced remainder,
// silently dropping e.g. the tool result a caller started the range on.
export function widenForPairing(session, start, end) {
  const callAt = new Map();   // toolCallId → seq of the assistant message
  const resultAt = new Map(); // toolCallId → seq of the tool result
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event?.type === 'assistant/message') {
      for (const block of blocksOf(event)) if (block?.type === 'tool-call' && block.id) callAt.set(block.id, seq);
    } else if (event?.type === 'tool/result') {
      const id = messageOf(event)?.toolCallId;
      if (id) resultAt.set(id, seq);
    }
  }
  let lo = start;
  let hi = end;
  for (let changed = true; changed;) {
    changed = false;
    for (const [id, r] of resultAt) {
      const c = callAt.get(id);
      if (c === undefined) continue;
      const inside = (r >= lo && r <= hi) || (c >= lo && c <= hi);
      if (!inside) continue;
      if (c < lo) { lo = c; changed = true; }
      if (r > hi) { hi = r; changed = true; }
    }
  }
  return { start: lo, end: hi };
}

// Short human label for one surface event (never includes its content).
export function labelOf(event, toolNames) {
  if (!event) return 'unknown';
  if (event.type === 'tool/result') {
    const msg = messageOf(event);
    return `tool ${toolNames?.get(msg?.toolCallId) ?? 'result'}`;
  }
  if (event.type === 'assistant/message') {
    const calls = blocksOf(event).filter((b) => b?.type === 'tool-call').map((b) => b.name ?? '?');
    return calls.length ? `assistant → ${calls.join(', ')}` : 'assistant';
  }
  if (event.type === 'user/message') {
    const kind = event.data?.source?.kind;
    if (kind === 'user' || kind === undefined) return 'user';
    if (kind === 'runtime-context') return 'runtime-context snapshot';
    if (kind === 'compact-checkpoint') return 'ACP summary block';
    if (typeof kind === 'string' && kind.startsWith('plugin:')) return kind;
    return String(kind);
  }
  return event.type;
}

export function isCheckpoint(event) {
  if (event?.type !== 'user/message') return false;
  const source = event.data?.source;
  return source?.kind === 'compact-checkpoint' || source?.plugin === 'compact';
}

function isRealUserTurn(event) {
  return event?.type === 'user/message' && (event.data?.source?.kind === 'user' || event.data?.source === undefined);
}

// --- protected zone (mirrors the ACP kernel's preservation rules) -----------
//
// The kernel refuses ranges inside the last `preserveRecentMessages` messages,
// the most recent real user message, or the last `preserveRecentTokens`
// tokens. Listing those would only produce rejected calls.

export function protectedSeqs(session, priceOf, { recentMessages = 5, recentTokens = 5000 } = {}) {
  const nodes = session.surface.nodes;
  const out = new Set();
  let tokens = 0;
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const withinCount = nodes.length - i <= recentMessages;
    const withinTokens = tokens < recentTokens;
    if (!withinCount && !withinTokens) break;
    out.add(nodes[i]);
    tokens += priceOf(nodes[i]);
  }
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    if (isRealUserTurn(session.eventAt(nodes[i]))) { out.add(nodes[i]); break; }
  }
  if (nodes.length && session.eventAt(nodes[0])?.type === 'system/message') out.add(nodes[0]);
  return out;
}

// --- large-item scan -----------------------------------------------------------

// Returns oversized single messages, completed turns and ACP summary blocks
// outside the protected zone, largest first. `turnOf(seq)` maps a surface seq
// to its turn number (undefined when unknown).
export function scanLarge(session, { priceOf, turnOf, cfg, currentTurn, overrides = {} }) {
  const limits = {
    message: overrides.largeMessageTokens ?? cfg.largeMessageTokens,
    turn: overrides.largeTurnTokens ?? cfg.largeTurnTokens,
    block: overrides.largeBlockTokens ?? cfg.largeBlockTokens,
  };
  const guarded = protectedSeqs(session, priceOf);
  const toolNames = toolNamesOf(session);
  const items = [];
  const turns = new Map(); // turn → { start, end, tokens, count, guarded }
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (!event || !MESSAGE_TYPES.has(event.type) || event.type === 'system/message') continue;
    const tokens = priceOf(seq);
    const turn = turnOf?.(seq);
    if (turn !== undefined && turn !== currentTurn) {
      const t = turns.get(turn) ?? { start: seq, end: seq, tokens: 0, count: 0, guarded: false };
      t.end = seq; t.tokens += tokens; t.count += 1; t.guarded ||= guarded.has(seq);
      turns.set(turn, t);
    }
    if (guarded.has(seq)) continue;
    if (isCheckpoint(event)) {
      if (tokens >= limits.block) items.push({ kind: 'block', start: seq, end: seq, tokens, label: 'ACP summary block' });
    } else if (tokens >= limits.message) {
      items.push({ kind: 'message', start: seq, end: seq, tokens, label: labelOf(event, toolNames), turn });
    }
  }
  for (const [turn, t] of turns) {
    if (t.guarded || t.tokens < limits.turn || t.count < 2) continue;
    items.push({ kind: 'turn', start: t.start, end: t.end, tokens: t.tokens, label: `turn ${turn} (${t.count} msgs)`, turn });
  }
  items.sort((a, b) => b.tokens - a.tokens);
  return { items, limits };
}

export function fmtTokens(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n));
}

export function renderLargeList(items, { maxItems, currentTurn, usagePct } = {}) {
  const shown = items.slice(0, maxItems ?? items.length);
  const lines = shown.map((it) => {
    const span = it.start === it.end ? `seq ${it.start}` : `seqs ${it.start}–${it.end}`;
    const age = it.turn !== undefined && currentTurn !== undefined ? ` · ${Math.max(0, currentTurn - it.turn)} turns ago` : '';
    return `· ${span} · ${it.label} · ~${fmtTokens(it.tokens)} tok${age}`;
  });
  const total = items.reduce((sum, it) => sum + (it.kind === 'turn' ? 0 : it.tokens), 0);
  const more = items.length > shown.length ? `\n· …and ${items.length - shown.length} more (context_large_blocks lists all)` : '';
  const usage = usagePct !== undefined ? `usage ${Math.round(usagePct * 100)}% · ` : '';
  return `${lines.join('\n')}${more}\n${usage}oversized messages/blocks ~${fmtTokens(total)} tok`;
}

// --- markers (the text that replaces a range on the surface) ---------------

export function sanitizeInline(text, max) {
  return String(text ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);
}

export function exportMarker({ file, count, start, end, tokens, note }) {
  const n = note ? ` · note: ${note}` : '';
  return `[CONTEXT EXPORTED (temp file) → ${file} · ${count} msgs · seqs ${start}–${end} · ~${fmtTokens(tokens)} tok${n} · open only if needed; manage with context_exports]`;
}

export function deleteMarker({ count, start, end, tokens, reason }) {
  return `[DELETED REFERENCES · seqs ${start}–${end} · ${count} msgs · ~${fmtTokens(tokens)} tok · reason: ${reason}]`;
}

// --- export store -----------------------------------------------------------
//
// One directory per session under <root>/<sessionId>/ (0700), one Markdown
// file per export (0600), plus index.json with metadata so listing never
// needs to open an export. Nothing here deletes anything on its own.

export function exportRoot(cfg) {
  return cfg.exportRoot || path.join(os.tmpdir(), PLUGIN);
}

const SAFE_SESSION = /^[A-Za-z0-9._-]{1,128}$/;
const SAFE_FILE = /^[A-Za-z0-9._-]{1,160}\.md$/;

export function sessionDir(cfg, sessionId) {
  if (!SAFE_SESSION.test(String(sessionId))) throw new Error(`invalid session id for export dir: ${sessionId}`);
  return path.join(exportRoot(cfg), sessionId);
}

export function slug(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

export function exportFileName({ name, start, end, now = new Date() }) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}_${slug(name) || `seqs-${start}-${end}`}.md`;
}

function readIndex(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    return data && typeof data === 'object' && data.exports && typeof data.exports === 'object' ? data : { exports: {} };
  } catch {
    return { exports: {} };
  }
}

function writeIndex(dir, index) {
  const tmp = path.join(dir, `index.json.tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, 'index.json'));
}

export function renderExport({ sessionId, start, end, events, toolNames, tokens, note, now = new Date() }) {
  const head = [
    `# Context export — ${PLUGIN}`,
    '',
    `- session: ${sessionId}`,
    `- seqs: ${start}–${end} (${events.length} messages, ~${fmtTokens(tokens)} tokens)`,
    `- exported: ${now.toISOString()}`,
    ...(note ? [`- note: ${note}`] : []),
    '',
    '---',
    '',
  ];
  const body = events.map((event) => `## seq ${event.seq} · ${labelOf(event, toolNames)}\n\n${textOf(event) || '(no text content)'}\n`);
  return head.join('\n') + body.join('\n');
}

export function writeExport(cfg, sessionId, fileName, content, meta) {
  if (!SAFE_FILE.test(fileName)) throw new Error(`invalid export file name: ${fileName}`);
  const dir = sessionDir(cfg, sessionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, content, { mode: 0o600, flag: 'wx' });
  const index = readIndex(dir);
  index.exports[fileName] = { ...meta, bytes: Buffer.byteLength(content) };
  writeIndex(dir, index);
  return file;
}

export function removeExportFile(cfg, sessionId, fileName) {
  const dir = sessionDir(cfg, sessionId);
  try { fs.unlinkSync(path.join(dir, fileName)); } catch {}
  const index = readIndex(dir);
  if (index.exports[fileName]) { delete index.exports[fileName]; writeIndex(dir, index); }
}

// Names + metadata only — never file contents.
export function listExports(cfg, sessionId) {
  const dir = sessionDir(cfg, sessionId);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => SAFE_FILE.test(n)); } catch { return { dir, exports: [] }; }
  const index = readIndex(dir);
  const exports = names.sort().map((name) => {
    let bytes = 0;
    try { bytes = fs.statSync(path.join(dir, name)).size; } catch {}
    const meta = index.exports[name] ?? {};
    return { name, bytes, ...(meta.createdAt ? { createdAt: meta.createdAt } : {}), ...(meta.start !== undefined ? { seqs: `${meta.start}–${meta.end}`, messages: meta.count, tokens: meta.tokens } : {}), ...(meta.note ? { note: meta.note } : {}) };
  });
  return { dir, exports };
}

// Deletes only inside this session's own directory; names are validated
// basenames, so `../` or absolute paths can never escape it.
export function deleteExports(cfg, sessionId, { names, all }) {
  const dir = sessionDir(cfg, sessionId);
  const { exports } = listExports(cfg, sessionId);
  const existing = new Set(exports.map((e) => e.name));
  const targets = all === true ? [...existing] : (Array.isArray(names) ? names : []);
  const deleted = [];
  const missing = [];
  for (const name of targets) {
    if (!SAFE_FILE.test(String(name)) || !existing.has(name)) { missing.push(String(name)); continue; }
    fs.unlinkSync(path.join(dir, name));
    deleted.push(name);
  }
  const index = readIndex(dir);
  for (const name of deleted) delete index.exports[name];
  if (fs.existsSync(dir)) writeIndex(dir, index);
  if (all === true) {
    try { fs.rmSync(path.join(dir, 'index.json'), { force: true }); fs.rmdirSync(dir); } catch {}
  }
  return { deleted, missing };
}
