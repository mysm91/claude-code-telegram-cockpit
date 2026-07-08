// Restart-safe session/group registry (JSON files under ~/.claude/bridge-state).
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./config.js";

export interface SessionRec {
  key: string;              // short bridge-local id (also used in callback data)
  sessionId?: string;       // Claude session UUID (known after first system message)
  topicId?: number;         // forum topic thread id (absent in flat mode)
  cwd: string;
  account: string;
  model?: string;
  mode: string;
  effort?: string;
  title?: string;
  status: "running" | "idle" | "detached" | "closed" | "watching";
  kind: "managed" | "watch";
  createdAt: number;
  lastActivityAt: number;
}

export interface Groups { [name: string]: { sessions: string[]; createdAt: number } }

function file(name: string): string { return path.join(STATE_DIR, name); }

function readJson<T>(name: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file(name), "utf8")) as T; } catch { return fallback; }
}

function writeJson(name: string, data: unknown): void {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = file(name) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file(name));
}

export class Store {
  sessions: Map<string, SessionRec>;
  groups: Groups;

  constructor() {
    this.sessions = new Map(Object.entries(readJson<Record<string, SessionRec>>("sessions.json", {})));
    this.groups = readJson<Groups>("groups.json", {});
    // Daemon just started: any previously running managed session is now detached.
    for (const s of this.sessions.values()) {
      if (s.kind === "managed" && (s.status === "running" || s.status === "idle")) s.status = "detached";
      if (s.kind === "watch") s.status = "closed";
    }
    this.flushSessions();
  }

  flushSessions(): void { writeJson("sessions.json", Object.fromEntries(this.sessions)); }
  flushGroups(): void { writeJson("groups.json", this.groups); }

  byTopic(topicId: number | undefined): SessionRec | undefined {
    if (topicId === undefined) return undefined;
    for (const s of this.sessions.values()) if (s.topicId === topicId && s.status !== "closed") return s;
    return undefined;
  }

  newKey(): string {
    let k;
    do { k = Math.random().toString(36).slice(2, 8); } while (this.sessions.has(k));
    return k;
  }
}
