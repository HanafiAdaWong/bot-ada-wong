const {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  createAudioPlayer,
  createAudioResource
} = require("@discordjs/voice");
const { EventEmitter } = require("node:events");
const { spawn, execSync } = require("node:child_process");
const fs = require("node:fs");
const staticFfmpeg = require("ffmpeg-static");
const { openAudioStream, getAutoplayRecommendation } = require("./audio-source");

// Cari binary ffmpeg yang valid (baik dari ffmpeg-static maupun dari sistem OS hosting)
function getFfmpegBinary() {
  if (staticFfmpeg && fs.existsSync(staticFfmpeg)) {
    try {
      fs.accessSync(staticFfmpeg, fs.constants.X_OK);
      return staticFfmpeg;
    } catch {
      // coba buat executable jika di linux
      try {
        fs.chmodSync(staticFfmpeg, 0o755);
        return staticFfmpeg;
      } catch {
        // lanjut cek system ffmpeg
      }
    }
  }

  // Coba cek ffmpeg bawaan sistem hosting
  try {
    execSync("ffmpeg -version", { stdio: "ignore" });
    return "ffmpeg";
  } catch {
    // jika tetap tidak ada, kembalikan static path
    return staticFfmpeg || "ffmpeg";
  }
}

const ffmpegExecutable = getFfmpegBinary();

const MAX_QUEUE_SIZE = 100;

