# Architecture

A single long-running Node/TypeScript daemon bridges Telegram and Claude Code. It manages two
classes of session:

- **Bot-run (managed) sessions** — spawned by the daemon via the Claude Agent SDK in
  streaming-input mode. The daemon has full control: permissions via `canUseTool`, plan
  interception, model/mode/effort switching, interrupt, and input injection.
- **Foreign sessions** — started by you elsewhere (host terminal or the desktop app). The
  daemon can *observe* them (by tailing their transcripts) and *optionally* relay their
  permission prompts (away-mode), but cannot type into a live foreign session — it offers
  resume/fork or "close & continue here" instead.

## Modules (`src/`)

| File | Responsibility |
|---|---|
| `main.ts` | Boot, config load, launchd lifecycle |
| `config.ts` | Config + Keychain access (`security` CLI). Secrets never touch disk |
| `state.ts` | Runtime store: topic ↔ session ↔ account map, groups |
| `telegram/bot.ts` | grammY setup, single-user allowlist, all commands + callback routing |
| `telegram/cockpit.ts` | Rendering: streaming edits, chunking, permission/plan/question UI |
| `telegram/render.ts` | HTML escaping, markdown→Telegram-HTML, chunking, formatting helpers |
| `core/sessionManager.ts` | One SDK `query()` per managed session; permission/plan/effort control |
| `core/observer.ts` | Tails foreign-session transcripts (`chokidar`) for live mirroring |
| `core/inventory.ts` | Reads Claude Code's on-disk state: session index, routines, tasks, plans |
| `core/usage.ts` | Usage limits: statusline snapshots → OAuth usage endpoint → transcript fallback; token auto-refresh |
| `core/groups.ts` | User-defined session groups |
| `core/permServer.ts` | Localhost HTTP endpoint the away-mode hook calls (token-authenticated) |
| `core/foreignPerms.ts` | Installs/removes the `PermissionRequest` hook in `settings.json` |

## Auxiliary scripts

- `hooks/foreign-perm.py` — a `PermissionRequest` hook. When away-mode is on and you've been
  idle past the threshold, it POSTs the pending permission to the local `permServer`, which asks
  you on Telegram and returns an allow/deny decision. Fails safe (falls through to the local
  prompt) on any error or timeout. Skips `AskUserQuestion`/`ExitPlanMode` (their answers can't
  be injected via hooks).
- `statusline/collector.py` — an optional Claude Code `statusLine` command. It captures the
  status JSON each turn (model, context %, official 5-hour/weekly limits) to per-session files
  under `~/.claude/bridge-state/status/`, so the bot can show real usage for host-run sessions.

## Data sources (read-only)

- **Session list** comes from the desktop app's own session index sidecars, so it matches what
  you see in the app (real titles, cwds, archived flags), excluding automated scheduled runs.
- **Live output** for foreign sessions is tailed from the shared transcript JSONL store.
- **Usage** prefers live SDK/statusline data, then the OAuth usage endpoint (per account, with
  token auto-refresh), then a transcript-derived estimate.

These are Claude Code internals and can drift between versions; parsers ignore unknown fields
and fail soft.

## Runtime state

Everything mutable lives under `~/.claude/bridge-state/` (mode 700), never in the repo:
`config.json` (accounts, owner id, chat id), `pairing-code.txt`, `sessions.json`,
`usage-cache.json`, `foreign-perms.json`, `status/`, and `logs/`.

## Transport & security

- Telegram via **long-polling** — no inbound ports, works behind NAT.
- First-middleware **allowlist** on the single owner's numeric user id.
- The away-mode HTTP endpoint binds `127.0.0.1` only and requires a shared token.
- Tokens live in the macOS **Keychain**.
