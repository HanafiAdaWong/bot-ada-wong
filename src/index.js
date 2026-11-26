require("dotenv").config();

const express = require("express");
const path = require("node:path");
const { timingSafeEqual } = require("node:crypto");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits
} = require("discord.js");
const {
  joinVoiceChannel,
  getVoiceConnection,
  entersState,
  VoiceConnectionStatus
} = require("@discordjs/voice");
const { commands } = require("./commands");
const { createMusicManager } = require("./music-manager");
const { createSettingsStore } = require("./settings-store");
const { readConfig } = require("./config");
const { resolveTracks } = require("./audio-source");

const config = readConfig();
const settings = createSettingsStore(config.dataDir);
const logger = console;
const music = createMusicManager({ allowedHosts: config.allowedAudioHosts, logger });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

function getDefaults(guildId) {
  return settings.get(guildId);
}

function controls() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ada_pause").setLabel("Jeda").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ada_resume").setLabel("Lanjut").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("ada_skip").setLabel("Lewati").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ada_stop").setLabel("Stop").setStyle(ButtonStyle.Danger)
  );
}

/**
 * Membuat Embed UI Modern & Lengkap seperti tampilan bot premium (foto referensi)
 */
function createMusicCard(statusTitle, track, queue, guild) {
  const loopDisplay = queue.loopMode === "track"
    ? "Lagu ini"
    : queue.loopMode === "queue"
      ? "Seluruh Antrean"
      : "Nonaktif";

  const autoplayDisplay = queue.autoplay ? "Aktif" : "Nonaktif";
  const duration = track.durationFormatted || "00:00";
  const requesterTag = track.requester || "Harukashii";

  const embed = new EmbedBuilder()
    .setColor(0x0099ff) // Biru modern sesuai foto referensi
    .setAuthor({
      name: statusTitle,
      iconURL: client.user.displayAvatarURL()
    })
    .setTitle(track.title)
    .setURL(track.url?.startsWith("http") ? track.url : null)
    .addFields(
      { name: "Durasi", value: duration, inline: true },
      { name: "Diminta oleh", value: requesterTag, inline: true },
      { name: "Loop", value: loopDisplay, inline: true },
      { name: "Autoplay", value: autoplayDisplay, inline: true }
    )
    .setFooter({
      text: `Volume: ${queue.volume}% — Ada Wong • Today at ${new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}`
    });

  if (track.thumbnail) {
    embed.setThumbnail(track.thumbnail);
  }

  return embed;
}

/**
 * Membuat Embed Panduan / Help yang rapi dan informatif
 */
function createHelpEmbed() {
  return new EmbedBuilder()
    .setColor(0x0099ff)
    .setAuthor({
      name: "Panduan & Perintah Ada Wong Music Bot",
      iconURL: client.user.displayAvatarURL()
    })
    .setDescription("Bot musik Ada Wong mendukung pencarian YouTube, Spotify, SoundCloud, dan URL audio langsung dengan tombol kontrol dan antrean server.")
    .addFields(
      {
        name: "⚡ Perintah Cepat / Prefix (Ketik langsung di chat):",
        value: [
          "• `awp <judul/link>` — Putar lagu atau tambahkan ke antrean *(contoh: `awp Pelangi`)*",
          "• `awstop` / `aws` — Hentikan musik & bot keluar dari voice channel",
          "• `awskip` / `awn` — Lewati lagu yang sedang diputar",
          "• `awpause` — Jeda lagu",
          "• `awresume` — Lanjutkan lagu yang dijeda",
          "• `awnp` — Tampilkan kartu lagu yang sedang diputar",
          "• `awqueue` / `awq` — Tampilkan daftar antrean lagu",
          "• `awhelp` / `awh` — Menampilkan pesan panduan ini"
        ].join("\n")
      },
      {
        name: "🎮 Slash Commands (Gunakan `/`):",
        value: [
          "• `/play <query>` — Putar lagu / link musik",
          "• `/pause` & `/resume` — Jeda atau lanjutkan lagu",
          "• `/skip` & `/stop` — Lewati atau hentikan lagu",
          "• `/nowplaying` & `/queue` — Info lagu saat ini & antrean",
          "• `/volume <0-100>` — Atur volume pemutaran bot",
          "• `/loop <off|track|queue>` — Atur mode pengulangan",
          "• `/autoplay <aktif:true/false>` — Putar ulang otomatis saat lagu habis",
          "• `/247 <aktif:true/false>` — Bot tetap stand-by di voice channel (Admin)",
          "• `/help` — Menampilkan bantuan ini"
        ].join("\n")
      },
      {
        name: "💡 Catatan Penting:",
        value: "Pastikan Anda sudah berada di voice channel sebelum memutar lagu!"
      }
    )
    .setFooter({
      text: "Ada Wong Music Bot • Solusi Musik Berkualitas Tinggi"
    });
}

