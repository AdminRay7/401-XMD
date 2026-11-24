module.exports = {
  name: "owner",
  description: "Show bot owner",
  usage: ".owner",
  category: "general",
  async execute({ reply, config }) {
    await reply(
      `👑 *Owner:* ${config.ownerName || "Unknown"}\n` +
      `📞 +${config.ownerNumber || "n/a"}`
    );
  },
};
