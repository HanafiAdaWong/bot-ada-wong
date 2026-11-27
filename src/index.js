require("dotenv").config();

const express = require("express");
const path = require("node:path");
const { timingSafeEqual } = require("node:crypto");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
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
const { resolveTracks, fetchLyrics, searchTracks, formatDuration } = require("./audio-source");

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

// Cache untuk pencarian lagu /search (query -> list of tracks)
const searchCache = new Map();

function getDefaults(guildId) {
  return settings.get(guildId);
}

/**
 * Format waktu ke WIB (Waktu Indonesia Barat)
 */
function getIndonesianTime() {
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date());
}

/**
 * Kontrol Tombol: Pause dan Resume TERPISAH
 */
function createControlRows(queue) {
  const isPaused = queue?.player?.state?.status === "paused";

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ada_pause")
      .setLabel("Pause")
      .setEmoji("⏸️")
      .setStyle(isPaused ? ButtonStyle.Secondary : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("ada_resume")
      .setLabel("Resume")
      .setEmoji("▶️")
      .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ada_skip").setLabel("Skip").setEmoji("⏭️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ada_stop").setLabel("Stop").setEmoji("⏹️").setStyle(ButtonStyle.Danger)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ada_like").setLabel("Like").setEmoji("🤍").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("ada_autoplay_toggle")
      .setLabel("AutoPlay")
      .setEmoji("🔄")
      .setStyle(queue?.autoplay ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("ada_lyrics_btn")
      .setLabel("Lyrics")
      .setEmoji("📝")
      .setStyle(ButtonStyle.Secondary)
  );

  return [row1, row2];
}

/**
 * Membuat progress bar dinamis berjalan
 */
function createProgressBar(currentSec, totalSec) {
  const totalBars = 20;
  if (!totalSec || totalSec <= 0) {
    return "🟣" + "━".repeat(totalBars);
  }
  const progressRatio = Math.min(Math.max(currentSec / totalSec, 0), 1);
  const currentPos = Math.round(progressRatio * totalBars);

  let bar = "";
  for (let i = 0; i <= totalBars; i++) {
    if (i === currentPos) {
      bar += "🟣";
    } else {
      bar += "━";
    }
  }
  return bar;
}

/**
 * Membuat Embed UI Kartu Pemutar Modern FlaviBot
 */
function createMusicCard(statusTitle, track, queue, guild) {
  const queueCount = queue.tracks.length;
  const loopDisplay = queue.loopMode === "track" ? "Track" : queue.loopMode === "queue" ? "Queue" : "Off";
  const duration = track.durationFormatted || formatDuration(track.duration) || "00:00";
  const channelName = queue.voiceChannelName ? `🔊 ${queue.voiceChannelName}` : "🔊 Voice Channel";
  const requesterDisplay = track.requesterId ? `<@${track.requesterId}>` : (track.requester || "User");

  let elapsedSec = 0;
  if (queue.startedAt) {
    elapsedSec = Math.floor((Date.now() - queue.startedAt) / 1000);
    if (track.duration && elapsedSec > track.duration) {
      elapsedSec = track.duration;
    }
  }
  const elapsedFormatted = formatDuration(elapsedSec);
  const progressBar = createProgressBar(elapsedSec, track.duration);

  const descriptionLines = [
    `[${track.title}](${track.url?.startsWith("http") ? track.url : "https://youtube.com"})`,
    "",
    `• Added by ${requesterDisplay}`,
    `• \`${channelName}\``,
    "",
    `Queue Size: **${queueCount}** - Volume: **${queue.volume}%** - Loop: **${loopDisplay}**`,
    "",
    `${progressBar}`,
    `\`${elapsedFormatted}\`${" ".repeat(25)}\`${duration}\``
  ];

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setAuthor({
      name: statusTitle || "Now playing",
      iconURL: client.user.displayAvatarURL()
    })
    .setDescription(descriptionLines.join("\n"))
    .setFooter({
      text: `Ada Wong Music • Hari ini pukul ${getIndonesianTime()} WIB`
    });

  if (track.thumbnail) {
    embed.setThumbnail(track.thumbnail);
  }

  return embed;
}

/**
 * Embed Panduan / Help
 */
function createHelpEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setAuthor({
      name: "Panduan & Perintah Ada Wong Music Bot",
      iconURL: client.user.displayAvatarURL()
    })
    .setDescription("Bot musik Ada Wong dengan UI modern, pemutar akurat, progress bar waktu berjalan, lirik publik, dan pencarian lagu!")
    .addFields(
      {
        name: "⚡ Prefix Commands (Ketik langsung di chat):",
        value: [
          "• `awp <judul/link>` — Putar lagu langsung *(contoh: `awp NewJeans Super Shy`)*",
          "• `aws` / `awsearch <judul>` — Cari lagu dan pilih dari dropdown menu",
          "• `awremove <nomor>` / `awdel <nomor>` — Hapus lagu tertentu dari antrean",
          "• `awl` / `awlyrics [judul]` — Tampilkan lirik lagu (dengan tombol tutup)",
          "• `awpause` & `awresume` — Jeda atau lanjutkan lagu (khusus pengundang pertama)",
          "• `awskip` / `awn` — Lewati lagu (hanya peminta lagu)",
          "• `awstop` — Hentikan musik & keluar",
          "• `awnp` — Tampilkan kartu musik lagu saat ini",
          "• `awqueue` / `awq` — Tampilkan antrean lagu",
          "• `awhelp` / `awh` — Menampilkan bantuan ini"
        ].join("\n")
      },
      {
        name: "🎮 Slash Commands (Gunakan `/`):",
        value: [
          "• `/play <query>` — Putar lagu",
          "• `/search <query>` — Cari lagu dan pilih pilihan",
          "• `/remove <nomor>` — Hapus lagu tertentu dari antrean",
          "• `/lyrics [judul]` — Tampilkan lirik",
          "• `/pause` & `/resume` — Jeda / Lanjut",
          "• `/skip` & `/stop` — Lewati / Hentikan",
          "• `/nowplaying` & `/queue` — Status lagu & antrean",
          "• `/volume <0-100>` — Atur volume",
          "• `/autoplay <aktif:true/false>` — Autoplay rekomendasi genre",
          "• `/loop <off|track|queue>` — Mode pengulangan",
          "• `/help` — Bantuan"
        ].join("\n")
      }
    )
    .setFooter({
      text: `Ada Wong Music Bot • ${getIndonesianTime()} WIB`
    });
}

// Timer untuk mengupdate timeplay progress bar secara langsung
const progressIntervals = new Map();

function startProgressUpdater(guildId, queue, message) {
  if (progressIntervals.has(guildId)) {
    clearInterval(progressIntervals.get(guildId));
  }

  const interval = setInterval(async () => {
    if (!queue.current || !message || queue.player?.state?.status !== "playing") {
      return;
    }
    try {
      const updatedEmbed = createMusicCard("Now playing", queue.current, queue, message.guild);
      await message.edit({ embeds: [updatedEmbed], components: createControlRows(queue) });
    } catch {
      clearInterval(interval);
      progressIntervals.delete(guildId);
    }
  }, 8000);

  progressIntervals.set(guildId, interval);
}

function stopProgressUpdater(guildId) {
  if (progressIntervals.has(guildId)) {
    clearInterval(progressIntervals.get(guildId));
    progressIntervals.delete(guildId);
  }
}

// Event otomatis saat lagu mulai diputar
music.events.on("trackStart", async ({ guildId, queue, track }) => {
  stopProgressUpdater(guildId);
  queue.startedAt = Date.now();

  // Hapus kartu lagu sebelumnya agar chat bersih tidak menumpuk
  if (queue.lastCardMessage) {
    try {
      await queue.lastCardMessage.delete();
    } catch {
      // pesan mungkin sudah dihapus manual oleh user
    }
    queue.lastCardMessage = null;
  }

  if (!queue.textChannel) return;
  try {
    const embed = createMusicCard("Now playing", track, queue);
    const sentMsg = await queue.textChannel.send({ embeds: [embed], components: createControlRows(queue) });
    queue.cardMessage = sentMsg;
    queue.lastCardMessage = sentMsg;
    startProgressUpdater(guildId, queue, sentMsg);
  } catch (err) {
    logger.error(`[${guildId}] Gagal mengirim kartu musik:`, err);
  }
});

