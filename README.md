# Claude Code Telegram Cockpit

Drive [Claude Code](https://claude.com/claude-code) from Telegram — start and resume sessions
in any directory, answer permission prompts and plan approvals, switch model / mode / effort,
watch any session's live output, and see your usage limits — all from your phone. **Everything
runs locally on your own machine; nothing is hosted in the cloud.**

It works only while your computer is on and online. One person, one bot, your machine.

---

## Features

- **Sessions** — list every local Claude Code session (grouped by project), start a new one in
  any folder, resume/fork existing ones, or "close on the host & continue here" for a session
  that's open elsewhere.
- **Permissions** — approve/deny tool prompts with **Allow once / Always allow / Deny** buttons.
- **Plans** — approve, reject, or **revise with feedback** plan-mode plans.
- **Questions** — answer `AskUserQuestion` prompts (single-select, multi-select, and free-text)
  for bot-run sessions.
- **Controls** — switch model, permission mode, and effort per session; interrupt/stop.
- **Output** — live-streamed to a Telegram topic per session, with tap-to-copy code blocks and
  large outputs sent as files. Send text or photos back as input.
- **Usage** — context-window %, 5-hour and weekly limit % with reset times, per account.
- **Multi-account** — switch between accounts (via `CLAUDE_CONFIG_DIR`) and even move a running
  session between usage pools.
- **Away-mode** — optionally forward *genuine* permission prompts from sessions you started
  outside the bot (host terminal / desktop app) to your phone, but only while you're away from
  the keyboard. Off by default; installs a hook only when enabled.

## How it works

A small Node/TypeScript daemon (launchd on macOS) pairs [grammY](https://grammy.dev)
(Telegram, long-polling — no inbound ports) with the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk). Bot-run sessions are driven
through the SDK's `canUseTool` / streaming APIs; sessions you started elsewhere are observed by
tailing Claude Code's on-disk transcripts and, optionally, relayed via a `PermissionRequest`
hook. See [ARCHITECTURE.md](ARCHITECTURE.md).

## Requirements

- **macOS** (uses the Keychain, `ioreg`, and launchd).
- **Node.js ≥ 20**.
- **Claude Code** installed and logged in (`claude auth login`). A Pro/Max/Team subscription or
  API access as you normally use it.
- A Telegram account.

## Security & privacy model

- **Single user.** The bot serves exactly one Telegram user id (set via a pairing code on first
  run); every other sender is silently dropped.
- **Local only.** Sessions execute on your machine; transcripts stay on your disk. The daemon
  never uses cloud/remote-execution features. Its only outbound traffic is the Telegram Bot API,
  the normal Claude API traffic every session makes, and (optionally) the usage endpoint. The
  voice features add two more destinations, each contacted only while you use it: a voice note's
  audio goes to **Google** through your own local `gemini` CLI to be transcribed, and with voice
  replies enabled the spoken text goes to **Microsoft's** keyless Edge read-aloud endpoint.
- **Secrets in the Keychain**, never in files or the repo. Runtime state lives in
  `~/.claude/bridge-state/` and is git-ignored.
- **Not end-to-end encrypted.** Telegram bot chats traverse Telegram's servers. Do not route
  sensitive/confidential data through the bot — including by dictating it into a voice note.

## Setup

**0. Prerequisite** — make sure Claude Code is installed and logged in:
```bash
claude auth login
```

**1. Create a bot** — in Telegram, message [@BotFather](https://t.me/BotFather) → `/newbot` →
pick a name and username → copy the token it gives you.

**2. Store the token in the Keychain** (it never touches a file):
```bash
security add-generic-password -s claude-tg-bridge -a bot -w '<YOUR_BOT_TOKEN>'
```

**3. Install & start the daemon:**
```bash
git clone https://github.com/mysm91/claude-code-telegram-cockpit.git
cd claude-code-telegram-cockpit
./setup.sh
```
`setup.sh` installs dependencies, builds, and registers a launchd agent that starts now and on
every login.

**4. Pair your phone** — the first run prints a one-time pairing code:
```bash
cat ~/.claude/bridge-state/pairing-code.txt
```
Open your bot in Telegram, press **Start**, and send it that code. From then on the bot answers
only you; everyone else is ignored.

**5. (Recommended) One topic per session** — create a Telegram **group** with just yourself,
open its settings and turn on **Topics**, then add your bot as an **admin** with the *Manage
Topics* permission. Each session then gets its own topic (tab). Skip this and everything runs in
one flat chat.

**6. Try it** — send **`/new`**, pick a folder, and start chatting. `/sessions` lists everything;
`/help` shows all commands.

**7. (Optional) Usage numbers for terminal/desktop sessions** — add a `statusLine` entry to
`~/.claude/settings.json` so the bot can read official limit data for sessions you *didn't* start
from the bot (merge it with any existing keys):
```json
{
  "statusLine": {
    "type": "command",
    "command": "/absolute/path/to/claude-code-telegram-cockpit/statusline/collector.py"
  }
}
```

## Managing the daemon

```bash
# follow the logs
tail -f ~/.claude/bridge-state/logs/bridge.log
# restart after changes
launchctl kickstart -k "gui/$(id -u)/com.claude-code-telegram-cockpit.bridge"
# stop it
launchctl bootout "gui/$(id -u)/com.claude-code-telegram-cockpit.bridge"
# update to the latest
git pull && ./setup.sh
```

## Configuration

Tunables live in `~/.claude/bridge-state/config.json` (created and managed by the daemon). Sensible
defaults apply when a key is absent — add a key only to override it:

| Key | Default | Meaning |
|---|---|---|
| `usageWarnPct` | `90` | Warn in Telegram when the 5-hour usage window crosses this percentage. |
| `approvalTimeoutMin` | `15` | Auto-deny a managed permission/plan/question prompt left unanswered for this many minutes — a fail-safe so a never-tapped prompt can't hang the session. |
| `richMessages` | `false` | Send replies containing tables or headings as Telegram Rich Messages (native tables), falling back to HTML. Clients too old for them show "update your Telegram" instead of the content, so it is opt-in. |
| `claudeExecutable` | *(unset)* | Absolute path to a `claude` binary for spawned sessions. Unset uses the SDK's bundled CLI, which is version-paired with the SDK — the recommended default. |
| `voice.googleCloudProject` | *(unset)* | `GOOGLE_CLOUD_PROJECT` for the `gemini` CLI. Required in practice: without a project the CLI's individual tier now refuses to run. |
| `voice.uvxPath` | `uvx` | How to run `edge-tts` (via [uv](https://docs.astral.sh/uv/)). Use an absolute path — launchd's `PATH` normally does not include it. |
| `voice.replies` | `auto` | `off` · `auto` (speak only when you sent a voice note) · `always`. |
| `voice.sttModel` | `gemini-2.5-pro` | Transcription model. Do not use a `flash` model for Persian — quality drops sharply. |
| `voice.faVoice` / `voice.enVoice` | `fa-IR-DilaraNeural` / `en-US-AriaNeural` | Edge TTS voices, picked per reply by script detection. |
| `voice.sttMaxDurationSec` / `voice.sttMaxBytes` | `300` / `19 MB` | Limits on an incoming note (Telegram itself caps bot downloads at 20 MB). |
| `voice.ttsMaxChars` | `2500` | How much of a reply gets spoken (code blocks and tables are skipped). |

`ownerId`, `chatId`, `accounts`, and `activeAccount` in the same file are managed by the daemon during
pairing and normal use — you don't normally edit those by hand.

**Pairing & re-pairing.** On first run the daemon prints a pairing code (also written to
`~/.claude/bridge-state/pairing-code.txt`, mode 0600) — send it to the bot to become the owner. The code
is 64-bit, expires after 15 minutes (a fresh one is issued on demand), and five wrong attempts trigger a
15-minute lockout with rotation. Once paired, the bot's home chat is **pinned**: `/start` elsewhere won't
move it — run `/bindchat` in the target chat and confirm. To re-pair from scratch (lost account, wrong
owner), delete the `ownerId` and `chatId` keys from `~/.claude/bridge-state/config.json`, restart the
daemon, and use the fresh code.

## Commands

| Command | What it does |
|---|---|
| `/new` | Start a session in a directory (pick a project or type a path) |
| `/sessions` | Browse all local sessions by project; resume / fork / mirror / details |
| `/info` (`/status`) | Full panel: session, usage, limits, account |
| `/usage` | 5-hour + weekly limits per connected account |
| `/model` `/mode` `/effort` | Switch model / permission mode / effort for the current session |
| `/account` | Switch account (new sessions) or move the current session to another account |
| `/plan` `/tasks` `/files` | Current plan · background tasks · git status (+ `/file <path>`) |
| `/watch` `/unwatch` | Mirror a host-started session's output here |
| `/groups` `/group <name>` | Organize sessions into your own groups |
| `/copy` `/stop` `/kill` | Resend last output · interrupt · terminate |
| `/foreign on [min]` `off` | Away-mode: relay host prompts to your phone (see below) |
| `/voice off` `auto` `always` | Spoken replies (`auto` = only for turns you started by voice) |

Inside a session topic, plain text is sent to that session; photos are sent as image input.
A 🎙 voice note (or an audio file) is transcribed and sent as if you had typed it — Persian and
English both work, including mixed sentences. Permission prompts, plan approvals, and questions
appear as inline-button messages.

## Away-mode (opt-in)

`/foreign on 5` forwards permission prompts from sessions you started *outside* the bot to your
phone — but only after you've been idle at the machine for the given minutes (default 3), and
only for prompts Claude Code would genuinely show (it uses the `PermissionRequest` hook, so
actions your permission mode auto-approves are never forwarded). It **fails safe**: no answer
within the wait window, or the daemon being unreachable, simply leaves the normal prompt on the
host. `/foreign off` removes the hook entirely.

Note: `AskUserQuestion` and plan-mode approvals for host-started sessions can't be answered from
a hook (Claude Code collects those in its local UI). To handle them from your phone, bring the
session into the bot with `/sessions → Close & continue here`.

## Caveats

- **macOS only** for now (Keychain / `ioreg` / launchd).
- **Relies on some undocumented Claude Code internals** — the usage/OAuth endpoints, the
  on-disk transcript/sidecar formats, and hook contracts. These can change between Claude Code
  versions; parsers are written to fail soft, but features may need updates after upgrades.
- Programmatic/agent-SDK sessions draw from your normal usage limits — watch the `/usage` panel.
- **Voice needs two external tools on the host**: the [`gemini` CLI](https://github.com/google-gemini/gemini-cli)
  (logged in, with `voice.googleCloudProject` set) for transcription, plus `ffmpeg` and `uvx` for
  spoken replies. Transcription takes roughly 20–60 s per note. Edge TTS is an unofficial endpoint:
  when it breaks, voice replies latch off for the rest of the run and text is unaffected.
- **`/usage` and expired accounts**: an account that has been idle for days is *logged out*, not
  merely stale — the CLI reports "Not logged in" and the 🔄 renew button cannot help. Use 🔁
  Re-sign in (`/login`). Renewal only works while a token is recent enough for the CLI to refresh it.
- The `/model` menu lists CLI aliases (`opus`, `sonnet`, …) plus the live catalog. Aliases track new
  releases automatically; the catalog comes from the SDK's bundled CLI, so a new model can require
  bumping `@anthropic-ai/claude-agent-sdk`.

## License

MIT © 2026 Meysam Shahrashoub — see [LICENSE](LICENSE).
