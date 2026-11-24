// utils.js

function normalizeNumber(s) {
  return String(s || "").replace(/[^0-9]/g, "");
}

function jidToNumber(jid) {
  if (!jid) return "";
  return normalizeNumber(String(jid).split("@")[0].split(":")[0]);
}

// Owner of THIS session (per-session config.ownerNumber, not global)
function isSessionOwner(senderJid, sessionConfig) {
  const owner = normalizeNumber(sessionConfig?.ownerNumber || "");
  if (!owner) return false;
  return jidToNumber(senderJid) === owner;
}

// Global bot owner (from .env) — used for cross-session admin commands
function isGlobalOwner(senderJid) {
  const CONFIG = require("./config");
  if (!CONFIG.OWNER_NUMBER) return false;
  return jidToNumber(senderJid) === CONFIG.OWNER_NUMBER;
}

function getText(msg) {
  if (!msg?.message) return "";
  return (
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    msg.message.imageMessage?.caption ||
    msg.message.videoMessage?.caption ||
    ""
  );
}

module.exports = { normalizeNumber, jidToNumber, isSessionOwner, isGlobalOwner, getText };