// Event otomatis saat lagu berikutnya mulai diputar
music.events.on("trackStart", async ({ guildId, queue, track }) => {
  if (!queue.textChannel) return;
  try {
    const embed = createMusicCard("Sedang Memutar", track, queue);
    await queue.textChannel.send({ embeds: [embed], components: [controls()] });
  } catch (err) {
    logger.error(`[${guildId}] Gagal mengirim kartu musik lagu berikutnya:`, err);
  }
});

async function connectToVoice(guild, channel) {
  let connection = getVoiceConnection(guild.id);
  if (connection && connection.joinConfig.channelId !== channel.id) {
    connection.destroy();
    connection = null;
  }
  if (!connection) {
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true
    });
  }

  const queue = music.getQueue(guild.id, getDefaults(guild.id));
  queue.connection = connection;
  connection.subscribe(queue.player);

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (err) {
    logger.error(`[${guild.id}] Voice connection failed to reach Ready:`, err);
  }

  return queue;
}

function canControlInVoice(member, queue) {
  const userChannel = member?.voice?.channel;
  if (!userChannel) return false;
  return !queue.connection || queue.connection.joinConfig.channelId === userChannel.id;
}

async function replyError(interaction, message) {
  const payload = { content: message, ephemeral: true };
  if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
  return interaction.reply(payload);
}

async function handleButton(interaction) {
  const guildId = interaction.guildId;
  const queue = music.getQueue(guildId, getDefaults(guildId));
  if (!canControlInVoice(interaction.member, queue)) {
    return replyError(interaction, "Masuk ke voice channel bot untuk menggunakan kontrol musik.");
  }

  switch (interaction.customId) {
    case "ada_pause":
      if (!queue.player.pause()) return replyError(interaction, "Tidak ada musik yang sedang diputar.");
      return interaction.reply({ content: "⏸️ Musik dijeda.", ephemeral: true });
    case "ada_resume":
      if (!queue.player.unpause()) return replyError(interaction, "Musik tidak sedang dijeda.");
      return interaction.reply({ content: "▶️ Musik dilanjutkan.", ephemeral: true });
    case "ada_skip":
      if (!music.skip(guildId)) return replyError(interaction, "Tidak ada lagu untuk dilewati.");
      return interaction.reply({ content: "⏭️ Lagu dilewati.", ephemeral: true });
    case "ada_stop":
      music.stop(guildId);
      if (getDefaults(guildId).stayInVoice) {
        const channel = interaction.guild.channels.cache.get(getDefaults(guildId).voiceChannelId);
        if (channel?.isVoiceBased()) await connectToVoice(interaction.guild, channel);
      }
      return interaction.reply({ content: "⏹️ Musik dihentikan.", ephemeral: true });
    default:
      return;
  }
}

/**
 * Eksekusi play umum (dipakai baik oleh slash command maupun prefix command awp)
 */
