module.exports = {
  name: "antilink",
  description: "Auto-removes WhatsApp group links",
  category: "auto",
  ownerOnly: false,
  // no execute() needed — this is an auto-feature, driven by onMessage
  async onMessage({ conn, msg, from, sender, isGroup, text, config, log }) {
    if (!isGroup) return;
    if (!(config.global.ANTILINK === true || config.overrides?.ANTILINK === true)) return;
    if (!text) return;

    const linkRegex = /chat\.whatsapp\.com\/[A-Za-z0-9]+/i;
    if (!linkRegex.test(text)) return;

    // check if sender is admin
    try {
      const meta = await conn.groupMetadata(from);
      const p = meta.participants.find((x) => x.id === sender);
      if (p?.admin === "admin" || p?.admin === "superadmin") return;
      await conn.sendMessage(from, { delete: msg.key });
      await conn.sendMessage(from, {
        text: `🚫 @${sender.split("@")[0]} links are not allowed.`,
        mentions: [sender],
      });
    } catch (e) {
      log.debug("antilink:", e.message);
    }
  },
};
