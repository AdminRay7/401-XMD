// ══════════════════════════════════════════════════════════════
//  presenter.js — 303-XMD advanced command handler
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

const COMMANDS = new Map();
const ALIASES = new Map();
const COMMAND_DIR = path.join(__dirname, "commands");

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const LEVEL = LEVELS[CONFIG.LOG_LEVEL] ?? 0;
const log = {
  error: (...a) => LEVEL >= 1 && console.error("❌", ...a),
  warn:  (...a) => LEVEL >= 2 && console.warn("⚠️ ", ...a),
  info:  (...a) => LEVEL >= 3 && console.log("ℹ️ ", ...a),
  debug: (...a) => LEVEL >= 4 && console.log("🐛", ...a),
};

const norm = (s) => String(s || "").toLowerCase();

function normalizeConfig(config) {
  const c = config || {};
  return {
    ...c,
    prefix: c.prefix || CONFIG.PREFIX || ".",
    workMode: (c.workMode || CONFIG.WORK_MODE || "public").toLowerCase(),
    ownerNumber: c.ownerNumber || CONFIG.OWNER_NUMBER || "",
    botName: c.botName || CONFIG.BOT_NAME || "Bot",
    global: c.global || {},
    overrides: c.overrides || {},
  };
}

function loadCommand(filePath) {
  const fileName = path.basename(filePath, ".js");
  let mod;
  try {
    delete require.cache[require.resolve(filePath)];
    mod = require(filePath);
  } catch (e) {
    log.error(`failed to load ${fileName}:`, e.message);
    return null;
  }

  let cmd;
  if (typeof mod === "function") {
    cmd = { name: norm(fileName), aliases: [], execute: mod };
  } else if (mod && typeof mod === "object") {
    if (typeof mod.execute !== "function" && typeof mod.run !== "function") {
      log.warn(`${fileName} has no execute()/run() — skipped`);
      return null;
    }
    cmd = {
      name: norm(mod.name || fileName),
      aliases: (Array.isArray(mod.aliases) ? mod.aliases : []).map(norm),
      description: mod.description || "",
      usage: mod.usage || "",
      category: mod.category || "general",
      ownerOnly: mod.ownerOnly === true,
      adminOnly: mod.adminOnly === true,
      groupOnly: mod.groupOnly === true,
      privateOnly: mod.privateOnly === true,
      hidden: mod.hidden === true,
      execute: mod.execute || mod.run,
      onLoad: mod.onLoad,
      onUnload: mod.onUnload,
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
  for (const a of cmd.aliases) {
    if (COMMANDS.has(a) && a !== cmd.name) {
      log.warn(`alias "${a}" of "${cmd.name}" shadows command "${a}"`);
    }
  }
  const old = COMMANDS.get(cmd.name);
  if (old) for (const a of old.aliases) ALIASES.delete(a);
  COMMANDS.set(cmd.name, cmd);
  for (const a of cmd.aliases) ALIASES.set(a, cmd.name);
  if (typeof cmd.onLoad === "function") {
    try { cmd.onLoad(); } catch (e) { log.error(`onLoad ${cmd.name}:`, e.message); }
  }
  log.info(
    `loaded command: ${cmd.name}` +
    (cmd.aliases.length ? ` (aliases: ${cmd.aliases.join(", ")})` : "")
  );
}

function unregisterCommand(name) {
  const old = COMMANDS.get(norm(name));
  if (!old) return;
  for (const a of old.aliases) ALIASES.delete(a);
  COMMANDS.delete(old.name);
  if (typeof old.onUnload === "function") {
    try { old.onUnload(); } catch (e) { log.error(`onUnload ${old.name}:`, e.message); }
  }
  log.info(`unloaded command: ${old.name}`);
}

function loadAllCommands() {
  if (!fs.existsSync(COMMAND_DIR)) {
    fs.mkdirSync(COMMAND_DIR, { recursive: true });
    log.warn(`commands/ folder did not exist — created it`);
    return;
  }
  // clear registry for a clean reload
  for (const name of [...COMMANDS.keys()]) unregisterCommand(name);
  ALIASES.clear();

  const files = fs.readdirSync(COMMAND_DIR).filter((f) => f.endsWith(".js"));
  for (const f of files) registerCommand(loadCommand(path.join(COMMAND_DIR, f)));
  log.info(`✅ loaded ${COMMANDS.size} commands`);
}

function startWatcher() {
  if (!fs.existsSync(COMMAND_DIR)) return;
  const timers = new Map();
  const scheduleReload = (file) => {
    if (timers.has(file)) clearTimeout(timers.get(file));
    timers.set(file, setTimeout(() => {
      timers.delete(file);
      const full = path.join(COMMAND_DIR, file);
      if (!fs.existsSync(full)) {
        unregisterCommand(path.basename(file, ".js"));
        return;
      }
      log.info(`🔄 reloading: ${file}`);
      registerCommand(loadCommand(full));
    }, 300));
  };
  try {
    fs.watch(COMMAND_DIR, (_event, filename) => {
      if (!filename || !filename.endsWith(".js")) return;
      scheduleReload(filename);
    });
    log.info(`👀 watching commands/ for changes`);
  } catch (e) {
    log.warn(`watcher failed:`, e.message);
  }
}

function eff(config, key) {
  const ov = config?.overrides?.[key];
  if (ov !== undefined) return ov === true;
  return config?.global?.[key] === true;
}

const META_CACHE = new Map();
const META_CACHE_MAX = 500;
async function safeGroupMetadata(conn, jid) {
  const now = Date.now();
  const cached = META_CACHE.get(jid);
  if (cached && now - cached.ts < 30_000) return cached.data;
  try {
    const data = await conn.groupMetadata(jid);
    if (META_CACHE.size >= META_CACHE_MAX) {
      const firstKey = META_CACHE.keys().next().value;
      META_CACHE.delete(firstKey);
    }
    META_CACHE.set(jid, { data, ts: now });
    return data;
  } catch {
    return cached?.data || null;
  }
}

async function handleMessage({ conn, m, sessionId, config: rawConfig }) {
  const config = normalizeConfig(rawConfig);
  const msg = m.messages?.[0];
  if (!msg?.message) return;

  if (msg.key.remoteJid === "status@broadcast") {
    return handleStatus({ conn, msg, sessionId, config });
  }
  if (msg.key.remoteJid === "protocol@broadcast") return;

  const from = msg.key.remoteJid;
  const sender = msg.key.participant || msg.key.remoteJid;
  const isGroup = from.endsWith("@g.us");
  const text = getText(msg);
  const isFromMe = !!msg.key.fromMe;
  const prefix = config.prefix;

  const senderIsOwner =
    jidToNumber(sender) === jidToNumber(config.ownerNumber) ||
    isSessionOwner(sender, config);
  const senderIsGlobalOwner = isGlobalOwner(sender);
  const isPrivileged = senderIsOwner || senderIsGlobalOwner;

  // AUTO-READ
  if (eff(config, "AUTO_READ")) {
    try { await conn.readMessages([msg.key]); } catch {}
  }

  // Work-mode gate: public = everyone, private = owner only
  if (config.workMode === "private" && !isPrivileged) return;

  // onMessage hooks (skip own messages, run in parallel)
  if (!isFromMe) {
    const tasks = [];
    for (const cmd of COMMANDS.values()) {
      if (typeof cmd.onMessage !== "function") continue;
      tasks.push(
        Promise.resolve()
          .then(() => cmd.onMessage({ conn, msg, from, sender, isGroup, text, sessionId, config, log }))
          .catch((e) => log.error(`onMessage ${cmd.name}:`, e.message))
      );
    }
    if (tasks.length) await Promise.allSettled(tasks);
  }

  if (!text || isFromMe) return;

  // AUTO-REACT
  if (eff(config, "AUTO_REACT") && !text.startsWith(prefix)) {
    try {
      await conn.sendMessage(from, { react: { text: "🔥", key: msg.key } });
    } catch {}
  }

  // Command parsing
  if (!text.startsWith(prefix)) return;
  const body = text.slice(prefix.length).trim();
  if (!body) return;

  const parts = body.split(/\s+/);
  const rawName = norm(parts[0]);
  const args = parts.slice(1);
  const canonical = ALIASES.get(rawName) || rawName;
  const cmd = COMMANDS.get(canonical);
  if (!cmd) { log.debug(`unknown command: ${rawName}`); return; }

  // Permission gates
  if (cmd.ownerOnly && !isPrivileged) {
    return conn.sendMessage(from, { text: "🔒 Owner only." }, { quoted: msg });
  }
  if (cmd.adminOnly && isGroup) {
    const meta = await safeGroupMetadata(conn, from);
    const isAdmin = meta?.participants?.some(
      (p) => p.id === sender && (p.admin === "admin" || p.admin === "superadmin")
    );
    if (!isAdmin && !isPrivileged) {
      return conn.sendMessage(from, { text: "🔒 Admin only." }, { quoted: msg });
    }
  }
  if (cmd.groupOnly && !isGroup) {
    return conn.sendMessage(from, { text: "👥 Group only." }, { quoted: msg });
  }
  if (cmd.privateOnly && isGroup) {
    return conn.sendMessage(from, { text: "📩 Private chat only." }, { quoted: msg });
  }

  // Typing (only around execution)
  const typingOn = eff(config, "AUTO_TYPING") && !isFromMe;
  if (typingOn) {
    try { await conn.sendPresenceUpdate("composing", from); } catch {}
  }

  const ctx = {
    conn, msg, m, from, sender, isGroup, text, args,
    commandName: cmd.name,
    sessionId, config,
    reply: (t, opts = {}) => conn.sendMessage(from, { text: String(t) }, { quoted: msg, ...opts }),
    replyImage: (url, caption = "", opts = {}) => conn.sendMessage(from, { image: { url }, caption }, { quoted: msg, ...opts }),
    replyVideo: (url, caption = "", opts = {}) => conn.sendMessage(from, { video: { url }, caption }, { quoted: msg, ...opts }),
    replyAudio: (url, opts = {}) => conn.sendMessage(from, { audio: { url }, mimetype: "audio/mp4" }, { quoted: msg, ...opts }),
    replyDoc: (url, fileName, mimetype, opts = {}) => conn.sendMessage(from, { document: { url }, fileName, mimetype }, { quoted: msg, ...opts }),
    react: (emoji) => conn.sendMessage(from, { react: { text: emoji, key: msg.key } }),
    typing: () => conn.sendPresenceUpdate("composing", from).catch(() => {}),
    stopTyping: () => conn.sendPresenceUpdate("paused", from).catch(() => {}),
    isOwner: isPrivileged,
    isGlobalOwner: senderIsGlobalOwner,
    groupMetadata: () => safeGroupMetadata(conn, from),
    log,
  };

  try {
    await cmd.execute.call(cmd.raw || cmd, ctx);
  } catch (e) {
    log.error(`command ${cmd.name} threw:`, e.message);
    try { await ctx.reply(`⚠️ Command error: ${e.message}`); } catch {}
  } finally {
    if (typingOn) {
      try { await conn.sendPresenceUpdate("paused", from); } catch {}
    }
  }
}

async function handleStatus({ conn, msg, sessionId, config }) {
  try {
    if (eff(config, "AUTO_STATUS_VIEW")) {
      await conn.readMessages([msg.key]).catch(() => {});
    }
    if (eff(config, "AUTO_STATUS_LIKE")) {
      const emojis = (config.global && config.global.CHANNEL_EMOJIS) || ["🔥"];
      const emoji = emojis[Math.floor(Math.random() * emojis.length)];
      const opts = msg.key.participant ? { statusJidList: [msg.key.participant] } : {};
      await conn.sendMessage(
        msg.key.remoteJid,
        { react: { text: emoji, key: msg.key } },
        opts
      ).catch(() => {});
    }
    if (eff(config, "AUTO_STATUS_REPLY") && config.global.STATUS_REPLY_TEXT) {
      const poster = msg.key.participant || msg.key.remoteJid;
      await conn.sendMessage(poster, { text: config.global.STATUS_REPLY_TEXT }).catch(() => {});
    }
  } catch (e) {
    log.debug(`status handler:`, e.message);
  }
}

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

async function onCall({ conn, calls, sessionId, config }) {
  if (!eff(config, "ANTICALL")) return;
  for (const call of calls) {
    try {
      // Never reject the owner's own calls
      if (
        jidToNumber(call.from) === jidToNumber(config?.ownerNumber) ||
        isSessionOwner(call.from, config) ||
        isGlobalOwner(call.from)
      ) continue;
      await conn.rejectCall(call.id, call.from);
      await conn.sendMessage(call.from, {
        text: `📵 Calls are not allowed on *${config?.botName || "this bot"}*.`,
      });
    } catch (e) {
      log.debug(`reject call:`, e.message);
    }
  }
}

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

function listCommands() {
  return Array.from(COMMANDS.values())
    .filter((c) => !c.hidden)
    .map((c) => ({
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
init();

module.exports = {
  handleMessage,
  onPresenceUpdate,
  onCall,
  onMessageDelete,
  listCommands,
  _reload: loadAllCommands,
  _commands: COMMANDS,
  _aliases: ALIASES,
};
