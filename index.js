// ══════════════════════════════════════════════════════════════
//  index.js — 303-XMD pairing + connection + Express
//  • Mongo-backed auth state
//  • Per-session config
//  • Delegates ALL command/feature logic to presenter.js
//  • Auto-serves the UI on root (/)
// ══════════════════════════════════════════════════════════════

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
const presenter = require("./presenter");
const {
  handleMessage,
  onPresenceUpdate,
  onCall,
  onMessageDelete,
} = presenter;

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
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

// ── Session registry ────────────────────────────────────────
const sessions = new Map();

// FIX #2: capacity is reserved synchronously before any await
let reservedSlots = 0;
function atCapacity() {
  return sessions.size + reservedSlots >= CONFIG.MAX_SESSIONS;
}
function reserveSlot() {
  if (atCapacity()) return false;
  reservedSlots++;
  return true;
}
function releaseSlot() {
  if (reservedSlots > 0) reservedSlots--;
}

// ── Rate limiter (per IP) ───────────────────────────────────
// FIX #1: prune old entries so the Map doesn't leak forever
// FIX #15: helper to resolve client IP safely (trust proxy aware)
const pairAttempts = new Map();
function clientIp(req) {
  // When app.set("trust proxy", ...) is configured, req.ip is already correct.
  return req.ip || req.socket?.remoteAddress || "unknown";
}
function rateLimited(ip) {
  const now = Date.now();
  const last = pairAttempts.get(ip) || 0;
  if (now - last < CONFIG.RATE_LIMIT_MS) return true;
  pairAttempts.set(ip, now);
  return false;
}
function pruneRateLimiter() {
  const cutoff = Date.now() - Math.max(CONFIG.RATE_LIMIT_MS * 4, 60_000);
  for (const [ip, ts] of pairAttempts.entries()) {
    if (ts < cutoff) pairAttempts.delete(ip);
  }
}

