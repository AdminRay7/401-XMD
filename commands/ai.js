const axios = require("axios");
const globalCfg = require("../config"); // adjust path to your root config

module.exports = {
  name: "ai",
  aliases: ["gpt", "ask"],
  description: "Chat with AI",
  usage: ".ai <question>",
  category: "ai",

  async execute({ reply, args, config, typing }) {
    // --- Resolve AI config safely (session → global → defaults) ---
    const aiCfg = {
      enabled: config?.global?.AI_CHAT_ENABLED ?? globalCfg.AI_CHAT_ENABLED ?? false,
      apiKey:  config?.global?.AI_API_KEY      ?? globalCfg.AI_API_KEY      ?? "",
      baseUrl: config?.global?.AI_BASE_URL     ?? globalCfg.AI_BASE_URL     ?? "https://api.openai.com/v1",
      model:   config?.global?.AI_MODEL        ?? globalCfg.AI_MODEL        ?? "gpt-3.5-turbo",
      system:  config?.global?.AI_SYSTEM_PROMPT ?? globalCfg.AI_SYSTEM_PROMPT ?? "You are a helpful assistant.",
    };

    if (!aiCfg.enabled) return reply("❌ AI chat is disabled.");
    if (!aiCfg.apiKey) return reply("❌ AI API key is not configured.");

    // --- Input ---
    const q = args.join(" ").trim().slice(0, 2000);
    if (!q) return reply(`Usage: ${(config?.prefix || globalCfg.PREFIX || ".")}ai <question>`);

    // --- Typing indicator (safe if helper missing) ---
    try { if (typeof typing === "function") await typing(); } catch {}

    try {
      const { data } = await axios.post(
        `${aiCfg.baseUrl.replace(/\/+$/, "")}/chat/completions`,
        {
          model: aiCfg.model,
          messages: [
            { role: "system", content: aiCfg.system },
            { role: "user", content: q },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${aiCfg.apiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 30000,
        }
      );

      // --- Extract answer (handles string OR array content) ---
      let ans = data?.choices?.[0]?.message?.content;
      if (Array.isArray(ans)) {
        ans = ans.map(p => (typeof p === "string" ? p : p?.text || "")).join("").trim();
      } else if (typeof ans === "string") {
        ans = ans.trim();
      }
      if (!ans) ans = "…";

      // --- Cap length for WhatsApp ---
      const MAX = 4000;
      if (ans.length > MAX) ans = ans.slice(0, MAX) + "\n…(truncated)";

      await reply(ans);
    } catch (e) {
      // Log full detail, reply generic
      console.error("AI error:", e.response?.data || e.message);
      await reply("⚠️ AI request failed. Please try again later.");
    }
  },
};
