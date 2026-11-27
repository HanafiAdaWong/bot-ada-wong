const { SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Putar musik dari YouTube, Spotify, Deezer, atau judul lagu")
    .addStringOption((option) => option
      .setName("query")
      .setDescription("Judul lagu, link YouTube, Spotify, atau Deezer")
      .setRequired(true)
      .setMaxLength(2000)),
  new SlashCommandBuilder()
    .setName("search")
    .setDescription("Cari lagu dan pilih dari daftar hasil pencarian")
    .addStringOption((option) => option
      .setName("query")
      .setDescription("Judul lagu atau kata kunci")
      .setRequired(true)
      .setMaxLength(500)),
  new SlashCommandBuilder().setName("pause").setDescription("Jeda musik"),
  new SlashCommandBuilder().setName("resume").setDescription("Lanjutkan musik"),
  new SlashCommandBuilder().setName("skip").setDescription("Lewati lagu yang sedang diputar"),
  new SlashCommandBuilder().setName("stop").setDescription("Hentikan musik dan keluar dari voice channel"),
  new SlashCommandBuilder().setName("queue").setDescription("Tampilkan lagu yang sedang diputar dan antrean"),
  new SlashCommandBuilder().setName("nowplaying").setDescription("Tampilkan kartu pemutar saat ini"),
  new SlashCommandBuilder()
    .setName("lyrics")
    .setDescription("Tampilkan lirik lagu")
    .addStringOption((option) => option
      .setName("judul")
      .setDescription("Judul lagu yang ingin dicari liriknya (opsional)")
      .setRequired(false)),
  new SlashCommandBuilder()
    .setName("volume")
    .setDescription("Atur volume bot")
    .addIntegerOption((option) => option
      .setName("level")
      .setDescription("Volume 0 sampai 100")
      .setMinValue(0)
      .setMaxValue(100)
      .setRequired(true)),
  new SlashCommandBuilder()
    .setName("autoplay")
    .setDescription("Putar lagu rekomendasi sesuai genre & artis saat antrean habis")
    .addBooleanOption((option) => option
      .setName("aktif")
      .setDescription("Aktifkan autoplay")
      .setRequired(true)),
  new SlashCommandBuilder()
    .setName("loop")
    .setDescription("Atur mode pengulangan")
    .addStringOption((option) => option
      .setName("mode")
      .setDescription("Mode pengulangan")
      .setRequired(true)
      .addChoices(
        { name: "Mati", value: "off" },
        { name: "Lagu ini", value: "track" },
        { name: "Seluruh antrean", value: "queue" }
      )),
  new SlashCommandBuilder()
    .setName("247")
    .setDescription("Atur bot agar tetap di voice channel")
    .addBooleanOption((option) => option
      .setName("aktif")
      .setDescription("Aktifkan mode 24/7")
      .setRequired(true)),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Menampilkan daftar perintah dan panduan bot Ada Wong")
];

module.exports = { commands };
