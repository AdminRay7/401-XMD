// ══════════════════════════════════════════════════════════════
//  runtime.js — bot runtime (sessions, sockets, pairing, reaper)
// ══════════════════════════════════════════════════════════════

"use strict";

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

// ── Sessions ──────────────────────────────────────────────
const sessions = new Map();
let reservedSlots = 0;

const atCapacity = () => sessions.size + reservedSlots >= CONFIG.MAX_SESSIONS;
function reserveSlot() {
  if (atCapacity()) return false;
  reservedSlots++;
  return true;
}
function releaseSlot() {
  if (reservedSlots > 0) reservedSlots--;
}

// ══════════════════════════════════════════════════════════════
//  BOOT SOCKET
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
    conn.ev.on("error", (e) =>
      console.error(`[${sessionId}] socket error:`, e?.message || e)
    );

    // ── messages.upsert: dispatch + revoke detection ──────
    conn.ev.on("messages.upsert", async (m) => {
      try {
        if (m.type !== "notify") return;
        s.lastSeen = Date.now();

        for (const msg of m.messages || []) {
          const pm = msg?.message?.protocolMessage;
          if (pm && (pm.type === 0 || pm.type === "REVOKE") && pm.key) {
            try {
              await onMessageDelete({
                conn, deletes: [msg], sessionId, config: s.config,
              });
            } catch (e) {
              console.error(`[${sessionId}] delete (revoke):`, e.message);
            }
          }
        }

        await handleMessage({ conn, m, sessionId, config: s.config });
      } catch (e) {
        console.error(`[${sessionId}] handler:`, e.message);
      }
    });

    conn.ev.on("presence.update", async (p) => {
      try {
        await onPresenceUpdate({ conn, presence: p, sessionId, config: s.config });
      } catch (e) {
        console.error(`[${sessionId}] presence:`, e.message);
      }
    });

    conn.ev.on("call", async (calls) => {
      try {
        await onCall({ conn, calls, sessionId, config: s.config });
      } catch (e) {
        console.error(`[${sessionId}] call:`, e.message);
      }
    });

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
        console.error(`[${sessionId}] delete:`, e.message);
      }
    });

    conn.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "open") {
        s.socketReady = true;
        s.pairing = null;
        s.pairingNumber = null;
        s.lastSeen = Date.now();
        console.log(`✅ [${sessionId}] connected as ${conn.user?.id}`);

        try {
          await collection.updateOne(
            { _id: `${sessionId}:meta` },
            {
              $set: {
                value: {
                  jid: conn.user?.id,
                  linkedAt: Date.now(),
                  bot: sessionConfig.botName || CONFIG.BOT_NAME,
                  pending: false,
                },
              },
            },
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
    const conn = await s.bootPromise;
    s.bootPromise = null;
    return conn;
  } catch (e) {
    s.bootPromise = null;
    throw e;
  }
}

// ══════════════════════════════════════════════════════════════
//  PAIRING
// ══════════════════════════════════════════════════════════════
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  s.pairing = formatted;
  s.pairingNumber = phoneNumber;
  return formatted;
}

// ══════════════════════════════════════════════════════════════
//  RESUME + REAPER
// ══════════════════════════════════════════════════════════════
async function resumeSessions() {
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
      if (sessions.size >= CONFIG.MAX_SESSIONS) break;
      console.log(`🔄 resuming ${sessionId}`);
      bootSocket(sessionId).catch((e) =>
        console.error(`resume ${sessionId}:`, e.message)
      );
    }
  } catch (e) {
    console.error("resume boot:", e.message);
  }
}

async function reapOnce() {
  const now = Date.now();
  for (const [sessionId, s] of sessions.entries()) {
    if (!s.lastSeen) continue;
    if (now - s.lastSeen <= CONFIG.SESSION_TTL_MS) continue;
    console.log(`🧹 reaping idle session ${sessionId}`);
    try { s.conn?.end?.(undefined); } catch {}
    if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
    sessions.delete(sessionId);
  }

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
}

