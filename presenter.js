// ============================================================
//   303-XMD — presenter.js (Fixed & Hardened)
// ============================================================
const fs = require('fs-extra');
const path = require('path');
const config = require('./config');
const { jidToNumber, isSessionOwner, isGlobalOwner, getText } = require('./utils');

// ================= HOT-RELOAD COMMAND LOADER =================
const COMMANDS_DIR = path.join(__dirname, 'commands');
const commandCache = new Map();
const autoCache = new Map();
let folderSignature = '';
let lastScan = 0;
let isLoading = false;
const RESCAN_DEBOUNCE_MS = 2000;

function computeFolderSignature(dir) {
    if (!fs.existsSync(dir)) return '';
    const parts = [];
    const walk = (d) => {
        for (const item of fs.readdirSync(d)) {
            const full = path.join(d, item);
            const stat = fs.statSync(full);
            if (stat.isDirectory()) walk(full);
            else if (item.endsWith('.js')) parts.push(`${item}:${stat.mtimeMs}`);
        }
    };
    walk(dir);
    return parts.sort().join('|');
}

function loadCommands(force = false) {
    if (isLoading) return false;
    const now = Date.now();
    if (!force && now - lastScan < RESCAN_DEBOUNCE_MS) return false;
    lastScan = now;
    if (!fs.existsSync(COMMANDS_DIR)) {
        fs.mkdirSync(COMMANDS_DIR, { recursive: true });
        return false;
    }

    const sig = computeFolderSignature(COMMANDS_DIR);
    if (!force && sig === folderSignature) return false;

    isLoading = true;
    try {
        folderSignature = sig;
        const newCommandCache = new Map();
        const newAutoCache = new Map();

        const walk = (dir) => {
            for (const item of fs.readdirSync(dir)) {
                const itemPath = path.join(dir, item);
                const stat = fs.statSync(itemPath);
                if (stat.isDirectory()) { walk(itemPath); continue; }
                if (!item.endsWith('.js')) continue;

                try {
                    delete require.cache[require.resolve(itemPath)];
                    const mod = require(itemPath);
                    if (!mod) continue;

                    const hasExecute = typeof mod.execute === 'function' || typeof mod.run === 'function';
                    const hasHook = typeof mod.onMessage === 'function' || typeof mod.onCall === 'function' || typeof mod.onDelete === 'function';

                    if (hasExecute) {
                        const names = [mod.name, ...(Array.isArray(mod.aliases) ? mod.aliases : [])]
                            .filter(Boolean).map(s => String(s).toLowerCase());
                        for (const n of names) newCommandCache.set(n, mod);
                    }

                    if (hasHook) {
                        const autoKey = mod.name || itemPath;
                        if (newAutoCache.has(autoKey)) {
                            console.warn(`⚠️ autoCache collision on "${autoKey}" (${itemPath}) — overwriting.`);
                        }
                        newAutoCache.set(autoKey, mod);
                    }
                } catch (e) {
                    console.error(`⚠️ Load ${itemPath}:`, e.message);
                }
            }
        };
        walk(COMMANDS_DIR);

        commandCache.clear();
        for (const [k, v] of newCommandCache) commandCache.set(k, v);
        autoCache.clear();
        for (const [k, v] of newAutoCache) autoCache.set(k, v);

        console.log(`♻️ Loaded ${commandCache.size} command(s) · ${autoCache.size} auto module(s).`);
        return true;
    } finally {
        isLoading = false;
    }
}

loadCommands(true);
setInterval(() => { try { loadCommands(false); } catch (e) {} }, 3000).unref();

