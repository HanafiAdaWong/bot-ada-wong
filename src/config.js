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
  const missing = ["DISCORD_TOKEN", "CLIENT_ID"].filter((key) => !env[key]);
  if (missing.length) {
    throw new Error(`Konfigurasi wajib belum diisi: ${missing.join(", ")} (lihat .env.example).`);
  }

  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT harus berupa angka antara 1 dan 65535.");
  }

  const dashboardHost = env.DASHBOARD_HOST || "127.0.0.1";
  const dashboardToken = env.DASHBOARD_TOKEN || "";
  if (!["127.0.0.1", "::1", "localhost"].includes(dashboardHost.toLowerCase()) && !dashboardToken) {
    throw new Error("DASHBOARD_TOKEN wajib diisi saat DASHBOARD_HOST bukan alamat loopback.");
  }

  return {
    token: env.DISCORD_TOKEN,
    clientId: env.CLIENT_ID,
    guildId: env.GUILD_ID || "",
    allowedAudioHosts: parseAllowedHosts(env.ALLOWED_AUDIO_HOSTS),
    port,
    dashboardHost,
    dashboardToken,
    dataDir: path.resolve(env.DATA_DIR || "./data")
  };
}

module.exports = { parseAllowedHosts, readConfig, validateAudioUrl };
