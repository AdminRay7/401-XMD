// ══════════════════════════════════════════════════════════════
//  index.js — 303-XMD multi-user pairing + Express
// ══════════════════════════════════════════════════════════════

"use strict";

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const pino = require("pino");
const {
  default: makeWASocket,
  DisconnectReason,
  Browsers,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

const CONFIG = require("./config");
const {
  getMongo,
  useMongoDBAuthState,
  getSessionConfig,
  saveSessionConfig,
  wipeSession,
  listStaleSessions,
  DEFAULT_GLOBAL,
} = require("./db");
const presenter = require("./presenter");
const { handleMessage, onPresenceUpdate, onCall, onMessageDelete } = presenter;

const logger = pino({ level: CONFIG.LOG_LEVEL });

process.on("uncaughtException", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n❌ Port ${CONFIG.PORT} already in use.\n`);
    process.exit(1);
  }
  console.error("Uncaught Exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

// ── Sessions ──────────────────────────────────────────────
const sessions = new Map();
let reservedSlots = 0;
const atCapacity = () => sessions.size + reservedSlots >= CONFIG.MAX_SESSIONS;
function reserveSlot() { if (atCapacity()) return false; reservedSlots++; return true; }
function releaseSlot() { if (reservedSlots > 0) reservedSlots--; }

// ── Per-IP limiters (multi-user safe) ─────────────────────
const limiterMaps = {
  pair:   new Map(),
  status: new Map(),
  config: new Map(),
};
function limited(bucket, ip, windowMs) {
  const m = limiterMaps[bucket];
  const now = Date.now();
  const last = m.get(ip) || 0;
  if (now - last < windowMs) return true;
  m.set(ip, now);
  return false;
}
function pruneLimiters() {
  const cut = Date.now() - Math.max(CONFIG.RATE_LIMIT_MS * 4, 60_000);
  for (const m of Object.values(limiterMaps)) {
    for (const [ip, ts] of m.entries()) if (ts < cut) m.delete(ip);
  }
}
function clientIp(req) { return req.ip || req.socket?.remoteAddress || "unknown"; }

// ══════════════════════════════════════════════════════════════
//  BOOT SOCKET (per user)
// ══════════════════════════════════════════════════════════════
async function bootSocket(sessionId) {
  let s = sessions.get(sessionId);
  if (s?.conn) return s.conn;
  if (s?.bootPromise) return s.bootPromise;

  if (!s) {
    s = {
      conn: null, socketReady: false, bootPromise: null,
      reconnectTimer: null, pairing: null, pairingNumber: null,
      lastSeen: Date.now(), config: null,
    };
    sessions.set(sessionId, s);
  }

  s.bootPromise = (async () => {
    const client = await getMongo();
    const collection = client.db(CONFIG.DB_NAME).collection("authState");
    const { state: waState, saveCreds } = await useMongoDBAuthState(collection, sessionId);
    const { version } = await fetchLatestBaileysVersion();
    const isNewSession = !waState.creds.me;

    const sessionConfig = await getSessionConfig(sessionId);
    s.config = sessionConfig;

    const conn = makeWASocket({
      version,
      auth: {
        creds: waState.creds,
        keys: makeCacheableSignalKeyStore(waState.keys, logger),
      },
      logger,
      browser: Browsers.macOS("Safari"),
      syncFullHistory: false,
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      fireInitQueries: !isNewSession,
      emitOwnEvents: false,
    });

    s.conn = conn;
    conn.ev.on("creds.update", saveCreds);
    conn.ev.on("error", (e) => console.error(`[${sessionId}] socket error:`, e?.message || e));

    conn.ev.on("messages.upsert", async (m) => {
      try {
        if (m.type !== "notify") return;
        s.lastSeen = Date.now();
        await handleMessage({ conn, m, sessionId, config: s.config });
      } catch (e) { console.error(`[${sessionId}] handler:`, e.message); }
    });
    conn.ev.on("presence.update", async (p) => {
      try { await onPresenceUpdate({ conn, presence: p, sessionId, config: s.config }); }
      catch (e) { console.error(`[${sessionId}] presence:`, e.message); }
    });
    conn.ev.on("call", async (calls) => {
      try { await onCall({ conn, calls, sessionId, config: s.config }); }
      catch (e) { console.error(`[${sessionId}] call:`, e.message); }
    });
    conn.ev.on("messages.update", async (updates) => {
      try {
        const deletes = updates.filter(
          (u) =>
            u?.update &&
            u.update.message === null &&
            (u.update.messageStubType === 1 || Array.isArray(u.update.messageStubParameters))
        );
        if (deletes.length) {
          await onMessageDelete({ conn, deletes, sessionId, config: s.config });
        }
      } catch (e) { console.error(`[${sessionId}] delete:`, e.message); }
    });

    conn.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "open") {
        s.socketReady = true;
        s.pairing = null; s.pairingNumber = null;
        s.lastSeen = Date.now();
        console.log(`✅ [${sessionId}] connected as ${conn.user?.id}`);

        // update :meta to reflect real JID and clear pending
        try {
          await collection.updateOne(
            { _id: `${sessionId}:meta` },
            { $set: { value: { jid: conn.user?.id, linkedAt: Date.now(), bot: sessionConfig.botName, pending: false } } },
            { upsert: true }
          );
        } catch {}

        if (isNewSession) {
          try {
            const num = conn.user?.id.split(":")[0].split("@")[0];
            await conn.sendMessage(`${num}@s.whatsapp.net`, {
              text:
                `👋 *${sessionConfig.botName}* is online!\n\n` +
                `📦 Version: *v${sessionConfig.version}*\n` +
                `🔑 Session: *${sessionId}*\n` +
                `⚙️ Prefix: *${sessionConfig.prefix}*\n` +
                `🌐 Mode: *${sessionConfig.workMode}*\n\n` +
                `_${sessionConfig.footer}_`,
            });
          } catch {}
        }
      }

      if (connection === "close") {
        s.socketReady = false;
        s.conn = null;
        s.bootPromise = null;
        const code = lastDisconnect?.error?.output?.statusCode;
        console.log(`❌ [${sessionId}] closed. code=${code}`);

        if (code === 401 || code === DisconnectReason.loggedOut) {
          sessions.delete(sessionId);
          try { await wipeSession(sessionId); } catch {}
          return;
        }
        if (code === 440) return;

        if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
        s.reconnectTimer = setTimeout(() => {
          s.reconnectTimer = null;
          if (sessions.has(sessionId)) {
            bootSocket(sessionId).catch((e) =>
              console.error(`[${sessionId}] reconnect:`, e.message)
            );
          }
        }, 5000);
      }
    });

    return conn;
  })();

  try { return await s.bootPromise; }
  catch (e) { s.bootPromise = null; throw e; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForSocketOpen(conn, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (conn.ws?.isClosed) throw new Error("Socket closed before ready.");
    if (conn.ws?.isOpen) return;
    await sleep(250);
  }
  throw new Error("Socket not ready (timeout).");
}

async function requestPairingCode(sessionId, phoneNumber) {
  const conn = await bootSocket(sessionId);
  const s = sessions.get(sessionId);
  if (!s) throw new Error("Session vanished.");
  if (conn.user) throw new Error("Session already paired.");
  await waitForSocketOpen(conn);
  if (s.pairing && s.pairingNumber === phoneNumber) return s.pairing;

  let code;
  try { code = await conn.requestPairingCode(phoneNumber); }
  catch (e1) {
    console.error(`[${sessionId}] pairing attempt 1 failed:`, e1?.message || e1);
    await sleep(1500);
    code = await conn.requestPairingCode(phoneNumber);
  }
  const formatted = code.match(/.{1,4}/g)?.join("-") || code;
  s.pairing = formatted; s.pairingNumber = phoneNumber;
  return formatted;
}

// ══════════════════════════════════════════════════════════════
//  EXPRESS
// ══════════════════════════════════════════════════════════════
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get("/api", (_req, res) => {
  res.json({
    bot: CONFIG.BOT_NAME, version: CONFIG.VERSION, footer: CONFIG.FOOTER,
    prefix: CONFIG.PREFIX, mode: CONFIG.WORK_MODE,
    sessions: sessions.size, capacity: CONFIG.MAX_SESSIONS,
  });
});

// ── /pair ────────────────────────────────────────────────
app.post("/pair", async (req, res) => {
  let reserved = false;
  try {
    if (CONFIG.PAIR_API_KEY) {
      const key = req.headers["x-api-key"] || req.body?.apiKey;
      if (key !== CONFIG.PAIR_API_KEY) return res.status(401).json({ error: "Unauthorized" });
    }
    const ip = clientIp(req);
    if (limited("pair", ip, CONFIG.RATE_LIMIT_MS)) {
      return res.status(429).json({ error: "Too many attempts, wait a minute" });
    }
    if (!reserveSlot()) {
      return res.status(503).json({ error: "Server at capacity, try later" });
    }
    reserved = true;

    const phone = String(req.body?.phone || "").replace(/[^0-9]/g, "");
    if (phone.length < 10 || phone.length > 15 || !/^[1-9]\d{9,14}$/.test(phone)) {
      return res.status(400).json({ error: "Invalid phone number" });
    }
    const customName = String(req.body?.botName || "").slice(0, 30);
    const sessionId = crypto.randomBytes(8).toString("hex");

    // per-session config: start from DEFAULT_GLOBAL, owner = the pairing phone
    await saveSessionConfig(sessionId, {
      botName: customName || CONFIG.BOT_NAME,
      footer: CONFIG.FOOTER,
      version: CONFIG.VERSION,
      prefix: CONFIG.PREFIX,
      ownerNumber: phone,
      ownerName: CONFIG.OWNER_NAME,
      workMode: CONFIG.WORK_MODE,
      overrides: {},
      global: { ...DEFAULT_GLOBAL }, // per-user defaults
    });

    // :meta placeholder so orphan configs can be reaped
    const client = await getMongo();
    await client.db(CONFIG.DB_NAME).collection("authState").updateOne(
      { _id: `${sessionId}:meta` },
      { $set: { value: { jid: null, linkedAt: null, pending: true, createdAt: Date.now() } } },
      { upsert: true }
    );

    const code = await requestPairingCode(sessionId, phone);
    return res.json({ success: true, sessionId, code, bot: customName || CONFIG.BOT_NAME });
  } catch (e) {
    console.error("pair:", e.message);
    return res.status(500).json({ error: e.message });
  } finally {
    if (reserved) releaseSlot();
  }
});

// ── /status/:sessionId ───────────────────────────────────
app.get("/status/:sessionId", (req, res) => {
  const ip = clientIp(req);
  if (limited("status", ip, CONFIG.STATUS_RATE_MS)) {
    return res.status(429).json({ error: "Slow down" });
  }
  const s = sessions.get(req.params.sessionId);
  if (!s) return res.status(404).json({ error: "Unknown session" });
  res.json({
    bot: s.config?.botName || CONFIG.BOT_NAME,
    version: s.config?.version || CONFIG.VERSION,
    connected: !!s.conn?.user,
    jid: s.conn?.user?.id || null,
    socketReady: s.socketReady,
  });
});

// ── /config/:sessionId ───────────────────────────────────
// The sessionId acts as the capability token. Require it, require the
// optional API key, and rate-limit per IP. Never allow cross-session writes.
app.post("/config/:sessionId", async (req, res) => {
  try {
    if (CONFIG.PAIR_API_KEY) {
      const key = req.headers["x-api-key"] || req.body?.apiKey;
      if (key !== CONFIG.PAIR_API_KEY) return res.status(401).json({ error: "Unauthorized" });
    }
    const ip = clientIp(req);
    if (limited("config", ip, CONFIG.RATE_LIMIT_MS)) {
      return res.status(429).json({ error: "Slow down" });
    }

    const s = sessions.get(req.params.sessionId);
    if (!s) return res.status(404).json({ error: "Unknown session" });

    if (req.body?.workMode !== undefined) {
      const wm = String(req.body.workMode).toLowerCase();
      if (!CONFIG.WORK_MODES.has(wm)) {
        return res.status(400).json({ error: `Invalid workMode. Allowed: ${[...CONFIG.WORK_MODES].join(", ")}` });
      }
    }
    const patch = {};
    if (req.body?.prefix) patch.prefix = String(req.body.prefix).slice(0, 3);
    if (req.body?.botName) patch.botName = String(req.body.botName).slice(0, 30);
    if (req.body?.workMode) patch.workMode = String(req.body.workMode).toLowerCase();
    if (req.body?.overrides && typeof req.body.overrides === "object") {
      const merged = { ...(s.config?.overrides || {}) };
      for (const [k, v] of Object.entries(req.body.overrides)) {
        if (v === null) delete merged[k];
        else if (typeof v === "boolean") merged[k] = v;
      }
      patch.overrides = merged;
    }
    if (req.body?.global && typeof req.body.global === "object") {
      // only allow toggling known feature keys + ALLOW_GLOBAL_OWNER
      const allowed = new Set([
        ...Object.keys(DEFAULT_GLOBAL),
      ]);
      const g = {};
      for (const [k, v] of Object.entries(req.body.global)) {
        if (!allowed.has(k)) continue;
        if (k === "STATUS_REPLY_TEXT" || k === "CHANNEL_EMOJIS") g[k] = v;
        else g[k] = v === true;
      }
      patch.global = g;
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    await saveSessionConfig(req.params.sessionId, patch);
    s.config = await getSessionConfig(req.params.sessionId);
    return res.json({ success: true, config: s.config });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("/commands", (_req, res) => res.json(presenter.listCommands()));
app.post("/reload", (req, res) => {
  if (CONFIG.PAIR_API_KEY) {
    const key = req.headers["x-api-key"] || req.body?.apiKey;
    if (key !== CONFIG.PAIR_API_KEY) return res.status(401).json({ error: "Unauthorized" });
  }
  presenter._reload();
  res.json({ success: true, commands: presenter.listCommands().length });
});
app.get("/health", (_req, res) =>
  res.json({
    ok: true, bot: CONFIG.BOT_NAME, version: CONFIG.VERSION,
    sessions: sessions.size, commands: presenter.listCommands().length,
  })
);

app.listen(CONFIG.PORT, "0.0.0.0", () =>
  console.log(`🌐 ${CONFIG.BOT_NAME} v${CONFIG.VERSION} panel → http://localhost:${CONFIG.PORT}`)
);

// ══════════════════════════════════════════════════════════════
//  RESUME ON BOOT (multi-user safe)
// ══════════════════════════════════════════════════════════════
(async () => {
  try {
    const client = await getMongo();
    const metas = await client
      .db(CONFIG.DB_NAME)
      .collection("authState")
      .find({ _id: { $regex: ":meta$" }, "value.pending": { $ne: true } })
      .sort({ "value.linkedAt": -1 })
      .limit(CONFIG.MAX_SESSIONS)
      .toArray();

    for (const meta of metas) {
      const sessionId = meta._id.replace(/:meta$/, "");
      if (sessions.has(sessionId)) continue;
      console.log(`🔄 resuming ${sessionId}`);
      bootSocket(sessionId).catch((e) =>
        console.error(`resume ${sessionId}:`, e.message)
      );
    }
  } catch (e) {
    console.error("resume boot:", e.message);
  }
})();

// ══════════════════════════════════════════════════════════════
//  REAPER (hourly)
// ══════════════════════════════════════════════════════════════
setInterval(async () => {
  pruneLimiters();

  // 1. reap idle in-memory sessions
  const now = Date.now();
  for (const [sessionId, s] of sessions.entries()) {
    if (!s.lastSeen) continue;
    if (now - s.lastSeen <= CONFIG.SESSION_TTL_MS) continue;
    console.log(`🧹 reaping idle session ${sessionId}`);
    try { s.conn?.end?.(undefined); } catch {}
    if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
    sessions.delete(sessionId);
  }

  // 2. wipe orphan configs / stale metas
  try {
    const stale = await listStaleSessions([...sessions.keys()]);
    for (const sid of stale) {
      if (sessions.has(sid)) continue;
      await wipeSession(sid);
    }
  } catch (e) {
    console.error("reaper stale:", e.message);
  }
}, 60 * 60 * 1000);