function createMusicManager({ allowedHosts, logger }) {
  const queues = new Map();
  const events = new EventEmitter();

  function getQueue(guildId, defaults = {}) {
    let queue = queues.get(guildId);
    if (queue) return queue;

    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play }
    });
    player.on("stateChange", (oldState, newState) => {
      logger.log(`[${guildId}] AudioPlayer state: ${oldState.status} -> ${newState.status}`);
    });
    queue = {
      guildId,
      player,
      connection: null,
      textChannel: null,
      tracks: [],
      current: null,
      lastTrack: null,
      currentResource: null,
      process: null,
      generation: 0,
      skipCurrent: false,
      autoplay: Boolean(defaults.autoplay),
      loopMode: defaults.loopMode || "off",
      volume: defaults.volume ?? 50,
      playedUrls: new Set()
    };
    queues.set(guildId, queue);

    player.on(AudioPlayerStatus.Idle, async () => {
      const previous = queue.current;
      stopProcess(queue);
      queue.current = null;
      queue.currentResource = null;

      const skipped = queue.skipCurrent;
      queue.skipCurrent = false;

      if (previous) {
        queue.lastTrack = previous;
        if (previous.url) queue.playedUrls.add(previous.url);

        // Jika bukan di-skip dan mode loop aktif
        if (!skipped && queue.loopMode === "track") {
          queue.tracks.unshift(previous);
        } else if (!skipped && queue.loopMode === "queue") {
          queue.tracks.push(previous);
        } else if (queue.autoplay && queue.tracks.length === 0) {
          // Autoplay: hanya cari lagu baru jika fitur autoplay aktif (diset user)
          try {
            const nextTrack = await getAutoplayRecommendation(previous, queue.playedUrls);
            if (nextTrack) {
              queue.tracks.push(nextTrack);
            }
          } catch (err) {
            logger.error(`[${guildId}] Autoplay failed:`, err);
          }
        }
      }

      void playNext(guildId, queue);
    });

    player.on("error", (error) => {
      logger.error(`[${guildId}] Audio player error:`, error);
      queue.skipCurrent = true;
      player.stop(true);
    });

    return queue;
  }

  function stopProcess(queue) {
    if (!queue.process) return;
    try {
      queue.process.stdin?.destroy();
      queue.process.stdout?.destroy();
      queue.process.kill();
    } catch {
      // ignore
    }
    queue.process = null;
  }

  async function playNext(guildId, queue) {
    if (queue.current || queue.tracks.length === 0) return;

    const track = queue.tracks.shift();
    queue.current = track;
    const generation = ++queue.generation;

    try {
      const audio = await openAudioStream(track, allowedHosts);
      if (generation !== queue.generation || queue.current !== track) {
        audio.stream?.destroy();
        return;
      }

      const ffmpegArgs = [
        "-hide_banner",
        "-loglevel", "error",
        "-i", "pipe:0",
        "-vn",
        "-f", "s16le",
        "-ar", "48000",
        "-ac", "2",
        "pipe:1"
      ];

      const process = spawn(ffmpegExecutable, ffmpegArgs, {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
      queue.process = process;

      let stderr = "";
      process.stderr.setEncoding("utf8");
      process.stderr.on("data", (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-4000);
      });
      process.stdin.on("error", (error) => {
        if (error.code !== "EPIPE") logger.error(`[${guildId}] FFmpeg input error:`, error);
      });
      process.on("error", (error) => {
        logger.error(`[${guildId}] FFmpeg process error:`, error);
        if (generation === queue.generation) {
          queue.skipCurrent = true;
          queue.player.stop(true);
        }
      });
      process.on("close", (code) => {
        if (code !== 0 && code !== null && generation === queue.generation && queue.current === track) {
          logger.error(`[${guildId}] FFmpeg exited with code ${code}: ${stderr.trim() || "no details"}`);
          queue.skipCurrent = true;
          queue.player.stop(true);
        }
      });
      audio.stream.on("error", (error) => {
        logger.error(`[${guildId}] Audio stream error:`, error);
        if (generation === queue.generation) {
          queue.skipCurrent = true;
          queue.player.stop(true);
        }
      });
      audio.stream.pipe(process.stdin);

      const resource = createAudioResource(process.stdout, {
        inputType: StreamType.Raw,
        inlineVolume: true
      });
      resource.volume.setVolume(queue.volume / 100);
      queue.currentResource = resource;
      queue.player.play(resource);

      events.emit("trackStart", { guildId, queue, track });
    } catch (error) {
      if (generation !== queue.generation) return;
      logger.error(`[${guildId}] Tidak dapat memutar "${track.title}":`, error);
      queue.current = null;
      queue.skipCurrent = false;
      // Jangan langsung memutar next secara instan jika error berturut-turut untuk mencegah spam
      setTimeout(() => {
        if (generation === queue.generation) {
          void playNext(guildId, queue);
        }
      }, 1000);
    }
  }

  function addTrack(guildId, track, defaults) {
    const queue = getQueue(guildId, defaults);
    if (queue.tracks.length >= MAX_QUEUE_SIZE) {
      throw new Error(`Antrean penuh (maksimal ${MAX_QUEUE_SIZE} lagu).`);
    }
    queue.tracks.push(track);
    void playNext(guildId, queue);
    return queue;
  }

  function addTracks(guildId, tracks, defaults) {
    const queue = getQueue(guildId, defaults);
    const available = MAX_QUEUE_SIZE - queue.tracks.length;
    if (available <= 0) {
      throw new Error(`Antrean penuh (maksimal ${MAX_QUEUE_SIZE} lagu).`);
    }
    const added = tracks.slice(0, available);
    queue.tracks.push(...added);
    void playNext(guildId, queue);
    return { queue, count: added.length };
  }

  function skip(guildId) {
    const queue = queues.get(guildId);
    if (!queue || !queue.current) return false;
    queue.skipCurrent = true;
    queue.generation += 1;
    stopProcess(queue);
    if (queue.player.state.status === AudioPlayerStatus.Idle) {
      queue.current = null;
      queue.currentResource = null;
      queue.skipCurrent = false;
      void playNext(guildId, queue);
      return true;
    }
    queue.player.stop(true);
    return true;
  }

  function stop(guildId) {
    const queue = queues.get(guildId);
    if (!queue) return null;
    queue.tracks = [];
    queue.lastTrack = null;
    queue.skipCurrent = true;
    queue.generation += 1;
    stopProcess(queue);
    queue.player.stop(true);
    queue.current = null;
    queue.currentResource = null;
    queue.connection?.destroy();
    queue.connection = null;
    return queue;
  }

  function setVolume(guildId, volume, defaults) {
    const queue = getQueue(guildId, defaults);
    queue.volume = volume;
    queue.currentResource?.volume?.setVolume(volume / 100);
    return queue;
  }

  function setAutoplay(guildId, enabled, defaults) {
    const queue = getQueue(guildId, defaults);
    queue.autoplay = enabled;
    return queue;
  }

  function setLoopMode(guildId, mode, defaults) {
    const queue = getQueue(guildId, defaults);
    queue.loopMode = mode;
    return queue;
  }

  return { addTrack, addTracks, getQueue, queues, setAutoplay, setLoopMode, setVolume, skip, stop, events };
}

module.exports = { createMusicManager, MAX_QUEUE_SIZE };
