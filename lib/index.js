// billion-context-relief — agent-requested context relief for DSH, as a
// companion to billion-context-dsh (ACP).
//
// Tools (nothing here runs on its own — every change is an explicit agent call):
//   context_large_blocks — list oversized messages / completed turns / ACP
//                          summary blocks outside the kernel's protected zone
//   context_export       — write a surface range to a temp file and replace
//                          it with a one-line pointer (the model never reads it)
//   context_delete       — replace a surface range with a DELETED REFERENCES
//                          marker, no summary
//   context_exports      — list / delete this session's export files by name
// Advisor: at most one rate-limited notice listing oversized items. It only
// informs; it never removes or edits anything.
//
// Every replacement goes through ACP's own compress path (makeTools(env) →
// handleCompress: kernel.applyCompression → store.set → durable transaction),
// so the result is a normal ACP block that acp_status / search_context /
// decompress understand. The only difference from a model `compress` call is a
// per-call `compress.minCompressRange: 0` override (so a small reminder can be
// removed on its own) and that our own tool call is not hidden afterwards.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PLUGIN,
  resolveConfig,
  scanLarge,
  renderLargeList,
  toolNamesOf,
  protectedSeqs,
  sanitizeInline,
  exportMarker,
  deleteMarker,
  exportFileName,
  renderExport,
  writeExport,
  removeExportFile,
  listExports,
  deleteExports,
  fmtTokens,
  widenForPairing,
} from './core.js';

export const name = PLUGIN;
export const inject = ['tools'];

const log = (...args) => { try { console.log(`[${PLUGIN}]`, ...args); } catch {} };

let acpModule = null;

// Test seam: lets the unit suite substitute a fake billion-context-dsh module.
export function __setAcpModuleForTests(mod) { acpModule = mod; }

// Candidate install locations of billion-context-dsh in DSH profiles. Needed
// because this plugin may be linked from a folder outside the profile, where a
// bare `import('billion-context-dsh')` cannot resolve.
export function acpCandidates(dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')) {
  const out = [];
  let profiles = [];
  try { profiles = fs.readdirSync(path.join(dshHome, 'profiles')); } catch {}
  for (const profile of profiles) {
    const dir = path.join(dshHome, 'profiles', profile, 'node_modules', 'billion-context-dsh');
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const dot = pkg.exports?.['.'];
      const entry = typeof dot === 'string' ? dot : (dot?.import ?? dot?.default ?? pkg.module ?? pkg.main ?? 'index.js');
      out.push(path.join(dir, typeof entry === 'string' ? entry : entry.default ?? 'index.js'));
    } catch {}
  }
  return out;
}

// Load the billion-context-dsh module the LIVE engine came from: the normal
// import first, then the profile installs. A candidate is accepted only when
// `engine instanceof mod.AcpCompactionEngine`, so instanceof checks (e.g.
// AlreadyCompressedRangeError) and shared helpers match the running engine.
async function loadAcp(engine) {
  if (acpModule) return acpModule;
  const matches = (mod) => mod && typeof mod.makeTools === 'function'
    && (engine === undefined || (typeof mod.AcpCompactionEngine === 'function' && engine instanceof mod.AcpCompactionEngine));
  try {
    const mod = await import('billion-context-dsh');
    if (matches(mod)) return (acpModule = mod);
  } catch {}
  for (const file of acpCandidates()) {
    try {
      const mod = await import(pathToFileURL(file).href);
      if (matches(mod)) { log(`using billion-context-dsh from ${path.dirname(path.dirname(file))}`); return (acpModule = mod); }
    } catch {}
  }
  log('billion-context-dsh module matching the live engine not found — relief tools cannot act');
  return null;
}

// The ACP engine is the `compaction` service; anything else has no kernel.
function acpEngineFor(ctx, agent) {
  const engine = agent?.ctx?.get?.('compaction') ?? ctx.get?.('compaction');
  return engine && engine.env && engine.env.kernel && engine.env.store ? engine : null;
}

function meterFor(ctx, agent) {
  return agent?.ctx?.get?.('tokenMeter') ?? agent?.ctx?.tokenMeter ?? ctx.get?.('tokenMeter') ?? null;
}

// seq → host price. The fixed-heuristic basis is what ACP records as
// shadowedTokenCount, so the numbers we show match acp_status.
function pricing(ctx, agent, session) {
  const meter = meterFor(ctx, agent);
  const measurement = meter?.measure?.(session);
  const bySeq = new Map();
  for (const node of measurement?.nodes ?? []) bySeq.set(node.seq, node.heuristicTokens ?? node.tokens ?? 0);
  const priceOf = (seq) => {
    if (bySeq.has(seq)) return bySeq.get(seq);
    const text = JSON.stringify(session.eventAt(seq)?.data ?? '');
    return Math.ceil(text.length / 4);
  };
  return { priceOf, totalTokens: measurement?.totalTokens };
}

