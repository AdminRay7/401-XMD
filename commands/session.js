module.exports = {
  name: "session",
  aliases: ["sid"],
  description: "Show your session ID",
  usage: ".session",
  category: "general",
  async execute({ reply, sessionId, config }) {
    await reply(`🆔 Session: *${sessionId}*\n📦 ${config.botName} v${config.version}`);
  },
};
