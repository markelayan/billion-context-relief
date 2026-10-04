# Changelog

## 0.1.0 (2026-10-04)

First release. Replaces the old local `dsh-ctxdel` plugin; its automatic deletion sweep is gone entirely.

- `context_large_blocks`, `context_export`, `context_delete`, `context_exports`: agent-requested only.
- Every replacement goes through billion-context-dsh's own compress path, so results are normal ACP blocks (`acp_status`, `search_context`, `decompress`). A per-call `minCompressRange: 0` override allows removing small rows alone; ACP's global config is untouched.
- Exports are written to `<tmpdir>/billion-context-relief/<session-id>/` (0700/0600), listed and deleted by name only; nothing is deleted automatically.
- Advisor: inform-only, rate-limited notice above `minUsagePct` when the oversized set changes.
- Refuses the open turn, the kernel's protected zone, already-compressed ranges, and the newest AGENTS.md copy.
