// ══════════════════════════════════════════════════════════════
//  config.js — 303-XMD central configuration loader
//  Reads .env once, validates, normalizes, exports frozen object
// ══════════════════════════════════════════════════════════════

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

function int(v, fallback) {
  return Math.floor(num(v, fallback));
}

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
  return String(v)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

// ─── Build config ────────────────────────────────────────────
const CONFIG = Object.freeze({
  // ══ Bot identity ══════════════════════════════════════════
  BOT_NAME:   str(process.env.BOT_NAME, "303-XMD"),
  FOOTER:     str(process.env.FOOTER, "303-XMD — THE LAST KEY"),
  VERSION:    str(process.env.VERSION, "2.0.0"),
  PREFIX:     str(process.env.PREFIX, "."),
  ADMIN_EMAIL: str(process.env.ADMIN_EMAIL, ""),

  // ══ Owner ═════════════════════════════════════════════════
  OWNER_NUMBER: digits(process.env.OWNER_NUMBER, ""),
  OWNER_NAME:   str(process.env.OWNER_NAME, "Unknown"),

  // ══ Server ════════════════════════════════════════════════
  PORT:      int(process.env.PORT, 3000),
  LOG_LEVEL: str(process.env.LOG_LEVEL, "silent"),
  WORK_MODE: str(process.env.WORK_MODE, "public").toLowerCase(),

  // ══ Mongo ═════════════════════════════════════════════════
  MONGO_URI: str(process.env.MONGODB_URI) || str(process.env.MONGO_URI),
  DB_NAME:   str(process.env.DB_NAME, "xmd303"),

  // ══ Multi-user safety ═════════════════════════════════════
  MAX_SESSIONS:   int(process.env.MAX_SESSIONS, 20),
  PAIR_API_KEY:   str(process.env.PAIR_API_KEY, ""),
  SESSION_TTL_MS: int(process.env.SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000),
  RATE_LIMIT_MS:  int(process.env.RATE_LIMIT_MS, 60_000),

  // ══ Auto behaviour ════════════════════════════════════════
  AUTO_READ:    bool(process.env.AUTO_READ, true),
  AUTO_REACT:   bool(process.env.AUTO_REACT, true),
  AUTO_SAVE:    bool(process.env.AUTO_SAVE, true),
  AUTO_TYPING:  bool(process.env.AUTO_TYPING, true),
  ANTICALL:     bool(process.env.ANTICALL, true),
  ANTIBUG:      bool(process.env.ANTIBUG, true),
  ANTISPAM:     bool(process.env.ANTISPAM, true),
  ANTILINK:     bool(process.env.ANTILINK, false),
  ANTIDELETE:   bool(process.env.ANTIDELETE, true),
  ANTIMEDIA:    str(process.env.ANTIMEDIA, "off").toLowerCase(),

  // ══ Status ════════════════════════════════════════════════
  AUTO_STATUS_VIEW:  bool(process.env.AUTO_STATUS_VIEW, true),
  AUTO_STATUS_LIKE:  bool(process.env.AUTO_STATUS_LIKE, true),
  AUTO_STATUS_REPLY: bool(process.env.AUTO_STATUS_REPLY, false),
  STATUS_REPLY_TEXT: str(process.env.STATUS_REPLY_TEXT, "Nice status! ✨"),

  // ══ Blocking ══════════════════════════════════════════════
  AUTOBLOCK: digits(process.env.AUTOBLOCK, ""),

  // ══ Channel / newsletter ══════════════════════════════════
  NEWSLETTER_JID:       str(process.env.NEWSLETTER_JID, ""),
  CHANNEL_LINK:         str(process.env.CHANNEL_LINK, ""),
  AUTO_REACT_CHANNEL:   bool(process.env.AUTO_REACT_CHANNEL, true),
  AUTO_SUBSCRIBE_CHANNEL: bool(process.env.AUTO_SUBSCRIBE_CHANNEL, true),
  LOG_CHANNEL_POSTS:    bool(process.env.LOG_CHANNEL_POSTS, true),
  CHANNEL_EMOJIS:       csv(process.env.CHANNEL_EMOJIS, ["🔑", "🔥", "⭐"]),
  FORWARD_CHANNEL_TO:   str(process.env.FORWARD_CHANNEL_TO, ""),
  CROSS_POST_WEBHOOK:   str(process.env.CROSS_POST_WEBHOOK, ""),

  // ══ Welcome / goodbye ═════════════════════════════════════
  AUTO_GREET:       bool(process.env.AUTO_GREET, false),
  WELCOME_MESSAGE:  bool(process.env.WELCOME_MESSAGE, true),
  GOODBYE_MESSAGE:  bool(process.env.GOODBYE_MESSAGE, true),

  // ══ JWT ═══════════════════════════════════════════════════
  JWT_SECRET: str(process.env.JWT_SECRET, ""),

  // ══ AI Chat (Groq) ════════════════════════════════════════
  AI_CHAT_ENABLED: bool(process.env.AI_CHAT_ENABLED, false),
  AI_CHAT_GROUPS:  bool(process.env.AI_CHAT_GROUPS, true),
  AI_MODEL:        str(process.env.AI_MODEL, "openai/gpt-oss-20b"),
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
});

// ─── Required env check ──────────────────────────────────────
// Only MONGO_URI is truly required (used by db.js / index.js).
// Everything else has a safe default so the bot still boots.
function validateConfig() {
  const errors = [];

  if (!CONFIG.MONGO_URI) {
    errors.push(
      "MONGODB_URI (or MONGO_URI) is missing in .env — the bot cannot store WhatsApp sessions without it."
    );
  } else if (!/^mongodb(\+srv)?:\/\//.test(CONFIG.MONGO_URI)) {
    errors.push(
      `MONGODB_URI does not look like a valid MongoDB URI (must start with mongodb:// or mongodb+srv://). Got: "${CONFIG.MONGO_URI.slice(0, 30)}..."`
    );
  }

  if (!CONFIG.OWNER_NUMBER) {
    console.warn("⚠️  OWNER_NUMBER is empty — owner-only commands will not work.");
  }

  if (CONFIG.AI_CHAT_ENABLED && !CONFIG.AI_API_KEY) {
    console.warn("⚠️  AI_CHAT_ENABLED=true but AI_API_KEY is empty — AI commands will reply with an error.");
  }

  if (errors.length) {
    console.error("\n❌ Configuration errors:\n");
    for (const e of errors) console.error("   • " + e);
    console.error("\nFix your .env and restart.\n");
    process.exit(1);
  }

  return true;
}

// ─── Debug dump (safe — masks secrets) ──────────────────────
function mask(s) {
  if (!s) return "(empty)";
  if (s.length <= 6) return "*".repeat(s.length);
  return s.slice(0, 3) + "*".repeat(Math.max(3, s.length - 6)) + s.slice(-3);
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

module.exports = CONFIG;
module.exports.validateConfig = validateConfig;
module.exports.dumpConfig = dumpConfig;
