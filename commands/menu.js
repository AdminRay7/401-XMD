const path = require("path");

// ============================================================
//   menu.js — Simple command list (names only)
//   .menu  |  .menu <category>
// ============================================================
module.exports = {
  name: "menu",
  aliases: ["help", "commands"],
  description: "List all available commands",
  usage: ".menu [category]",
  category: "general",

  async execute({ reply, args, config, isOwner, prefix, botName }) {
    const presenter  = require(path.join(__dirname, "..", "presenter"));
    const globalCfg  = require(path.join(__dirname, "..", "config"));

    // ---- resolve shared values ----
    const p         = prefix || config?.prefix || globalCfg.PREFIX || ".";
    const name      = botName || config?.botName || globalCfg.BOT_NAME || "Bot";
    const version   = config?.version || globalCfg.VERSION || globalCfg.version || "1.0.0";
    const workMode  = (config?.workMode || globalCfg.WORK_MODE || "public").toLowerCase();
    const footer    = config?.footer || globalCfg.FOOTER || globalCfg.footer || `${name} • ${p}menu`;

    // ---- get + filter commands ----
    const all     = presenter.listCommands();
    const visible = all.filter(c => !c.hidden || isOwner);

    // ---- group by category ----
    const grouped = new Map();
    for (const c of visible) {
      const cat = (c.category || "general").toLowerCase();
      if (!grouped.has(cat)) grouped.set(cat, []);
      grouped.get(cat).push(c);
    }
    const categories = [...grouped.keys()].sort();
    for (const cat of categories) {
      grouped.get(cat).sort((a, b) => a.name.localeCompare(b.name));
    }

    // ---- header ----
    const header =
      `╭─「 *${name}* 」\n` +
      `│ 🔑 Prefix : ${p}\n` +
      `│ 📦 Version: v${version}\n` +
      `│ 🌐 Mode   : ${workMode}\n` +
      `│ 📚 Total  : ${visible.length} commands\n` +
      `╰──────────────────────\n\n`;

    // ---- category view ----
    const sub = (args[0] || "").toLowerCase();
    if (sub && grouped.has(sub)) {
      const cmds = grouped.get(sub);
      let out = header + `*${sub.toUpperCase()}* — ${cmds.length}\n\n`;
      for (const c of cmds) out += `• ${p}${c.name}${badges(c)}\n`;
      out += `\n_${footer}_`;
      return reply(out);
    }

    if (sub) {
      return reply(
        `${header}❓ Unknown category: *${sub}*\n\n` +
        `Available: ${categories.map(c => `\`${c}\``).join(", ")}`
      );
    }

    // ---- main menu ----
    let out = header;
    for (const cat of categories) {
      const cmds = grouped.get(cat);
      out += `╭─「 *${cat.toUpperCase()}* 」\n`;
      for (const c of cmds) out += `│ ${p}${c.name}${badges(c)}\n`;
      out += `╰──────────────────────\n\n`;
    }
    out += `_${footer}_`;

    return reply(truncate(out, 4000));
  },
};

// ============================================================
//   HELPERS
// ============================================================
function badges(c) {
  const b = [];
  if (c.ownerOnly)   b.push("👑");
  if (c.adminOnly)   b.push("🛡️");
  if (c.groupOnly)   b.push("👥");
  if (c.privateOnly) b.push("💬");
  return b.length ? ` ${b.join("")}` : "";
}

function truncate(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, max - 20) + "\n…(truncated)";
}
