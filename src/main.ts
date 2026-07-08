// claude-tg-bridge daemon entry point. Runs under launchd (KeepAlive); long-polls
// Telegram, so no inbound port. All secrets come from the macOS Keychain.
import fs from "node:fs";
import path from "node:path";
import { botToken, loadConfig, STATE_DIR } from "./config.js";
import { Store } from "./state.js";
import { createBot } from "./telegram/bot.js";

fs.mkdirSync(path.join(STATE_DIR, "status"), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(STATE_DIR, "logs"), { recursive: true, mode: 0o700 });

const token = botToken();
if (!token) {
  console.error(
    [
      "claude-tg-bridge: no Telegram bot token in the Keychain.",
      "1) Create a bot with @BotFather in Telegram (/newbot), copy the token.",
      "2) security add-generic-password -s claude-tg-bridge -a bot -w '<TOKEN>'",
      "3) Restart the bridge, then send the pairing code (printed at startup and in",
      `   ${STATE_DIR}/pairing-code.txt) to the bot from YOUR Telegram account.`,
    ].join("\n"),
  );
  process.exit(1);
}

const cfg = loadConfig();
const store = new Store();
const { bot, cockpit } = createBot(token, cfg, store);

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
function shutdown(): void {
  console.log("shutting down: killing managed sessions, flushing state");
  for (const s of cockpit.live.values()) s.kill();
  for (const w of cockpit.watchers.values()) w.stop();
  store.flushSessions();
  void bot.stop().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("unhandledRejection", (e) => console.error("unhandledRejection", e));
process.on("uncaughtException", (e) => console.error("uncaughtException", e));

console.log(`claude-tg-bridge starting (state: ${STATE_DIR}, paired: ${Boolean(cfg.ownerId)})`);
void bot.start({
  onStart: (me) => console.log(`long-polling as @${me.username}`),
  allowed_updates: ["message", "callback_query"],
});