async function connectToVoice(guild, channel, inviterMember = null) {
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

    // Tangani disconnect otomatis (jika bot di-kick atau channel dihapus)
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5000)
        ]);
      } catch {
        // Benar-benar terputus / di-disconnect
        stopProgressUpdater(guild.id);
        music.stop(guild.id);
      }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      stopProgressUpdater(guild.id);
      const queue = music.queues.get(guild.id);
      if (queue) {
        queue.connection = null;
        queue.voiceChannelId = null;
        queue.voiceChannelName = null;
      }
    });
  }

  const queue = music.getQueue(guild.id, getDefaults(guild.id));
  queue.connection = connection;
  queue.voiceChannelId = channel.id;
  queue.voiceChannelName = channel.name;

  if (!queue.voiceStarterId && inviterMember) {
    queue.voiceStarterId = inviterMember.id;
    queue.voiceStarterName = inviterMember.displayName || inviterMember.user?.username;
  }

  connection.subscribe(queue.player);

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (err) {
    logger.error(`[${guild.id}] Voice connection timeout:`, err);
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

  if (interaction.customId === "ada_close_lyrics") {
    try {
      await interaction.message.delete();
    } catch {
      await interaction.reply({ content: "Lirik ditutup.", ephemeral: true });
    }
    return;
  }

  if (!canControlInVoice(interaction.member, queue)) {
    return replyError(interaction, "⚠️ Masuk ke voice channel bot untuk menggunakan tombol kontrol.");
  }

  const userId = interaction.user.id;
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

  switch (interaction.customId) {
    case "ada_pause": {
      if (queue.voiceStarterId && queue.voiceStarterId !== userId && !isAdmin) {
        return replyError(interaction, `⚠️ Hanya yang pertama mengundang bot (<@${queue.voiceStarterId}>) yang dapat menjeda lagu.`);
      }
      if (queue.player.state.status === "paused") {
        return replyError(interaction, "Musik sudah dalam keadaan dijeda.");
      }
      if (!queue.player.pause()) return replyError(interaction, "Tidak ada musik yang sedang diputar.");
      if (queue.cardMessage) {
        const embed = createMusicCard("Paused", queue.current, queue, interaction.guild);
        queue.cardMessage.edit({ embeds: [embed], components: createControlRows(queue) }).catch(() => {});
      }
      return interaction.reply({ content: "⏸️ Musik dijeda.", ephemeral: true });
    }

    case "ada_resume": {
      if (queue.voiceStarterId && queue.voiceStarterId !== userId && !isAdmin) {
        return replyError(interaction, `⚠️ Hanya yang pertama mengundang bot (<@${queue.voiceStarterId}>) yang dapat melanjutkan lagu.`);
      }
      if (queue.player.state.status !== "paused") {
        return replyError(interaction, "Musik tidak sedang dijeda.");
      }
      if (!queue.player.unpause()) return replyError(interaction, "Gagal melanjutkan musik.");
      if (queue.cardMessage) {
        const embed = createMusicCard("Now playing", queue.current, queue, interaction.guild);
        queue.cardMessage.edit({ embeds: [embed], components: createControlRows(queue) }).catch(() => {});
      }
      return interaction.reply({ content: "▶️ Musik dilanjutkan.", ephemeral: true });
    }

    case "ada_skip": {
      const currentTrack = queue.current;
      if (!currentTrack) return replyError(interaction, "Tidak ada lagu untuk dilewati.");
      if (currentTrack.requesterId && currentTrack.requesterId !== userId && !isAdmin) {
        return replyError(interaction, `⚠️ Hanya yang menambahkan lagu ini (<@${currentTrack.requesterId}>) yang dapat melewati lagunya.`);
      }
      stopProgressUpdater(guildId);
      if (!music.skip(guildId)) return replyError(interaction, "Gagal melewati lagu.");
      return interaction.reply({ content: "⏭️ Lagu dilewati.", ephemeral: true });
    }

    case "ada_stop": {
      if (queue.voiceStarterId && queue.voiceStarterId !== userId && !isAdmin) {
        return replyError(interaction, `⚠️ Hanya pengundang bot (<@${queue.voiceStarterId}>) yang dapat menghentikan bot.`);
      }
      stopProgressUpdater(guildId);
      music.stop(guildId);
      return interaction.reply({ content: "⏹️ Musik dihentikan.", ephemeral: true });
    }

    case "ada_like": {
      return interaction.reply({ content: `🤍 Kamu menyukai lagu **${queue.current?.title || "ini"}**!`, ephemeral: true });
    }

    case "ada_autoplay_toggle": {
      const nextState = !queue.autoplay;
      music.setAutoplay(guildId, nextState, getDefaults(guildId));
      settings.update(guildId, { autoplay: nextState });
      return interaction.reply({
        content: nextState ? "🔄 **AutoPlay aktif**: Lagu rekomendasi genre serupa akan diputar otomatis." : "🔄 **AutoPlay nonaktif**.",
        ephemeral: true
      });
    }

    case "ada_lyrics_btn": {
      if (!queue.current) return replyError(interaction, "Tidak ada lagu yang sedang diputar.");
      await interaction.deferReply({ ephemeral: false });
      const lirikData = await fetchLyrics(queue.current.title, queue.current.artist);
      if (!lirikData) {
        return interaction.editReply(`Maaf, lirik untuk **${queue.current.title}** tidak ditemukan.`);
      }
      const lirikSnippet = lirikData.lyrics.length > 3900 ? lirikData.lyrics.slice(0, 3900) + "\n\n...(lirik terpotong)" : lirikData.lyrics;
      const lyricsEmbed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`📝 Lirik: ${lirikData.title || queue.current.title}`)
        .setDescription(lirikSnippet)
        .setFooter({ text: `Lirik via LRCLIB • ${getIndonesianTime()} WIB` });

      const closeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("ada_close_lyrics").setLabel("Tutup Lirik").setEmoji("✖️").setStyle(ButtonStyle.Danger)
      );

      return interaction.editReply({ embeds: [lyricsEmbed], components: [closeRow] });
    }

    default:
      return;
  }
}

