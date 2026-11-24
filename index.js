// index.js
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
} = require("./db");
const { handleMessage, onPresenceUpdate } = require("./handler");

const logger = pino({ level: CONFIG.LOG_LEVEL });

// ── Required env check ──────────────────────────────────────
if (!CONFIG.MONGO_URI) {
  console.error("❌ MONGODB_URI missing in .env — fill it before starting.");
  process.exit(1);
}

// ── Global safety net (does NOT kill bot) ───────────────────
process.on("uncaughtException", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n❌ Port ${CONFIG.PORT} already in use.`);
    console.error(`Run "npx kill-port ${CONFIG.PORT}" or change PORT in .env\n`);
    process.exit(1);
  }
  console.error("Uncaught Exception:", err);
});

// ── Session registry ────────────────────────────────────────
const sessions = new Map();

// ── Rate limiter (per IP) ───────────────────────────────────
const pairAttempts = new Map();
function rateLimited(ip) {
  const last = pairAttempts.get(ip) || 0;
  if (Date.now() - last < CONFIG.RATE_LIMIT_MS) return true;
  pairAttempts.set(ip, Date.now());
  return false;
}

// ── Capacity check ──────────────────────────────────────────
function atCapacity() {
  return sessions.size >= CONFIG.MAX_SESSIONS;
}

// ── Boot a socket for a session ─────────────────────────────
async function bootSocket(sessionId) {
  let s = sessions.get(sessionId);
  if (s?.conn) return s.conn;
  if (s?.bootPromise) return s.bootPromise;

  if (!s) {
    s = {
      conn: null,
      socketReady: false,
      bootPromise: null,
      reconnectTimer: null,
      pairing: null,
      pairingNumber: null,
      lastSeen: Date.now(),
      config: null,
    };
    sessions.set(sessionId, s);
  }

  s.bootPromise = (async () => {
    const client = await getMongo();
    const collection = client.db(CONFIG.DB_NAME).collection("authState");
    const { state: waState, saveCreds } = await useMongoDBAuthState(collection, sessionId);
    const { version } = await fetchLatestBaileysVersion();
    const isNewSession = !waState.creds.me;

    // per-session config (loaded fresh every boot)
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

    // messages → handler (per-session config passed in)
    conn.ev.on("messages.upsert", async (m) => {
      try {
        if (m.type !== "notify") return;
        s.lastSeen = Date.now();
        await handleMessage({ conn, m, sessionId, config: s.config });
      } catch (e) {
        console.error(`[${sessionId}] handler error:`, e.message);
      }
    });

    conn.ev.on("presence.update", async (p) => {
      try {
        await onPresenceUpdate({ conn, presence: p, sessionId, config: s.config });
      } catch (e) {
        console.error(`[${sessionId}] presence error:`, e.message);
      }
    });

    conn.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "open") {
        s.socketReady = true;
        s.pairing = null;
        s.pairingNumber = null;
        s.lastSeen = Date.now();
        console.log(`✅ [${sessionId}] connected as ${conn.user?.id} — ${sessionConfig.botName} v${sessionConfig.version}`);

        try {
          await collection.updateOne(
            { _id: `${sessionId}:meta` },
            { $set: { value: { jid: conn.user?.id, linkedAt: Date.now(), bot: sessionConfig.botName } } },
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

  try {
    return await s.bootPromise;
  } finally {
    s.bootPromise = null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function requestPairingCode(sessionId, phoneNumber) {
  const conn = await bootSocket(sessionId);
  const s = sessions.get(sessionId);
  if (conn.user) throw new Error("Session already paired.");

  const deadline = Date.now() + 30000;
  while (!s.socketReady && Date.now() < deadline) {
    if (conn.ws?.isClosed) throw new Error("Socket closed before ready.");
    await sleep(500);
  }
  if (!s.socketReady) throw new Error("Socket not ready (timeout).");

  if (s.pairing && s.pairingNumber === phoneNumber) return s.pairing;

  let code;
  try {
    code = await conn.requestPairingCode(phoneNumber);
  } catch {
    await sleep(2000);
    code = await conn.requestPairingCode(phoneNumber);
  }

  const formatted = code.match(/.{1,4}/g)?.join("-") || code;
  s.pairing = formatted;
  s.pairingNumber = phoneNumber;
  return formatted;
}

// ── Express panel ───────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_req, res) => {
  res.json({
    bot: CONFIG.BOT_NAME,
    version: CONFIG.VERSION,
    footer: CONFIG.FOOTER,
    prefix: CONFIG.PREFIX,
    mode: CONFIG.WORK_MODE,
    sessions: sessions.size,
    capacity: CONFIG.MAX_SESSIONS,
  });
});

app.post("/pair", async (req, res) => {
  try {
    // optional API key gate (empty = open, same as before)
    if (CONFIG.PAIR_API_KEY) {
      const key = req.headers["x-api-key"] || req.body?.apiKey;
      if (key !== CONFIG.PAIR_API_KEY) return res.status(401).json({ error: "Unauthorized" });
    }

    // rate limit
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    if (rateLimited(ip)) {
      return res.status(429).json({ error: "Too many attempts, wait a minute" });
    }

    // capacity
    if (atCapacity()) {
      return res.status(503).json({ error: "Server at capacity, try later" });
    }

    const phone = String(req.body?.phone || "").replace(/[^0-9]/g, "");
    if (phone.length < 10 || phone.length > 15) {
      return res.status(400).json({ error: "Invalid phone number" });
    }

    const sessionId = crypto.randomBytes(8).toString("hex");
    const customName = String(req.body?.botName || "").slice(0, 30);

    // persist per-session config BEFORE pairing
    await saveSessionConfig(sessionId, {
      botName: customName || CONFIG.BOT_NAME,
      footer: CONFIG.FOOTER,
      version: CONFIG.VERSION,
      prefix: CONFIG.PREFIX,
      ownerNumber: phone,
      ownerName: CONFIG.OWNER_NAME,
      workMode: CONFIG.WORK_MODE,
      createdAt: Date.now(),
      overrides: {},
    });

    const code = await requestPairingCode(sessionId, phone);
    res.json({ success: true, sessionId, code, bot: customName || CONFIG.BOT_NAME });
  } catch (e) {
    console.error("pair:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/status/:sessionId", (req, res) => {
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

// per-session overrides — lets a user turn off AUTO_READ etc. for THEIR bot only
app.post("/config/:sessionId", async (req, res) => {
  try {
    const s = sessions.get(req.params.sessionId);
    if (!s) return res.status(404).json({ error: "Unknown session" });
    const patch = {};
    if (req.body?.prefix) patch.prefix = String(req.body.prefix).slice(0, 3);
    if (req.body?.botName) patch.botName = String(req.body.botName).slice(0, 30);
    if (req.body?.workMode) patch.workMode = String(req.body.workMode).toLowerCase();
    if (req.body?.overrides && typeof req.body.overrides === "object") {
      patch.overrides = { ...(s.config?.overrides || {}), ...req.body.overrides };
    }
    await saveSessionConfig(req.params.sessionId, patch);
    s.config = await getSessionConfig(req.params.sessionId);
    res.json({ success: true, config: s.config });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/health", (_req, res) =>
  res.json({ ok: true, bot: CONFIG.BOT_NAME, version: CONFIG.VERSION, sessions: sessions.size })
);

app.listen(CONFIG.PORT, "0.0.0.0", () =>
  console.log(`🌐 ${CONFIG.BOT_NAME} v${CONFIG.VERSION} panel → http://localhost:${CONFIG.PORT}`)
);

// ── Resume existing sessions on boot ────────────────────────
(async () => {
  try {
    const client = await getMongo();
    const metas = await client
      .db(CONFIG.DB_NAME)
      .collection("authState")
      .find({ _id: { $regex: ":meta$" } })
      .toArray();

    for (const meta of metas) {
      const sessionId = meta._id.replace(/:meta$/, "");
      console.log(`🔄 resuming ${sessionId}`);
      bootSocket(sessionId).catch((e) =>
        console.error(`resume ${sessionId}:`, e.message)
      );
    }
  } catch (e) {
    console.error("resume boot:", e.message);
  }
})();

// ── Idle session reaper (hourly) ────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, s] of sessions.entries()) {
    if (s.lastSeen && now - s.lastSeen > CONFIG.SESSION_TTL_MS) {
      console.log(`🧹 reaping idle session ${sessionId}`);
      try { s.conn?.end?.(undefined); } catch {}
      sessions.delete(sessionId);
    }
  }
}, 60 * 60 * 1000);
