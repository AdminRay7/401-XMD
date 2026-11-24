module.exports = {
  name: "reload",
  aliases: ["rl"],
  description: "Reload all commands",
  usage: ".reload",
  category: "owner",
  ownerOnly: true,
  async execute({ reply }) {
    const presenter = require("../presenter");
    presenter._reload();
    await reply(`♻️ Reloaded *${presenter.listCommands().length}* commands.`);
  },
};
