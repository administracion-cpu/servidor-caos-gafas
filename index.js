// Servidor puente CAO-S <-> Gafas Mentra
// Foto por voz ("oye caos, foto") + botón + videollamada WebRTC directa
// (mismo modo "Stream Here" que usa la app oficial de Mentra).
// Nunca toca RTMP.

import * as MentraSDK from "@mentra/sdk";
import fetch from "node-fetch";

const ServerBase =
  MentraSDK.AppServer ||
  MentraSDK.TpaServer ||
  MentraSDK.default?.AppServer ||
  MentraSDK.default?.TpaServer;

if (!ServerBase) {
  console.error("[CAO-S] No encuentro servidor Mentra:", Object.keys(MentraSDK));
  process.exit(1);
}

const {
  MENTRA_API_KEY,
  MENTRA_PACKAGE_NAME,
  MENTRA_BRIDGE_SECRET,
  PORT = 3000,
} = process.env;

const CAOS_WEBHOOK_URL =
  process.env.CAOS_WEBHOOK_URL ||
  process.env.CAOS_BRIDGE_URL ||
  process.env.URL_DE_WEB_DE_CAOS;

if (!MENTRA_API_KEY || !MENTRA_PACKAGE_NAME || !MENTRA_BRIDGE_SECRET || !CAOS_WEBHOOK_URL) {
  console.error("[CAO-S] Faltan variables de entorno");
  process.exit(1);
}

console.log("[CAO-S] Arrancando. Webhook:", CAOS_WEBHOOK_URL);

process.on("uncaughtException", (err) => {
  const m = String(err?.message || err);
  if (m.includes("Unrecognized message type")) return;
  console.error("[CAO-S] uncaughtException:", err);
});
process.on("unhandledRejection", (r) => {
  const m = String(r?.message || r);
  if (m.includes("Unrecognized message type")) return;
  console.error("[CAO-S] unhandledRejection:", r);
});

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------
const WAKE_WINDOW_MS = 8_000;
const PHOTO_DEBOUNCE_MS = 5_000;
const WALL_CONTENT_TTL_MS = 30_000;
const FAIL_WALL_MS = 4_000;
const COMMAND_POLL_MS = 4_000;
const NOTICE_POLL_MS = 8_000;
const LIVESTREAM_WAIT_MS = 35_000; // damos más margen
const LIVESTREAM_RETRY_AFTER_MS = 12_000; // si en 12s no hay url, reintento una vez

// Mismos ajustes que la app oficial "Stream Here" (lo que conecta en 5s)
const STREAM_OPTIONS = {
  quality: "720p",
  video: { width: 720, height: 480, bitrate: 1_000_000, frameRate: 30 },
  audio: true,
};

// ---------------------------------------------------------------------------
// Estado por gafa
// ---------------------------------------------------------------------------
const lastSpokenId = new Map();
const lastWallAt = new Map();
const lastPhotoAt = new Map();
const photoInFlight = new Map();
const armed = new Map();
const liveSessions = new Map();
const commandPollers = new Map();
const noticePollers = new Map();
const liveStreamActive = new Map();

