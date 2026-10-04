# billion-context-relief

Agent-requested context relief for [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness). A companion plugin to **[billion-context-dsh](https://github.com/Tyan66666/billion-context-dsh)** (ACP).

ACP lets an agent **compress** a range of its context into a summary the agent writes. Sometimes a summary is the wrong tool:

- **Bulky but possibly needed again verbatim** (a long log, a fetched page, a file dump). Move it **out** of the window into a file and keep a pointer: `context_export`.
- **No further value at all** (a dead-end search, a superseded snapshot, a stale reminder). Drop it, with no summary and no file: `context_delete`.

The plugin adds those two moves, plus a way to find what is worth moving (`context_large_blocks`) and a way to clean up the exported files (`context_exports`).

**Every change is an explicit agent call.** Nothing is compressed, exported, deleted or cleaned up automatically. The only thing that runs on its own is an advisor notice, and it only informs.

---

## Contents

- [Requirements and compatibility](#requirements-and-compatibility)
- [ACP dependency](#acp-dependency)
- [Install](#install)
- [Tools](#tools)
- [How replacements work](#how-replacements-work)
- [What it refuses](#what-it-refuses)
- [Advisor](#advisor)
- [Exports](#exports)
- [Configuration](#configuration)
- [Safety and data notes](#safety-and-data-notes)
- [Upgrading and reloading](#upgrading-and-reloading)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Related plugins](#related-plugins)

---

## Requirements and compatibility

| Component | Version | Status |
|---|---|---|
| DSH | `0.2.0-rc.2` | ✅ compatible. Live-tested in a real DSH session (export, delete, refusals, export cleanup). |
| DSH | `0.1.x` | ❌ not supported. The 0.2 compaction seam and session surface are required. |
| billion-context-dsh (ACP) | `github:Tyan66666/billion-context-dsh#2026-09-30_dsh-0.2-seam-port` (reports `0.2.26`) | ✅ tested |
| billion-context-dsh (ACP) | npm `billion-context-dsh@0.2.26` | ⚠️ expected to work (same version and exports), not tested |
| billion-context-dsh (ACP) | the DSH 0.1 line | ❌ not supported |
| Node.js | `>= 20` | required |

Runtime dependencies: none. `billion-context-dsh` is a **peer** dependency: it must already be installed in the same DSH profile and active as the compaction engine.

The declared DSH compatibility is in `package.json` → `dsh.compatibility.dshReleases`.

## ACP dependency

This plugin does **not** implement its own compaction. Every replacement is made through ACP's own compress path, so ACP must be:

1. **installed** in the profile (`billion-context-dsh` in the profile's `package.json`), and
2. **the active compaction engine**, i.e. listed in `dsh.profile.bundles`. ACP's bundle replaces `compaction-basic`.

What it uses from ACP (all public exports of `billion-context-dsh`):

| Export | Used for |
|---|---|
| `AcpCompactionEngine` | identifying the live engine (`ctx.compaction`) and reading its `env` and context window |
| `makeTools(env)` → `compress` | performing each replacement through ACP's compress handler |
| `resolveSurfaceRange` | resolving a requested span to ACP's live, tool-pair-balanced range |
| `shadowedSeqsOf` | the exact messages a range will hide |
| `AlreadyCompressedRangeError` | refusing ranges that are already inside an ACP block |

How ACP is located:

- First as a normal import (`billion-context-dsh` resolvable from this package).
- When this plugin is **linked from a folder outside the profile** (`link:` install), from `~/.dsh/profiles/*/node_modules/billion-context-dsh`. Only a copy whose `AcpCompactionEngine` is the class of the live engine is accepted, so a stale or second copy is never used.

**Without ACP** (not installed, or another compaction engine active), every tool answers that ACP is required and changes nothing. The advisor stays silent.

ACP's global configuration is never modified. See [How replacements work](#how-replacements-work) for the two per-call differences.

## Install

Install ACP first, if the profile doesn't have it yet:

```bash
dsh plugin --profile web add "billion-context-dsh@github:Tyan66666/billion-context-dsh#2026-09-30_dsh-0.2-seam-port"
```

Then install this plugin, from GitHub (pinned to a release tag):

```bash
dsh plugin --profile web add "billion-context-relief@github:markelayan/billion-context-relief#v0.1.2"
```

or from npm:

```bash
dsh plugin --profile web add billion-context-relief
```

or as a local link, for development:

```bash
dsh plugin --profile web add "billion-context-relief@link:/path/to/billion-context-relief"
```

`dsh plugin add` puts the package in the profile's `package.json` and in `dsh.profile.bundles`, and the running DSH picks it up without a restart. The plugin's tools appear in **sessions opened after the install**: a session's tool list is fixed when the session is composed, so reopen sessions that should use it.

Check that it loaded: the DSH log (`~/.dsh/dsh-web.log` for `dsh web`) shows

```
[billion-context-relief] ready — tools: context_large_blocks, context_export, context_delete, context_exports · advisor=true · exports in <tmpdir>/billion-context-relief
```

Uninstall:

```bash
dsh plugin --profile web remove billion-context-relief
```

Blocks already created stay in the sessions as ordinary ACP blocks. Export files stay on disk until deleted; see [Exports](#exports).

## Tools

Range boundaries are **surface seqs** (integers) or ACP **`mNNNNN` refs**, as shown by `context_large_blocks` and `acp_status`. Ranges are inclusive.

### `context_large_blocks`

Lists oversized items outside the protected zone. Read-only.

| Parameter | Type | Description |
|---|---|---|
| `largeMessageTokens` | integer | Override the single-message threshold for this call |
| `largeTurnTokens` | integer | Override the per-turn threshold for this call |
| `largeBlockTokens` | integer | Override the ACP summary-block threshold for this call |
| `limit` | integer 1–50 | Max items (default 20) |

Example output:

```
Thresholds: message ≥4.0K · turn ≥12.0K · ACP block ≥3.0K tokens.
· seqs 278–394 · turn 6 (38 msgs) · ~50.1K tok · 6 turns ago
· seq 308 · tool web_fetch · ~12.5K tok · 6 turns ago
· seq 355 · tool web_fetch · ~11.4K tok · 6 turns ago
usage 45% · oversized messages/blocks ~40.8K tok
Turn entries overlap their messages — act on either, not both.
```

Labels show the kind of item (tool name, `runtime-context snapshot`, `plugin:<name>`, `ACP summary block`, …). They **never show content**.

### `context_export`

Writes a range of completed context to a temp file **without the model reading it**, and replaces the range with a one-line pointer.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `startSeq` | seq or `mNNNNN` | ✅ | First message |
| `endSeq` | seq or `mNNNNN` | ✅ | Last message |
| `name` | string | | File-name hint, e.g. `pytest-run-3` |
| `note` | string | | One line kept in the pointer (max 120 chars) |

What stays in context:

```
[CONTEXT EXPORTED (temp file) → /…/billion-context-relief/<session>/2026-10-04_205824_pytest-run-3.md · 2 msgs · seqs 306–308 · ~12.5K tok · note: …]
```

The agent can read the file later with its normal file tools if it needs the content back.

### `context_delete`

Replaces a range with a marker. No summary and no file.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `startSeq` | seq or `mNNNNN` | ✅ | First message |
| `endSeq` | seq or `mNNNNN` | ✅ | Last message |
| `reason` | string | ✅ | Why it is safe to drop; kept in the marker (max `reasonMaxChars`) |
| `confirm` | boolean | above `deleteConfirmTokens` | Required for ranges over 8,000 tokens (default) |

What stays in context:

```
[DELETED REFERENCES · seqs 363–365 · 2 msgs · ~12.8K tok · reason: consumed docs fetch, findings in report]
```

### `context_exports`

Manages this session's export files **by name only**: it never opens or prints a file's content.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | `"list"` or `"delete"` | ✅ | |
| `names` | string[] | for `delete` | File names from `list` |
| `all` | boolean | | `delete` every export of this session |

`list` shows file name, size, seq span, message count, token estimate and note. Names are validated, so path escapes (`../`) are refused. Only the calling session's own exports are visible.

## How replacements work

Each replacement goes through **ACP's own compress path** (`makeTools(env)` → `compress` → `kernel.applyCompression` → ACP state store → durable compaction transaction), with the pointer or marker as the "summary". The result is a normal ACP block:

- `acp_status` lists it, `search_context` finds text inside it, and `decompress` can still **read** the originals from the session log;
- DSH's usage meter credits the freed tokens (live test: 45% → 39% after one 12.5K export).

**Range handling.** Before ACP resolves a range, the plugin widens it so no tool call or result is cut in half: a range that starts on a tool result also takes in the assistant message that made the call, and a range that ends on a call takes in its result. ACP itself shrinks a range to a balanced remainder, which would otherwise silently leave the first result in context. The tool's answer always reports the **actual** span acted on.

**Two per-call differences from a model `compress`:**

1. `compress.minCompressRange` is `0` for these calls. ACP's 5,000-character floor would otherwise stop a single small row (such as one plugin reminder) from being removed.
2. The relief tool's own call and result are not hidden from the transcript (ACP hides its own `compress` calls).

ACP's global configuration is never changed.

## What it refuses

Nothing changes when a call is refused; the answer says why.

| Case | Answer |
|---|---|
| The current (open) turn | `reach into the current (open) turn — only completed turns can be relieved` |
| The kernel's protected zone (last 5 messages, last 5K tokens, most recent user message) | `are in the protected zone … — pick older messages` |
| A range already inside an ACP block | `already inside an ACP block — nothing to relieve; decompress reads the originals` |
| `context_delete` without a reason | `a reason is required` |
| `context_delete` over `deleteConfirmTokens` without `confirm: true` | asks for `confirm:true` or suggests `context_export` |
| The newest AGENTS.md / agent-instructions copy | rejected by ACP (DSH re-injects it immediately) |
| ACP not active | explains that ACP is required |

If ACP refuses a range after the export file was written, the file is removed again.

## Advisor

A notice the agent receives in its conversation. It is **inform-only**: it never edits, exports or deletes anything.

It is sent when **all** of these hold:

- the session's context usage is at least `minUsagePct` (default 40%);
- at least one oversized item exists outside the protected zone;
- the list of top items has **changed** since the last notice;
- at least `advisorCooldownSteps` steps (default 8) have passed since the last notice.

```
[billion-context-relief: large context — act on it if no longer needed]
· seq 342 · tool bash · ~9.2K tok · 23 turns ago
· seq 118 · runtime-context snapshot · ~4.2K tok · 30 turns ago
usage 61% · oversized messages/blocks ~13.4K tok
Tools: context_export (keep a temp copy) · context_delete (drop, no copy). This notice can itself be removed with context_delete.
```

Older notices are never removed automatically. The agent can delete them like any other content. Set `advisorEnabled: false` to turn the notice off; the tools keep working.

## Exports

- **Location:** `<os tmpdir>/billion-context-relief/<session-id>/`, or `<exportRoot>/<session-id>/` when configured. On macOS the tmpdir is under `/var/folders/…/T/`.
- **Permissions:** directory `0700`, files `0600`.
- **Index:** each session directory has an `index.json` with metadata (span, count, tokens, note), so listing never opens an export.
- **Format:** Markdown, one section per message (`## seq N · <label>`) with the original text, tool calls and tool results.
- **Lifetime:** **nothing deletes exports automatically.** They stay until the agent calls `context_exports` with `delete` (by name, or `all: true`). `delete all` also removes the session directory. The operating system may purge old files in its temp directory on its own schedule; set `exportRoot` if exports must survive that.

## Configuration

Defaults ship in this package's `cordis.patch.yml`. Override them with a same-id row in your profile's `cordis.patch.yml` (`~/.dsh/profiles/<profile>/cordis.patch.yml`):

```yaml
- id: billion-context-relief
  config:
    largeMessageTokens: 4000     # single message
    largeTurnTokens: 12000       # one completed turn
    largeBlockTokens: 3000       # one ACP summary block
    minUsagePct: 0.4             # advisor stays silent below this usage (0–1)
    advisorEnabled: true         # inform-only notice; never modifies context
    advisorCooldownSteps: 8      # min steps between notices per session
    maxItems: 5                  # items per advisor notice
    deleteConfirmTokens: 8000    # context_delete above this needs confirm:true
    reasonMaxChars: 120          # max length of the delete reason in the marker
    exportRoot: ''               # '' → <os tmpdir>/billion-context-relief
```

Unknown keys are ignored. Values of the wrong type fall back to the default.

## Safety and data notes

- **Not undoable in the session.** ACP's `decompress` returns the original content for **reading**, but it does not un-compress the range. Treat `context_delete` as permanent for the session, and use `context_export` when unsure.
- **Originals are not erased from disk.** Both moves remove content from the **model's view**. The session log keeps the original events (that is what `decompress` reads). This plugin never edits session logs.
- **Exports hold raw conversation content**, including anything sensitive a tool printed (keys in logs, personal data in fetched pages). Keep `exportRoot` outside any repository or synced folder.
- **No network access.** The plugin makes no outbound requests and registers no HTTP routes.
- **Scope.** A tool call can only act on the calling session's own context and exports.

## Upgrading and reloading

- Reloading the plugin from the DSH GUI, or restarting DSH, loads new code. `dsh plugin remove` + `add` updates the profile, but a module already loaded in the running process may keep its old code until a reload.
- Sessions get new or changed **tool schemas** only when reopened.
- Blocks and markers created by earlier versions stay valid; they are ordinary ACP blocks.

See [CHANGELOG.md](CHANGELOG.md).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Tools answer that ACP is required | ACP is not installed in this profile, or not in `dsh.profile.bundles`, or another compaction engine is active |
| Tools missing in a session | The session was opened before the install. Reopen it. |
| `ready` line missing from the log | Check that `billion-context-relief` is in the profile's `package.json` and `dsh.profile.bundles` (`dsh plugin --profile web list`) |
| Reported span differs from the requested one | Expected: the range was widened to whole tool call/result pairs, or narrowed to messages not already in an ACP block. The answer shows the actual span. |
| Export pointer points to a missing file | The export was deleted with `context_exports`, or the OS purged its temp directory. `decompress` still reads the originals. |

## Development

```bash
npm test
```

Node's built-in test runner covers the helpers (`test/core.test.mjs`: scanning, protected zone, markers, export store, range widening) and the tools against a mocked DSH host and ACP module (`test/host.test.mjs`). There are no external dependencies.

## Related plugins

- **[billion-context-dsh](https://github.com/Tyan66666/billion-context-dsh)**: ACP, the compaction engine this plugin builds on (required).
- **[agents-in-the-loop](https://github.com/markelayan/agents-in-the-loop)**: cross-session messaging for DSH agents.
- **[dsh-keyword-injector](https://github.com/markelayan/dsh-keyword-injector)**: keyword- and tool-triggered context reminders.

This plugin replaces the old local `dsh-ctxdel` plugin, whose automatic deletion sweep is gone entirely.

## License

MIT
