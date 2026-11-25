// ============================================================
//   303-XMD — presenter.js (Template Structure Fixed)
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
                        newAutoCache.set(mod.name || itemPath, mod);
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
module.exports = async (conn, m, sessionId = "default", sessionConfig = {}) => {
    try {
        if (!m.messages || !m.messages[0]) return;
        const msg = m.messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        const type = Object.keys(msg.message)[0];
        
        if (type === 'senderKeyDistributionMessage' || (type === 'protocolMessage' && !msg.message.protocolMessage.type)) {
            return;
        }

        const sender = msg.key.participant || msg.key.remoteJid;
        const pushname = msg.pushName || "Unknown";
        
        const body = getText(msg);
        const isGroup   = from.endsWith('@g.us');
        const isStatus  = from === 'status@broadcast';
        
        const currentPrefix = sessionConfig?.prefix || config.PREFIX || ".";
        const currentBotName = sessionConfig?.botName || config.BOT_NAME || "Bot";

        const isCmd     = body && currentPrefix.length > 0 && body.startsWith(currentPrefix);
        const command   = isCmd ? body.slice(currentPrefix.length).trim().split(/\s+/)[0].toLowerCase() : '';
        const args      = body ? body.trim().split(/ +/).slice(1) : [];

        // 🖨️ CONSOLE LOGGER
        if (process.env.LOG_LEVEL !== "silent") {
            const date = new Date().toLocaleString('en-US', { timeZone: 'Africa/Nairobi' });
            console.log(`\n┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓`);
            console.log(`┃ 🟢 ${currentBotName}                   ┃`);
            console.log(`┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛`);
            console.log(`» Sent Time: ${date}`);
            console.log(`» Message Type: ${type}`);
            console.log(`» Sender Name: ${pushname}`);
            console.log(`» Chat ID: ${String(sender).split('@')[0]}`);
            console.log(`» Group: ${isGroup ? "YES" : "NO"}`);
            console.log(`» Group JID: ${isGroup ? from : "N/A"}`);
            console.log(`» Message: ${body ? body.slice(0, 50) : "[Media/No Text]"}`);
            console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
        }

        // BULLETPROOF OWNER DETECTION
        const senderBare     = bareJid(sender);
        const sessionJid     = conn.user?.id || '';
        const sessionLid     = conn.user?.lid || ''; 
        const sessionBare    = bareJid(sessionJid);
        const sessionLidBare = bareJid(sessionLid);
        const ownerCfgBare   = bareJid(sessionConfig?.ownerNumber || config.OWNER_NUMBER);

        // This ensures the number that paired is the owner, or if it's the bot itself.
        const isOwner =
            msg.key.fromMe === true ||                                     
            (senderBare && ownerCfgBare && senderBare === ownerCfgBare) || 
            (senderBare && sessionBare && senderBare === sessionBare) ||   
            (senderBare && sessionLidBare && senderBare === sessionLidBare) ||
            isSessionOwner(sender, sessionConfig) ||
            isGlobalOwner(sender);

        // 🛡️ GROUP ADMIN DETECTION
        let isGroupAdmin = false;
        if (isGroup) {
            try {
                const meta = await conn.groupMetadata(from);
                const participant = meta.participants.find(p => {
                    const pid = String(p.id || '');
                    return pid === sender || bareJid(pid) === senderBare;
                });
                isGroupAdmin = participant?.admin === 'admin' || participant?.admin === 'superadmin';
            } catch (e) {}
        }

        try { loadCommands(false); } catch {}

        const cmdCtx = {
            from, sender, isOwner, isGroupAdmin, pushname, config: sessionConfig, conn, msg,
            sessionId, isGroup, isStatus, body, args, command,
            prefix: currentPrefix, botName: currentBotName, isCmd,
            senderBare, sessionBare, ownerCfgBare
        };

        // STATUS HANDLING
        if (isStatus) {
            // If you have status auto-view/like logic, it goes here.
            // For now, we just return to prevent processing it as a command.
            return; 
        }

        // AUTO ENFORCEMENT LAYER
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

        // WORK MODE GATE
        const mode = (sessionConfig?.workMode || config.WORK_MODE || "public").toLowerCase();
        if (mode === 'private' && !isOwner) return;

        if (!isCmd && /^[0-9]$/.test((body || '').trim())) {
            return;
        }

        // COMMANDS
        if (isCmd) {
            const handler = commandCache.get(command);
            if (handler && (typeof handler.execute === 'function' || typeof handler.run === 'function')) {
                const execFn = handler.execute || handler.run;
                try {
                    await execFn(conn, msg, args, cmdCtx);
                } catch (e) {
                    console.error(`Cmd "${command}":`, e.message);
                    try {
                        await conn.sendMessage(from, { text: `❌ Error: ${e.message}` });
                    } catch (_) {}
                }
            }
        }

    } catch (err) {
        console.error("Handler Error:", err.message);
    }
};

// ============================================================
//   GROUP / CALL EVENT HOOKS
// ============================================================
module.exports.onPresenceUpdate = async ({ conn, presence, sessionId, config }) => {
    const autoSnapshot = [...autoCache.values()];
    for (const mod of autoSnapshot) {
        if (typeof mod.onPresence !== 'function') continue;
        try { await mod.onPresence({ conn, presence, sessionId, config }); } catch (e) {}
    }
};

module.exports.onCall = async ({ conn, calls, sessionId, config }) => {
    const autoSnapshot = [...autoCache.values()];
    for (const mod of autoSnapshot) {
        if (typeof mod.onCall !== 'function') continue;
        try { await mod.onCall({ conn, calls, sessionId, config }); } catch (e) {}
    }
};

module.exports.onMessageDelete = async ({ conn, deletes, sessionId, config }) => {
    const autoSnapshot = [...autoCache.values()];
    for (const mod of autoSnapshot) {
        if (typeof mod.onDelete !== 'function') continue;
        try { await mod.onDelete({ conn, deletes, sessionId, config }); } catch (e) {}
    }
};

// ================= EXPOSE =================
module.exports.getCommandCache = () => commandCache;
module.exports.getAutoCache    = () => autoCache;
module.exports.reloadCommands  = async () => loadCommands(true);
module.exports.listCommands    = () => Array.from(new Set(commandCache.values())).map(c => ({ name: c.name, aliases: c.aliases }));
