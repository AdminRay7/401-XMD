// ══════════════════════════════════════════════════════════════
//  config.js — 303-XMD central configuration loader
//  Multi-user: every paired session gets its own config row.
//  This file only provides GLOBAL DEFAULTS + server settings.
// ══════════════════════════════════════════════════════════════

"use strict";

require("dotenv").config();

// ─── Helpers ─────────────────────────────────────────────────
function str(v, fallback = "") {
  if (v === undefined || v === null) return fallback;
  const s = String(v).trim();
  return s === "" ? fallback : s;
}
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function uint(v, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}
function int(v, fallback) { return Math.floor(num(v, fallback)); }
function bool(v, fallback = false) {
  if (v === undefined || v === null || v === "") return fallback;
  const s = String(v).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(s)) return true;
  if (["false", "0", "no", "off"].includes(s)) return false;
  return fallback;
}
function digits(v, fallback = "") {
  const s = String(v || "").replace(/[^0-9]/g, "");
  return s || fallback;
}
function csv(v, fallback = []) {
  if (v === undefined || v === null || v === "") return fallback;
  return String(v).split(",").map((x) => x.trim()).filter(Boolean);
}
function digitsCsv(v, fallback = []) {
  return csv(v, fallback).map((s) => digits(s)).filter(Boolean);
}

