// ══════════════════════════════════════════════════════════════
//  presenter.js — 303-XMD advanced command handler
//  • Hot-reloads commands from ./commands/
//  • Routes messages by name + aliases
//  • Applies per-session feature toggles
//  • Emits lifecycle hooks for auto-features
// ══════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");
const CONFIG = require("./config");
const {
  isSessionOwner,
  isGlobalOwner,
  jidToNumber,
  getText,
} = require("./utils");

// ─── Command registry ───────────────────────────────────────
const COMMANDS = new Map();      // name -> command module
const ALIASES = new Map();       // alias -> canonical name
const COMMAND_DIR = path.join(__dirname, "commands");

// ─── Logger (respects LOG_LEVEL) ────────────────────────────
const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const LEVEL = LEVELS[CONFIG.LOG_LEVEL] ?? 0;
const log = {
  error: (...a) => LEVEL >= 1 && console.error("❌", ...a),
  warn:  (...a) => LEVEL >= 2 && console.warn("⚠️ ", ...a),
  info:  (...a) => LEVEL >= 3 && console.log("ℹ️ ", ...a),
  debug: (...a) => LEVEL >= 4 && console.log("🐛", ...a),
};

// ══════════════════════════════════════════════════════════════
//  LOADER — reads ./commands/*.js
// ══════════════════════════════════════════════════════════════
function loadCommand(filePath) {
  const fileName = path.basename(filePath, ".js");
  let mod;
  try {
    // bust require cache so hot-reload picks up changes
    delete require.cache[require.resolve(filePath)];
    mod = require(filePath);
  } catch (e) {
    log.error(`failed to load ${fileName}:`, e.message);
    return null;
  }

  // Accept either:
  //   module.exports = { name, aliases, execute, ... }
  //   module.exports = async function(...) {}   (name = filename)
  let cmd;
  if (typeof mod === "function") {
    cmd = { name: fileName, aliases: [], execute: mod };
  } else if (mod && typeof mod === "object") {
    if (typeof mod.execute !== "function" && typeof mod.run !== "function") {
      log.warn(`${fileName} has no execute()/run() — skipped`);
      return null;
    }
    cmd = {
      name: mod.name || fileName,
      aliases: Array.isArray(mod.aliases) ? mod.aliases : [],
      description: mod.description || "",
      usage: mod.usage || "",
      category: mod.category || "general",
      ownerOnly: mod.ownerOnly === true,
      adminOnly: mod.adminOnly === true,
      groupOnly: mod.groupOnly === true,
      privateOnly: mod.privateOnly === true,
      hidden: mod.hidden === true,
      execute: mod.execute || mod.run,
      // optional lifecycle hooks
      onLoad: mod.onLoad,
      onUnload: mod.onUnload,
      // optional auto-feature hooks
      onMessage: mod.onMessage,
      onPresence: mod.onPresence,
      onCall: mod.onCall,
      onDelete: mod.onDelete,
      raw: mod,
    };
  } else {
    log.warn(`${fileName} exports invalid shape — skipped`);
    return null;
  }

  return cmd;
}

function registerCommand(cmd) {
  if (!cmd) return;
  // remove old aliases for this name (hot-reload safety)
  const old = COMMANDS.get(cmd.name);
  if (old) {
    for (const a of old.aliases) ALIASES.delete(a);
  }
  COMMANDS.set(cmd.name, cmd);
  for (const a of cmd.aliases) ALIASES.set(a, cmd.name);
  log.info(`loaded command: ${cmd.name}${cmd.aliases.length ? ` (aliases: ${cmd.aliases.join(", ")})` : ""}`);
}

function unregisterCommand(name) {
  const old = COMMANDS.get(name);
  if (!old) return;
  for (const a of old.aliases) ALIASES.delete(a);
  COMMANDS.delete(name);
  if (typeof old.onUnload === "function") {
    try { old.onUnload(); } catch (e) { log.error(`onUnload ${name}:`, e.message); }
  }
  log.info(`unloaded command: ${name}`);
}

function loadAllCommands() {
  if (!fs.existsSync(COMMAND_DIR)) {
    fs.mkdirSync(COMMAND_DIR, { recursive: true });
    log.warn(`commands/ folder did not exist — created it`);
    return;
  }
  const files = fs.readdirSync(COMMAND_DIR).filter((f) => f.endsWith(".js"));
  for (const f of files) {
    const cmd = loadCommand(path.join(COMMAND_DIR, f));
    registerCommand(cmd);
  }
  log.info(`✅ loaded ${COMMANDS.size} commands`);
}