/**
 * Handle pilihan dari Select Menu fitur /search
 */
async function handleSelectMenu(interaction) {
  if (interaction.customId !== "ada_select_search") return;
  const searchId = interaction.values[0];
  const track = searchCache.get(searchId);

  if (!track) {
    return interaction.reply({ content: "Pilihan sudah kadaluarsa. Silakan cari kembali.", ephemeral: true });
  }

  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    return interaction.reply({ content: "⚠️ Masuk ke voice channel terlebih dahulu.", ephemeral: true });
  }

  await interaction.deferUpdate();
  await connectToVoice(interaction.guild, voiceChannel, interaction.member);

  track.requesterId = interaction.user.id;
  track.requester = interaction.member.displayName || interaction.user.username;

  const guildId = interaction.guildId;
  const queue = music.getQueue(guildId, getDefaults(guildId));
  const isFirst = !queue.current && queue.tracks.length === 0;
  music.addTrack(guildId, track, getDefaults(guildId));

  if (!isFirst) {
    const card = createMusicCard("Added to queue", track, queue, interaction.guild);
    const sentCard = await interaction.editReply({ content: null, embeds: [card], components: createControlRows(queue) });
    setTimeout(() => { sentCard.delete().catch(() => {}); }, 15000);
  } else {
    // Hapus menu pilihan search agar chat bersih
    await interaction.deleteReply().catch(() => {});
  }
}

/**
 * Eksekusi play umum
 */
async function executePlay(query, member, guild, channel, textChannel, sendReply) {
  const guildId = guild.id;
  const queue = music.getQueue(guildId, getDefaults(guildId));
  queue.textChannel = textChannel;

  const voiceChannel = member?.voice?.channel;
  if (!voiceChannel) {
    return sendReply("⚠️ Masuk ke voice channel terlebih dahulu.");
  }

  // Jika bot tercatat di room lain tapi sudah tidak ada koneksi aktif atau room kosong, otomatis pindah
  if (queue.connection && queue.connection.joinConfig.channelId !== voiceChannel.id) {
    const currentChannel = guild.channels.cache.get(queue.connection.joinConfig.channelId);
    if (!currentChannel || currentChannel.members.filter((m) => !m.user.bot).size === 0) {
      queue.connection.destroy();
      queue.connection = null;
    } else {
      return sendReply("Ada Wong sudah terhubung ke voice channel lain di server ini.");
    }
  }

  try {
    const requesterName = member.displayName || member.user?.username || "User";
    const requesterId = member.id;

    await connectToVoice(guild, voiceChannel, member);

    const tracks = await resolveTracks(query, config.allowedAudioHosts, requesterName);
    if (!tracks || tracks.length === 0) {
      return sendReply(`Tidak dapat menemukan lagu untuk "${query}".`);
    }

    for (const t of tracks) {
      t.requesterId = requesterId;
    }

    if (tracks.length === 1) {
      const track = tracks[0];
      const isFirst = !queue.current && queue.tracks.length === 0;
      music.addTrack(guildId, track, getDefaults(guildId));

      if (!isFirst) {
        const card = createMusicCard("Added to queue", track, queue, guild);
        const replyMsg = await sendReply({ embeds: [card], components: createControlRows(queue) });
        // Hapus notif 'Added to queue' setelah 15 detik agar chat bersih
        if (replyMsg?.delete) {
          setTimeout(() => replyMsg.delete().catch(() => {}), 15000);
        }
        return replyMsg;
      } else {
        const loadingMsg = await sendReply({ content: `🎵 Memuat dan memutar **${track.title}**...` });
        // Hapus pesan loading setelah 5 detik begitu kartu utama muncul
        if (loadingMsg?.delete) {
          setTimeout(() => loadingMsg.delete().catch(() => {}), 5000);
        }
        return loadingMsg;
      }
    } else {
      const { count } = music.addTracks(guildId, tracks, getDefaults(guildId));
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setAuthor({ name: "Playlist Added", iconURL: client.user.displayAvatarURL() })
        .setTitle(`Menambahkan ${count} lagu ke antrean`)
        .setDescription(`🎵 Diminta oleh: <@${requesterId}>\nAntrean saat ini: **${queue.tracks.length} lagu**`)
        .setFooter({ text: `Volume: ${queue.volume}% — Ada Wong • ${getIndonesianTime()} WIB` });

      const replyMsg = await sendReply({ embeds: [embed], components: createControlRows(queue) });
      if (replyMsg?.delete) {
        setTimeout(() => replyMsg.delete().catch(() => {}), 15000);
      }
      return replyMsg;
    }
  } catch (error) {
    logger.error(`[${guildId}] Play error:`, error);
    return sendReply(error.message || "Tidak dapat memutar lagu.");
  }
}

