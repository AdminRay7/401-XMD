// ══════════════════════════════════════════════════════════════
//  db.js — Multi-user Mongo store
//  • authState:      `${sessionId}:creds`, `${sessionId}:key:*`, `${sessionId}:meta`
//  • sessionConfigs: one doc per sessionId (config, owner, overrides)
// ══════════════════════════════════════════════════════════════

"use strict";

const { MongoClient } = require("mongodb");
const { initAuthCreds, BufferJSON, proto } = require("@whiskeysockets/baileys");
const CONFIG = require("./config");

let mongoClient = null;
async function getMongo() {
  if (!mongoClient) {
    mongoClient = new MongoClient(CONFIG.MONGO_URI, { maxPoolSize: 10 });
    await mongoClient.connect();
    console.log("📦 mongo connected");
  }
  return mongoClient;
}

// ── Per-session auth state ────────────────────────────────
async function useMongoDBAuthState(collection, sessionId) {
  const writeData = async (data, id) => {
    try {
      const serialized = JSON.stringify(data, BufferJSON.replacer);
      await collection.updateOne(
        { _id: id },
        { $set: { data: JSON.parse(serialized) } },
        { upsert: true }
      );
    } catch (e) {
      console.error(`[${sessionId}] writeData ${id}:`, e.message);
      throw e; // fail loudly so Baileys doesn't silently corrupt
    }
  };
  const readData = async (id) => {
    try {
      const doc = await collection.findOne({ _id: id });
      if (doc && doc.data !== undefined && doc.data !== null) {
        return JSON.parse(JSON.stringify(doc.data), BufferJSON.reviver);
      }
      return null;
    } catch (e) {
      console.error(`[${sessionId}] readData ${id}:`, e.message);
      throw e;
    }
  };
  const removeData = async (id) => {
    try {
      await collection.deleteOne({ _id: id });
    } catch (e) {
      console.error(`[${sessionId}] removeData ${id}:`, e.message);
      throw e;
    }
  };

  const credsId = `${sessionId}:creds`;
  const creds = (await readData(credsId)) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readData(`${sessionId}:${type}-${id}`);
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${sessionId}:${category}-${id}`;
              tasks.push(value ? writeData(value, key) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => { await writeData(creds, credsId); },
  };
}

// ══════════════════════════════════════════════════════════════
//  Per-session config
// ══════════════════════════════════════════════════════════════

// FIX M2: default toggles for every NEW session. Presenter sees these
// as `config.global`; overrides per session come from `overrides`.
const DEFAULT_GLOBAL = {
  AUTO_READ: CONFIG.AUTO_READ,
  AUTO_TYPING: CONFIG.AUTO_TYPING,
  AUTO_REACT: CONFIG.AUTO_REACT,
  AUTO_SAVE: CONFIG.AUTO_SAVE,
  AUTO_STATUS_VIEW: CONFIG.AUTO_STATUS_VIEW,
  AUTO_STATUS_LIKE: CONFIG.AUTO_STATUS_LIKE,
  AUTO_STATUS_REPLY: CONFIG.AUTO_STATUS_REPLY,
  STATUS_REPLY_TEXT: CONFIG.STATUS_REPLY_TEXT,
  CHANNEL_EMOJIS: CONFIG.CHANNEL_EMOJIS,
  ANTICALL: CONFIG.ANTICALL,
  ANTIDELETE: CONFIG.ANTIDELETE,
  ANTIBUG: CONFIG.ANTIBUG,
  ANTISPAM: CONFIG.ANTISPAM,
  ANTILINK: CONFIG.ANTILINK,
  ANTIMEDIA: CONFIG.ANTIMEDIA,
  // FIX M8: by default, global owners do NOT pierce this session's
  // owner gates. The user must explicitly opt in.
  ALLOW_GLOBAL_OWNER: false,
};

const CONFIG_FIELDS = [
  "botName", "footer", "version", "prefix",
  "ownerNumber", "ownerName", "workMode",
  "overrides", "global",
];

function sanitizeOverrides(o) {
  if (!o || typeof o !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "boolean" || v === null) out[k] = v;
  }
  return out;
}
function sanitizePatch(patch) {
  const safe = {};
  for (const k of CONFIG_FIELDS) {
    if (patch[k] !== undefined) safe[k] = patch[k];
  }
  return safe;
}

async function getSessionConfig(sessionId) {
  const client = await getMongo();
  const doc = await client
    .db(CONFIG.DB_NAME)
    .collection("sessionConfigs")
    .findOne({ _id: sessionId });

  const ownerNumber = doc?.ownerNumber || CONFIG.OWNER_NUMBER || "";
  return {
    // per-session identity
    botName:     doc?.botName     || CONFIG.BOT_NAME,
    footer:      doc?.footer      || CONFIG.FOOTER,
    version:     doc?.version     || CONFIG.VERSION,
    prefix:      doc?.prefix      || CONFIG.PREFIX,
    ownerNumber,
    ownerName:   doc?.ownerName   || CONFIG.OWNER_NAME,
    workMode:    (doc?.workMode || CONFIG.WORK_MODE || "public").toLowerCase(),

    // per-session toggles (defaults + user overrides)
    overrides:   sanitizeOverrides(doc?.overrides),
    global:      { ...DEFAULT_GLOBAL, ...(doc?.global || {}) },
  };
}

async function saveSessionConfig(sessionId, patch) {
  const client = await getMongo();
  const col = client.db(CONFIG.DB_NAME).collection("sessionConfigs");

  const safePatch = sanitizePatch(patch);
  if (Object.keys(safePatch).length === 0) {
    return getSessionConfig(sessionId);
  }

  // read-modify-write so nested objects merge instead of replace
  const existing = (await col.findOne({ _id: sessionId })) || {};
  const merged = {
    ...existing,
    ...safePatch,
    overrides: { ...(existing.overrides || {}), ...sanitizeOverrides(safePatch.overrides) },
    global:    { ...DEFAULT_GLOBAL, ...(existing.global || {}), ...(safePatch.global || {}) },
    createdAt: existing.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  for (const [k, v] of Object.entries(safePatch.overrides || {})) {
    if (v === null) delete merged.overrides[k];
  }

  await col.updateOne({ _id: sessionId }, { $set: merged }, { upsert: true });
  return getSessionConfig(sessionId);
}

async function wipeSession(sessionId) {
  const client = await getMongo();
  const db = client.db(CONFIG.DB_NAME);

  const escaped = String(sessionId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}:`);

  const results = await Promise.allSettled([
    db.collection("authState").deleteMany({ _id: re }),
    db.collection("sessionConfigs").deleteOne({ _id: sessionId }),
  ]);
  for (const r of results) {
    if (r.status === "rejected") {
      console.error(`[${sessionId}] wipe partial failure:`, r.reason?.message);
    }
  }
  console.log(`🧹 wiped session ${sessionId}`);
}