function eventsOf(session) {
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents();
  if (Array.isArray(session.events)) return session.events;
  return [];
}

// seq → turn number, plus the turn that is still open (never touched).
function turnsOf(session) {
  const bySeq = new Map();
  let current;
  let open;
  for (const event of eventsOf(session)) {
    if (event.type === 'turn/start') { current = event.data?.turn; open = current; continue; }
    if (event.type === 'turn/end' && event.data?.turn === open) open = undefined;
    if (current !== undefined) bySeq.set(event.seq, current);
  }
  return { turnOf: (seq) => bySeq.get(seq), openTurn: open, lastTurn: current };
}

async function usageOf(engine, agent, totalTokens) {
  try {
    const window = await engine.windowFor?.(agent);
    if (window?.limit > 0 && totalTokens !== undefined) return totalTokens / window.limit;
  } catch {}
  return undefined;
}

function sessionIdOf(agent) {
  return agent?.session?.id ?? agent?.id ?? null;
}

// Accepts a surface seq (integer / numeric string) or an ACP message ref
// (mNNNNN, as shown by acp_status drilldowns).
function parseBoundary(value, engine, session) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  const raw = String(value ?? '').trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  if (/^m\d+$/i.test(raw)) {
    const byRef = engine.env.store.stateFor?.(session)?.messageRefs?.byRef;
    const hit = byRef?.[raw.toLowerCase()] ?? byRef?.[raw];
    const seq = hit !== undefined ? Number.parseInt(String(hit), 10) : NaN;
    if (Number.isInteger(seq)) return seq;
    throw new Error(`unknown ref ${raw} — run acp_status (or context_large_blocks) and use the surface seqs it reports`);
  }
  throw new Error(`invalid boundary ${JSON.stringify(value)} — pass a surface seq (integer) or an mNNNNN ref`);
}

const TEXT_OUTPUT = {
  schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },
  render: (_args, value) => [{ type: 'text', text: value.text }],
};