let reaperTimer = null;
function startReaper() {
  if (reaperTimer) return;
  reaperTimer = setInterval(reapOnce, 60 * 60 * 1000);
  reaperTimer.unref?.();
}
function stopReaper() {
  if (reaperTimer) { clearInterval(reaperTimer); reaperTimer = null; }
}

// ══════════════════════════════════════════════════════════════
//  PUBLIC API (bot-server.js calls these)
// ══════════════════════════════════════════════════════════════
async function pair(sessionId, phoneNumber, botName) {
  // caller handles slot reservation + sessionId generation
  const phone = String(phoneNumber || "").replace(/\D/g, "");
  if (!/^[1-9]\d{9,14}$/.test(phone)) throw new Error("Invalid phone number");

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

  const client = await getMongo();
  await client.db(CONFIG.DB_NAME).collection("authState").updateOne(
    { _id: `${sessionId}:meta` },
    { $set: { value: { jid: null, linkedAt: null, pending: true, createdAt: Date.now() } } },
    { upsert: true }
  );

  try {
    const code = await requestPairingCode(sessionId, phone);
    return { success: true, sessionId, code };
  } catch (e) {
    try { await wipeSession(sessionId); } catch {}
    sessions.delete(sessionId);
    throw e;
  }
}

function getStatus(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return null;
  return {
    bot: s.config?.botName || CONFIG.BOT_NAME,
    version: s.config?.version || CONFIG.VERSION,
    connected: !!s.conn?.user,
    jid: s.conn?.user?.id || null,
    socketReady: s.socketReady,
  };
}

async function updateConfig(sessionId, patch) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("Unknown session");

  const clean = {};

  if (patch.workMode !== undefined) {
    const wm = String(patch.workMode).toLowerCase();
    if (!CONFIG.WORK_MODES?.has?.(wm)) {
      throw new Error(
        `Invalid workMode. Allowed: ${CONFIG.WORK_MODES ? [...CONFIG.WORK_MODES].join(", ") : "n/a"}`
      );
    }
    clean.workMode = wm;
  }
  if (patch.prefix) clean.prefix = String(patch.prefix).slice(0, 3);
  if (patch.botName) clean.botName = String(patch.botName).slice(0, 30);

  if (patch.overrides && typeof patch.overrides === "object") {
    const merged = { ...(s.config?.overrides || {}) };
    for (const [k, v] of Object.entries(patch.overrides)) {
      if (v === null) delete merged[k];
      else if (typeof v === "boolean") merged[k] = v;
    }
    clean.overrides = merged;
  }

  if (patch.global && typeof patch.global === "object") {
    const allowed = new Set(Object.keys(DEFAULT_GLOBAL || {}));
    const current = (await getSessionConfig(sessionId)) || {};
    const merged = { ...(current.global || DEFAULT_GLOBAL || {}) };
    for (const [k, v] of Object.entries(patch.global)) {
      if (!allowed.has(k)) continue;
      if (k === "STATUS_REPLY_TEXT" || k === "CHANNEL_EMOJIS") merged[k] = v;
      else merged[k] = !!v;
    }
    clean.global = merged;
  }

  if (Object.keys(clean).length === 0) throw new Error("No valid fields to update");

  await saveSessionConfig(sessionId, clean);
  s.config = (await getSessionConfig(sessionId)) || {};
  return s.config;
}

function publicCommands() {
  return presenter.listCommands().filter((c) => !c.hidden && !c.ownerOnly);
}

async function reloadCommands() {
  await presenter._reload();
  return presenter.listCommands().length;
}

function stats() {
  return {
    sessions: sessions.size,
    reserved: reservedSlots,
    capacity: CONFIG.MAX_SESSIONS,
  };
}

module.exports = {
  bootSocket,
  sessions,
  reserveSlot,
  releaseSlot,
  pair,
  getStatus,
  updateConfig,
  publicCommands,
  reloadCommands,
  stats,
  resumeSessions,
  startReaper,
  stopReaper,
  // presenter helpers for internal use
  presenter,
};
