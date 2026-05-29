// Servidor puente CAO-S <-> Gafas Mentra
// -----------------------------------------------------------------------------
// Ejecuta en Render como Web Service (Node). Usa el PUERTO que asigna Render
// automáticamente (variable de entorno PORT). NO abre puertos adicionales.
//
// Variables de entorno necesarias en Render:
//   MENTRA_PACKAGE_NAME   -> tu package name de Mentra
//   MENTRA_API_KEY        -> tu API key de Mentra
//   MENTRA_BRIDGE_SECRET  -> mismo secreto que ya tienes en Supabase
//   Y la URL del webhook, con CUALQUIERA de estos nombres (vale el primero
//   que esté puesto):
//     CAOS_WEBHOOK_URL
//     CAOS_BRIDGE_URL
//     URL_DE_WEB_DE_CAOS
//   PORT                  -> lo pone Render solo, no tocar
// -----------------------------------------------------------------------------

import * as MentraSDK from "@mentra/sdk";
import fetch from "node-fetch";

const ServerBase =
  MentraSDK.AppServer ||
  MentraSDK.TpaServer ||
  MentraSDK.default?.AppServer ||
  MentraSDK.default?.TpaServer;

if (!ServerBase) {
  throw new Error("[CAO-S] No se encontró AppServer/TpaServer en @mentra/sdk");
}

const {
  MENTRA_PACKAGE_NAME,
  MENTRA_API_KEY,
  MENTRA_BRIDGE_SECRET,
  PORT = "3000",
} = process.env;

// Acepta el nombre nuevo y los viejos. Coge el primero que tenga valor.
const CAOS_WEBHOOK_URL =
  process.env.CAOS_WEBHOOK_URL ||
  process.env.CAOS_BRIDGE_URL ||
  process.env.URL_DE_WEB_DE_CAOS;

if (!MENTRA_PACKAGE_NAME || !MENTRA_API_KEY) {
  throw new Error("[CAO-S] Faltan MENTRA_PACKAGE_NAME o MENTRA_API_KEY");
}
if (!CAOS_WEBHOOK_URL) {
  throw new Error(
    "[CAO-S] Falta la URL del webhook. Pon una de estas variables en Render: " +
    "CAOS_WEBHOOK_URL, CAOS_BRIDGE_URL o URL_DE_WEB_DE_CAOS"
  );
}
if (!MENTRA_BRIDGE_SECRET) {
  throw new Error("[CAO-S] Falta MENTRA_BRIDGE_SECRET");
}

// Estado en memoria por gafa --------------------------------------------------
const lastPhotoAt = new Map();
const failWallUntil = new Map();
const liveSessions = new Map();
const liveStreamActive = new Map();
const commandPollers = new Map();
const noticePollers = new Map();

const PHOTO_DEBOUNCE_MS = 5_000;
const FAIL_WALL_MS = 30_000;
const COMMAND_POLL_MS = 4_000;
const NOTICE_POLL_MS = 8_000;

// Helpers webhook -------------------------------------------------------------
async function postToCaos(payload) {
  try {
    const r = await fetch(CAOS_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-mentra-secret": MENTRA_BRIDGE_SECRET,
      },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    try { return { ok: r.ok, status: r.status, json: JSON.parse(text) }; }
    catch { return { ok: r.ok, status: r.status, text }; }
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message || e) };
  }
}

async function speakOnGlasses(session, speak) {
  if (!session || !speak) return;
  try {
    if (speak.audio_base64 && session.audio?.playAudio) {
      await session.audio.playAudio({
        audioBase64: speak.audio_base64,
        mime: speak.mime || "audio/mpeg",
      });
      return;
    }
    if (speak.text && session.layouts?.showTextWall) {
      await session.layouts.showTextWall(speak.text, { durationMs: 4000 });
    }
  } catch (e) {
    console.warn("[CAO-S] speak error:", e?.message || e);
  }
}

