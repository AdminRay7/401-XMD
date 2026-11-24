module.exports = {
  name: "eval",
  aliases: ["exec"],
  description: "Run JavaScript (owner only)",
  usage: ".eval <code>",
  category: "owner",
  ownerOnly: true,
  hidden: true,
  async execute({ reply, args, conn, config }) {
    const code = args.join(" ");
    if (!code) return reply(`Usage: ${config.prefix}eval <code>`);
    try {
      let result = await eval(`(async () => { ${code} })()`);
      result = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      await reply("```" + String(result).slice(0, 4000) + "```");
    } catch (e) {
      await reply(`❌ ${e.message}`);
    }
  },
};
