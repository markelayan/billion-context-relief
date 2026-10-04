# billion-context-relief

Agent-requested context relief for [DSH](https://github.com/deepseek-ai/deepseek-harness), as a companion to [billion-context-dsh](https://github.com/Tyan66666/billion-context-dsh) (ACP).

ACP lets an agent **compress** a range into a summary it writes. Sometimes a summary is the wrong tool:

- the content is bulky but might be needed again verbatim (a long log, a file dump), so keep it **outside** the window, not summarized;
- the content has no further value at all (a dead-end search, a superseded snapshot, a stale reminder), so it should simply **go**.

This plugin adds those two moves, plus a way to find what is worth moving. **Every change is an explicit agent call.** The only thing that runs on its own is an advisor notice, and it only informs; it never edits or removes anything.

## Tools

| Tool | What it does |
|---|---|
| `context_large_blocks` | Lists oversized items outside the protected zone: single messages ≥ `largeMessageTokens`, completed turns ≥ `largeTurnTokens`, ACP summary blocks ≥ `largeBlockTokens`. Read-only. |
| `context_export` | Writes a range of completed context to a temp file **without the model reading it**, and replaces the range with one line: `[CONTEXT EXPORTED (temp file) → <path> · N msgs · seqs a–b · ~T tok …]`. |
| `context_delete` | Replaces a range with `[DELETED REFERENCES · seqs a–b · N msgs · ~T tok · reason: …]`. No summary, no file. A `reason` is required; ranges over `deleteConfirmTokens` also need `confirm: true`. |
| `context_exports` | `list` this session's export files (names, sizes, spans, notes; never contents) or `delete` them by name / `all: true`. |

Boundaries are surface seqs (integers) or ACP `mNNNNN` refs, as shown by `context_large_blocks` and `acp_status`.

### How replacements work

Each replacement goes through **ACP's own compress path** (`makeTools(env)` → `handleCompress` → `kernel.applyCompression` → state store → durable compaction transaction), with the pointer or marker as the "summary". So the result is a normal ACP block:

- `acp_status` lists it, `search_context` finds text inside it, and `decompress` can still **read** the originals from the session log;
- DSH's usage meter credits the freed tokens.

Two per-call differences from a model `compress`: `compress.minCompressRange` is set to `0` (ACP's 5,000-char floor would otherwise stop a single small reminder from being removed), and the calling tool's own result is not hidden. ACP's global configuration is never changed.

### What it refuses

- the current (open) turn;
- the kernel's protected zone: the last 5 messages, the last 5K tokens, and the most recent user message;
- ranges already inside an ACP block (`decompress` reads those);
- the newest AGENTS.md / agent-instructions copy (ACP rejects it: DSH re-injects it immediately).

### Not undoable

ACP's `decompress` returns the original content for reading, but it does **not** un-compress the range. Treat `context_delete` as permanent for the session; use `context_export` when unsure.

## Advisor

When usage is at least `minUsagePct` and the set of oversized items has changed, at most once every `advisorCooldownSteps` steps, the agent receives one notice:

```
[billion-context-relief: large context — act on it if no longer needed]
· seq 342 · tool bash · ~9.2K tok · 23 turns ago
· seq 118 · runtime-context snapshot · ~4.2K tok · 30 turns ago
usage 61% · oversized messages/blocks ~13.4K tok
Tools: context_export (keep a temp copy) · context_delete (drop, no copy). This notice can itself be removed with context_delete.
```

Older notices are never removed automatically; the agent can delete them like any other content.

## Exports

Files go to `<os tmpdir>/billion-context-relief/<session-id>/` (directory `0700`, files `0600`), each with an `index.json` holding metadata so listing never opens an export. **Nothing deletes them automatically**: they stay until the agent calls `context_exports` with `delete`. On macOS, the operating system may itself purge old files in the temp directory; set `exportRoot` to keep them elsewhere.

Exports contain raw conversation content, including anything sensitive a tool printed. Keep `exportRoot` outside any repository.

## Configuration

Defaults ship in this package's `cordis.patch.yml`; override them with a same-id row in your profile's `cordis.patch.yml`:

```yaml
- id: billion-context-relief
  config:
    largeMessageTokens: 4000
    largeTurnTokens: 12000
    largeBlockTokens: 3000
    minUsagePct: 0.4
    advisorEnabled: true
    advisorCooldownSteps: 8
    maxItems: 5
    deleteConfirmTokens: 8000
    reasonMaxChars: 120
    exportRoot: ''        # '' → <os tmpdir>/billion-context-relief
```

## Requirements

- DSH 0.2.0-rc.2 with **billion-context-dsh** as the active compaction engine (tested against the `2026-09-30_dsh-0.2-seam-port` line). Without ACP, the tools explain why they cannot act and change nothing.
- Uses ACP's exported `makeTools`, `resolveSurfaceRange`, `shadowedSeqsOf` and `AlreadyCompressedRangeError`.
- **Reopen sessions after installing**: a session's tool list is fixed when it is composed.

## Install (local link)

```bash
dsh plugin --profile web add "billion-context-relief@link:local-plugins/billion-context-relief"
```

Then restart `dsh web` and reopen the sessions that should use it.

## Development

```bash
npm test
```

## License

MIT
