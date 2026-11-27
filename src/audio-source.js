const { Ytdl } = require("@distube/ytdl-core");
const ytSearch = require("yt-search");
const { Readable } = require("node:stream");
const { validateAudioUrl } = require("./config");

const ytdl = new Ytdl();
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return "00:00";
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
 * Ekstraksi video ID dari berbagai format URL YouTube
 */
function extractYouTubeId(urlStr) {
  try {
    const url = new URL(urlStr);
    if (url.hostname === "youtu.be") {
      return url.pathname.slice(1).split("/")[0] || null;
    }
    if (url.hostname.includes("youtube.com")) {
      if (url.pathname.startsWith("/shorts/")) {
        return url.pathname.split("/")[2] || null;
      }
      return url.searchParams.get("v") || null;
    }
  } catch {
    const match = urlStr.match(/(?:youtu\.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/);
    return (match && match[1].length === 11) ? match[1] : null;
  }
  return null;
}

/**
 * Mengambil metadata lagu dari Deezer API (Sangat cepat, akurat, cover HD)
 */
async function searchDeezer(query) {
  try {
    const res = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=1`, {
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.data?.[0] || null;
  } catch {
    return null;
  }
}

/**
 * Resolves Spotify link (track/album/playlist) via oEmbed & API
 */
async function resolveSpotify(url, requester) {
  try {
    const oembedRes = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(6000)
    });
    if (oembedRes.ok) {
      const data = await oembedRes.json();
      const rawTitle = data.title || "Spotify Track";
      
      const deezerTrack = await searchDeezer(rawTitle);
      const sec = deezerTrack?.duration || 0;
      const title = deezerTrack ? `${deezerTrack.artist?.name} - ${deezerTrack.title}` : rawTitle;
      const thumbnail = data.thumbnail_url || deezerTrack?.album?.cover_big || null;

      return [{
        title,
        query: `${title} official audio`,
        artist: deezerTrack?.artist?.name || "",
        artistId: deezerTrack?.artist?.id || null,
        source: "spotify",
        url,
        duration: sec,
        durationFormatted: formatDuration(sec),
        thumbnail,
        requester
      }];
    }
  } catch (err) {
    console.warn("Spotify oEmbed gagal:", err.message);
  }

  return null;
}

/**
 * Resolves Deezer link (track/album)
 */
async function resolveDeezer(url, requester) {
  const match = url.match(/deezer\.com\/(?:\w{2}\/)?(track|album)\/(\d+)/i);
  if (!match) return null;
  const type = match[1].toLowerCase();
  const id = match[2];

  try {
    const res = await fetch(`https://api.deezer.com/${type}/${id}`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const data = await res.json();

    if (type === "track") {
      const title = `${data.artist?.name} - ${data.title}`;
      const sec = data.duration || 0;
      return [{
        title,
        query: `${title} official audio`,
        artist: data.artist?.name || "",
        artistId: data.artist?.id || null,
        source: "deezer",
        url: data.link || url,
        duration: sec,
        durationFormatted: formatDuration(sec),
        thumbnail: data.album?.cover_big || data.album?.cover || null,
        requester
      }];
    } else if (type === "album" && data.tracks?.data) {
      return data.tracks.data.slice(0, 50).map((t) => {
        const title = `${t.artist?.name || data.artist?.name} - ${t.title}`;
        const sec = t.duration || 0;
        return {
          title,
          query: `${title} official audio`,
          artist: t.artist?.name || data.artist?.name || "",
          artistId: t.artist?.id || data.artist?.id || null,
          source: "deezer",
          url: t.link,
          duration: sec,
          durationFormatted: formatDuration(sec),
          thumbnail: data.cover_big || data.cover || null,
          requester
        };
      });
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Mencari lirik lagu lengkap menggunakan lrclib.net (bebas kuota, akurat & instan)
 */
async function fetchLyrics(trackTitle, artistName = "") {
  try {
    let clean = trackTitle
      .replace(/[\(\[\{].*?[\)\]\}]/g, "")
      .replace(/ft\..*|feat\..*/i, "")
      .trim();

    if (artistName) {
      const url = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artistName)}&track_name=${encodeURIComponent(clean)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const json = await res.json();
        if (json.plainLyrics) return { lyrics: json.plainLyrics, title: json.trackName, artist: json.artistName };
      }
    }

    const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(clean)}`;
    const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(5000) });
    if (searchRes.ok) {
      const list = await searchRes.json();
      if (Array.isArray(list) && list.length > 0) {
        const item = list.find((i) => i.plainLyrics) || list[0];
        if (item?.plainLyrics) {
          return { lyrics: item.plainLyrics, title: item.trackName, artist: item.artistName };
        }
      }
    }
  } catch (err) {
    console.warn("fetchLyrics error:", err.message);
  }
  return null;
}

/**
 * Fitur pencarian lagu untuk memilih lagu yang benar (mengembalikan top 5-10 hasil)
 */
async function searchTracks(query, requester = null) {
  const searchResults = await ytSearch(query.trim());
  if (!searchResults || !searchResults.videos || searchResults.videos.length === 0) {
    return [];
  }
  return searchResults.videos.slice(0, 10).map((video) => {
    const sec = video.seconds || 0;
    return {
      title: video.title,
      source: "youtube",
      url: video.url,
      duration: sec,
      durationFormatted: video.timestamp || formatDuration(sec),
      thumbnail: video.thumbnail || video.image || null,
      requester
    };
  });
}

/**
 * Resolve query/URL into track objects
 */
async function resolveTracks(query, allowedHosts = [], requester = null) {
  const trimmed = query.trim();

  // 1. Cek YouTube URL (watch, youtu.be, shorts) - PRIORITAS TERTINGGI JIKA INPUT ADALAH URL
  const ytVideoId = extractYouTubeId(trimmed);
  if (ytVideoId) {
    try {
      const videoInfo = await ytSearch({ videoId: ytVideoId });
      if (videoInfo && videoInfo.title) {
        const sec = videoInfo.seconds || 0;
        return [{
          title: videoInfo.title,
          source: "youtube",
          url: `https://www.youtube.com/watch?v=${ytVideoId}`,
          duration: sec,
          durationFormatted: videoInfo.timestamp || formatDuration(sec),
          thumbnail: videoInfo.thumbnail || videoInfo.image || `https://i.ytimg.com/vi/${ytVideoId}/hqdefault.jpg`,
          requester
        }];
      }
    } catch (e) {
      console.warn("Resolving yt videoId error:", e.message);
    }
    return [{
      title: "YouTube Audio",
      source: "youtube",
      url: `https://www.youtube.com/watch?v=${ytVideoId}`,
      duration: 0,
      durationFormatted: "00:00",
      thumbnail: `https://i.ytimg.com/vi/${ytVideoId}/hqdefault.jpg`,
      requester
    }];
  }

  // 2. Cek Spotify link
  if (trimmed.includes("spotify.com") || trimmed.startsWith("spotify:")) {
    const spResult = await resolveSpotify(trimmed, requester);
    if (spResult && spResult.length > 0) return spResult;
  }

  // 3. Cek Deezer link
  if (trimmed.includes("deezer.com")) {
    const dzResult = await resolveDeezer(trimmed, requester);
    if (dzResult && dzResult.length > 0) return dzResult;
  }

  // 4. Cek SoundCloud URL
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
      }
    } catch (err) {
      console.warn("SoundCloud resolving error:", err.message);
    }
  }

  // 5. Direct audio URL
  if (/^https?:\/\//i.test(trimmed)) {
    let validUrl = trimmed;
    if (allowedHosts.length > 0) {
      try {
        validUrl = validateAudioUrl(trimmed, allowedHosts).toString();
      } catch {
        // abaikan
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

  // 6. Pencarian default berupa kata kunci/judul lagu:
  const deezerInfo = await searchDeezer(trimmed);
  if (deezerInfo) {
    const title = `${deezerInfo.artist?.name} - ${deezerInfo.title}`;
    const sec = deezerInfo.duration || 0;
    return [{
      title,
      query: `${title} official audio`,
      artist: deezerInfo.artist?.name || "",
      artistId: deezerInfo.artist?.id || null,
      source: "deezer_search",
      url: deezerInfo.link || `https://www.deezer.com/track/${deezerInfo.id}`,
      duration: sec,
      durationFormatted: formatDuration(sec),
      thumbnail: deezerInfo.album?.cover_big || deezerInfo.album?.cover || null,
      requester
    }];
  }

  // Fallback YouTube Search
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
 * Autoplay Cerdas Berdasarkan Genre & Artis Terkait
 */
async function getAutoplayRecommendation(lastTrack, playedUrls = new Set()) {
  if (!lastTrack || !lastTrack.title) return null;

  try {
    let artistId = lastTrack.artistId;
    if (!artistId) {
      const dz = await searchDeezer(lastTrack.title);
      artistId = dz?.artist?.id;
    }

    if (artistId) {
      const relRes = await fetch(`https://api.deezer.com/artist/${artistId}/related?limit=5`, {
        signal: AbortSignal.timeout(5000)
      });
      if (relRes.ok) {
        const relData = await relRes.json();
        const candidateArtists = [artistId, ...(relData.data?.map((a) => a.id) || [])];

        for (const aid of candidateArtists) {
          const topRes = await fetch(`https://api.deezer.com/artist/${aid}/top?limit=10`, {
            signal: AbortSignal.timeout(5000)
          });
          if (topRes.ok) {
            const topData = await topRes.json();
            for (const t of topData.data || []) {
              const fullTitle = `${t.artist?.name} - ${t.title}`;
              if (playedUrls.has(fullTitle) || playedUrls.has(t.link) || t.title.toLowerCase() === lastTrack.title.toLowerCase()) {
                continue;
              }
              const sec = t.duration || 0;
              return {
                title: fullTitle,
                query: `${fullTitle} official audio`,
                artist: t.artist?.name || "",
                artistId: t.artist?.id || null,
                source: "deezer_search",
                url: t.link,
                duration: sec,
                durationFormatted: formatDuration(sec),
                thumbnail: t.album?.cover_big || t.album?.cover || null,
                requester: "Autoplay 📻"
              };
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn("Autoplay via Deezer gagal:", err.message);
  }

  let cleanTitle = lastTrack.title
    .replace(/[\(\[\{].*?[\)\]\}]/g, "")
    .replace(/ft\..*|feat\..*/i, "")
    .trim();

  let artistPart = cleanTitle.includes("-") ? cleanTitle.split("-")[0].trim() : cleanTitle.split(" ").slice(0, 2).join(" ");
  const searchQueries = [
    `${artistPart} mix songs`,
    `${artistPart} lagu hits`
  ];

  for (const q of searchQueries) {
    try {
      const res = await ytSearch(q);
      if (res && res.videos && res.videos.length > 0) {
        for (const video of res.videos) {
          if (playedUrls.has(video.url) || video.url === lastTrack.url || video.seconds > 600) continue;
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
      // next
    }
  }

  return null;
}

/**
 * Membuka readable audio stream
 */
async function openAudioStream(track, allowedHosts = []) {
  if ((track.source === "spotify" || track.source === "deezer" || track.source === "deezer_search") && track.query) {
    const searchResults = await ytSearch(track.query);
    if (!searchResults || !searchResults.videos || searchResults.videos.length === 0) {
      throw new Error(`Tidak dapat menemukan stream audio untuk "${track.title}".`);
    }
    const ytVideo = searchResults.videos[0];
    if (!track.thumbnail) track.thumbnail = ytVideo.thumbnail || ytVideo.image;
    if (!track.duration || track.duration === 0) {
      track.duration = ytVideo.seconds || 0;
      track.durationFormatted = ytVideo.timestamp || formatDuration(ytVideo.seconds);
    }
    const stream = await ytdl.download(ytVideo.url, {
      filter: { hasAudio: true, hasVideo: false },
      quality: "highestaudio",
      highWaterMark: 1 << 25
    });
    return { stream, type: "arbitrary" };
  }

  if (track.source === "youtube") {
    const stream = await ytdl.download(track.url, {
      filter: { hasAudio: true, hasVideo: false },
      quality: "highestaudio",
      highWaterMark: 1 << 25
    });
    return { stream, type: "arbitrary" };
  }

  if (track.source === "soundcloud") {
    const play = require("play-dl");
    const streamInfo = await play.stream(track.url);
    return { stream: streamInfo.stream, type: streamInfo.type };
  }

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
        throw new Error("Sumber audio memiliki terlalu banyak redirect.");
      }
      url = new URL(location, url).toString();
      continue;
    }

    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Sumber audio HTTP ${response.status}.`);
    }

    return {
      stream: Readable.fromWeb(response.body),
      type: "arbitrary"
    };
  }

  throw new Error("Tidak dapat membuka stream audio.");
}

module.exports = {
  openAudioStream,
  resolveTracks,
  formatDuration,
  getAutoplayRecommendation,
  fetchLyrics,
  searchTracks
};