async function executePlay(query, member, guild, channel, textChannel, sendReply) {
  const guildId = guild.id;
  const queue = music.getQueue(guildId, getDefaults(guildId));
  queue.textChannel = textChannel;

  const voiceChannel = member?.voice?.channel;
  if (!voiceChannel) {
    return sendReply("Masuk ke voice channel terlebih dahulu.");
  }
  if (queue.connection && queue.connection.joinConfig.channelId !== voiceChannel.id) {
    return sendReply("Ada sudah terhubung ke voice channel lain di server ini.");
  }

  try {
    const requester = member.displayName || member.user?.username || "User";
    const tracks = await resolveTracks(query, config.allowedAudioHosts, requester);
    if (!tracks || tracks.length === 0) {
      return sendReply(`Tidak dapat menemukan lagu untuk "${query}".`);
    }

    await connectToVoice(guild, voiceChannel);

    if (tracks.length === 1) {
      const track = tracks[0];
      const isFirst = !queue.current && queue.tracks.length === 0;
      music.addTrack(guildId, track, getDefaults(guildId));

      const card = createMusicCard(
        isFirst ? "Sedang Memutar" : "Ditambahkan ke Antrean",
        track,
        queue,
        guild
      );
      return sendReply({ embeds: [card], components: [controls()] });
    } else {
      const { count } = music.addTracks(guildId, tracks, getDefaults(guildId));
      const embed = new EmbedBuilder()
        .setColor(0x0099ff)
        .setAuthor({ name: "Playlist Ditambahkan", iconURL: client.user.displayAvatarURL() })
        .setTitle(`Menambahkan ${count} lagu ke antrean`)
        .setDescription(`🎵 Diminta oleh: **${requester}**\nAntrean saat ini: **${queue.tracks.length} lagu**`)
        .setFooter({ text: `Volume: ${queue.volume}% — Ada Wong` });

      return sendReply({ embeds: [embed], components: [controls()] });
    }
  } catch (error) {
    logger.error(`[${guildId}] Play error:`, error);
    return sendReply(error.message || "Tidak dapat memutar lagu.");
  }
}