// ─── Build config ────────────────────────────────────────────
const CONFIG = {
  // ══ Bot identity ══════════════════════════════════════════
  BOT_NAME:   str(process.env.BOT_NAME, "303-XMD"),
  FOOTER:     str(process.env.FOOTER, "303-XMD — THE LAST KEY"),
  VERSION:    str(process.env.VERSION, "2.0.0"),
  PREFIX:     str(process.env.PREFIX, "."),
  ADMIN_EMAIL: str(process.env.ADMIN_EMAIL, ""),

  // ══ Global owner (infra operator) ═════════════════════════
  // These numbers can access any session IF the session opts in
  // via global.ALLOW_GLOBAL_OWNER. They are NOT auto-injected.
  OWNER_NUMBER:  digits(process.env.OWNER_NUMBER, ""),
  OWNER_NAME:    str(process.env.OWNER_NAME, "Unknown"),
  GLOBAL_OWNERS: digitsCsv(process.env.GLOBAL_OWNERS, []),

  // ══ Server ════════════════════════════════════════════════
  PORT:      int(process.env.PORT, 3000),
  LOG_LEVEL: str(process.env.LOG_LEVEL, "silent"),
  // Default for NEW sessions only. Per-session workMode overrides.
  WORK_MODE: str(process.env.WORK_MODE, "public").toLowerCase(),

  // ══ Mongo ═════════════════════════════════════════════════
  MONGO_URI: str(process.env.MONGODB_URI) || str(process.env.MONGO_URI),
  DB_NAME:   str(process.env.DB_NAME, "xmd303"),

  // ══ Multi-user safety ═════════════════════════════════════
  MAX_SESSIONS:   int(process.env.MAX_SESSIONS, 20),
  PAIR_API_KEY:   str(process.env.PAIR_API_KEY, ""),
  SESSION_TTL_MS: uint(process.env.SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000),
  RATE_LIMIT_MS:  uint(process.env.RATE_LIMIT_MS, 60_000),
  STATUS_RATE_MS: uint(process.env.STATUS_RATE_MS, 10_000),

  // ══ Per-session default toggles ═══════════════════════════
  AUTO_READ:    bool(process.env.AUTO_READ, true),
  AUTO_REACT:   bool(process.env.AUTO_REACT, false),
  AUTO_SAVE:    bool(process.env.AUTO_SAVE, false),
  AUTO_TYPING:  bool(process.env.AUTO_TYPING, true),
  ANTICALL:     bool(process.env.ANTICALL, true),
  ANTIBUG:      bool(process.env.ANTIBUG, false),
  ANTISPAM:     bool(process.env.ANTISPAM, false),
  ANTILINK:     bool(process.env.ANTILINK, false),
  ANTIDELETE:   bool(process.env.ANTIDELETE, true),
  ANTIMEDIA:    str(process.env.ANTIMEDIA, "off").toLowerCase(),

  // ══ Status ════════════════════════════════════════════════
  AUTO_STATUS_VIEW:  bool(process.env.AUTO_STATUS_VIEW, true),
  AUTO_STATUS_LIKE:  bool(process.env.AUTO_STATUS_LIKE, false),
  AUTO_STATUS_REPLY: bool(process.env.AUTO_STATUS_REPLY, false),
  STATUS_REPLY_TEXT: str(process.env.STATUS_REPLY_TEXT, "Nice status! ✨"),

  // ══ Blocking ══════════════════════════════════════════════
  AUTOBLOCK: digitsCsv(process.env.AUTOBLOCK, []),

  // ══ Channel / newsletter ══════════════════════════════════
  NEWSLETTER_JID:       str(process.env.NEWSLETTER_JID, ""),
  CHANNEL_LINK:         str(process.env.CHANNEL_LINK, ""),
  AUTO_REACT_CHANNEL:   bool(process.env.AUTO_REACT_CHANNEL, false),
  AUTO_SUBSCRIBE_CHANNEL: bool(process.env.AUTO_SUBSCRIBE_CHANNEL, false),
  LOG_CHANNEL_POSTS:    bool(process.env.LOG_CHANNEL_POSTS, false),
  CHANNEL_EMOJIS:       csv(process.env.CHANNEL_EMOJIS, ["🔑", "🔥", "⭐"]),
  FORWARD_CHANNEL_TO:   str(process.env.FORWARD_CHANNEL_TO, ""),
  CROSS_POST_WEBHOOK:   str(process.env.CROSS_POST_WEBHOOK, ""),

  // ══ Welcome / goodbye ═════════════════════════════════════
  AUTO_GREET:       bool(process.env.AUTO_GREET, false),
  WELCOME_MESSAGE:  bool(process.env.WELCOME_MESSAGE, false),
  GOODBYE_MESSAGE:  bool(process.env.GOODBYE_MESSAGE, false),

  // ══ JWT ═══════════════════════════════════════════════════
  JWT_SECRET: str(process.env.JWT_SECRET, ""),

  // ══ AI Chat (Groq) ════════════════════════════════════════
  AI_CHAT_ENABLED: bool(process.env.AI_CHAT_ENABLED, false),
  AI_CHAT_GROUPS:  bool(process.env.AI_CHAT_GROUPS, true),
  AI_MODEL:        str(process.env.AI_MODEL, "llama-3.1-8b-instant"),
  AI_BASE_URL:     str(process.env.AI_BASE_URL, "https://api.groq.com/openai/v1"),
  AI_SYSTEM_PROMPT: str(
    process.env.AI_SYSTEM_PROMPT,
    "You are a normal person chatting in a WhatsApp group. Keep replies very short, casual, human. Use emojis occasionally. Never mention you are an AI or bot."
  ),
  AI_API_KEY: str(process.env.AI_API_KEY, ""),

  // ══ External APIs ═════════════════════════════════════════
  API_KEY:      str(process.env.API_KEY, ""),
  HF_TOKEN:     str(process.env.HF_TOKEN, ""),
  MODELSLAB_KEY: str(process.env.MODELSLAB_KEY, ""),
  RAPIDAPI_KEY:  str(process.env.RAPIDAPI_KEY, ""),
  RAPIDAPI_HOST: str(process.env.RAPIDAPI_HOST, "youtube-mp36.p.rapidapi.com"),
  SEARCH_API_HOST: str(process.env.SEARCH_API_HOST, "youtube-v31.p.rapidapi.com"),
  WEATHER_API_KEY: str(process.env.WEATHER_API_KEY, ""),
  NEWS_API_KEY:    str(process.env.NEWS_API_KEY, ""),
  TOOSII_API_KEY:  str(process.env.TOOSII_API_KEY, ""),

  // ══ Payments ══════════════════════════════════════════════
  PAYSTACK_SECRET_KEY: str(process.env.PAYSTACK_SECRET_KEY, ""),
  STRIPE_SECRET_KEY:   str(process.env.STRIPE_SECRET_KEY, ""),

  // ══ Pairing / session ═════════════════════════════════════
  PHONE:       digits(process.env.PHONE, ""),
  SESSION_DIR: str(process.env.SESSION_DIR, "./session"),
};

