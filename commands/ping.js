module.exports = {
  name: "ping",
  aliases: ["p"],
  description: "Check bot latency",
  usage: ".ping",
  category: "general",
  async execute({ conn, from, msg, reply }) {
    const start = Date.now();
    const sent = await conn.sendMessage(from, { text: "🏓 Pinging…" }, { quoted: msg });
    const latency = Date.now() - start;
    try {
      await conn.sendMessage(from, {
        text: `🏓 Pong! *${latency}ms*`,
        edit: sent.key,
      });
    } catch {
      // fallback if edit fails (older WA / unsupported)
      await reply(`🏓 Pong! *${latency}ms*`);
    }
  },
};