// ══════════════════════════════════════════════════════════════
//  HOT-RELOAD — watches commands/ folder
// ══════════════════════════════════════════════════════════════
function startWatcher() {
  if (!fs.existsSync(COMMAND_DIR)) return;

  let reloadTimer = null;
  const scheduleReload = (file) => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      const full = path.join(COMMAND_DIR, file);
      if (!fs.existsSync(full)) {
        // file was deleted
        unregisterCommand(path.basename(file, ".js"));
        return;
      }
      log.info(`🔄 reloading: ${file}`);
      const cmd = loadCommand(full);
      registerCommand(cmd);
    }, 300); // debounce
  };

  try {
    fs.watch(COMMAND_DIR, (eventType, filename) => {
      if (!filename || !filename.endsWith(".js")) return;
      scheduleReload(filename);
    });
    log.info(`👀 watching commands/ for changes`);
  } catch (e) {
    log.warn(`watcher failed (hot-reload disabled):`, e.message);
  }
}

// ══════════════════════════════════════════════════════════════
//  FEATURE HELPERS — per-session toggle resolution
// ══════════════════════════════════════════════════════════════
function eff(config, key) {
  const ov = config?.overrides?.[key];
  if (ov !== undefined) return ov === true;
  return config?.global?.[key] === true;
}

// ══════════════════════════════════════════════════════════════
//  MAIN ENTRY — called by index.js on every messages.upsert
// ══════════════════════════════════════════════════════════════
async function handleMessage({ conn, m, sessionId, config }) {
  const msg = m.messages?.[0];
  if (!msg?.message) return;

  // Ignore status broadcasts & protocol messages
  if (msg.key.remoteJid === "status@broadcast") {
    await handleStatus({ conn, msg, sessionId, config });
    return;
  }
  if (msg.key.remoteJid === "protocol@broadcast") return;

  const from = msg.key.remoteJid;
  const sender = msg.key.participant || msg.key.remoteJid;
  const isGroup = from.endsWith("@g.us");
  const text = getText(msg);
  const isFromMe = !!msg.key.fromMe;

  // ── AUTO-READ ───────────────────────────────────────────
  if (eff(config, "AUTO_READ")) {
    try { await conn.readMessages([msg.key]); } catch {}
  }

  // ── Run per-command onMessage hooks (auto-features) ─────
  // e.g. antilink.js, antidelete.js can react to ANY message
  for (const cmd of COMMANDS.values()) {
    if (typeof cmd.onMessage !== "function") continue;
    try {
      await cmd.onMessage({ conn, msg, from, sender, isGroup, text, sessionId, config });
    } catch (e) {
      log.error(`onMessage ${cmd.name}:`, e.message);
    }
  }

  // Nothing more to do for non-text or self messages past this point
  if (!text || isFromMe) return;

  // ── AUTO-REACT (non-command only) ───────────────────────
  if (eff(config, "AUTO_REACT") && !text.startsWith(config.prefix)) {
    try {
      await conn.sendMessage(from, { react: { text: "🔥", key: msg.key } });
    } catch {}
  }

  // ── Work-mode gate ──────────────────────────────────────
  const mode = (config.workMode || "public").toLowerCase();
  const senderIsOwner = isSessionOwner(sender, config);
  const senderIsGlobalOwner = isGlobalOwner(sender);
  if (mode === "private" && !senderIsOwner && !senderIsGlobalOwner) return;

  // ── Command parsing ─────────────────────────────────────
  if (!text.startsWith(config.prefix)) return;
  const body = text.slice(config.prefix.length).trim();
  if (!body) return;

  const parts = body.split(/\s+/);
  const rawName = parts[0].toLowerCase();
  const args = parts.slice(1);

  // resolve alias -> canonical
  const canonical = ALIASES.get(rawName) || rawName;
  const cmd = COMMANDS.get(canonical);

  if (!cmd) {
    // unknown command — silent (matches your "don't break" requirement)
    log.debug(`unknown command: ${rawName}`);
    return;
  }

  // ── Permission gates ────────────────────────────────────
  if (cmd.ownerOnly && !senderIsOwner && !senderIsGlobalOwner) {
    return conn.sendMessage(from, { text: "🔒 Owner only." }, { quoted: msg });
  }
  if (cmd.adminOnly && isGroup) {
    const meta = await safeGroupMetadata(conn, from);
    const isAdmin = meta?.participants?.some(
      (p) => p.id === sender && (p.admin === "admin" || p.admin === "superadmin")
    );
    if (!isAdmin && !senderIsOwner && !senderIsGlobalOwner) {
      return conn.sendMessage(from, { text: "🔒 Admin only." }, { quoted: msg });
    }
  }
  if (cmd.groupOnly && !isGroup) {
    return conn.sendMessage(from, { text: "👥 Group only." }, { quoted: msg });
  }
  if (cmd.privateOnly && isGroup) {
    return conn.sendMessage(from, { text: "📩 Private chat only." }, { quoted: msg });
  }

  // ── Execute ─────────────────────────────────────────────
  const ctx = {
    conn,
    msg,
    m,
    from,
    sender,
    isGroup,
    text,
    args,
    commandName: cmd.name,
    sessionId,
    config,
    // helpers
    reply: (t, opts = {}) =>
      conn.sendMessage(from, { text: String(t) }, { quoted: msg, ...opts }),
    replyImage: (url, caption = "", opts = {}) =>
      conn.sendMessage(from, { image: { url }, caption }, { quoted: msg, ...opts }),
    replyVideo: (url, caption = "", opts = {}) =>
      conn.sendMessage(from, { video: { url }, caption }, { quoted: msg, ...opts }),
    replyAudio: (url, opts = {}) =>
      conn.sendMessage(from, { audio: { url }, mimetype: "audio/mp4" }, { quoted: msg, ...opts }),
    replyDoc: (url, fileName, mimetype, opts = {}) =>
      conn.sendMessage(from, { document: { url }, fileName, mimetype }, { quoted: msg, ...opts }),
    react: (emoji) =>
      conn.sendMessage(from, { react: { text: emoji, key: msg.key } }),
    typing: () =>
      conn.sendPresenceUpdate("composing", from).catch(() => {}),
    stopTyping: () =>
      conn.sendPresenceUpdate("paused", from).catch(() => {}),
    isOwner: senderIsOwner || senderIsGlobalOwner,
    isGlobalOwner: senderIsGlobalOwner,
    log,
  };

  try {
    await cmd.execute(ctx);
  } catch (e) {
    log.error(`command ${cmd.name} threw:`, e.message);
    try {
      await ctx.reply(`⚠️ Command error: ${e.message}`);
    } catch {}
  }
}

