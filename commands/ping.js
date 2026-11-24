module.exports = {
  name: "ping",
  aliases: ["p"],
  description: "Check bot latency",
  usage: ".ping",
  category: "general",
  async execute({ reply }) {
    const start = Date.now();
    const sent = await reply("🏓 Pinging…");
    const latency = Date.now() - start;
    await reply(`🏓 Pong! *${latency}ms*`);
  },
};