async function handleCommand(interaction) {
  const guildId = interaction.guildId;
  const queue = music.getQueue(guildId, getDefaults(guildId));
  queue.textChannel = interaction.channel;
  const command = interaction.commandName;

  if (command === "play") {
    await interaction.deferReply();
    const query = interaction.options.getString("query") || interaction.options.getString("url");
    if (!query) return interaction.editReply("Harap masukkan judul lagu atau URL.");

    return executePlay(
      query,
      interaction.member,
      interaction.guild,
      interaction.channel,
      interaction.channel,
      (msg) => (typeof msg === "string" ? interaction.editReply(msg) : interaction.editReply(msg))
    );
  }

  if (command === "pause" || command === "resume" || command === "skip" ||
      command === "stop" || command === "volume" || command === "autoplay" ||
      command === "loop" || command === "247") {
    if (!canControlInVoice(interaction.member, queue) && command !== "247") {
      return replyError(interaction, "Masuk ke voice channel bot untuk menggunakan perintah musik.");
    }
  }

  switch (command) {
    case "pause":
      if (!queue.player.pause()) return replyError(interaction, "Tidak ada musik yang sedang diputar.");
      return interaction.reply("Musik dijeda.");
    case "resume":
      if (!queue.player.unpause()) return replyError(interaction, "Musik tidak sedang dijeda.");
      return interaction.reply("Musik dilanjutkan.");
    case "skip":
      if (!music.skip(guildId)) return replyError(interaction, "Tidak ada lagu untuk dilewati.");
      return interaction.reply("Lagu dilewati.");
    case "stop": {
      music.stop(guildId);
      const saved = getDefaults(guildId);
      if (saved.stayInVoice) {
        const channel = interaction.guild.channels.cache.get(saved.voiceChannelId);
        if (channel?.isVoiceBased()) await connectToVoice(interaction.guild, channel);
      }
      return interaction.reply("Musik dihentikan.");
    }
    case "queue": {
      const current = queue.current ? `Sedang diputar: **${queue.current.title}**` : "Tidak ada lagu yang sedang diputar.";
      const tracks = queue.tracks.slice(0, 15).map((track, index) => `${index + 1}. ${track.title} (${track.durationFormatted || "00:00"})`);
      const more = queue.tracks.length > tracks.length ? `\n...dan ${queue.tracks.length - tracks.length} lagu lainnya.` : "";
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x0099ff)
          .setTitle("Antrean Ada Wong")
          .setDescription([current, "", ...tracks, more].filter(Boolean).join("\n"))],
        ephemeral: true
      });
    }
    case "nowplaying":
      if (!queue.current) return replyError(interaction, "Tidak ada lagu yang sedang diputar.");
      return interaction.reply({
        embeds: [createMusicCard("Sedang Memutar", queue.current, queue, interaction.guild)],
        components: [controls()]
      });
    case "volume": {
      const volume = interaction.options.getInteger("level", true);
      music.setVolume(guildId, volume, getDefaults(guildId));
      settings.update(guildId, { volume });
      return interaction.reply(`Volume diatur ke **${volume}%**.`);
    }
    case "autoplay": {
      const enabled = interaction.options.getBoolean("aktif", true);
      music.setAutoplay(guildId, enabled, getDefaults(guildId));
      settings.update(guildId, { autoplay: enabled });
      return interaction.reply(enabled
        ? "Autoplay aktif: lagu terakhir akan diputar ulang saat antrean habis."
        : "Autoplay dimatikan.");
    }
    case "loop": {
      const mode = interaction.options.getString("mode", true);
      music.setLoopMode(guildId, mode, getDefaults(guildId));
      settings.update(guildId, { loopMode: mode });
      return interaction.reply(`Mode loop diatur ke **${mode}**.`);
    }
    case "247": {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return replyError(interaction, "Perintah 24/7 hanya dapat diatur oleh anggota dengan izin Manage Server.");
      }
      const enabled = interaction.options.getBoolean("aktif", true);
      const channel = interaction.member?.voice?.channel;
      if (enabled && !channel) return replyError(interaction, "Masuk ke voice channel yang ingin dijaga terlebih dahulu.");
      if (enabled && queue.connection && queue.connection.joinConfig.channelId !== channel.id) {
        return replyError(interaction, "Ada sedang berada di voice channel lain.");
      }
      if (enabled) {
        await connectToVoice(interaction.guild, channel);
        settings.update(guildId, { stayInVoice: true, voiceChannelId: channel.id });
        return interaction.reply("Mode 24/7 aktif. Bot akan mencoba kembali ke voice channel ini setelah restart.");
      }
      settings.update(guildId, { stayInVoice: false, voiceChannelId: null });
      return interaction.reply("Mode 24/7 dimatikan. Koneksi saat ini tidak diputus.");
    }
    case "help": {
      return interaction.reply({ embeds: [createHelpEmbed()], ephemeral: false });
    }
    default:
      return;
  }
}