/**
 * Eksekusi Search cepat (tanpa lag)
 */
async function executeSearch(query, member, sendReply) {
  try {
    const results = await searchTracks(query, member.displayName || member.user?.username);
    if (!results || results.length === 0) {
      return sendReply(`Tidak ditemukan hasil pencarian untuk: "${query}".`);
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("ada_select_search")
      .setPlaceholder("Pilih lagu yang ingin diputar...");

    results.slice(0, 10).forEach((t, index) => {
      const uniqueId = `track_${Date.now()}_${index}`;
      searchCache.set(uniqueId, t);
      setTimeout(() => searchCache.delete(uniqueId), 300000);

      selectMenu.addOptions({
        label: `${index + 1}. ${t.title.slice(0, 95)}`,
        description: `Durasi: ${t.durationFormatted}`,
        value: uniqueId
      });
    });

    const row = new ActionRowBuilder().addComponents(selectMenu);
    const searchEmbed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`🔍 Hasil Pencarian: "${query}"`)
      .setDescription("Silakan pilih lagu dari menu dropdown di bawah ini:")
      .setFooter({ text: "Pilihan berlaku selama 5 menit" });

    return sendReply({ embeds: [searchEmbed], components: [row] });
  } catch (err) {
    logger.error("Search error:", err);
    return sendReply("Terjadi kesalahan saat mencari lagu.");
  }
}

