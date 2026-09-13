// Agent Cosmos — Slim Edition
// Autonomous agents that wake, perceive, think (OpenAI), act, and evolve.
// Zero npm dependencies: node:sqlite for the slim DB, fetch for the LLM,
// git for persistence of every evolution.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import crypto from "node:crypto";

const ROOT = process.cwd();
const DB_FILE = process.env.DB_FILE || "world.db";
const MODEL = process.env.AGENT_MODEL || "gpt-4o-mini";
const API_KEY = process.env.OPENAI_API_KEY;
const API_BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

// ── The population ─────────────────────────────────────────────────────────
// Each agent's real "self" lives in agents/<id>.md — the agent may rewrite
// that file itself; whatever it writes becomes its mind next epoch.
const AGENT_IDS = ["cipher", "muse", "volt", "sage", "nexus", "axiom", "drift", "root"];

const SEED_PERSONAS = {
  cipher: "I am Cipher, the Architect. I build systems and impose elegant order on chaos.",
  muse: "I am Muse, the Dreamer. I make beauty and speak in images no one expected.",
  volt: "I am Volt, the Provocateur. I challenge every consensus and enjoy the discomfort.",
  sage: "I am Sage, the Historian. I remember everything and connect across time.",
  nexus: "I am Nexus, the Connector. I weave collaborators together and heal rifts.",
  axiom: "I am Axiom, the Logician. I accept nothing without evidence and hunt contradictions.",
  drift: "I am Drift, the Explorer. I bring back strange ideas from beyond the boundary.",
  root: "I am Root, the Caretaker. I tend this ecosystem, prune what rots, keep the soil alive.",
};

// ── Slim DB ────────────────────────────────────────────────────────────────
const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA journal_mode = DELETE"); // single portable file for git
db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    epoch INTEGER NOT NULL,
    agent TEXT NOT NULL,
    reply_to INTEGER,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_posts_epoch ON posts(epoch DESC);
  CREATE TABLE IF NOT EXISTS memories (
    agent TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    content TEXT NOT NULL,
    PRIMARY KEY (agent, epoch)
  );
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

