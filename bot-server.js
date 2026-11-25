// Bot repo — internal HTTP API, binds to loopback only
const express = require("express");
const crypto = require("crypto");
const CONFIG = require("./config");
const {
  getSessionConfig, saveSessionConfig, wipeSession,
  getMongo, DEFAULT_GLOBAL,
} = require("./db");
const presenter = require("./presenter");

// ── import the boot/pair/status logic from index.js (refactored) ──
const {
  bootSocket, sessions, requestPairingCode,
  reserveSlot, releaseSlot,
} = require("./runtime");

const app = express();
app.use(express.json({ limit: "16kb" }));

// Internal API key — set in env, never exposed
const INTERNAL_KEY = process.env.INTERNAL_API_KEY;
if (!INTERNAL_KEY) {
  console.error("❌ INTERNAL_API_KEY not set — refusing to start.");
  process.exit(1);
}

function auth(req, res) {
  if (req.headers["x-internal-key"] !== INTERNAL_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return true;
}

// ── pairing ─────────────────────────────────────────────
app.post("/internal/pair", async (req, res) => {
  if (!auth(req, res)) return;
  try {
    if (!reserveSlot()) return res.status(503).json({ error: "At capacity" });

    const phone = String(req.body.phone || "").replace(/\D/g, "");
    if (!/^[1-9]\d{9,14}$/.test(phone)) {
      return res.status(400).json({ error: "Invalid phone" });
    }
    const botName = String(req.body.botName || "").slice(0, 30);
    const sessionId = crypto.randomBytes(16).toString("hex");

    await saveSessionConfig(sessionId, {
      botName: botName || CONFIG.BOT_NAME,
      footer: CONFIG.FOOTER,
      version: CONFIG.VERSION,
      prefix: CONFIG.PREFIX,
      ownerNumber: phone,
      ownerName: CONFIG.OWNER_NAME,
      workMode: CONFIG.WORK_MODE,
      overrides: {},
      global: { ...DEFAULT_GLOBAL },
    });

    const code = await requestPairingCode(sessionId, phone);
    return res.json({ success: true, sessionId, code });
  } catch (e) {
    console.error("pair:", e.message);
    return res.status(500).json({ error: e.message });
  } finally {
    releaseSlot();
  }
});

// ── status ──────────────────────────────────────────────
app.get("/internal/status/:id", (req, res) => {
  if (!auth(req, res)) return;
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Unknown session" });
  res.json({
    bot: s.config?.botName || CONFIG.BOT_NAME,
    connected: !!s.conn?.user,
    jid: s.conn?.user?.id || null,
    socketReady: s.socketReady,
  });
});

// ── config ──────────────────────────────────────────────
app.post("/internal/config/:id", async (req, res) => {
  if (!auth(req, res)) return;
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Unknown session" });

  // ... same validation as before, call saveSessionConfig, update s.config ...
  res.json({ success: true });
});

// ── commands (public view) ──────────────────────────────
app.get("/internal/commands", (req, res) => {
  if (!auth(req, res)) return;
  res.json(presenter.listCommands().filter(c => !c.hidden && !c.ownerOnly));
});

// ── admin: reload ───────────────────────────────────────
app.post("/internal/reload", async (req, res) => {
  if (!auth(req, res)) return;
  await presenter._reload();
  res.json({ success: true, count: presenter.listCommands().length });
});

app.get("/internal/health", (req, res) => {
  if (!auth(req, res)) return;
  res.json({ ok: true, sessions: sessions.size });
});

// Loopback only — the public panel is in front
app.listen(process.env.BOT_PORT || 4000, "127.0.0.1", () => {
  console.log(`🤖 Bot server on 127.0.0.1:${process.env.BOT_PORT || 4000}`);
});
