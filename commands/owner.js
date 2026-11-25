const globalConfig = require('../config'); // adjust path if commands/ is nested differently

module.exports = {
  name: "owner",
  description: "Show bot owner",
  usage: ".owner",
  category: "general",
  async execute({ reply, config }) {
    // Session config first, then global config, then fallback
    const ownerName =
      config.ownerName ||
      globalConfig.OWNER_NAME ||
      globalConfig.ownerName ||
      "Unknown";

    const rawOwner =
      config.ownerNumber ||
      globalConfig.OWNER_NUMBER ||
      globalConfig.ownerNumber ||
      "";

    // Normalize: strip @domain, device suffix, keep digits only
    const ownerDigits = String(rawOwner)
      .split("@")[0]
      .split(":")[0]
      .replace(/\D/g, "");

    const ownerDisplay = ownerDigits ? `+${ownerDigits}` : "n/a";

    await reply(
      `👑 *Owner:* ${ownerName}\n` +
      `📞 ${ownerDisplay}`
    );
  },
};