// Handler Prefix Command (misalnya: awp, awplay, awstop, dll.)
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;

  const content = message.content.trim();
  const lower = content.toLowerCase();

  // Awali dengan awp (contoh: awp lantas / awp https://...)
  if (lower.startsWith("awp ") || lower.startsWith("awplay ") || lower === "awp") {
    const query = content.replace(/^aw(play|p)\s*/i, "").trim();
    if (!query) {
      return message.reply("Gunakan: `awp <judul lagu atau link>` (contoh: `awp Pelangi`)");
    }
    return executePlay(
      query,
      message.member,
      message.guild,
      message.channel,
      message.channel,
      (replyContent) => (typeof replyContent === "string" ? message.reply(replyContent) : message.reply(replyContent))
    );
  }

  // awstop
  if (lower === "awstop" || lower === "aws") {
    const queue = music.getQueue(message.guild.id, getDefaults(message.guild.id));
    if (!canControlInVoice(message.member, queue)) {
      return message.reply("Masuk ke voice channel bot terlebih dahulu.");
    }
    music.stop(message.guild.id);
    return message.reply("⏹️ Musik dihentikan.");
  }

  // awskip
  if (lower === "awskip" || lower === "awn") {
    const queue = music.getQueue(message.guild.id, getDefaults(message.guild.id));
    if (!canControlInVoice(message.member, queue)) {
      return message.reply("Masuk ke voice channel bot terlebih dahulu.");
    }
    if (!music.skip(message.guild.id)) return message.reply("Tidak ada lagu untuk dilewati.");
    return message.reply("⏭️ Lagu dilewati.");
  }

  // awpause & awresume
  if (lower === "awpause") {
    const queue = music.getQueue(message.guild.id, getDefaults(message.guild.id));
    if (!canControlInVoice(message.member, queue)) return message.reply("Masuk ke voice channel bot terlebih dahulu.");
    if (!queue.player.pause()) return message.reply("Tidak ada musik yang sedang diputar.");
    return message.reply("⏸️ Musik dijeda.");
  }
  if (lower === "awresume") {
    const queue = music.getQueue(message.guild.id, getDefaults(message.guild.id));
    if (!canControlInVoice(message.member, queue)) return message.reply("Masuk ke voice channel bot terlebih dahulu.");
    if (!queue.player.unpause()) return message.reply("Musik tidak sedang dijeda.");
    return message.reply("▶️ Musik dilanjutkan.");
  }

  // awnp (now playing)
  if (lower === "awnp" || lower === "awnowplaying") {
    const queue = music.getQueue(message.guild.id, getDefaults(message.guild.id));
    if (!queue.current) return message.reply("Tidak ada lagu yang sedang diputar.");
    return message.reply({
      embeds: [createMusicCard("Sedang Memutar", queue.current, queue, message.guild)],
      components: [controls()]
    });
  }

  // awqueue
  if (lower === "awqueue" || lower === "awq") {
    const queue = music.getQueue(message.guild.id, getDefaults(message.guild.id));
    const current = queue.current ? `Sedang diputar: **${queue.current.title}**` : "Tidak ada lagu yang sedang diputar.";
    const tracks = queue.tracks.slice(0, 15).map((track, index) => `${index + 1}. ${track.title} (${track.durationFormatted || "00:00"})`);
    const more = queue.tracks.length > tracks.length ? `\n...dan ${queue.tracks.length - tracks.length} lagu lainnya.` : "";
    return message.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x0099ff)
        .setTitle("Antrean Ada Wong")
        .setDescription([current, "", ...tracks, more].filter(Boolean).join("\n"))]
    });
  }

  // awhelp / awh
  if (lower === "awhelp" || lower === "awh") {
    return message.reply({ embeds: [createHelpEmbed()] });
  }
});

client.on(Events.InteractionCreate, (interaction) => {
  if (!interaction.inGuild()) return;
  const handler = interaction.isButton()
    ? handleButton(interaction)
    : interaction.isChatInputCommand()
      ? handleCommand(interaction)
      : Promise.resolve();
  void handler.catch(async (error) => {
    logger.error("Gagal memproses interaksi Discord:", error);
    try {
      await replyError(interaction, "Terjadi kesalahan saat memproses perintah.");
    } catch (replyFailure) {
      logger.error("Tidak dapat mengirim pesan error ke Discord:", replyFailure);
    }
  });
});

