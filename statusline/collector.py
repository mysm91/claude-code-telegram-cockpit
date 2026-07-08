#!/usr/bin/env python3
"""Claude Code statusline command + bridge collector.

Claude Code pipes a JSON status blob on stdin (session_id, model, context_window,
rate_limits, cost, ...). We:
  1. atomically dump the raw blob to ~/.claude/bridge-state/status/<session_id>.json
     (+ a per-account rollup of rate_limits keyed by config dir) for the Telegram bridge,
  2. print a one-line statusline for the terminal/desktop UI.

Must be fast (<50ms) and NEVER fail loudly — a broken statusline would annoy every
session across all 5 desktop instances. No network. Stdlib only.
"""
import json
import os
import sys
import time

def main():
    raw = sys.stdin.read()
    data = json.loads(raw)

    state_dir = os.path.expanduser("~/.claude/bridge-state/status")
    os.makedirs(state_dir, mode=0o700, exist_ok=True)

    sid = data.get("session_id") or "unknown"
    if all(c.isalnum() or c in "-_" for c in sid):
        payload = dict(data)
        payload["_collected_at"] = time.time()
        payload["_config_dir"] = os.environ.get("CLAUDE_CONFIG_DIR", "")
        tmp = os.path.join(state_dir, f".{sid}.tmp")
        with open(tmp, "w") as f:
            json.dump(payload, f)
        os.replace(tmp, os.path.join(state_dir, f"{sid}.json"))

    # ---- statusline text ----
    parts = []
    model = (data.get("model") or {}).get("display_name") or (data.get("model") or {}).get("id") or ""
    if model:
        parts.append(model)

    cw = data.get("context_window") or {}
    pct = cw.get("used_percentage")
    if pct is not None:
        parts.append(f"ctx {round(pct)}%")

    rl = data.get("rate_limits") or {}
    for key, label in (("five_hour", "5h"), ("seven_day", "wk")):
        win = rl.get(key) or {}
        p = win.get("used_percentage")
        if p is not None:
            s = f"{label} {round(p)}%"
            resets = win.get("resets_at")
            if resets and key == "five_hour":
                try:
                    mins = max(0, int((float(resets) - time.time()) / 60))
                    s += f"→{mins//60}h{mins%60:02d}m" if mins >= 60 else f"→{mins}m"
                except (TypeError, ValueError):
                    pass
            parts.append(s)

    cost = (data.get("cost") or {}).get("total_cost_usd")
    if cost:
        parts.append(f"${cost:.2f}")

    ws = (data.get("workspace") or {}).get("current_dir") or data.get("cwd") or ""
    if ws:
        parts.append(os.path.basename(ws))

    print(" | ".join(parts) if parts else "claude")

if __name__ == "__main__":
    try:
        main()
    except Exception:
        # fail-silent: always emit something, never a traceback
        print("claude")
