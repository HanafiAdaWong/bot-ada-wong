const fs = require("node:fs");
const path = require("node:path");

function createSettingsStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = path.join(dataDir, "guild-settings.json");
  let settings = {};

  if (fs.existsSync(filePath)) {
    settings = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new Error("File pengaturan guild tidak berisi objek JSON yang valid.");
    }
  }

  function persist() {
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(settings, null, 2), "utf8");
    fs.renameSync(tempPath, filePath);
  }

  return {
    get(guildId) {
      return settings[guildId] || {
        stayInVoice: false,
        voiceChannelId: null,
        autoplay: false,
        loopMode: "off",
        volume: 50
      };
    },
    update(guildId, patch) {
      settings[guildId] = { ...this.get(guildId), ...patch };
      persist();
      return settings[guildId];
    },
    entries() {
      return Object.entries(settings);
    }
  };
}

module.exports = { createSettingsStore };