// ---------------------------------------------------------------------------
// Cartelitos
// ---------------------------------------------------------------------------
function showWallOnce(session, deviceId, text, opts) {
  if (!text) return;
  const now = Date.now();
  const last = lastWallAt.get(deviceId);
  if (last && last.text === text && now - last.at < WALL_CONTENT_TTL_MS) return;
  lastWallAt.set(deviceId, { text, at: now });
  try { session.layouts?.showTextWall?.(text, opts); } catch {}
}
function showFailWall(session, text) {
  try { session.layouts?.showTextWall?.(text, { durationMs: FAIL_WALL_MS }); } catch {}
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------
async function sendToCaos(payload) {
  try {
    const res = await fetch(CAOS_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-mentra-secret": MENTRA_BRIDGE_SECRET,
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (payload.event_type !== "fetch_command" && payload.event_type !== "fetch_notice") {
      console.log(`[CAO-S] ${res.ok ? "OK" : "FAIL"} ${payload.event_type} → ${JSON.stringify(data).slice(0,300)}`);
    }
    return { ok: res.ok, status: res.status, body: text, data };
  } catch (e) {
    console.error("[CAO-S] Error red:", e?.message || e);
    return { ok: false, status: 0, body: "", data: null };
  }
}

// ---------------------------------------------------------------------------
// Voz en gafas (igual)
// ---------------------------------------------------------------------------
async function speakOnGlasses(session, deviceId, speak) {
  if (!speak) return;
  const speakId = speak.id || null;
  if (speakId && lastSpokenId.get(deviceId) === speakId) return;

  try {
    if (speak.audio_base64) {
      const audioMime = speak.mime || "audio/mpeg";
      const dataUrl = `data:${audioMime};base64,${speak.audio_base64}`;
      if (typeof session.audio?.playAudio === "function") {
        await session.audio.playAudio({ audioUrl: dataUrl, audioBase64: speak.audio_base64, mime: audioMime });
      } else if (typeof session.audio?.play === "function") {
        await session.audio.play({ audioUrl: dataUrl });
      } else if (typeof session.layouts?.playAudio === "function") {
        await session.layouts.playAudio({ audioUrl: dataUrl });
      } else if (typeof session.speaker?.play === "function") {
        await session.speaker.play({ audioUrl: dataUrl });
      } else if (speak.text) {
        session.layouts?.showTextWall?.(speak.text, { durationMs: 4000 });
      }
      if (speakId) lastSpokenId.set(deviceId, speakId);
      return;
    }
    if (speak.text) {
      session.layouts?.showTextWall?.(speak.text, { durationMs: 4000 });
      if (speakId) lastSpokenId.set(deviceId, speakId);
    }
  } catch (e) {
    console.error("[CAO-S] Error voz:", e?.message || e);
  }
}

// ---------------------------------------------------------------------------
// Foto (igual — funciona)
// ---------------------------------------------------------------------------
async function handlePhoto(session, deviceId) {
  const now = Date.now();
  const last = lastPhotoAt.get(deviceId) || 0;
  if (photoInFlight.get(deviceId)) return;
  if (now - last < PHOTO_DEBOUNCE_MS) return;
  photoInFlight.set(deviceId, true);
  lastPhotoAt.set(deviceId, now);

  const cancel = (msg) => {
    console.log(`[CAO-S] FOTO ANULADA: ${msg}`);
    showFailWall(session, msg);
  };

  try {
    showWallOnce(session, deviceId, "Capturando...");
    let photo;
    try {
      if (typeof session?.camera?.requestPhoto === "function") photo = await session.camera.requestPhoto();
      else if (typeof session?.photos?.requestPhoto === "function") photo = await session.photos.requestPhoto();
      else if (typeof session?.camera?.takePhoto === "function") photo = await session.camera.takePhoto();
      else if (typeof session?.capturePhoto === "function") photo = await session.capturePhoto();
      else if (typeof session?.requestPhoto === "function") photo = await session.requestPhoto();
      else return cancel("Cámara no disponible. Repite la foto.");
    } catch (e) {
      console.error("[CAO-S] Cámara error:", e?.message || e);
      return cancel("No salió la foto. Repítela.");
    }
    const raw = photo?.base64 || photo?.imageBase64 || photo?.data || photo?.image || photo?.buffer || null;
    const mime = photo?.mimeType || photo?.mime || "image/jpeg";
    if (!raw) return cancel("Foto vacía. Repítela.");
    const base64 = typeof raw === "string" ? raw : Buffer.from(raw).toString("base64");

    const result = await sendToCaos({
      device_id: deviceId,
      event_type: "photo",
      photo_base64: base64,
      photo_mime: mime,
      battery_level: session.device?.batteryLevel ?? null,
      device_model: session.device?.model ?? "Mentra",
      captured_at: new Date().toISOString(),
    });

    if (!result.ok && result.status === 0) return cancel("Sin conexión. Repite la foto.");
    if (!result.ok) return cancel("Foto no guardada. Repítela.");
    if (result.body?.includes("glasses_orphan")) return cancel("Gafas sin dueño. Reclámalas en CAO-S.");
    if (result.body?.includes("no_target_work")) return cancel("Sin obra activa. Ficha y repite.");
    if (result.data?.error) return cancel("Foto no guardada. Repítela.");
    if (result.data?.duplicate) { console.log("[CAO-S] foto duplicada → silencio"); return; }

    showWallOnce(session, deviceId, "Foto enviada al diario ✓");
    if (result.data?.speak) await speakOnGlasses(session, deviceId, result.data.speak);
  } catch (e) {
    console.error("[CAO-S] Excepción foto:", e?.message || e);
    cancel("Error al capturar. Repítela.");
  } finally {
    photoInFlight.set(deviceId, false);
  }
}

// ---------------------------------------------------------------------------
// Wake word + comandos (igual)
// ---------------------------------------------------------------------------
function normalize(s) {
  return (s || "").toString().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,;:!?¿¡"'()\-_/\\]/g, " ")
    .replace(/\s+/g, " ").trim();
}
const WAKE = /\boye\s+(c|k)aos\b/;
const PHOTO_CMDS = [
  /\bfoto\b/, /\bfotografia\b/,
  /\bhaz(me)?\s+(una\s+)?foto\b/,
  /\bsaca(me)?\s+(una\s+)?foto\b/,
  /\btomar?\s+(una\s+)?foto\b/,
];
function matchCommand(t) {
  if (!t) return null;
  if (PHOTO_CMDS.some(rx => rx.test(t))) return "photo";
  return "unknown";
}
async function runCommand(session, deviceId, raw) {
  if (matchCommand(raw) === "photo") return handlePhoto(session, deviceId);
  showWallOnce(session, deviceId, "Ese comando aún no lo entiendo", { durationMs: 2000 });
}
function handleHeardText(session, deviceId, rawText) {
  const text = normalize(rawText);
  if (!text) return;
  const hasWake = WAKE.test(text);
  if (hasWake) {
    const tail = text.replace(WAKE, "").trim();
    if (tail) { runCommand(session, deviceId, tail); return; }
    if (armed.has(deviceId)) clearTimeout(armed.get(deviceId));
    armed.set(deviceId, setTimeout(() => armed.delete(deviceId), WAKE_WINDOW_MS));
    showWallOnce(session, deviceId, "Te escucho…", { durationMs: WAKE_WINDOW_MS });
    return;
  }
  if (!armed.has(deviceId)) return;
  clearTimeout(armed.get(deviceId));
  armed.delete(deviceId);
  runCommand(session, deviceId, text);
}

// ---------------------------------------------------------------------------
// Livestream — WebRTC directo estilo "Stream Here". Nunca RTMP.
// ---------------------------------------------------------------------------
function extractStreamUrl(obj) {
  if (!obj || typeof obj !== "object") return null;
  // Cubrimos todas las formas que mete Mentra: webrtc, whep, share, viewer…
  return (
    obj.webrtcUrl || obj.webrtc_url ||
    obj.whepUrl || obj.whep_url ||
    obj.viewerUrl || obj.viewer_url ||
    obj.shareUrl || obj.share_url ||
    obj.playbackUrl || obj.playback_url ||
    obj.hlsUrl || obj.hls_url ||
    obj.streamUrl || obj.stream_url ||
    obj.url || null
  );
}

// Probamos en orden los métodos que la app oficial "Stream Here" usa.
// startStream({ streamType:'webrtc', ...quality }) es el equivalente directo.
async function tryStartWebRTC(cam) {
  const attempts = [
    () => cam.startManagedStream?.(STREAM_OPTIONS),
    () => cam.startManagedStream?.(),
    () => cam.requestManagedStream?.(STREAM_OPTIONS),
    () => cam.requestManagedStream?.(),
    () => cam.startStream?.({ streamType: "webrtc", ...STREAM_OPTIONS }),
    () => cam.startStream?.({ streamType: "managed", ...STREAM_OPTIONS }),
    () => cam.startWebRTCStream?.(STREAM_OPTIONS),
    () => cam.startWebRTC?.(STREAM_OPTIONS),
  ];
  for (const run of attempts) {
    try {
      const fn = run();
      if (fn === undefined) continue; // método no existe en este SDK
      const res = (await fn) ?? {};
      // Si devuelve URL directa, perfecto: lo usamos al instante
      const urlNow = extractStreamUrl(res) || extractStreamUrl(res?.stream);
      return { res, urlNow };
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes("rtmpUrl is required")) {
        console.warn("[CAO-S] el SDK quiso RTMP — descartado, sigo con el siguiente método");
        continue;
      }
      console.warn("[CAO-S] intento de stream falló:", msg);
    }
  }
  return null;
}

async function attemptStartOnce(session, deviceId, cam, waitMs) {
  let urlFromEvent = null;
  let offEvent = null;
  const eventPromise = new Promise((resolve) => {
    try {
      if (typeof cam.onLivestreamStatus === "function") {
        offEvent = cam.onLivestreamStatus((st) => {
          try {
            const status = st?.status || st?.state;
            const u = extractStreamUrl(st) || extractStreamUrl(st?.stream);
            if ((status === "active" || status === "live" || status === "ready") && u) {
              urlFromEvent = u; resolve(u);
            }
            if (status === "error" || status === "failed") resolve(null);
          } catch {}
        });
      }
    } catch {}
    setTimeout(() => resolve(urlFromEvent), waitMs);
  });

  const started = await tryStartWebRTC(cam);
  if (!started) {
    try { offEvent?.(); } catch {}
    return { ok: false, reason: "no_webrtc_api" };
  }
  if (started.urlNow) {
    try { offEvent?.(); } catch {}
    return { ok: true, url: started.urlNow };
  }
  const url = await eventPromise;
  try { offEvent?.(); } catch {}
  if (url) return { ok: true, url };
  return { ok: false, reason: "no_url" };
}

async function startLivestream(session, deviceId, callSessionId) {
  const cam = session?.camera;
  if (!cam) { console.warn("[CAO-S] camera no disponible"); return false; }
  console.log(`[CAO-S] start_livestream (webrtc directo) device=${deviceId} call=${callSessionId || "-"}`);

  showWallOnce(session, deviceId, "Conectando vídeo…", { durationMs: LIVESTREAM_WAIT_MS });

  // 1er intento corto. Si las gafas tardan en arrancar cámara, reintento 1 vez.
  let result = await attemptStartOnce(session, deviceId, cam, LIVESTREAM_RETRY_AFTER_MS);
  if (!result.ok && result.reason === "no_url") {
    console.warn("[CAO-S] sin URL al primer intento, reintento limpio");
    try { await stopLivestreamSilent(session); } catch {}
    await new Promise((r) => setTimeout(r, 1500));
    result = await attemptStartOnce(session, deviceId, cam, LIVESTREAM_WAIT_MS - LIVESTREAM_RETRY_AFTER_MS);
  }

  if (!result.ok) {
    console.warn(`[CAO-S] livestream fallo: ${result.reason}`);
    try { await stopLivestreamSilent(session); } catch {}
    showFailWall(session, "Sin vídeo. Reintenta.");
    await sendToCaos({
      device_id: deviceId, event_type: "livestream_failed",
      reason: result.reason, call_session_id: callSessionId || null,
    });
    return false;
  }

  liveStreamActive.set(deviceId, true);
  showWallOnce(session, deviceId, "Vídeo en directo ✓", { durationMs: 3000 });

  await sendToCaos({
    device_id: deviceId, event_type: "livestream_started",
    stream_url: result.url, stream_kind: "webrtc",
    call_session_id: callSessionId || null,
  });
  return true;
}

async function stopLivestreamSilent(session) {
  try {
    if (session?.camera?.stopManagedStream) await session.camera.stopManagedStream();
    else if (session?.camera?.stopWebRTCStream) await session.camera.stopWebRTCStream();
    else if (session?.camera?.stopStream) await session.camera.stopStream();
    else if (session?.camera?.stopLivestream) await session.camera.stopLivestream();
    else if (session?.streaming?.stop) await session.streaming.stop();
  } catch (e) { console.warn("[CAO-S] stopLivestream:", e?.message || e); }
}

async function stopLivestream(session, deviceId) {
  await stopLivestreamSilent(session);
  liveStreamActive.set(deviceId, false);
  await sendToCaos({ device_id: deviceId, event_type: "livestream_stopped" });
}

// ---------------------------------------------------------------------------
// Sondeos (igual)
// ---------------------------------------------------------------------------
function startCommandPoller(session, deviceId) {
  stopCommandPoller(deviceId);
  const id = setInterval(async () => {
    const r = await sendToCaos({ device_id: deviceId, event_type: "fetch_command" });
    const cmd = r.data?.command;
    if (!cmd?.command) return;
    if (cmd.command === "start_livestream") {
      if (liveStreamActive.get(deviceId)) return;
      await startLivestream(session, deviceId, cmd.payload?.call_session_id);
    } else if (cmd.command === "stop_livestream") {
      if (liveStreamActive.get(deviceId)) await stopLivestream(session, deviceId);
    }
  }, COMMAND_POLL_MS);
  commandPollers.set(deviceId, id);
}
function stopCommandPoller(deviceId) {
  const id = commandPollers.get(deviceId);
  if (id) clearInterval(id);
  commandPollers.delete(deviceId);
}
function startNoticePoller(session, deviceId) {
  stopNoticePoller(deviceId);
  const id = setInterval(async () => {
    const r = await sendToCaos({ device_id: deviceId, event_type: "fetch_notice" });
    if (r.data?.speak) await speakOnGlasses(session, deviceId, r.data.speak);
  }, NOTICE_POLL_MS);
  noticePollers.set(deviceId, id);
}
function stopNoticePoller(deviceId) {
  const id = noticePollers.get(deviceId);
  if (id) clearInterval(id);
  noticePollers.delete(deviceId);
}

// ---------------------------------------------------------------------------
// Servidor (igual)
// ---------------------------------------------------------------------------
class CaosServer extends ServerBase {
  async onSession(session, sessionId, userId) {
    const deviceId = String(userId);
    const deviceModel = session.device?.model ?? "Mentra";
    console.log(`[CAO-S] Sesión abierta device_id=${deviceId}`);

    liveSessions.set(deviceId, session);
    lastSpokenId.delete(deviceId);
    lastWallAt.delete(deviceId);
    lastPhotoAt.delete(deviceId);
    photoInFlight.set(deviceId, false);
    liveStreamActive.set(deviceId, false);

    showWallOnce(session, deviceId, "CAO-S conectado. Di \"oye caos, foto\" o pulsa el botón.");

    await sendToCaos({
      device_id: deviceId, event_type: "heartbeat",
      device_model: deviceModel,
      battery_level: session.device?.batteryLevel ?? null,
    });

    startCommandPoller(session, deviceId);
    startNoticePoller(session, deviceId);

    session.events?.onDisconnected?.(async () => {
      console.log(`[CAO-S] Sesión cerrada device_id=${deviceId}`);
      stopCommandPoller(deviceId);
      stopNoticePoller(deviceId);
      if (liveStreamActive.get(deviceId)) {
        try { await stopLivestream(session, deviceId); } catch {}
      }
      liveSessions.delete(deviceId);
      liveStreamActive.delete(deviceId);
      lastSpokenId.delete(deviceId);
      lastWallAt.delete(deviceId);
      lastPhotoAt.delete(deviceId);
      photoInFlight.delete(deviceId);
      const t = armed.get(deviceId);
      if (t) clearTimeout(t);
      armed.delete(deviceId);
    });

    session.events?.onTranscription?.(async (data) => {
      try {
        if (!data?.isFinal) return;
        handleHeardText(session, deviceId, data.text || "");
      } catch (e) { console.error("[CAO-S] Voz:", e?.message || e); }
    });

    session.events?.onButtonPress?.(async () => {
      try { await handlePhoto(session, deviceId); }
      catch (e) { console.error("[CAO-S] Botón:", e?.message || e); }
    });
  }
}

const server = new CaosServer({
  packageName: MENTRA_PACKAGE_NAME,
  apiKey: MENTRA_API_KEY,
  port: Number(PORT),
});

server.start().then(() => {
  console.log(`[CAO-S] Servidor escuchando puerto ${PORT}`);
});
