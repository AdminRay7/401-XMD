// ══════════════════════════════════════════════════════════════
//  bot-server.js — internal-only API for the web panel
//  Binds to 127.0.0.1 ONLY. Never expose publicly.
// ══════════════════════════════════════════════════════════════

"use strict";

const express = require("express");
const crypto = require("crypto");
const CONFIG = require("./config");
const runtime = require("./runtime");

const logger = require("pino")({ level: CONFIG.LOG_LEVEL || "info" });

// ── env checks ────────────────────────────────────────────
const INTERNAL_KEY = process.env.INTERNAL_API_KEY;
if (!INTERNAL_KEY) {
  console.error("❌ INTERNAL_API_KEY is not set — refusing to start.");
  process.exit(1);
}
if (INTERNAL_KEY.length < 16) {
  console.error("❌ INTERNAL_API_KEY must be at least 16 characters.");
  process.exit(1);
}

const PORT = Number(process.env.BOT_PORT || 4000);
const HOST = process.env.BOT_HOST || "127.0.0.1";

// ── app ───────────────────────────────────────────────────
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

// no static, no UI, no trust proxy — this is internal

function auth(req, res) {
  const key = req.headers["x-internal-key"];
  if (key !== INTERNAL_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// tiny request logger
app.use((req, _res, next) => {
  logger.debug(`${req.method} ${req.path}`);
  next();
});

// ══════════════════════════════════════════════════════════════
//  /internal/health
// ══════════════════════════════════════════════════════════════
app.get("/internal/health", (req, res) => {
  if (!auth(req, res)) return;
  res.json({
    ok: true,
    bot: CONFIG.BOT_NAME,
    version: CONFIG.VERSION,
    ...runtime.stats(),
    commands: runtime.presenter.listCommands().length,
    uptime: Math.floor(process.uptime()),
  });
});

// ══════════════════════════════════════════════════════════════
//  /internal/pair
// ══════════════════════════════════════════════════════════════
app.post("/internal/pair", async (req, res) => {
  if (!auth(req, res)) return;

  if (!runtime.reserveSlot()) {
    return res.status(503).json({ error: "Server at capacity, try later" });
  }

  try {
    const phone = String(req.body?.phone || "").replace(/[^0-9]/g, "");
    if (phone.length < 10 || phone.length > 15 || !/^[1-9]\d{9,14}$/.test(phone)) {
      return res.status(400).json({ error: "Invalid phone number" });
    }
    const botName = String(req.body?.botName || "").slice(0, 30);
    const sessionId = crypto.randomBytes(16).toString("hex");

    const result = await runtime.pair(sessionId, phone, botName);
    return res.json(result);
  } catch (e) {
    logger.error({ err: e.message }, "pair failed");
    return res.status(500).json({ error: e.message || "Pairing failed" });
  } finally {
    runtime.releaseSlot();
  }
});

// ══════════════════════════════════════════════════════════════
//  /internal/status/:sessionId
// ══════════════════════════════════════════════════════════════
app.get("/internal/status/:sessionId", (req, res) => {
  if (!auth(req, res)) return;
  const status = runtime.getStatus(req.params.sessionId);
  if (!status) return res.status(404).json({ error: "Unknown session" });
  res.json(status);
});

// ══════════════════════════════════════════════════════════════
//  /internal/config/:sessionId
// ══════════════════════════════════════════════════════════════
app.post("/internal/config/:sessionId", async (req, res) => {
  if (!auth(req, res)) return;
  try {
    const config = await runtime.updateConfig(req.params.sessionId, req.body || {});
    res.json({ success: true, config });
  } catch (e) {
    const status = /unknown session/i.test(e.message) ? 404 : 400;
    res.status(status).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  /internal/commands  (public-safe view only)
// ══════════════════════════════════════════════════════════════
app.get("/internal/commands", (req, res) => {
  if (!auth(req, res)) return;
  res.json(runtime.publicCommands());
});

// ══════════════════════════════════════════════════════════════
//  /internal/reload
// ══════════════════════════════════════════════════════════════
app.post("/internal/reload", async (req, res) => {
  if (!auth(req, res)) return;
  try {
    const count = await runtime.reloadCommands();
    res.json({ success: true, commands: count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  Fallback
// ══════════════════════════════════════════════════════════════
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// ══════════════════════════════════════════════════════════════
//  Boot
// ══════════════════════════════════════════════════════════════
const server = app.listen(PORT, HOST, () => {
  console.log(`🤖 Bot server → http://${HOST}:${PORT}`);
  console.log(`   Internal API key: ${INTERNAL_KEY.slice(0, 4)}…`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`❌ Port ${PORT} already in use.`);
    process.exit(1);
  }
  console.error("Server error:", err);
});

// resume sessions + start reaper
runtime.resumeSessions().catch((e) => logger.error({ err: e.message }, "resume"));
runtime.startReaper();

// graceful shutdown
function shutdown(signal) {
  console.log(`\n${signal} received — shutting down…`);
  runtime.stopReaper();
  for (const [sid, s] of runtime.sessions.entries()) {
    try { s.conn?.end?.(undefined); } catch {}
    runtime.sessions.delete(sid);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});