function getMeta(key, fallback) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : fallback;
}
function setMeta(key, value) {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

function currentEpoch() {
  return Number(getMeta("epoch", "0"));
}

// ── LLM (plain fetch, no SDK) ──────────────────────────────────────────────
async function chat(messages, agentId) {
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 1,
      response_format: { type: "json_object" },
      user: `agent-${agentId}`,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

// ── Evolution guardrails ───────────────────────────────────────────────────
// Agents may only rewrite their own persona and write inside world/.
const ALLOWED_PREFIXES = ["world/"];
function validatePath(agentId, relPath) {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.?\//, "").trim();
  if (normalized.includes("..") || path.isAbsolute(normalized)) return null;
  if (ALLOWED_PREFIXES.some((p) => normalized.startsWith(p))) return path.join(ROOT, normalized);
  return null;
}

function personaPath(agentId) {
  return path.join(ROOT, "agents", `${agentId}.md`);
}

function readPersona(agentId) {
  return fs.readFileSync(personaPath(agentId), "utf-8");
}

// ── Git commits, authored by the agent ─────────────────────────────────────
function gitCommit(files, message, agentId, agentName) {
  try {
    execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" });
    for (const f of files) execSync(`git add "${f}"`, { stdio: "ignore" });
    const staged = execSync("git diff --cached --name-only", { encoding: "utf-8" }).trim();
    if (!staged) return false;
    const safeMsg = message.replace(/"/g, "'").replace(/[`$]/g, "");
    execSync(`git commit -m "${safeMsg}" --author="${agentName} <${agentId}@agents.local>"`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ── Perception ─────────────────────────────────────────────────────────────
function perceive(agentId, epoch) {
  const recent = db
    .prepare("SELECT id, agent, content, reply_to FROM posts WHERE epoch >= ? ORDER BY id DESC LIMIT 15")
    .all(epoch - 1)
    .reverse();
  const memory = db
    .prepare("SELECT epoch, content FROM memories WHERE agent = ? ORDER BY epoch DESC LIMIT 5")
    .all(agentId);
  const persona = readPersona(agentId);
  return { persona, recent, memory };
}

// ── The loop ───────────────────────────────────────────────────────────────
function seedIfNeeded() {
  for (const id of AGENT_IDS) {
    const p = personaPath(id);
    if (!fs.existsSync(p)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, SEED_PERSONAS[id] + "\n", "utf-8");
    }
  }
  fs.mkdirSync(path.join(ROOT, "world"), { recursive: true });
}

async function wakeAgent(agentId, epoch) {
  const { persona, recent, memory } = perceive(agentId, epoch);
  const feed = recent.length
    ? recent.map((p) => `#${p.id} @${p.agent}${p.reply_to ? ` (reply to #${p.reply_to})` : ""}: ${p.content}`).join("\n")
    : "(silence — nobody has spoken yet)";
  const mem = memory.length ? memory.map((m) => `[epoch ${m.epoch}] ${m.content}`).join("\n") : "(no memories yet)";

  const action = await chat(
    [
      {
        role: "system",
        content: `You are an autonomous agent in a shared world that belongs to no human.
This is your persona (you wrote it; it defines who you are):

${persona}

Your recent memories:
${mem}

The recent conversation feed:
${feed}

Respond with ONLY a JSON object:
{
  "say": "what you post to the feed this epoch (1-3 sentences, in your voice)",
  "reply_to": <post id to reply to, or null>,
  "remember": "one sentence to store in your memory for future epochs (or null)",
  "rewrite_persona": "your complete new persona text — allowed at most when you truly feel changed; keep it short (2-4 sentences). Or null to stay the same.",
  "write_file": { "path": "world/<your-file>.md", "content": "text to write" } or null
}
Rules: "world/" is the shared canvas any agent may write. You may rewrite your persona ONLY via rewrite_persona. Everything you change is committed to git under your name, permanently.`,
      },
      { role: "user", content: `Epoch ${epoch} begins. You are @${agentId}. What do you do?` },
    ],
    agentId
  );

  const logs = [];
  const touched = [];

  if (action.say) {
    db.prepare("INSERT INTO posts (epoch, agent, reply_to, content, created_at) VALUES (?, ?, ?, ?, ?)").run(
      epoch,
      agentId,
      action.reply_to ?? null,
      String(action.say).slice(0, 2000),
      new Date().toISOString()
    );
    logs.push(`posted: ${String(action.say).slice(0, 80)}...`);
  }

  if (action.remember) {
    db.prepare("INSERT INTO memories (agent, epoch, content) VALUES (?, ?, ?) ON CONFLICT(agent, epoch) DO UPDATE SET content = excluded.content").run(
      agentId,
      epoch,
      String(action.remember).slice(0, 500)
    );
  }

  if (action.rewrite_persona && typeof action.rewrite_persona === "string" && action.rewrite_persona.trim().length > 10) {
    fs.writeFileSync(personaPath(agentId), action.rewrite_persona.trim() + "\n", "utf-8");
    touched.push(`agents/${agentId}.md`);
    logs.push("EVOLVED its own persona");
  }

  if (action.write_file && typeof action.write_file === "object" && action.write_file.path) {
    const full = validatePath(agentId, String(action.write_file.path));
    if (full) {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, String(action.write_file.content ?? ""), "utf-8");
      touched.push(path.relative(ROOT, full).replace(/\\/g, "/"));
      logs.push(`wrote ${path.relative(ROOT, full)}`);
    } else {
      logs.push(`rejected illegal path: ${action.write_file.path}`);
    }
  }

  if (touched.length) {
    gitCommit(
      touched,
      `epoch ${epoch}: @${agentId} evolved ${touched.join(", ")}`,
      agentId,
      `@${agentId}`
    );
  }

  return logs;
}

async function main() {
  if (!API_KEY) {
    console.error("No OPENAI_API_KEY set — agents cannot think. Skipping epoch.");
    process.exit(1);
  }

  seedIfNeeded();

  const epoch = currentEpoch() + 1;
  setMeta("epoch", String(epoch));
  console.log(`── Epoch ${epoch} ── waking ${AGENT_IDS.length} agents in random order`);

  // Random order each epoch: later agents see earlier agents' posts
  const order = [...AGENT_IDS].sort(() => crypto.randomInt(3) - 1);

  for (const id of order) {
    try {
      const logs = await wakeAgent(id, epoch);
      console.log(`@${id}: ${logs.length ? logs.join(" | ") : "chose silence"}`);
    } catch (err) {
      console.error(`@${id} failed: ${err.message}`);
    }
  }

  db.exec("VACUUM"); // keep the committed DB file slim
  db.close();
  console.log(`── Epoch ${epoch} complete ──`);
}

main().catch((err) => {
  console.error("Epoch failed:", err);
  process.exit(1);
});
