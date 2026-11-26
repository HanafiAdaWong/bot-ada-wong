# Ada Wong — Discord Music Bot

Bot musik Discord berbasis Node.js dengan antrean terpisah per server, kontrol slash command dan tombol, dashboard status lokal, pengaturan volume, loop, autoplay, serta mode 24/7 yang mencoba menyambung kembali setelah proses restart.

## Batasan sumber audio

Bot ini hanya menerima **URL HTTPS stream audio langsung** dari hostname yang Anda masukkan sendiri ke `ALLOWED_AUDIO_HOSTS`. Sumber dan konten harus memang mengizinkan pemutaran ulang melalui Discord. URL halaman Spotify, YouTube, TikTok, atau SoundCloud bukan stream audio langsung; bot ini tidak mengambil audio dari halaman-halaman tersebut atau melewati proteksi platform. Spotify dapat menyediakan metadata lewat API resminya, tetapi integrasi metadata belum diaktifkan dalam versi ini.

## Persiapan

1. Instal Node.js 20.11 atau lebih baru.
2. Buat aplikasi dan bot di [Discord Developer Portal](https://discord.com/developers/applications), lalu salin token bot dan Application ID.
3. Undang bot memakai OAuth2 scope `bot` dan `applications.commands`, dengan izin minimum: View Channels, Send Messages, Embed Links, Read Message History, Connect, dan Speak.
4. Salin `.env.example` menjadi `.env`, lalu isi:

   ```env
   DISCORD_TOKEN=token_bot_anda
   CLIENT_ID=application_id_anda
   ALLOWED_AUDIO_HOSTS=radio.domain-anda.com,cdn.domain-anda.com
   ```

   Masukkan hostname persis dan hanya host yang Anda percaya/berwenang gunakan. Jangan bagikan token dan jangan masukkan `.env` ke repository.

## Menjalankan di Windows

Di terminal pada folder proyek:

```powershell
npm install
npm run deploy
npm start
```

Slash command global mungkin perlu beberapa menit untuk muncul. Untuk pengujian lebih cepat, isi `GUILD_ID` di `.env` dengan ID server uji sebelum menjalankan `npm run deploy`; hapus lagi untuk mendaftarkan command global.

Dashboard status tersedia di `http://127.0.0.1:3000`. Untuk memakai panel pengaturan server (volume, autoplay, dan loop), isi `DASHBOARD_TOKEN` dengan nilai acak yang panjang di `.env`, lalu masukkan token tersebut pada dashboard. Token diperlukan untuk API pengaturan; saat `DASHBOARD_HOST` bukan alamat loopback, aplikasi menolak start jika token belum disetel. Jangan paparkan dashboard ke internet tanpa HTTPS dan perlindungan tambahan.

## Perintah bot

- `/play url:<URL>` — tambah stream langsung ke antrean.
- `/pause`, `/resume`, `/skip`, `/stop`
- `/queue`, `/nowplaying`, `/volume level:<0-100>`
- `/autoplay aktif:<true|false>` — mengulang lagu terakhir ketika antrean habis.
- `/loop mode:<off|track|queue>` — loop mati, satu lagu, atau seluruh antrean.
- `/247 aktif:<true|false>` — menyimpan voice channel untuk dicoba sambungkan kembali saat bot restart.

Pengguna harus berada di voice channel yang sama untuk memakai kontrol pemutaran. Antrean dibatasi 100 lagu per server.

## Hosting 24/7 dengan Docker

Pastikan `.env` sudah diisi (termasuk `DASHBOARD_TOKEN`, karena container bind ke `0.0.0.0`), lalu jalankan:

```powershell
docker compose up -d --build
docker compose logs -f
```

Restart policy `unless-stopped` akan menjalankan ulang container setelah proses/host restart; volume menyimpan konfigurasi mode 24/7 per server. Ketersediaan tetap bergantung pada hosting, koneksi internet, izin Discord, dan ketersediaan sumber audio.

## Pengembangan dan pengujian

```powershell
npm test
```

Dashboard menggunakan token bearer sederhana, bukan login Discord OAuth2. Untuk penggunaan publik, tambahkan OAuth2 Discord, HTTPS, dan kontrol akses yang sesuai sebelum mengekspos dashboard ke jaringan publik.