// ── FIX M4: list orphans for reaper ───────────────────────
// Returns sessionIds whose `:meta` is pending (pairing never completed)
// OR whose `:meta` is older than SESSION_TTL_MS and which are not
// currently active in `activeSessionIds`.
async function listStaleSessions(activeSessionIds) {
  const client = await getMongo();
  const col = client.db(CONFIG.DB_NAME).collection("authState");
  const metas = await col.find({ _id: { $regex: ":meta$" } }).toArray();
  const active = new Set(activeSessionIds);
  const now = Date.now();
  const cutoff = now - CONFIG.SESSION_TTL_MS;

  const stale = [];
  for (const m of metas) {
    const sid = m._id.replace(/:meta$/, "");
    if (active.has(sid)) continue;
    const v = m.value || {};
    // pairing never completed
    if (v.pending === true) { stale.push(sid); continue; }
    // last activity older than TTL
    const last = v.linkedAt || v.createdAt || 0;
    if (last && last < cutoff) stale.push(sid);
  }

  // also catch configs with no meta at all (older data)
  const configIds = await client
    .db(CONFIG.DB_NAME)
    .collection("sessionConfigs")
    .find({}, { projection: { _id: 1 } })
    .toArray();
  for (const { _id } of configIds) {
    if (active.has(_id)) continue;
    if (metas.some((m) => m._id === `${_id}:meta`)) continue;
    stale.push(_id);
  }
  return [...new Set(stale)];
}

module.exports = {
  getMongo,
  useMongoDBAuthState,
  getSessionConfig,
  saveSessionConfig,
  wipeSession,
  listStaleSessions,
  DEFAULT_GLOBAL,
};