async function handleCommand(interaction) {
  const guildId = interaction.guildId;
  const queue = music.getQueue(guildId, getDefaults(guildId));
  queue.textChannel = interaction.channel;
  const command = interaction.commandName;
  const userId = interaction.user.id;
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

  if (command === "play") {
    await interaction.deferReply();
    const query = interaction.options.getString("query");
    return executePlay(
      query,
      interaction.member,
      interaction.guild,
      interaction.channel,
      interaction.channel,
      (msg) => interaction.editReply(msg)
    );
  }

  if (command === "search") {
    await interaction.deferReply();
    const query = interaction.options.getString("query");
    return executeSearch(query, interaction.member, (msg) => interaction.editReply(msg));
  }

  if (command === "remove") {
    const pos = interaction.options.getInteger("nomor", true);
    const removed = music.removeTrack(guildId, pos - 1);
    if (!removed) {
      return interaction.reply({ content: `⚠️ Tidak ada lagu pada nomor urut **${pos}**. Cek nomor dengan \`/queue\`.`, ephemeral: true });
    }
    return interaction.reply({ content: `🗑️ Berhasil menghapus lagu ke-${pos}: **${removed.title}** dari antrean.` });
  }

  if (command === "lyrics") {
    await interaction.deferReply({ ephemeral: false });
    const targetTitle = interaction.options.getString("judul") || queue.current?.title;
    if (!targetTitle) {
      return interaction.editReply("Tidak ada lagu yang sedang diputar. Gunakan `/lyrics <judul lagu>` untuk mencari.");
    }
    const lirik = await fetchLyrics(targetTitle, queue.current?.artist || "");
    if (!lirik) {
      return interaction.editReply(`Lirik untuk **${targetTitle}** tidak ditemukan.`);
    }
    const snippet = lirik.lyrics.length > 3900 ? lirik.lyrics.slice(0, 3900) + "\n\n...(lirik terpotong)" : lirik.lyrics;
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`📝 Lirik: ${lirik.title || targetTitle}`)
      .setDescription(snippet)
      .setFooter({ text: `Lirik via LRCLIB • ${getIndonesianTime()} WIB` });

    const closeRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("ada_close_lyrics").setLabel("Tutup Lirik").setEmoji("✖️").setStyle(ButtonStyle.Danger)
    );

    return interaction.editReply({ embeds: [embed], components: [closeRow] });
  }

  if (command === "pause" || command === "resume" || command === "skip" ||
      command === "stop" || command === "volume" || command === "autoplay" ||
      command === "loop" || command === "247") {
    if (!canControlInVoice(interaction.member, queue) && command !== "247") {
      return replyError(interaction, "Masuk ke voice channel bot untuk menggunakan perintah musik.");
    }
  }

  switch (command) {
    case "pause": {
      if (queue.voiceStarterId && queue.voiceStarterId !== userId && !isAdmin) {
        return replyError(interaction, `⚠️ Hanya yang pertama mengundang bot (<@${queue.voiceStarterId}>) yang dapat menjeda.`);
      }
      if (!queue.player.pause()) return replyError(interaction, "Tidak ada musik yang sedang diputar.");
      return interaction.reply("⏸️ Musik dijeda.");
    }
    case "resume": {
      if (queue.voiceStarterId && queue.voiceStarterId !== userId && !isAdmin) {
        return replyError(interaction, `⚠️ Hanya yang pertama mengundang bot (<@${queue.voiceStarterId}>) yang dapat melanjutkan.`);
      }
      if (!queue.player.unpause()) return replyError(interaction, "Musik tidak sedang dijeda.");
      return interaction.reply("▶️ Musik dilanjutkan.");
    }
    case "skip": {
      const currentTrack = queue.current;
      if (!currentTrack) return replyError(interaction, "Tidak ada lagu untuk dilewati.");
      if (currentTrack.requesterId && currentTrack.requesterId !== userId && !isAdmin) {
        return replyError(interaction, `⚠️ Hanya yang menambahkan lagu ini (<@${currentTrack.requesterId}>) yang dapat melewati (skip) lagunya.`);
      }
      stopProgressUpdater(guildId);
      if (!music.skip(guildId)) return replyError(interaction, "Tidak ada lagu untuk dilewati.");
      return interaction.reply("⏭️ Lagu dilewati.");
    }
    case "stop": {
      if (queue.voiceStarterId && queue.voiceStarterId !== userId && !isAdmin) {
        return replyError(interaction, `⚠️ Hanya pengundang bot (<@${queue.voiceStarterId}>) yang dapat menghentikan bot.`);
      }
      stopProgressUpdater(guildId);
      music.stop(guildId);
      return interaction.reply("⏹️ Musik dihentikan.");
    }
    case "queue": {
      const current = queue.current ? `Sedang diputar: **${queue.current.title}**` : "Tidak ada lagu yang sedang diputar.";
      const tracks = queue.tracks.slice(0, 15).map((track, index) => `${index + 1}. ${track.title} (${track.durationFormatted || "00:00"})`);
      const more = queue.tracks.length > tracks.length ? `\n...dan ${queue.tracks.length - tracks.length} lagu lainnya.` : "";
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle("Antrean Ada Wong")
          .setDescription([current, "", ...tracks, more].filter(Boolean).join("\n"))],
        ephemeral: true
      });
    }
    case "nowplaying":
      if (!queue.current) return replyError(interaction, "Tidak ada lagu yang sedang diputar.");
      return interaction.reply({
        embeds: [createMusicCard("Now playing", queue.current, queue, interaction.guild)],
        components: createControlRows(queue)
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
        ? "📻 **Autoplay aktif**: Bot akan mencari lagu rekomendasi sesuai genre & artis."
        : "📻 Autoplay dimatikan.");
    }
    case "loop": {
      const mode = interaction.options.getString("mode", true);
      music.setLoopMode(guildId, mode, getDefaults(guildId));
      settings.update(guildId, { loopMode: mode });
      return interaction.reply(`Mode loop diatur ke **${mode}**.`);
    }
    case "247": {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return replyError(interaction, "Perintah 24/7 hanya dapat diatur oleh Admin.");
      }
      const enabled = interaction.options.getBoolean("aktif", true);
      const channel = interaction.member?.voice?.channel;
      if (enabled && !channel) return replyError(interaction, "Masuk ke voice channel yang ingin dijaga terlebih dahulu.");
      if (enabled) {
        await connectToVoice(interaction.guild, channel, interaction.member);
        settings.update(guildId, { stayInVoice: true, voiceChannelId: channel.id });
        return interaction.reply("Mode 24/7 aktif.");
      }
      settings.update(guildId, { stayInVoice: false, voiceChannelId: null });
      return interaction.reply("Mode 24/7 dimatikan.");
    }
    case "help": {
      return interaction.reply({ embeds: [createHelpEmbed()], ephemeral: false });
    }
    default:
      return;
  }
}