// ══════════════════════════════════════════════════════════════
//  BOOT SOCKET
// ══════════════════════════════════════════════════════════════
async function bootSocket(sessionId) {
  let s = sessions.get(sessionId);
  if (s?.conn) return s.conn;
  // FIX #4: keep bootPromise set synchronously; never null it in finally.
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
      wsOpenPromise: null, // FIX #3: track WS open separately from pairing
    };
    sessions.set(sessionId, s);
  }

  // FIX #4: assign synchronously, clear only in connection.close / on error
  s.bootPromise = (async () => {
    const client = await getMongo();
    const collection = client.db(CONFIG.DB_NAME).collection("authState");
    const { state: waState, saveCreds } = await useMongoDBAuthState(collection, sessionId);
    const { version } = await fetchLatestBaileysVersion();
    const isNewSession = !waState.creds.me;

    // per-session config
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

    // FIX #14: handle socket-level "error" so EventEmitter doesn't crash process
    conn.ev.on("error", (e) => {
      console.error(`[${sessionId}] socket error:`, e?.message || e);
    });

    // ── Messages → presenter ─────────────────────────────
    conn.ev.on("messages.upsert", async (m) => {
      try {
        if (m.type !== "notify") return;
        s.lastSeen = Date.now();
        await handleMessage({ conn, m, sessionId, config: s.config });
      } catch (e) {
        console.error(`[${sessionId}] handler error:`, e.message);
      }
    });

    // ── Presence → presenter ─────────────────────────────
    conn.ev.on("presence.update", async (p) => {
      try {
        await onPresenceUpdate({ conn, presence: p, sessionId, config: s.config });
      } catch (e) {
        console.error(`[${sessionId}] presence error:`, e.message);
      }
    });

    // ── Calls (ANTICALL) ─────────────────────────────────
    conn.ev.on("call", async (calls) => {
      try {
        await onCall({ conn, calls, sessionId, config: s.config });
      } catch (e) {
        console.error(`[${sessionId}] call error:`, e.message);
      }
    });

    // ── Deletions (ANTIDELETE) ───────────────────────────
    // FIX #7: require message:null AND (messageStubType===1 OR stub params present)
    conn.ev.on("messages.update", async (updates) => {
      try {
        const deletes = updates.filter(
          (u) =>
            u?.update &&
            u.update.message === null &&
            (u.update.messageStubType === 1 ||
              Array.isArray(u.update.messageStubParameters))
        );
        if (deletes.length) {
          await onMessageDelete({ conn, deletes, sessionId, config: s.config });
        }
      } catch (e) {
        console.error(`[${sessionId}] delete error:`, e.message);
      }
    });

    // ── Connection lifecycle ─────────────────────────────
    conn.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "open") {
        s.socketReady = true;
        s.pairing = null;
        s.pairingNumber = null;
        s.lastSeen = Date.now();
        console.log(
          `✅ [${sessionId}] connected as ${conn.user?.id} — ` +
          `${sessionConfig.botName} v${sessionConfig.version}`
        );

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
        // FIX #4: clear bootPromise only here, so concurrent callers
        //          during setup still share the same promise
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
  } catch (e) {
    // FIX #4: on failure, allow a fresh retry
    s.bootPromise = null;
    throw e;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// FIX #3: wait for the WebSocket to open (not for socketReady, which
//         only flips after pairing completes)
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

  // FIX #3: wait for the underlying WS to be open (correct precondition)
  await waitForSocketOpen(conn);

  if (s.pairing && s.pairingNumber === phoneNumber) return s.pairing;

  let code;
  try {
    code = await conn.requestPairingCode(phoneNumber);
  } catch (e1) {
    // FIX #12: log first error; retry only once with a short delay
    console.error(`[${sessionId}] pairing attempt 1 failed:`, e1?.message || e1);
    await sleep(1500);
    code = await conn.requestPairingCode(phoneNumber);
  }

  const formatted = code.match(/.{1,4}/g)?.join("-") || code;
  s.pairing = formatted;
  s.pairingNumber = phoneNumber;
  return formatted;
}

// ══════════════════════════════════════════════════════════════
//  EXPRESS PANEL
// ══════════════════════════════════════════════════════════════
const app = express();

// FIX #15: honor X-Forwarded-For when behind a proxy.
// Set to `1` (single proxy hop) by default. If not behind a proxy,
// the header is ignored and req.ip falls back to the socket address.
app.set("trust proxy", 1);

// FIX #11: cap JSON body size
app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── SERVE UI AUTOMATICALLY ON ROOT (/) ──────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── SYSTEM JSON STATUS (Moved from / to /api) ───────────────
app.get("/api", (_req, res) => {
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
  let reserved = false;
  try {
    if (CONFIG.PAIR_API_KEY) {
      const key = req.headers["x-api-key"] || req.body?.apiKey;
      if (key !== CONFIG.PAIR_API_KEY) return res.status(401).json({ error: "Unauthorized" });
    }

    // FIX #15: use helper
    const ip = clientIp(req);
    if (rateLimited(ip)) {
      return res.status(429).json({ error: "Too many attempts, wait a minute" });
    }

    // FIX #2: reserve a slot synchronously to avoid the capacity race
    if (!reserveSlot()) {
      return res.status(503).json({ error: "Server at capacity, try later" });
    }
    reserved = true;

    const phone = String(req.body?.phone || "").replace(/[^0-9]/g, "");
    if (phone.length < 10 || phone.length > 15) {
      return res.status(400).json({ error: "Invalid phone number" });
    }

    const sessionId = crypto.randomBytes(8).toString("hex");
    const customName = String(req.body?.botName || "").slice(0, 30);

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
    return res.json({ success: true, sessionId, code, bot: customName || CONFIG.BOT_NAME });
  } catch (e) {
    console.error("pair:", e.message);
    return res.status(500).json({ error: e.message });
  } finally {
    // FIX #2: release reservation once the session is actually registered,
    // or on failure. On success, the session now lives in `sessions` and
    // counts against capacity instead of the reservation.
    if (reserved) {
      releaseSlot();
    }
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

// FIX #8: allowlist workMode
const VALID_WORK_MODES = new Set(["public", "private", "group", "self"]);

app.post("/config/:sessionId", async (req, res) => {
  try {
    const s = sessions.get(req.params.sessionId);
    if (!s) return res.status(404).json({ error: "Unknown session" });

    // FIX #8: reject invalid workMode rather than silently storing it
    if (req.body?.workMode !== undefined) {
      const wm = String(req.body.workMode).toLowerCase();
      if (!VALID_WORK_MODES.has(wm)) {
        return res.status(400).json({
          error: `Invalid workMode. Allowed: ${[...VALID_WORK_MODES].join(", ")}`,
        });
      }
    }

    const patch = {};
    if (req.body?.prefix) patch.prefix = String(req.body.prefix).slice(0, 3);
    if (req.body?.botName) patch.botName = String(req.body.botName).slice(0, 30);
    if (req.body?.workMode) patch.workMode = String(req.body.workMode).toLowerCase();
    if (req.body?.overrides && typeof req.body.overrides === "object") {
      // FIX #8: allow deleting an override by passing null
      const merged = { ...(s.config?.overrides || {}) };
      for (const [k, v] of Object.entries(req.body.overrides)) {
        if (v === null) delete merged[k];
        else merged[k] = v;
      }
      patch.overrides = merged;
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

// ── List loaded commands (from presenter) ───────────────────
app.get("/commands", (_req, res) => res.json(presenter.listCommands()));

// ── Manual reload (owner convenience) ───────────────────────
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
    ok: true,
    bot: CONFIG.BOT_NAME,
    version: CONFIG.VERSION,
    sessions: sessions.size,
    commands: presenter.listCommands().length,
  })
);

app.listen(CONFIG.PORT, "0.0.0.0", () =>
  console.log(`🌐 ${CONFIG.BOT_NAME} v${CONFIG.VERSION} panel → http://localhost:${CONFIG.PORT}`)
);

// ══════════════════════════════════════════════════════════════
//  RESUME EXISTING SESSIONS ON BOOT
// ══════════════════════════════════════════════════════════════
(async () => {
  try {
    const client = await getMongo();
    const metas = await client
      .db(CONFIG.DB_NAME)
      .collection("authState")
      .find({ _id: { $regex: ":meta$" } })
      .toArray();

    // FIX #6: dedupe by sessionId just in case (shouldn't happen, but cheap)
    const seen = new Set();
    for (const meta of metas) {
      const sessionId = meta._id.replace(/:meta$/, "");
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);
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
//  IDLE SESSION REAPER (hourly)
// ══════════════════════════════════════════════════════════════
setInterval(() => {
  // FIX #1: prune rate limiter alongside the reaper
  pruneRateLimiter();

  const now = Date.now();
  for (const [sessionId, s] of sessions.entries()) {
    if (!s.lastSeen) continue;
    if (now - s.lastSeen <= CONFIG.SESSION_TTL_MS) continue;
    // FIX #5: only reap if the socket is actually connected OR has been idle
    // long enough that the auth state is likely orphaned. (We do NOT
    // wipe Mongo auth here — resume-on-boot still picks it up.)
    console.log(`🧹 reaping idle session ${sessionId}`);
    try {
      s.conn?.end?.(undefined);
    } catch (e) {
      console.error(`[${sessionId}] end error:`, e.message);
    }
    // Clear any pending reconnect timer so we don't immediately re-boot
    if (s.reconnectTimer) {
      clearTimeout(s.reconnectTimer);
      s.reconnectTimer = null;
    }
    sessions.delete(sessionId);
  }
}, 60 * 60 * 1000);