export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  const advisorState = new Map(); // sessionId → { steps, lastStep, lastKey }

  // Resolve + validate a requested range against the live session. Returns
  // the exact balanced span ACP will shadow, so the marker we write names it.
  async function prepareRange(exec, args) {
    const agent = exec?.agent;
    const session = agent?.session;
    if (!session) throw new Error('caller session unavailable');
    const engine = acpEngineFor(ctx, agent);
    const acp = engine ? await loadAcp(engine) : null;
    if (!acp || !engine) throw new Error('billion-context-dsh (ACP) is not the active compaction engine in this session — relief tools need it');
    const startSeq = parseBoundary(args?.startSeq, engine, session);
    const endSeq = parseBoundary(args?.endSeq, engine, session);
    const wide = widenForPairing(session, Math.min(startSeq, endSeq), Math.max(startSeq, endSeq));
    let resolved;
    try {
      resolved = acp.resolveSurfaceRange(session, wide.start, wide.end);
    } catch (e) {
      if (e instanceof acp.AlreadyCompressedRangeError) throw new Error(`seqs ${e.start}..${e.end} are already inside an ACP block — nothing to relieve; decompress reads the originals`);
      throw e;
    }
    const seqs = acp.shadowedSeqsOf(session, resolved.start, resolved.end);
    if (seqs.length === 0) throw new Error(`seqs ${resolved.start}..${resolved.end} contain no model-visible messages`);
    const { priceOf, totalTokens } = pricing(ctx, agent, session);
    const { turnOf, openTurn } = turnsOf(session);
    if (openTurn !== undefined && seqs.some((seq) => turnOf(seq) === openTurn)) {
      throw new Error(`seqs ${resolved.start}..${resolved.end} reach into the current (open) turn — only completed turns can be relieved`);
    }
    const guarded = protectedSeqs(session, priceOf);
    const hits = seqs.filter((seq) => guarded.has(seq));
    if (hits.length > 0) {
      throw new Error(`seqs ${hits.slice(0, 5).join(', ')}${hits.length > 5 ? '…' : ''} are in the protected zone (last 5 messages / last 5K tokens / most recent user message) — pick older messages`);
    }
    const events = seqs.map((seq) => session.eventAt(seq)).filter(Boolean);
    const tokens = seqs.reduce((sum, seq) => sum + priceOf(seq), 0);
    return { agent, session, acp, engine, start: resolved.start, end: resolved.end, seqs, events, tokens, priceOf, totalTokens, turnOf };
  }

  // Run ACP's own compress handler with our marker as the summary.
  async function replaceWithMarker(prep, marker, exec) {
    const { acp, engine } = prep;
    const env = {
      ...engine.env,
      compressCallIdsToHide: undefined,
      coreOverrides: {
        ...engine.env.coreOverrides,
        compress: { ...engine.env.coreOverrides?.compress, minCompressRange: 0 },
      },
    };
    const compress = acp.makeTools(env).find((tool) => tool.name === 'compress');
    if (!compress) throw new Error('ACP compress tool not found in billion-context-dsh');
    const result = await compress.execute({ content: [{ startSeq: prep.start, endSeq: prep.end, summary: marker }] }, exec);
    const text = typeof result?.text === 'string' ? result.text : JSON.stringify(result);
    const created = Number(/Compressed (\d+) block/.exec(text)?.[1] ?? 0);
    return { ok: created > 0, text };
  }

  function largeSummary(exec, max) {
    try {
      const agent = exec?.agent;
      const session = agent?.session;
      if (!session) return '';
      const { priceOf } = pricing(ctx, agent, session);
      const { turnOf, openTurn, lastTurn } = turnsOf(session);
      const { items } = scanLarge(session, { priceOf, turnOf, cfg, currentTurn: openTurn });
      if (items.length === 0) return '\nNo oversized items remain.';
      return `\nRemaining oversized items:\n${renderLargeList(items, { maxItems: max, currentTurn: openTurn ?? lastTurn })}`;
    } catch {
      return '';
    }
  }

  const tools = ctx.get('tools');
  const disposers = [];
  const register = (definition) => {
    try { disposers.push(tools.register({ ...definition, output: TEXT_OUTPUT })); }
    catch (e) { log(`failed to register ${definition.name}: ${e?.message}`); }
  };

  register({
    name: 'context_large_blocks',
    description: `List oversized context items you can relieve: single messages ≥ ${cfg.largeMessageTokens} tokens, completed turns ≥ ${cfg.largeTurnTokens} tokens, ACP summary blocks ≥ ${cfg.largeBlockTokens} tokens. Items in the protected zone (last 5 messages / last 5K tokens / latest user message) and the current turn are excluded. Read-only. Act on results with context_export (keeps a temp file) or context_delete (no copy kept).`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        largeMessageTokens: { type: 'integer', minimum: 0, description: 'Override the single-message threshold for this call.' },
        largeTurnTokens: { type: 'integer', minimum: 0, description: 'Override the per-turn threshold for this call.' },
        largeBlockTokens: { type: 'integer', minimum: 0, description: 'Override the ACP summary-block threshold for this call.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max items to list (default 20).' },
      },
    },
    async execute(args, exec) {
      try {
        const agent = exec?.agent;
        const session = agent?.session;
        if (!session) return { text: 'context_large_blocks: caller session unavailable' };
        const engine = acpEngineFor(ctx, agent);
        const { priceOf, totalTokens } = pricing(ctx, agent, session);
        const { turnOf, openTurn, lastTurn } = turnsOf(session);
        const { items, limits } = scanLarge(session, { priceOf, turnOf, cfg, currentTurn: openTurn, overrides: args ?? {} });
        const usagePct = engine ? await usageOf(engine, agent, totalTokens) : undefined;
        const head = `Thresholds: message ≥${fmtTokens(limits.message)} · turn ≥${fmtTokens(limits.turn)} · ACP block ≥${fmtTokens(limits.block)} tokens.`;
        if (items.length === 0) return { text: `${head}\nNo oversized items outside the protected zone.${usagePct !== undefined ? ` Usage ${Math.round(usagePct * 100)}%.` : ''}` };
        return { text: `${head}\n${renderLargeList(items, { maxItems: args?.limit ?? 20, currentTurn: openTurn ?? lastTurn, usagePct })}\nTurn entries overlap their messages — act on either, not both.` };
      } catch (e) {
        return { text: `context_large_blocks failed: ${e?.message ?? e}` };
      }
    },
  });

  register({
    name: 'context_export',
    description: 'Move a range of COMPLETED context out of your window into a temporary file and replace it with a one-line pointer (file path + name). The content is written to disk without you reading it. Use it for bulky material you might need again (logs, file dumps, long tool output). The file lives in a per-session temp folder and is only removed when you call context_exports. Boundaries: surface seqs or mNNNNN refs from context_large_blocks / acp_status. The range is widened to keep tool calls paired; the pointer names the exact span.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['startSeq', 'endSeq'],
      properties: {
        startSeq: { description: 'First surface seq (integer) or mNNNNN ref.' },
        endSeq: { description: 'Last surface seq (integer) or mNNNNN ref.' },
        name: { type: 'string', description: 'Short file-name hint, e.g. "pytest-run-3" (letters/digits/dashes).' },
        note: { type: 'string', description: 'One line kept in the pointer, e.g. what the export contains (max 120 chars).' },
      },
    },
    async execute(args, exec) {
      let written = null;
      let prep;
      try {
        prep = await prepareRange(exec, args);
        const sessionId = sessionIdOf(prep.agent);
        const note = sanitizeInline(args?.note, cfg.reasonMaxChars);
        const fileName = exportFileName({ name: args?.name, start: prep.start, end: prep.end });
        const content = renderExport({ sessionId, start: prep.start, end: prep.end, events: prep.events, toolNames: toolNamesOf(prep.session), tokens: prep.tokens, note });
        written = writeExport(cfg, sessionId, fileName, content, { createdAt: new Date().toISOString(), start: prep.start, end: prep.end, count: prep.events.length, tokens: prep.tokens, ...(note ? { note } : {}) });
        const marker = exportMarker({ file: written, count: prep.events.length, start: prep.start, end: prep.end, tokens: prep.tokens, note });
        const outcome = await replaceWithMarker(prep, marker, exec);
        if (!outcome.ok) {
          removeExportFile(cfg, sessionId, fileName);
          return { text: `context_export: ACP refused the range, nothing changed and no file kept.\n${outcome.text}` };
        }
        log(`export ${sessionId} seqs ${prep.start}..${prep.end} (${prep.events.length} msgs, ~${prep.tokens} tok) → ${fileName}`);
        return { text: `Exported ${prep.events.length} messages (seqs ${prep.start}–${prep.end}, ~${fmtTokens(prep.tokens)} tokens) to ${written}. The range now reads as a pointer.${largeSummary(exec, 3)}` };
      } catch (e) {
        if (written && prep) removeExportFile(cfg, sessionIdOf(prep.agent), written.split('/').pop());
        return { text: `context_export failed, nothing changed: ${e?.message ?? e}` };
      }
    },
  });

  register({
    name: 'context_delete',
    description: `Drop a range of COMPLETED context from your window with NO summary and NO file — it is replaced by a "[DELETED REFERENCES · seqs a–b …]" marker. Not undoable in this session (acp decompress can still READ the originals from the session log). Use only for content with no further value: dead-end exploration, repeated status checks, superseded snapshots, stale reminders. Prefer context_export when unsure. A short reason is required; ranges over ${cfg.deleteConfirmTokens} tokens also need confirm:true.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['startSeq', 'endSeq', 'reason'],
      properties: {
        startSeq: { description: 'First surface seq (integer) or mNNNNN ref.' },
        endSeq: { description: 'Last surface seq (integer) or mNNNNN ref.' },
        reason: { type: 'string', description: `Why it is safe to drop (kept in the marker, max ${cfg.reasonMaxChars} chars).` },
        confirm: { type: 'boolean', description: `Required for ranges over ${cfg.deleteConfirmTokens} tokens.` },
      },
    },
    async execute(args, exec) {
      try {
        const reason = sanitizeInline(args?.reason, cfg.reasonMaxChars);
        if (!reason) return { text: 'context_delete refused: a reason is required.' };
        const prep = await prepareRange(exec, args);
        if (prep.tokens > cfg.deleteConfirmTokens && args?.confirm !== true) {
          return { text: `context_delete refused: seqs ${prep.start}–${prep.end} hold ~${fmtTokens(prep.tokens)} tokens (> ${fmtTokens(cfg.deleteConfirmTokens)}). Call again with confirm:true, or use context_export to keep a copy.` };
        }
        const marker = deleteMarker({ count: prep.events.length, start: prep.start, end: prep.end, tokens: prep.tokens, reason });
        const outcome = await replaceWithMarker(prep, marker, exec);
        if (!outcome.ok) return { text: `context_delete: ACP refused the range, nothing changed.\n${outcome.text}` };
        log(`delete ${sessionIdOf(prep.agent)} seqs ${prep.start}..${prep.end} (${prep.events.length} msgs, ~${prep.tokens} tok) reason: ${reason}`);
        return { text: `Deleted ${prep.events.length} messages (seqs ${prep.start}–${prep.end}, ~${fmtTokens(prep.tokens)} tokens).${largeSummary(exec, 3)}` };
      } catch (e) {
        return { text: `context_delete failed, nothing changed: ${e?.message ?? e}` };
      }
    },
  });

  register({
    name: 'context_exports',
    description: 'Manage this session\'s context_export files by NAME only — never opens them. action "list": file names, sizes, seq spans, notes. action "delete": remove files given in names (or all:true). Only your own session\'s exports are visible or deletable. Deleting a file makes its pointer dead; the originals stay readable via acp decompress.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'delete'] },
        names: { type: 'array', items: { type: 'string' }, description: 'File names from action "list" (delete only).' },
        all: { type: 'boolean', description: 'Delete every export of this session.' },
      },
    },
    async execute(args, exec) {
      try {
        const sessionId = sessionIdOf(exec?.agent);
        if (!sessionId) return { text: 'context_exports: caller session unavailable' };
        if (args?.action === 'delete') {
          if (args?.all !== true && !(Array.isArray(args?.names) && args.names.length)) return { text: 'context_exports delete: pass names:[...] or all:true' };
          const { deleted, missing } = deleteExports(cfg, sessionId, { names: args?.names, all: args?.all === true });
          if (deleted.length) log(`exports deleted ${sessionId}: ${deleted.length}`);
          return { text: `Deleted ${deleted.length} export(s)${deleted.length ? `: ${deleted.join(', ')}` : ''}.${missing.length ? ` Not found: ${missing.join(', ')}.` : ''}` };
        }
        const { dir, exports } = listExports(cfg, sessionId);
        if (exports.length === 0) return { text: `No exports for this session (${dir}).` };
        const total = exports.reduce((sum, e) => sum + e.bytes, 0);
        const rows = exports.map((e) => `· ${e.name} · ${(e.bytes / 1024).toFixed(1)} KB${e.seqs ? ` · seqs ${e.seqs} · ${e.messages} msgs · ~${fmtTokens(e.tokens)} tok` : ''}${e.note ? ` · ${e.note}` : ''}`);
        return { text: `${exports.length} export(s), ${(total / 1024 / 1024).toFixed(2)} MB in ${dir}:\n${rows.join('\n')}` };
      } catch (e) {
        return { text: `context_exports failed: ${e?.message ?? e}` };
      }
    },
  });

  // --- advisor: inform only, never modify -----------------------------------
  if (cfg.advisorEnabled) {
    disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
      try {
        const agent = payload?.agent;
        const session = agent?.session;
        const sessionId = sessionIdOf(agent);
        if (session && sessionId && typeof agent.inject === 'function') {
          const st = advisorState.get(sessionId) ?? { steps: 0, lastStep: -Infinity, lastKey: '' };
          st.steps += 1;
          advisorState.set(sessionId, st);
          if (advisorState.size > 256) advisorState.delete(advisorState.keys().next().value);
          if (st.steps - st.lastStep >= cfg.advisorCooldownSteps) {
            const engine = acpEngineFor(ctx, agent);
            if (engine) {
              const { priceOf, totalTokens } = pricing(ctx, agent, session);
              const usagePct = await usageOf(engine, agent, totalTokens);
              if (usagePct !== undefined && usagePct >= cfg.minUsagePct) {
                const { turnOf, openTurn, lastTurn } = turnsOf(session);
                const { items } = scanLarge(session, { priceOf, turnOf, cfg, currentTurn: openTurn });
                const key = items.slice(0, cfg.maxItems).map((it) => `${it.kind}:${it.start}-${it.end}`).join('|');
                if (items.length > 0 && key !== st.lastKey) {
                  st.lastKey = key;
                  st.lastStep = st.steps;
                  agent.inject({
                    id: `bcr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
                    role: 'user',
                    content: [{ type: 'text', text: `[${PLUGIN}: large context — act on it if no longer needed]\n${renderLargeList(items, { maxItems: cfg.maxItems, currentTurn: openTurn ?? lastTurn, usagePct })}\nTools: context_export (keep a temp copy) · context_delete (drop, no copy). This notice can itself be removed with context_delete.` }],
                    source: { kind: `plugin:${PLUGIN}`, plugin: PLUGIN },
                  });
                  log(`advisor notice → ${sessionId}: ${items.length} item(s), usage ${Math.round(usagePct * 100)}%`);
                }
              }
            }
          }
        }
      } catch (e) {
        log(`advisor skipped: ${e?.message ?? e}`);
      }
      return next();
    }));
  }

  log(`ready — tools: context_large_blocks, context_export, context_delete, context_exports · advisor=${cfg.advisorEnabled} · exports in ${cfg.exportRoot || '<tmpdir>/billion-context-relief'}`);

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of disposers) { try { dispose?.(); } catch {} }
    }, `${PLUGIN}: tools + advisor`);
  }
}