client.once(Events.ClientReady, async (readyClient) => {
  logger.info(`${readyClient.user.tag} (Ada Wong) berhasil online.`);

  // Cetak link invite resmi dengan izin otomatis
  const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${config.clientId}&scope=bot%20applications.commands&permissions=8`;
  logger.info(`🔗 Link invite bot dengan izin lengkap: ${inviteUrl}`);

  for (const [guildId, saved] of settings.entries()) {
    if (!saved.stayInVoice || !saved.voiceChannelId) continue;
    const guild = readyClient.guilds.cache.get(guildId);
    const channel = guild?.channels.cache.get(saved.voiceChannelId);
    if (!guild || !channel?.isVoiceBased()) {
      logger.warn(`[${guildId}] Voice channel 24/7 tidak tersedia; lewati pemulihan koneksi.`);
      continue;
    }
    try {
      await connectToVoice(guild, channel);
      logger.info(`[${guildId}] Koneksi voice 24/7 dipulihkan.`);
    } catch (error) {
      logger.error(`[${guildId}] Gagal memulihkan koneksi voice:`, error);
    }
  }
});

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "4kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));
function requireDashboardToken(request, response, next) {
  const supplied = request.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  const expected = config.dashboardToken;
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  if (!expected || suppliedBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    return response.status(401).json({ error: "Token dashboard tidak valid." });
  }
  return next();
}

app.get("/api/status", (_request, response) => {
  response.json({
    name: "Ada Wong",
    status: client.isReady() ? "online" : "starting",
    servers: client.guilds.cache.size,
    voiceConnections: [...music.queues.values()].filter((queue) => queue.connection).length,
    activePlayers: [...music.queues.values()].filter((queue) => queue.current).length,
    uptimeSeconds: Math.floor(process.uptime())
  });
});
app.get("/api/guilds", requireDashboardToken, (_request, response) => {
  response.json(client.guilds.cache.map((guild) => ({ id: guild.id, name: guild.name })));
});
app.get("/api/guilds/:guildId/settings", requireDashboardToken, (request, response) => {
  const guild = client.guilds.cache.get(request.params.guildId);
  if (!guild) return response.status(404).json({ error: "Server Discord tidak ditemukan." });
  const saved = getDefaults(guild.id);
  const queue = music.queues.get(guild.id);
  return response.json({
    autoplay: queue?.autoplay ?? saved.autoplay,
    loopMode: queue?.loopMode || saved.loopMode,
    volume: queue?.volume ?? saved.volume
  });
});
app.post("/api/guilds/:guildId/settings", requireDashboardToken, (request, response) => {
  const guild = client.guilds.cache.get(request.params.guildId);
  if (!guild) return response.status(404).json({ error: "Server Discord tidak ditemukan." });
  const { autoplay, loopMode, volume } = request.body || {};
  const patch = {};

  if (autoplay !== undefined) {
    if (typeof autoplay !== "boolean") return response.status(400).json({ error: "autoplay harus boolean." });
    patch.autoplay = autoplay;
  }
  if (loopMode !== undefined) {
    if (!["off", "track", "queue"].includes(loopMode)) {
      return response.status(400).json({ error: "loopMode harus off, track, atau queue." });
    }
    patch.loopMode = loopMode;
  }
  if (volume !== undefined) {
    if (!Number.isInteger(volume) || volume < 0 || volume > 100) {
      return response.status(400).json({ error: "volume harus berupa angka bulat dari 0 sampai 100." });
    }
    patch.volume = volume;
  }
  if (Object.keys(patch).length === 0) {
    return response.status(400).json({ error: "Tidak ada pengaturan valid untuk disimpan." });
  }

  settings.update(guild.id, patch);
  if (patch.autoplay !== undefined) music.setAutoplay(guild.id, patch.autoplay, getDefaults(guild.id));
  if (patch.loopMode !== undefined) music.setLoopMode(guild.id, patch.loopMode, getDefaults(guild.id));
  if (patch.volume !== undefined) music.setVolume(guild.id, patch.volume, getDefaults(guild.id));
  const saved = getDefaults(guild.id);
  return response.json({
    ok: true,
    settings: { autoplay: saved.autoplay, loopMode: saved.loopMode, volume: saved.volume }
  });
});
const dashboard = app.listen(config.port, config.dashboardHost, () => {
  logger.info(`Dashboard lokal tersedia di http://${config.dashboardHost}:${config.port}`);
});
dashboard.on("error", (error) => {
  logger.error("Dashboard gagal dijalankan:", error);
  process.exitCode = 1;
});

client.login(config.token).catch((error) => {
  logger.error("Gagal login ke Discord. Periksa DISCORD_TOKEN dan koneksi jaringan:", error);
  process.exitCode = 1;
});

process.on("SIGINT", () => {
  logger.info("Mematikan bot...");
  dashboard.close();
  for (const [guildId] of music.queues) music.stop(guildId);
  client.destroy();
  process.exit(0);
});

process.on("SIGTERM", () => {
  logger.info("Mematikan bot...");
  dashboard.close();
  for (const [guildId] of music.queues) music.stop(guildId);
  client.destroy();
  process.exit(0);
});