// ─── Status broadcast handler (AUTO_STATUS_* toggles) ──────
async function handleStatus({ conn, msg, sessionId, config }) {
  try {
    if (eff(config, "AUTO_STATUS_VIEW")) {
      await conn.readMessages([msg.key]);
    }
    if (eff(config, "AUTO_STATUS_LIKE")) {
      const emojis = config.global.CHANNEL_EMOJIS || ["🔥"];
      const emoji = emojis[Math.floor(Math.random() * emojis.length)];
      await conn.sendMessage(
        msg.key.remoteJid,
        { react: { text: emoji, key: msg.key } },
        { statusJidList: [msg.key.participant] }
      );
    }
    if (eff(config, "AUTO_STATUS_REPLY") && config.global.STATUS_REPLY_TEXT) {
      await conn.sendMessage(msg.key.remoteJid, {
        text: config.global.STATUS_REPLY_TEXT,
      });
    }
  } catch (e) {
    log.debug(`status handler:`, e.message);
  }
}

// ─── Presence handler ───────────────────────────────────────
async function onPresenceUpdate({ conn, presence, sessionId, config }) {
  for (const cmd of COMMANDS.values()) {
    if (typeof cmd.onPresence !== "function") continue;
    try {
      await cmd.onPresence({ conn, presence, sessionId, config });
    } catch (e) {
      log.error(`onPresence ${cmd.name}:`, e.message);
    }
  }
}

// ─── Call handler (ANTICALL) ────────────────────────────────
async function onCall({ conn, calls, sessionId, config }) {
  if (!eff(config, "ANTICALL")) return;
  for (const call of calls) {
    try {
      await conn.rejectCall(call.id, call.from);
      await conn.sendMessage(call.from, {
        text: `📵 Calls are not allowed on *${config.botName}*.`,
      });
    } catch (e) {
      log.debug(`reject call:`, e.message);
    }
  }
}

// ─── Message delete handler (ANTIDELETE) ────────────────────
async function onMessageDelete({ conn, deletes, sessionId, config }) {
  if (!eff(config, "ANTIDELETE")) return;
  for (const cmd of COMMANDS.values()) {
    if (typeof cmd.onDelete !== "function") continue;
    try {
      await cmd.onDelete({ conn, deletes, sessionId, config });
    } catch (e) {
      log.error(`onDelete ${cmd.name}:`, e.message);
    }
  }
}

// ─── Group metadata cache-safe fetch ────────────────────────
const META_CACHE = new Map(); // jid -> { data, ts }
async function safeGroupMetadata(conn, jid) {
  const now = Date.now();
  const cached = META_CACHE.get(jid);
  if (cached && now - cached.ts < 30_000) return cached.data;
  try {
    const data = await conn.groupMetadata(jid);
    META_CACHE.set(jid, { data, ts: now });
    return data;
  } catch {
    return cached?.data || null;
  }
}

// ══════════════════════════════════════════════════════════════
//  PUBLIC API + BOOTSTRAP
// ══════════════════════════════════════════════════════════════
function listCommands() {
  return Array.from(COMMANDS.values()).map((c) => ({
    name: c.name,
    aliases: c.aliases,
    description: c.description,
    usage: c.usage,
    category: c.category,
    ownerOnly: c.ownerOnly,
  }));
}

function init() {
  loadAllCommands();
  startWatcher();
}

// auto-init when required (index.js just needs `require("./presenter")`)
init();

module.exports = {
  handleMessage,
  onPresenceUpdate,
  onCall,
  onMessageDelete,
  listCommands,
  // exposed for testing / manual reload
  _reload: loadAllCommands,
  _commands: COMMANDS,
  _aliases: ALIASES,
};