// Foto -----------------------------------------------------------------------
async function handlePhoto(session, deviceId) {
  const now = Date.now();
  const wallUntil = failWallUntil.get(deviceId) || 0;
  if (now < wallUntil) return;

  const lastAt = lastPhotoAt.get(deviceId) || 0;
  if (now - lastAt < PHOTO_DEBOUNCE_MS) return;
  lastPhotoAt.set(deviceId, now);

  let photo;
  try {
    photo = await session.camera.takePhoto();
  } catch (e) {
    console.warn("[CAO-S] takePhoto:", e?.message || e);
    failWallUntil.set(deviceId, now + FAIL_WALL_MS);
    await speakOnGlasses(session, { text: "No he podido tomar la foto" });
    return;
  }

  const photoBase64 = photo?.base64 || photo?.imageBase64 || photo?.data;
  if (!photoBase64) {
    failWallUntil.set(deviceId, now + FAIL_WALL_MS);
    return;
  }

  const res = await postToCaos({
    device_id: deviceId,
    photo_base64: photoBase64,
    photo_mime: photo?.mime || "image/jpeg",
    captured_at: new Date().toISOString(),
    event_type: "photo",
  });

  if (res.json?.speak) await speakOnGlasses(session, res.json.speak);
}

// Livestream Mentra ----------------------------------------------------------
async function startLivestream(session, deviceId, callSessionId) {
  if (!session?.camera?.startStream) {
    console.warn("[CAO-S] camera.startStream no disponible");
    return false;
  }
  try {
    const res = await session.camera.startStream({ streamType: "managed" });
    const streamUrl =
      res?.whepUrl || res?.webrtcUrl || res?.url || res?.streamUrl || null;
    if (!streamUrl) {
      console.warn("[CAO-S] startStream no devolvió URL");
      return false;
    }
    liveStreamActive.set(deviceId, true);
    await postToCaos({
      device_id: deviceId,
      event_type: "livestream_started",
      stream_url: streamUrl,
      stream_kind: "webrtc",
      call_session_id: callSessionId || null,
    });
    return true;
  } catch (e) {
    console.warn("[CAO-S] startLivestream:", e?.message || e);
    return false;
  }
}

async function stopLivestream(session, deviceId) {
  try {
    if (session?.camera?.stopStream) await session.camera.stopStream();
    else if (session?.camera?.stopManagedStream) await session.camera.stopManagedStream();
    else if (session?.streaming?.stop) await session.streaming.stop();
  } catch (e) {
    console.warn("[CAO-S] stopLivestream:", e?.message || e);
  }
  liveStreamActive.set(deviceId, false);
  await postToCaos({ device_id: deviceId, event_type: "livestream_stopped" });
}

// Sondeo de órdenes ----------------------------------------------------------
function startCommandPoller(session, deviceId) {
  stopCommandPoller(deviceId);
  const id = setInterval(async () => {
    const r = await postToCaos({ device_id: deviceId, event_type: "fetch_command" });
    const cmd = r.json?.command;
    if (!cmd) return;
    if (cmd.command === "start_livestream") {
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

// Sondeo de avisos de voz ----------------------------------------------------
function startNoticePoller(session, deviceId) {
  stopNoticePoller(deviceId);
  const id = setInterval(async () => {
    const r = await postToCaos({ device_id: deviceId, event_type: "fetch_notice" });
    if (r.json?.speak) await speakOnGlasses(session, r.json.speak);
  }, NOTICE_POLL_MS);
  noticePollers.set(deviceId, id);
}
function stopNoticePoller(deviceId) {
  const id = noticePollers.get(deviceId);
  if (id) clearInterval(id);
  noticePollers.delete(deviceId);
}

// Servidor Mentra ------------------------------------------------------------
class CaosServer extends ServerBase {
  async onSession(session, sessionId, userId) {
    const deviceId = userId || sessionId;
    liveSessions.set(deviceId, session);

    await speakOnGlasses(session, { text: "CAO-S listo" });

    if (session.events?.onTranscription) {
      session.events.onTranscription(async () => {
        try { await handlePhoto(session, deviceId); }
        catch (e) { console.error("[CAO-S] Voz:", e?.message || e); }
      });
    }

    if (session.events?.onButtonPress) {
      session.events.onButtonPress(async () => {
        try { await handlePhoto(session, deviceId); }
        catch (e) { console.error("[CAO-S] Botón:", e?.message || e); }
      });
    }

    startCommandPoller(session, deviceId);
    startNoticePoller(session, deviceId);

    await postToCaos({ device_id: deviceId, event_type: "heartbeat" });

    if (session.events?.onDisconnected) {
      session.events.onDisconnected(async () => {
        stopCommandPoller(deviceId);
        stopNoticePoller(deviceId);
        if (liveStreamActive.get(deviceId)) {
          try { await stopLivestream(session, deviceId); } catch {}
        }
        liveSessions.delete(deviceId);
        liveStreamActive.delete(deviceId);
        lastPhotoAt.delete(deviceId);
        failWallUntil.delete(deviceId);
      });
    }
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
