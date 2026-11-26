const { Ytdl } = require("@distube/ytdl-core");
const ytSearch = require("yt-search");
const { Readable } = require("node:stream");
const { validateAudioUrl } = require("./config");

const ytdl = new Ytdl();
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return "Live / Unknown";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hrs > 0) {
    return `${hrs.toString().padStart(2, "0")}:${remMins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${remMins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Resolve query/URL into track objects:
 * { title, url, source, duration, durationFormatted, thumbnail, requester }
 */
async function resolveTracks(query, allowedHosts = [], requester = null) {
  const trimmed = query.trim();

  // 1. Cek apakah ini Spotify URL
  if (trimmed.includes("spotify.com") || trimmed.startsWith("spotify:")) {
    try {
      const play = require("play-dl");
      const spType = play.sp_validate(trimmed);
      if (spType === "track") {
        const spData = await play.spotify(trimmed);
        const searchTitle = `${spData.name} ${spData.artists?.map((a) => a.name).join(" ") || ""}`;
        const sec = spData.durationInSec || 0;
        return [{
          title: `${spData.name} - ${spData.artists?.map((a) => a.name).join(", ") || "Unknown"}`,
          query: searchTitle.trim(),
          source: "spotify",
          url: spData.url || trimmed,
          duration: sec,
          durationFormatted: formatDuration(sec),
          thumbnail: spData.thumbnail?.url || null,
          requester
        }];
      } else if (spType === "playlist" || spType === "album") {
        const spData = await play.spotify(trimmed);
        const tracks = await spData.all_tracks();
        return tracks.slice(0, 50).map((t) => {
          const sec = t.durationInSec || 0;
          return {
            title: `${t.name} - ${t.artists?.map((a) => a.name).join(", ") || "Unknown"}`,
            query: `${t.name} ${t.artists?.map((a) => a.name).join(" ") || ""}`.trim(),
            source: "spotify",
            url: t.url || trimmed,
            duration: sec,
            durationFormatted: formatDuration(sec),
            thumbnail: t.thumbnail?.url || spData.thumbnail?.url || null,
            requester
          };
        });
      }
    } catch (err) {
      console.warn("Spotify resolving error, fallback to search:", err.message);
    }
  }

  // 2. Cek apakah ini SoundCloud URL
  if (trimmed.includes("soundcloud.com")) {
    try {
      const play = require("play-dl");
      const scType = await play.so_validate(trimmed);
      if (scType === "track") {
        const scInfo = await play.soundcloud(trimmed);
        const sec = scInfo.durationInSec || 0;
        return [{
          title: scInfo.name || "SoundCloud Track",
          source: "soundcloud",
          url: scInfo.url,
          duration: sec,
          durationFormatted: formatDuration(sec),
          thumbnail: scInfo.thumbnail || null,
          requester
        }];
      } else if (scType === "playlist") {
        const scPlaylist = await play.soundcloud(trimmed);
        const tracks = await scPlaylist.all_tracks();
        return tracks.slice(0, 50).map((t) => {
          const sec = t.durationInSec || 0;
          return {
            title: t.name || "SoundCloud Track",
            source: "soundcloud",
            url: t.url,
            duration: sec,
            durationFormatted: formatDuration(sec),
            thumbnail: t.thumbnail || null,
            requester
          };
        });
      }
    } catch (err) {
      console.warn("SoundCloud resolving error:", err.message);
    }
  }

  // 3. Cek apakah ini YouTube URL (watch, youtu.be, shorts)
  if (/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/i.test(trimmed)) {
    try {
      const res = await ytSearch(trimmed);
      if (res && res.videos && res.videos.length > 0) {
        const video = res.videos[0];
        const sec = video.seconds || 0;
        return [{
          title: video.title || "YouTube Audio",
          source: "youtube",
          url: video.url,
          duration: sec,
          durationFormatted: video.timestamp || formatDuration(sec),
          thumbnail: video.thumbnail || video.image || null,
          requester
        }];
      }
    } catch {
      // lanjut fallback
    }
    return [{
      title: "YouTube Video",
      source: "youtube",
      url: trimmed,
      duration: 0,
      durationFormatted: "00:00",
      thumbnail: null,
      requester
    }];
  }

  // 4. Cek apakah ini direct HTTP/HTTPS URL
  if (/^https?:\/\//i.test(trimmed)) {
    let validUrl = trimmed;
    if (allowedHosts.length > 0) {
      try {
        validUrl = validateAudioUrl(trimmed, allowedHosts).toString();
      } catch {
        // jika gagal, lanjut ke pencarian youtube
      }
    }
    if (validUrl === trimmed) {
      const parsed = new URL(trimmed);
      const filename = parsed.pathname.split("/").filter(Boolean).pop() || parsed.hostname;
      return [{
        title: decodeURIComponent(filename).slice(0, 200),
        source: "direct",
        url: trimmed,
        duration: 0,
        durationFormatted: "Live Stream",
        thumbnail: null,
        requester
      }];
    }
  }

  // 5. Query judul lagu / keyword umum -> Gunakan yt-search
  const searchResults = await ytSearch(trimmed);
  if (searchResults && searchResults.videos && searchResults.videos.length > 0) {
    const video = searchResults.videos[0];
    const sec = video.seconds || 0;
    return [{
      title: video.title || trimmed,
      source: "youtube",
      url: video.url,
      duration: sec,
      durationFormatted: video.timestamp || formatDuration(sec),
      thumbnail: video.thumbnail || video.image || null,
      requester
    }];
  }

  throw new Error(`Tidak dapat menemukan lagu untuk: "${query}".`);
}

/**
 * Mencari lagu rekomendasi berikutnya (Autoplay cerdas) berdasarkan artis / genre lagu sebelumnya
 */
async function getAutoplayRecommendation(lastTrack, playedUrls = new Set()) {
  if (!lastTrack || !lastTrack.title) return null;

  // Ekstrak nama artis atau judul bersih
  // Contoh: "Juicy Luicy - Lantas (Official Video)" -> artis: "Juicy Luicy", judul: "Lantas"
  let cleanTitle = lastTrack.title
    .replace(/[\(\[\{].*?[\)\]\}]/g, "") // hapus (Official Video), [MV], dll.
    .replace(/ft\..*|feat\..*/i, "")
    .trim();

  let artistPart = "";
  if (cleanTitle.includes("-")) {
    const parts = cleanTitle.split("-");
    artistPart = parts[0].trim();
  } else {
    artistPart = cleanTitle.split(" ").slice(0, 2).join(" ");
  }

  // Kueri pencarian rekomendasi musik yang mirip / genre / artis terkait
  const searchQueries = [
    `${artistPart} lagu terbaik`,
    `${cleanTitle} mix music`,
    `${artistPart} songs`
  ];

  for (const q of searchQueries) {
    try {
      const res = await ytSearch(q);
      if (res && res.videos && res.videos.length > 0) {
        for (const video of res.videos) {
          // Lewati jika video ini sudah pernah diputar atau sama persis dengan lagu terakhir
          if (playedUrls.has(video.url) || video.url === lastTrack.url) continue;

          // Hindari kompilasi 1 jam jika ingin single track
          if (video.seconds > 720) continue;

          const sec = video.seconds || 0;
          return {
            title: video.title,
            source: "youtube",
            url: video.url,
            duration: sec,
            durationFormatted: video.timestamp || formatDuration(sec),
            thumbnail: video.thumbnail || video.image || null,
            requester: "Autoplay 📻"
          };
        }
      }
    } catch {
      // coba kueri berikutnya
    }
  }

  return null;
}

/**
 * Membuka readable audio stream
 */
async function openAudioStream(track, allowedHosts = []) {
  // Jika lagu berasal dari Spotify
  if (track.source === "spotify" && track.query) {
    const searchResults = await ytSearch(track.query);
    if (!searchResults || !searchResults.videos || searchResults.videos.length === 0) {
      throw new Error(`Tidak dapat menemukan track audio untuk "${track.title}".`);
    }
    const ytVideo = searchResults.videos[0];
    if (!track.thumbnail) track.thumbnail = ytVideo.thumbnail || ytVideo.image;
    if (!track.duration) {
      track.duration = ytVideo.seconds || 0;
      track.durationFormatted = ytVideo.timestamp || formatDuration(ytVideo.seconds);
    }
    const stream = await ytdl.download(ytVideo.url, {
      filter: { hasAudio: true, hasVideo: false },
      quality: "highestaudio"
    });
    return { stream, type: "arbitrary" };
  }

  // Jika lagu dari YouTube
  if (track.source === "youtube") {
    const stream = await ytdl.download(track.url, {
      filter: { hasAudio: true, hasVideo: false },
      quality: "highestaudio"
    });
    return { stream, type: "arbitrary" };
  }

  // Jika lagu dari SoundCloud
  if (track.source === "soundcloud") {
    const play = require("play-dl");
    const streamInfo = await play.stream(track.url);
    return { stream: streamInfo.stream, type: streamInfo.type };
  }

  // Jika direct URL
  let url = track.url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Audio source request timed out.")), 15_000);
    let response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        headers: { Accept: "audio/*, application/octet-stream;q=0.9" },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects === MAX_REDIRECTS) {
        throw new Error("Sumber audio memiliki terlalu banyak atau tidak valid redirect.");
      }
      url = new URL(location, url).toString();
      continue;
    }

    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Sumber audio mengembalikan HTTP ${response.status}.`);
    }

    return {
      stream: Readable.fromWeb(response.body),
      type: "arbitrary"
    };
  }

  throw new Error("Tidak dapat membuka stream audio.");
}

module.exports = { openAudioStream, resolveTracks, formatDuration, getAutoplayRecommendation };
