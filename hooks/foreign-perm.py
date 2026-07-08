#!/usr/bin/env python3
"""PermissionRequest hook: forward GENUINE permission prompts from sessions the bridge did
NOT start (desktop app / terminal) to Telegram — but ONLY when the owner is away from the Mac.

Uses the PermissionRequest hook (not PreToolUse) so it fires ONLY on the real ask-path — i.e.
exactly the prompts the Mac would show. Auto-mode / accept-edits / allow-rule approvals never
reach here, so it does not over-forward.

Fail-safe: on ANY doubt (feature off, user present, bridge unreachable, timeout, or an
interaction tool whose answer can't be injected) it exits 0 with no decision, so Claude Code
shows its normal local prompt. It never denies on error and never blocks past the bridge's wait.
"""
import json
import os
import subprocess
import sys
import urllib.request

STATE = os.path.expanduser("~/.claude/bridge-state/foreign-perms.json")
LOG = os.path.expanduser("~/.claude/bridge-state/foreign-hook.log")
# Interaction tools whose ANSWER can't be injected via a hook (Claude Code collects them in its
# local UI). Leave them on the Mac; bridge-run sessions handle them via the SDK instead.
UNRESOLVABLE = {"AskUserQuestion", "ExitPlanMode"}


def log(msg):
    try:
        import datetime
        with open(LOG, "a") as f:
            f.write(datetime.datetime.now().isoformat(timespec="seconds") + " " + msg + "\n")
    except Exception:
        pass


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool = data.get("tool_name", "")
    try:
        cfg = json.load(open(STATE))
    except Exception:
        sys.exit(0)
    if not cfg.get("enabled"):
        sys.exit(0)
    if tool in UNRESOLVABLE:
        log("skip (answer not hook-injectable): %s" % tool)
        sys.exit(0)  # fall through to the Mac's interactive prompt

    log("PERMISSION-REQUEST tool=%s session=%s" % (tool, str(data.get("session_id", ""))[:8]))

    # Only forward when the Mac has been idle (owner away) — never interrupt active desktop work.
    try:
        out = subprocess.run(["ioreg", "-c", "IOHIDSystem"], capture_output=True, text=True, timeout=3).stdout
        idle_ns = next(int(line.split("=")[-1]) for line in out.splitlines() if "HIDIdleTime" in line)
        idle_s = idle_ns / 1e9
    except Exception as e:
        idle_s = 0
        log("idle check errored: " + str(e))
    if idle_s < cfg.get("idleSeconds", 180):
        log("passthrough: not idle enough: %.1fs < %ss" % (idle_s, cfg.get("idleSeconds", 180)))
        sys.exit(0)
    log("forwarding to bridge: tool=%s idle=%.0fs" % (tool, idle_s))

    try:
        body = json.dumps({
            "sessionId": data.get("session_id", ""),
            "tool": tool,
            "input": data.get("tool_input", {}),
            "cwd": data.get("cwd", ""),
        }).encode()
        req = urllib.request.Request(
            f"http://127.0.0.1:{cfg['port']}/perm",
            data=body,
            headers={"content-type": "application/json", "x-bridge-token": cfg.get("token", "")},
        )
        with urllib.request.urlopen(req, timeout=cfg.get("waitSeconds", 110)) as r:
            verdict = json.loads(r.read().decode())
            decision = verdict.get("decision", "ask")
            reason = verdict.get("reason") or "Answered by owner from Telegram (away-mode)."
        log("bridge returned decision=%s" % decision)
    except Exception as e:
        log("POST to bridge failed: " + str(e))
        sys.exit(0)  # fall through to the Mac dialog

    # PermissionRequest decision shape (verified against CLI v2.1.204).
    if decision == "allow":
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": {"behavior": "allow"},
        }}))
    elif decision == "deny":
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": {"behavior": "deny", "message": reason},
        }}))
    # anything else ("ask") → no output → the Mac dialog shows normally
    sys.exit(0)


if __name__ == "__main__":
    main()
