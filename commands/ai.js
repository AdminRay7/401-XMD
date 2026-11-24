const axios = require("axios");

module.exports = {
  name: "ai",
  aliases: ["gpt", "ask"],
  description: "Chat with AI",
  usage: ".ai <question>",
  category: "ai",
  async execute({ reply, args, config, typing }) {
    if (!config.global.AI_CHAT_ENABLED || !config.global.AI_API_KEY) {
      return reply("❌ AI chat is disabled.");
    }
    const q = args.join(" ").trim();
    if (!q) return reply(`Usage: ${config.prefix}ai <question>`);

    try {
      await typing();
      const { data } = await axios.post(
        `${config.global.AI_BASE_URL}/chat/completions`,
        {
          model: config.global.AI_MODEL,
          messages: [
            { role: "system", content: config.global.AI_SYSTEM_PROMPT },
            { role: "user", content: q },
          ],
        },
        {
          headers: { Authorization: `Bearer ${config.global.AI_API_KEY}` },
          timeout: 30000,
        }
      );
      const ans = data?.choices?.[0]?.message?.content?.trim() || "…";
      await reply(ans);
    } catch (e) {
      await reply(`⚠️ AI error: ${e.message}`);
    }
  },
};
