# Security policy

## What this project is (threat model)

`claude-code-telegram-cockpit` is a **single-user, local-execution** tool. It runs as a daemon on
*your own machine* and lets *only you* drive Claude Code from Telegram. It is deliberately not a
multi-tenant service, and its security model reflects that:

- **One owner.** The bot serves exactly one Telegram user id, set via a pairing code on first run.
  Every other sender is dropped. There is no notion of multiple users, roles, or ACLs.
- **Local execution.** Sessions run on your machine; transcripts stay on your disk. The daemon never
  uses cloud/remote-execution features of Claude Code.
- **Secrets in the OS keychain.** The bot token (and any other secrets) live in the macOS Keychain,
  never in files or the repository. Runtime state lives under `~/.claude/bridge-state/` (mode `0700`).
- **Localhost-only control surface.** The optional away-mode permission endpoint binds to
  `127.0.0.1` only and requires a shared token (constant-time comparison; an empty token rejects all
  requests). It is never exposed off-box.

### The one caveat you must understand

**Transport is not end-to-end encrypted.** Your commands and Claude's replies travel through
Telegram's servers. "Local" here means local *execution*, not a private *channel* — treat the bot
like any third-party chat app. **Do not route confidential, customer, or otherwise sensitive data
through it.** If you need private transport, run it over a private network (e.g. a VPN/Tailscale)
and/or a transport you control.

### Out of scope

Because this is a personal, single-user tool, the following are explicitly *not* hardened to
production-service standards: denial-of-service resistance, multi-user isolation, audit logging, and
protection against a local attacker who already has your user account on the machine (they already
have your Keychain and your files).

## Reporting a vulnerability

If you find a security issue, please **do not open a public issue**. Instead, open a
[private security advisory](https://github.com/mysm91/claude-code-telegram-cockpit/security/advisories/new)
on this repository. I'll aim to respond within a few days. Since this is a personal project maintained
in spare time, please be patient — and thank you for reporting responsibly.
