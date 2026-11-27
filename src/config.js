const path = require("node:path");
const { isIP } = require("node:net");

function parseAllowedHosts(value = "") {
  return value
    .split(",")
    .map((host) => host.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
}

function validateAudioUrl(value, allowedHosts) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("URL audio tidak valid.");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !hostname ||
    isIP(hostname) ||
    !allowedHosts.includes(hostname)
  ) {
    throw new Error("URL harus HTTPS dan host-nya harus ada di ALLOWED_AUDIO_HOSTS.");
  }

  url.hash = "";
  return url;
}

function readConfig(env = process.env) {
  const token = (env.DISCORD_TOKEN || "").trim();
  const clientId = (env.CLIENT_ID || "").trim();

  const missing = [];
  if (!token) missing.push("DISCORD_TOKEN");
  if (!clientId) missing.push("CLIENT_ID");
  if (missing.length) {
    throw new Error(`Konfigurasi wajib belum diisi: ${missing.join(", ")} (isi di file .env atau Environment Variables hosting).`);
  }

  const port = Number(env.PORT || 3000);
  const dashboardHost = env.DASHBOARD_HOST || "127.0.0.1";
  const dashboardToken = env.DASHBOARD_TOKEN || "";

  return {
    token,
    clientId,
    guildId: env.GUILD_ID || "",
    allowedAudioHosts: parseAllowedHosts(env.ALLOWED_AUDIO_HOSTS),
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 3000,
    dashboardHost,
    dashboardToken,
    dataDir: path.resolve(env.DATA_DIR || "./data")
  };
}

module.exports = { parseAllowedHosts, readConfig, validateAudioUrl };
