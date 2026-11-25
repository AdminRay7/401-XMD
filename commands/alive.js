const globalCfg = require("../config"); // adjust path to your root config

module.exports = {
  name: "alive",
  aliases: ["online"],
  description: "Check bot status",
  usage: ".alive",
  category: "general",

  async execute({ reply, config, botName, prefix }) {
    // Resolve with safe fallbacks: cmdCtx → session config → global config → default
    const name    = botName || config?.botName || globalCfg.BOT_NAME  || "Bot";
    const version = config?.version || globalCfg.VERSION || globalCfg.version || "1.0.0";
    const footer  = config?.footer  || globalCfg.FOOTER  || globalCfg.footer  || `${name} • ${prefix || globalCfg.PREFIX || "."}help`;
    const uptime  = formatUptime(process.uptime());

    await reply(
      `✅ *${name}* is alive!\n` +
      `📦 v${version}\n` +
      `⏱️ Uptime: ${uptime}\n` +
      `_${footer}_`
    );
  },
};

// small helper — avoids pulling a dep just for this
function formatUptime(sec) {
  sec = Math.floor(sec);
  const d = Math.floor(sec / 86400); sec %= 86400;
  const h = Math.floor(sec / 3600);  sec %= 3600;
  const m = Math.floor(sec / 60);    sec %= 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(" ");
}
