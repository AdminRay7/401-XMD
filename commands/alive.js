module.exports = {
  name: "alive",
  aliases: ["online"],
  description: "Check bot status",
  usage: ".alive",
  category: "general",
  async execute({ reply, config }) {
    await reply(
      `✅ *${config.botName}* is alive!\n` +
      `📦 v${config.version}\n` +
      `_${config.footer}_`
    );
  },
};
