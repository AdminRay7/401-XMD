"use strict";
const CONFIG = require("./config");

function normalizeNumber(s) { return String(s || "").replace(/[^0-9]/g, ""); }
function jidToNumber(jid) { return jid ? normalizeNumber(String(jid).split("@")[0].split(":")[0]) : ""; }

function isSessionOwner(senderJid, sessionConfig) {
  const owner = normalizeNumber(sessionConfig?.ownerNumber || "");
  if (!owner) return false;
  return jidToNumber(senderJid) === owner;
}

function isGlobalOwner(senderJid) {
  const sender = jidToNumber(senderJid);
  if (!sender) return false;
  const owners = [CONFIG.OWNER_NUMBER, ...(CONFIG.GLOBAL_OWNERS || [])].map(normalizeNumber).filter(Boolean);
  return owners.includes(sender);
}

function getText(msg) {
  if (!msg?.message) return "";
  let m = msg.message;
  if (m.ephemeralMessage) m = m.ephemeralMessage.message || {};
  if (m.viewOnceMessage) m = m.viewOnceMessage.message || {};
  if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message || {};
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || "";
}

module.exports = { normalizeNumber, jidToNumber, isSessionOwner, isGlobalOwner, getText };
