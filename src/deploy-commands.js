require("dotenv").config();

const { REST, Routes } = require("discord.js");
const { commands } = require("./commands");
const { readConfig } = require("./config");

async function main() {
  const config = readConfig();
  const rest = new REST({ version: "10" }).setToken(config.token);
  const route = config.guildId
    ? Routes.applicationGuildCommands(config.clientId, config.guildId)
    : Routes.applicationCommands(config.clientId);

  console.log(`Mendaftarkan ${commands.length} slash commands${config.guildId ? " ke server uji" : " secara global"}...`);
  await rest.put(route, { body: commands.map((command) => command.toJSON()) });
  console.log("Slash commands berhasil didaftarkan.");
}

main().catch((error) => {
  console.error("Gagal mendaftarkan slash commands:", error);
  process.exitCode = 1;
});
