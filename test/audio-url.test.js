const test = require("node:test");
const assert = require("node:assert/strict");
const { parseAllowedHosts, readConfig, validateAudioUrl } = require("../src/config");

test("parses exact host allowlist entries", () => {
  assert.deepEqual(parseAllowedHosts(" radio.example.com,cdn.example.com., ,"), [
    "radio.example.com",
    "cdn.example.com"
  ]);
});

test("accepts HTTPS URLs only for an explicitly allowed exact hostname", () => {
  const parsed = validateAudioUrl("https://radio.example.com/live.mp3", ["radio.example.com"]);
  assert.equal(parsed.hostname, "radio.example.com");
  assert.throws(
    () => validateAudioUrl("https://sub.radio.example.com/live.mp3", ["radio.example.com"]),
    /ALLOWED_AUDIO_HOSTS/
  );
});

test("rejects insecure, credentialed, non-standard-port, and IP-literal URLs", () => {
  for (const url of [
    "http://radio.example.com/live.mp3",
    "https://user:password@radio.example.com/live.mp3",
    "https://radio.example.com:8443/live.mp3",
    "https://127.0.0.1/live.mp3",
    "https://[::1]/live.mp3"
  ]) {
    assert.throws(() => validateAudioUrl(url, ["radio.example.com"]), url);
  }
});

test("requires a dashboard token when binding beyond loopback", () => {
  const env = {
    DISCORD_TOKEN: "bot-token",
    CLIENT_ID: "application-id",
    DASHBOARD_HOST: "0.0.0.0"
  };
  assert.throws(() => readConfig(env), /DASHBOARD_TOKEN/);
  assert.equal(readConfig({ ...env, DASHBOARD_TOKEN: "a-long-random-secret" }).dashboardHost, "0.0.0.0");
});
