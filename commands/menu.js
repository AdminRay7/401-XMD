const path = require("path");

module.exports = {
  name: "menu",
  aliases: ["help", "commands"],
  description: "List all available commands",
  usage: ".menu",
  category: "general",
  
  // 🌟 FIX: Accept (conn, msg, args, ctx) properly
  async execute(conn, msg, args, ctx) {
    // pull registry from presenter without circular require
    const presenter = require(path.join(__dirname, "..", "presenter"));
    const all = presenter.listCommands();

    const grouped = {};
    for (const c of all) {
      (grouped[c.category] ||= []).push(c);
    }

    // 🌟 FIX: Use ctx.config instead of config
    const config = ctx.config;
    
    let out = `╭─「 *${config.botName}* 」\n`;
    out += `│ 🔑 Prefix : ${config.prefix}\n`;
    out += `│ 📦 Version: v${config.version}\n`;
    out += `│ 🌐 Mode   : ${config.workMode}\n`;
    out += `╰──────────────\n\n`;

    for (const [cat, cmds] of Object.entries(grouped)) {
      out += `*${cat.toUpperCase()}*\n`;
      for (const c of cmds) {
        out += `• ${config.prefix}${c.name}${c.aliases.length ? ` (${c.aliases.map(a => config.prefix + a).join(", ")})` : ""}\n`;
      }
      out += `\n`;
    }

    out += `_${config.footer}_`;
    await ctx.reply(out);
  },
};
