// ══════════════════════════════════════════════════════════════
//  index.js — 303-XMD multi-user pairing + Express (Fully Fixed)
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

const logger = pino({ level: CONFIG.LOG_LEVEL || "info" });

// ── Process-level safety ──────────────────────────────────
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

// ── Config sanity warnings ────────────────────────────────
if (!CONFIG.PAIR_API_KEY) {
  console.warn("⚠️  PAIR_API_KEY is not set — /pair endpoint is OPEN to anyone.");
}
if (!CONFIG.RATE_LIMIT_MS) {
  console.warn("⚠️  RATE_LIMIT_MS missing — defaulting to 60_000ms.");
}
if (!CONFIG.STATUS_RATE_MS) {
  console.warn("⚠️  STATUS_RATE_MS missing — defaulting to 30_000ms.");
}

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
  const cut = Date.now() - Math.max((CONFIG.RATE_LIMIT_MS || 60_000) * 4, 60_000);
  for (const m of Object.values(limiterMaps)) {
    for (const [ip, ts] of m.entries()) if (ts < cut) m.delete(ip);
  }
}
function clientIp(req) { return req.ip || req.socket?.remoteAddress || "unknown"; }

// ══════════════════════════════════════════════════════════════
//  BOOT SOCKET (per user) — fully hardened
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

    // ✅ FIX #25: default config if DB returns null
    const sessionConfig = (await getSessionConfig(sessionId)) || {};
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

    // ✅ FIX #19: detect revokes from messages.upsert (protocolMessage)
    conn.ev.on("messages.upsert", async (m) => {
      try {
        if (m.type !== "notify") return;
        s.lastSeen = Date.now();

        // handle revokes
        for (const msg of m.messages || []) {
          const pm = msg?.message?.protocolMessage;
          if (pm && (pm.type === 0 || pm.type === "REVOKE") && pm.key) {
            try {
              await onMessageDelete({ conn, deletes: [msg], sessionId, config: s.config });
            } catch (e) {
              console.error(`[${sessionId}] delete (revoke):`, e.message);
            }
          }
        }

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
            const bname = sessionConfig.botName || CONFIG.BOT_NAME;
            const bver  = sessionConfig.version  || CONFIG.VERSION;
            const bpre  = sessionConfig.prefix   || CONFIG.PREFIX;
            const bmode = sessionConfig.workMode || CONFIG.WORK_MODE;
            const bfoot = sessionConfig.footer   || CONFIG.FOOTER;
            await conn.sendMessage(`${num}@s.whatsapp.net`, {
              text:
                `👋 *${bname}* is online!\n\n` +
                `📦 Version: *v${bver}*\n` +
                `🔑 Session: *${sessionId}*\n` +
                `⚙️ Prefix: *${bpre}*\n` +
                `🌐 Mode: *${bmode}*\n\n` +
                `_${bfoot}_`,
            });
          } catch {}
        }
      }

      if (connection === "close") {
        s.socketReady = false;
        s.conn = null;
        s.bootPromise = null;      // ✅ FIX #13: clear stale promise
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

  // ✅ FIX #12: clear bootPromise on BOTH success and failure
  try {
    const conn = await s.bootPromise;
    s.bootPromise = null;
    return conn;
  } catch (e) {
    s.bootPromise = null;
    throw e;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ✅ FIX #5 / #30: don't block on ws.isOpen — resolve when connection update
//                    reports qr/connecting, or if socket already has user.
async function waitForSocketOpen(conn, timeoutMs = 60000) {
  if (conn.user) return;
  if (conn.ws?.isOpen) return;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.ev.off("connection.update", onUpdate);
      reject(new Error("Socket not ready (timeout)."));
    }, timeoutMs);

    function onUpdate(u) {
      if (u?.connection === "connecting" || u?.qr || u?.connection === "open") {
        clearTimeout(timer);
        conn.ev.off("connection.update", onUpdate);
        resolve();
      }
    }
    conn.ev.on("connection.update", onUpdate);
  });
}