// ================= HELPERS =================
function bareJid(s) {
    return String(s || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

// ================= MAIN HANDLER =================
async function handleMessage({ conn, m, sessionId, config: sessionConfig }) {
    let from = null;
    let composedTyping = false;

    try {
        if (!conn || !m || !m.messages || !m.messages[0]) return;
        const msg = m.messages[0];
        if (!msg.message) return;

        from = msg.key.remoteJid;
        if (!from) return;
        if (from === 'status@broadcast') return;

        const type = Object.keys(msg.message)[0];
        if (type === 'senderKeyDistributionMessage' ||
            (type === 'protocolMessage' && !msg.message.protocolMessage.type)) return;

        // Session config safety — never undefined
        sessionConfig = sessionConfig || {};

        const sender = msg.key.participant || msg.key.remoteJid;
        if (!sender) return;
        const pushname = msg.pushName || "Unknown";
        const text = String(getText(msg) ?? '');
        const isGroup = from.endsWith('@g.us');
        const isFromMe = !!msg.key.fromMe;

        const currentPrefix = sessionConfig.prefix || config.PREFIX || ".";
        const currentBotName = sessionConfig.botName || config.BOT_NAME || "Bot";

        const isCmd = text && currentPrefix.length > 0 && text.startsWith(currentPrefix);
        // Parse after prefix — args stay consistent for spaced prefixes
        const afterPrefix = isCmd ? text.slice(currentPrefix.length).trim() : '';
        const parts = afterPrefix ? afterPrefix.split(/\s+/) : [];
        const command = (parts[0] || '').toLowerCase();
        const args = parts.slice(1);

        // 🌟 MULTI-USER OWNER DETECTION
        const senderBare     = bareJid(sender);
        const sessionJid     = conn.user?.id || '';
        const sessionBare    = bareJid(sessionJid);
        const ownerCfgBare   = bareJid(sessionConfig.ownerNumber || config.OWNER_NUMBER);

        const isOwner =
            msg.key.fromMe === true ||
            (senderBare && ownerCfgBare && senderBare === ownerCfgBare) ||
            (senderBare && sessionBare && senderBare === sessionBare) ||
            isSessionOwner(sender, sessionConfig) ||
            isGlobalOwner(sender);

        // 🌟 WORK MODE GATE
        const mode = (sessionConfig.workMode || config.WORK_MODE || "public").toLowerCase();
        if (mode === 'private' && !isOwner) return;

        // 🛡️ GROUP ADMIN DETECTION
        let isGroupAdmin = false;
        if (isGroup) {
            try {
                const meta = await conn.groupMetadata(from);
                const participant = meta.participants.find(p => bareJid(p.id) === senderBare);
                isGroupAdmin = participant?.admin === 'admin' || participant?.admin === 'superadmin';
            } catch (e) {}
        }

        try { loadCommands(false); } catch {}

        // 🌟 Build per-message reply closure (no conn mutation → no race)
        const reply = (t, opts = {}) =>
            conn.sendMessage(from, { text: String(t) }, { quoted: msg, ...opts });

        // Attach convenience fields to msg only (per-invocation object)
        msg.body = text;
        msg.text = text;
        msg.sender = sender;

        const cmdCtx = {
            from, sender, isOwner, isGlobalOwner: isGlobalOwner(sender), isGroupAdmin, pushname,
            config: sessionConfig, conn, msg,
            sessionId, isGroup, body: text, text, args, command,
            prefix: currentPrefix, botName: currentBotName, isCmd,
            senderBare, sessionBare, ownerCfgBare,
            reply,
            react: (emoji) => conn.sendMessage(from, { react: { text: emoji, key: msg.key } }),
            groupMetadata: () => conn.groupMetadata(from),
            saveConfig: async (patch) => {
                const db = require("./db");
                await db.saveSessionConfig(sessionId, patch);
                const newConf = await db.getSessionConfig(sessionId);
                Object.assign(sessionConfig, newConf || {});
                return newConf;
            }
        };

        // TYPING INDICATOR
        const autoTyping = sessionConfig.AUTO_TYPING ?? config.AUTO_TYPING;
        if (isCmd && autoTyping && !isFromMe) {
            try {
                await conn.sendPresenceUpdate('composing', from);
                composedTyping = true;
            } catch {}
        }

        // AUTO ENFORCEMENT LAYER
        if (!isFromMe) {
            const autoSnapshot = [...autoCache.values()];
            for (const mod of autoSnapshot) {
                if (typeof mod.onMessage !== 'function') continue;
                try {
                    const r = await mod.onMessage(conn, msg, cmdCtx);
                    if (r === true) return;
                } catch (e) {
                    console.error(`auto/${mod.name}:`, e.message);
                }
            }
        }

        // Skip single-digit replies (poll/vote flows)
        if (!isCmd && /^[0-9]$/.test(text.trim())) {
            return;
        }

        // EXECUTE COMMAND
        if (isCmd) {
            const handler = commandCache.get(command);
            if (handler) {
                const execFn = handler.execute || handler.run;
                if (typeof execFn === 'function') {
                    try {
                        await execFn(conn, msg, args, cmdCtx);
                    } catch (e) {
                        console.error(`Cmd "${command}":`, e.message);
                        try { await reply(`❌ Error: ${e.message}`); } catch (_) {}
                    }
                }
            }
        }

    } catch (err) {
        console.error("Handler Error:", err?.message || err);
    } finally {
        if (conn && from && composedTyping) {
            try { await conn.sendPresenceUpdate('paused', from); } catch {}
        }
    }
}

// ============================================================
//   EVENT HOOKS
// ============================================================
async function onPresenceUpdate({ conn, presence, sessionId, config }) {
    const autoSnapshot = [...autoCache.values()];
    for (const mod of autoSnapshot) {
        if (typeof mod.onPresence !== 'function') continue;
        try { await mod.onPresence({ conn, presence, sessionId, config }); } catch (e) {}
    }
}

async function onCall({ conn, calls, sessionId, config }) {
    const autoSnapshot = [...autoCache.values()];
    for (const mod of autoSnapshot) {
        if (typeof mod.onCall !== 'function') continue;
        try { await mod.onCall({ conn, calls, sessionId, config }); } catch (e) {}
    }
}

async function onMessageDelete({ conn, deletes, sessionId, config }) {
    const autoSnapshot = [...autoCache.values()];
    for (const mod of autoSnapshot) {
        if (typeof mod.onDelete !== 'function') continue;
        try { await mod.onDelete({ conn, deletes, sessionId, config }); } catch (e) {}
    }
}

// ================= EXPORT =================
module.exports = {
    handleMessage,
    onPresenceUpdate,
    onCall,
    onMessageDelete,
    getCommandCache: () => commandCache,
    getAutoCache: () => autoCache,
    reloadCommands: async () => loadCommands(true),
    listCommands: () => Array.from(new Set(commandCache.values())).map(c => ({
        name: c.name || "unknown",
        aliases: Array.isArray(c.aliases) ? c.aliases : [],
        category: c.category || "general",
        description: c.description || ""
    })),
    _reload: async () => loadCommands(true)
};