// Handler Prefix Command (awp, aws, awsearch, awremove, awl, dll.)
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;

  const content = message.content.trim();
  const lower = content.toLowerCase();
  const userId = message.author.id;
  const isAdmin = message.member?.permissions?.has(PermissionFlagsBits.ManageGuild);

  // awp / awplay
  if (lower.startsWith("awp ") || lower.startsWith("awplay ") || lower === "awp") {
    const query = content.replace(/^aw(play|p)\s*/i, "").trim();
    if (!query) {
      return message.reply("Gunakan: `awp <judul lagu atau link>` (contoh: `awp NewJeans Super Shy`)");
    }
    return executePlay(
      query,
      message.member,
      message.guild,
      message.channel,
      message.channel,
      (replyContent) => message.reply(replyContent)
    );
  }

  // awsearch / aws (Pencarian lagu)
  if (lower.startsWith("awsearch ") || lower.startsWith("aws ") || lower === "awsearch" || lower === "aws") {
    const query = content.replace(/^aw(search|s)\s*/i, "").trim();
    if (!query) {
      return message.reply("Gunakan: `aws <judul lagu>` (contoh: `aws Keshi beside you`)");
    }
    return executeSearch(query, message.member, (replyContent) => message.reply(replyContent));
  }

  // awremove / awdel / awr (Hapus lagu tertentu dari antrean)
  if (lower.startsWith("awremove ") || lower.startsWith("awdel ") || lower.startsWith("awr ")) {
    const numStr = content.replace(/^aw(remove|del|r)\s*/i, "").trim();
    const pos = parseInt(numStr, 10);
    if (isNaN(pos) || pos < 1) {
      return message.reply("Gunakan: `awremove <nomor urut>` (contoh: `awremove 2`). Cek nomor dengan `awqueue`.");
    }
    const removed = music.removeTrack(message.guild.id, pos - 1);
    if (!removed) {
      return message.reply(`⚠️ Tidak ada lagu pada nomor urut **${pos}**. Cek daftar antrean dengan \`awqueue\`.`);
    }
    return message.reply(`🗑️ Berhasil menghapus lagu ke-${pos}: **${removed.title}** dari antrean.`);
  }

  // awl / awlyrics (Lirik lagu publik dengan tombol tutup)
  if (lower.startsWith("awl") || lower.startsWith("awlyrics")) {
    const query = content.replace(/^aw(lyrics|l)\s*/i, "").trim();
    const queue = music.getQueue(message.guild.id, getDefaults(message.guild.id));
    const targetTitle = query || queue.current?.title;
    if (!targetTitle) {
      return message.reply("Gunakan: `awl <judul lagu>` atau putar lagu terlebih dahulu.");
    }

    const waitMsg = await message.reply("🔍 Mencari lirik lagu...");
    const lirik = await fetchLyrics(targetTitle, queue.current?.artist || "");
    if (!lirik) {
      return waitMsg.edit(`Lirik untuk **${targetTitle}** tidak ditemukan.`);
    }

    const snippet = lirik.lyrics.length > 3900 ? lirik.lyrics.slice(0, 3900) + "\n\n...(lirik terpotong)" : lirik.lyrics;
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`📝 Lirik: ${lirik.title || targetTitle}`)
      .setDescription(snippet)
      .setFooter({ text: `Lirik via LRCLIB • ${getIndonesianTime()} WIB` });

    const closeRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("ada_close_lyrics").setLabel("Tutup Lirik").setEmoji("✖️").setStyle(ButtonStyle.Danger)
    );

    return waitMsg.edit({ content: null, embeds: [embed], components: [closeRow] });
  }

  // awstop
  if (lower === "awstop") {
    const queue = music.getQueue(message.guild.id, getDefaults(message.guild.id));
    if (!canControlInVoice(message.member, queue)) {
      return message.reply("Masuk ke voice channel bot terlebih dahulu.");
    }
    if (queue.voiceStarterId && queue.voiceStarterId !== userId && !isAdmin) {
      return message.reply(`⚠️ Hanya pengundang bot (<@${queue.voiceStarterId}>) yang dapat menghentikan bot.`);
    }
    stopProgressUpdater(message.guild.id);
    music.stop(message.guild.id);
    return message.reply("⏹️ Musik dihentikan.");
  }

  // awskip
  if (lower === "awskip" || lower === "awn") {
    const queue = music.getQueue(message.guild.id, getDefaults(message.guild.id));
    if (!canControlInVoice(message.member, queue)) {
      return message.reply("Masuk ke voice channel bot terlebih dahulu.");
    }
    const currentTrack = queue.current;
    if (!currentTrack) return message.reply("Tidak ada lagu untuk dilewati.");
    if (currentTrack.requesterId && currentTrack.requesterId !== userId && !isAdmin) {
      return message.reply(`⚠️ Hanya yang menambahkan lagu ini (<@${currentTrack.requesterId}>) yang dapat melewati (skip) lagunya.`);
    }
    stopProgressUpdater(message.guild.id);
    if (!music.skip(message.guild.id)) return message.reply("Tidak ada lagu untuk dilewati.");
    return message.reply("⏭️ Lagu dilewati.");
  }

  // awpause
  if (lower === "awpause") {
    const queue = music.getQueue(message.guild.id, getDefaults(message.guild.id));
    if (!canControlInVoice(message.member, queue)) return message.reply("Masuk ke voice channel bot terlebih dahulu.");
    if (queue.voiceStarterId && queue.voiceStarterId !== userId && !isAdmin) {
      return message.reply(`⚠️ Hanya pengundang bot (<@${queue.voiceStarterId}>) yang dapat menjeda lagu.`);
    }
    if (!queue.player.pause()) return message.reply("Tidak ada musik yang sedang diputar.");
    return message.reply("⏸️ Musik dijeda.");
  }

  // awresume
  if (lower === "awresume") {
    const queue = music.getQueue(message.guild.id, getDefaults(message.guild.id));
    if (!canControlInVoice(message.member, queue)) return message.reply("Masuk ke voice channel bot terlebih dahulu.");
    if (queue.voiceStarterId && queue.voiceStarterId !== userId && !isAdmin) {
      return message.reply(`⚠️ Hanya pengundang bot (<@${queue.voiceStarterId}>) yang dapat melanjutkan lagu.`);
    }
    if (!queue.player.unpause()) return message.reply("Musik tidak sedang dijeda.");
    return message.reply("▶️ Musik dilanjutkan.");
  }

  // awnp (now playing)
  if (lower === "awnp" || lower === "awnowplaying") {
    const queue = music.getQueue(message.guild.id, getDefaults(message.guild.id));
    if (!queue.current) return message.reply("Tidak ada lagu yang sedang diputar.");
    return message.reply({
      embeds: [createMusicCard("Now playing", queue.current, queue, message.guild)],
      components: createControlRows(queue)
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
        .setColor(0x5865F2)
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
    : interaction.isStringSelectMenu()
      ? handleSelectMenu(interaction)
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

  const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${config.clientId}&scope=bot%20applications.commands&permissions=8`;
  logger.info(`🔗 Link invite bot dengan izin lengkap: ${inviteUrl}`);

  for (const [guildId, saved] of settings.entries()) {
    if (!saved.stayInVoice || !saved.voiceChannelId) continue;
    const guild = readyClient.guilds.cache.get(guildId);
    const channel = guild?.channels.cache.get(saved.voiceChannelId);
    if (!guild || !channel?.isVoiceBased()) continue;
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

const dashboard = app.listen(config.port, config.dashboardHost, () => {
  logger.info(`Dashboard lokal tersedia di http://${config.dashboardHost}:${config.port}`);
});
dashboard.on("error", (error) => {
  logger.warn("Peringatan: Dashboard HTTP tidak dapat dibuka di port ini:", error.message);
});

client.login(config.token).catch((error) => {
  logger.error("Gagal login ke Discord. Periksa DISCORD_TOKEN / BOT_TOKEN:", error);
  process.exitCode = 1;
});

process.on("SIGINT", () => {
  logger.info("Mematikan bot...");
  dashboard.close();
  for (const [guildId] of music.queues) {
    stopProgressUpdater(guildId);
    music.stop(guildId);
  }
  client.destroy();
  process.exit(0);
});

process.on("SIGTERM", () => {
  logger.info("Mematikan bot...");
  dashboard.close();
  for (const [guildId] of music.queues) {
    stopProgressUpdater(guildId);
    music.stop(guildId);
  }
  client.destroy();
  process.exit(0);
});