async function requestPairingCode(sessionId, phoneNumber) {
  const conn = await bootSocket(sessionId);
  const s = sessions.get(sessionId);
  if (!s) throw new Error("Session vanished.");
  if (conn.user) throw new Error("Session already paired.");
  await waitForSocketOpen(conn);
  if (s.pairing && s.pairingNumber === phoneNumber) return s.pairing;

  let code;
  try {
    code = await conn.requestPairingCode(phoneNumber);
  } catch (e1) {
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

// ✅ FIX #8 / #2 / #10: shared auth helper
function requireApiKey(req, res) {
  if (!CONFIG.PAIR_API_KEY) return true;
  const key = req.headers["x-api-key"] || req.body?.apiKey || req.query?.apiKey;
  if (key !== CONFIG.PAIR_API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

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
  let sessionId = null;
  try {
    if (!requireApiKey(req, res)) return;

    const ip = clientIp(req);
    const rateMs = CONFIG.RATE_LIMIT_MS || 60_000;
    if (limited("pair", ip, rateMs)) {
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
    sessionId = crypto.randomBytes(16).toString("hex"); // ✅ FIX #31: 128-bit

    await saveSessionConfig(sessionId, {
      botName: customName || CONFIG.BOT_NAME,
      footer: CONFIG.FOOTER,
      version: CONFIG.VERSION,
      prefix: CONFIG.PREFIX,
      ownerNumber: phone,
      ownerName: CONFIG.OWNER_NAME,
      workMode: CONFIG.WORK_MODE,
      overrides: {},
      global: { ...DEFAULT_GLOBAL },
    });

    const client = await getMongo();
    await client.db(CONFIG.DB_NAME).collection("authState").updateOne(
      { _id: `${sessionId}:meta` },
      { $set: { value: { jid: null, linkedAt: null, pending: true, createdAt: Date.now() } } },
      { upsert: true }
    );

    // ✅ FIX #3: wipe session/config if pairing fails
    let code;
    try {
      code = await requestPairingCode(sessionId, phone);
    } catch (pairErr) {
      console.error(`pair ${sessionId}:`, pairErr.message);
      try { await wipeSession(sessionId); } catch {}
      sessions.delete(sessionId);
      return res.status(500).json({ error: pairErr.message || "Pairing failed" });
    }

    return res.json({ success: true, sessionId, code, bot: customName || CONFIG.BOT_NAME });
  } catch (e) {
    console.error("pair:", e.message);
    if (sessionId) {
      try { await wipeSession(sessionId); } catch {}
      sessions.delete(sessionId);
    }
    return res.status(500).json({ error: e.message });
  } finally {
    if (reserved) releaseSlot();
  }
});

// ── /status/:sessionId ───────────────────────────────────
// ✅ FIX #8: require API key if configured
app.get("/status/:sessionId", (req, res) => {
  if (!requireApiKey(req, res)) return;

  const ip = clientIp(req);
  if (limited("status", ip, CONFIG.STATUS_RATE_MS || 30_000)) {
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
app.post("/config/:sessionId", async (req, res) => {
  try {
    if (!requireApiKey(req, res)) return;

    const ip = clientIp(req);
    if (limited("config", ip, CONFIG.RATE_LIMIT_MS || 60_000)) {
      return res.status(429).json({ error: "Slow down" });
    }

    const s = sessions.get(req.params.sessionId);
    if (!s) return res.status(404).json({ error: "Unknown session" });

    if (req.body?.workMode !== undefined) {
      const wm = String(req.body.workMode).toLowerCase();
      if (!CONFIG.WORK_MODES?.has?.(wm)) {
        return res.status(400).json({
          error: `Invalid workMode. Allowed: ${CONFIG.WORK_MODES ? [...CONFIG.WORK_MODES].join(", ") : "n/a"}`,
        });
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

    // ✅ FIX #9: merge global, don't replace
    if (req.body?.global && typeof req.body.global === "object") {
      const allowed = new Set(Object.keys(DEFAULT_GLOBAL || {}));
      const current = await getSessionConfig(req.params.sessionId);
      const merged = { ...(current?.global || DEFAULT_GLOBAL || {}) };
      for (const [k, v] of Object.entries(req.body.global)) {
        if (!allowed.has(k)) continue;
        if (k === "STATUS_REPLY_TEXT" || k === "CHANNEL_EMOJIS") merged[k] = v;
        else merged[k] = v === true;
      }
      patch.global = merged;
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    await saveSessionConfig(req.params.sessionId, patch);
    s.config = (await getSessionConfig(req.params.sessionId)) || {};
    return res.json({ success: true, config: s.config });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ✅ FIX #10: /commands hides sensitive commands if no API key
app.get("/commands", (req, res) => {
  const all = presenter.listCommands();
  if (CONFIG.PAIR_API_KEY) {
    const key = req.headers["x-api-key"] || req.query?.apiKey;
    if (key !== CONFIG.PAIR_API_KEY) {
      // public view: strip hidden + owner-only
      return res.json(all.filter((c) => !c.hidden && !c.ownerOnly));
    }
  }
  res.json(all);
});

// ✅ FIX #4: await the reload
app.post("/reload", async (req, res) => {
  if (!requireApiKey(req, res)) return;
  try {
    await presenter._reload();
    res.json({ success: true, commands: presenter.listCommands().length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/health", (_req, res) =>
  res.json({
    ok: true, bot: CONFIG.BOT_NAME, version: CONFIG.VERSION,
    sessions: sessions.size, commands: presenter.listCommands().length,
  })
);

const server = app.listen(CONFIG.PORT, "0.0.0.0", () =>
  console.log(`🌐 ${CONFIG.BOT_NAME} v${CONFIG.VERSION} panel → http://localhost:${CONFIG.PORT}`)
);
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`❌ Port ${CONFIG.PORT} already in use.`);
    process.exit(1);
  }
  console.error("Server error:", err);
});

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
      if (sessions.size >= CONFIG.MAX_SESSIONS) break; // ✅ FIX #14
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
      try { await wipeSession(sid); } catch (e) {
        console.error(`wipe ${sid}:`, e.message);
      }
    }
  } catch (e) {
    console.error("reaper stale:", e.message);
  }
}, 60 * 60 * 1000);