const VALID_WORK_MODES = new Set(["public", "private"]);

// ─── Validation ─────────────────────────────────────────────
function validateConfig() {
  const errors = [];
  const warnings = [];

  if (!CONFIG.MONGO_URI) {
    errors.push("MONGODB_URI (or MONGO_URI) is missing in .env.");
  } else if (!/^mongodb(\+srv)?:\/\//.test(CONFIG.MONGO_URI)) {
    errors.push(`MONGODB_URI does not look valid.`);
  }
  if (!VALID_WORK_MODES.has(CONFIG.WORK_MODE)) {
    errors.push(`WORK_MODE must be one of ${[...VALID_WORK_MODES].join(", ")}.`);
  }
  if (!CONFIG.PAIR_API_KEY) {
    warnings.push("PAIR_API_KEY is empty — /pair is UNAUTHENTICATED.");
  }
  if (!CONFIG.OWNER_NUMBER && CONFIG.GLOBAL_OWNERS.length === 0) {
    warnings.push("No OWNER_NUMBER or GLOBAL_OWNERS — no session can be recovered if owner loses access.");
  }
  if (!CONFIG.JWT_SECRET) {
    warnings.push("JWT_SECRET is empty — any JWT auth is insecure.");
  }
  if (CONFIG.AI_CHAT_ENABLED && !CONFIG.AI_API_KEY) {
    warnings.push("AI_CHAT_ENABLED=true but AI_API_KEY is empty.");
  }
  if (CONFIG.MAX_SESSIONS > 50) {
    warnings.push(`MAX_SESSIONS=${CONFIG.MAX_SESSIONS} — verify server memory.`);
  }

  if (errors.length) {
    console.error("\n❌ Configuration errors:\n");
    for (const e of errors) console.error("   • " + e);
    console.error("\nFix your .env and restart.\n");
    process.exit(1);
  }
  for (const w of warnings) console.warn("⚠️  " + w);
  return true;
}

function mask(s) {
  if (!s) return "(empty)";
  const str = String(s);
  if (/^mongodb/.test(str)) return str.replace(/:\/\/([^@]*)@/, "://***:***@");
  if (str.length <= 6) return "*".repeat(str.length);
  return str.slice(0, 3) + "*".repeat(Math.max(3, str.length - 6)) + str.slice(-3);
}
function dumpConfig() {
  const secrets = [
    "MONGO_URI", "AI_API_KEY", "API_KEY", "HF_TOKEN", "MODELSLAB_KEY",
    "RAPIDAPI_KEY", "WEATHER_API_KEY", "NEWS_API_KEY", "TOOSII_API_KEY",
    "PAYSTACK_SECRET_KEY", "STRIPE_SECRET_KEY", "JWT_SECRET", "PAIR_API_KEY",
  ];
  const out = {};
  for (const [k, v] of Object.entries(CONFIG)) {
    out[k] = secrets.includes(k) ? mask(String(v)) : v;
  }
  return out;
}

// Run at load time so every consumer gets a sane config
validateConfig();

// Export a plain wrapper (never the frozen object)
const exported = { ...CONFIG };
exported.validateConfig = validateConfig;
exported.dumpConfig = dumpConfig;
exported.WORK_MODES = VALID_WORK_MODES;
module.exports = exported;
