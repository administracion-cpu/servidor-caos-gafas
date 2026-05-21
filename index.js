// Servidor puente CAO-S <-> Gafas Mentra
// - Filtro "oye caos" + comando foto por voz/botón
// - Latido MUDO (jamás reproduce audio aunque el servidor lo mande)
// - Canal separado para avisos de voz (mensajes nuevos de CAO-S)
// - Anti-repetición DOBLE: por id de voz + por hash de contenido (10 min)
// - Cartel en pantalla con anti-rebote (30 s) para no parpadear el mismo aviso
// - Anti-rebote: botón/voz no disparan dos fotos seguidas
import * as MentraSDK from "@mentra/sdk";
import fetch from "node-fetch";
import crypto from "node:crypto";

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
  CAOS_BRIDGE_URL,
  PORT = 3000,
} = process.env;

if (!MENTRA_API_KEY || !MENTRA_PACKAGE_NAME || !MENTRA_BRIDGE_SECRET || !CAOS_BRIDGE_URL) {
  console.error("[CAO-S] Faltan variables de entorno");
  process.exit(1);
}

console.log("[CAO-S] Arrancando. Puente apunta a:", CAOS_BRIDGE_URL);

process.on("uncaughtException", (err) => {
  const m = String(err?.message || err);
  if (m.includes("Unrecognized message type")) {
    console.warn("[CAO-S] Mensaje desconocido SDK (ignorado):", m);
    return;
  }
  console.error("[CAO-S] uncaughtException:", err);
});
process.on("unhandledRejection", (r) => {
  const m = String(r?.message || r);
  if (m.includes("Unrecognized message type")) return;
  console.error("[CAO-S] unhandledRejection:", r);
});

const HEARTBEAT_MS = 30_000;
const NOTICE_POLL_MS = 8_000;
const WAKE_WINDOW_MS = 8_000;
const PHOTO_DEBOUNCE_MS = 5_000;
const SPEAK_CONTENT_TTL_MS = 10 * 60_000; // mismo audio no se repite en 10 min
const WALL_CONTENT_TTL_MS = 30_000;       // mismo cartel no se repite en 30 s

// Memoria por gafa
const lastSpokenId = new Map();          // deviceId -> último speak.id reproducido
const lastSpokenHashAt = new Map();      // deviceId -> { hash, at }  (anti-rep por contenido)
const lastWallAt = new Map();            // deviceId -> { text, at }  (anti-rep cartel)
const lastPhotoAt = new Map();
const photoInFlight = new Map();
const sessionTimers = new Map();

function sha1Short(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 16);
}

function showWallOnce(session, deviceId, text, opts) {
  if (!text) return;
  const now = Date.now();
  const last = lastWallAt.get(deviceId);
  if (last && last.text === text && now - last.at < WALL_CONTENT_TTL_MS) {
    return; // mismo cartel hace menos de 30 s → no parpadear
  }
  lastWallAt.set(deviceId, { text, at: now });
  try { session.layouts?.showTextWall?.(text, opts); } catch {}
}

async function sendToCaos(payload) {
  try {
    const res = await fetch(CAOS_BRIDGE_URL, {
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
    console.log(
      `[CAO-S] ${res.ok ? "OK" : "FAIL"} ${payload.event_type} →`,
      JSON.stringify(data).slice(0, 300)
    );
    return { ok: res.ok, status: res.status, body: text, data };
  } catch (e) {
    console.error("[CAO-S] Error enviando a CAO-S:", e?.message || e);
    return { ok: false, status: 0, body: "", data: null };
  }
}

async function speakOnGlasses(session, deviceId, data, { allowHeartbeat = false } = {}) {
  const speak = data?.speak;
  if (!speak) return;
  // Seguridad extra: nunca hablar como respuesta a un heartbeat.
  if (!allowHeartbeat && data?.event === "heartbeat") {
    console.log("[CAO-S] heartbeat con voz → ignorado");
    return;
  }
  const audioB64 = speak.audio_base64;
  if (!audioB64) return;

  const speakId = speak.id || null;
  if (!speakId) {
    console.log("[CAO-S] voz sin id → ignorada");
    return;
  }

  // 1) Bloqueo por id repetido
  if (lastSpokenId.get(deviceId) === speakId) {
    console.log(`[CAO-S] voz ignorada (id repetido ${speakId})`);
    return;
  }

  // 2) Bloqueo por contenido: si el mismo audio se reprodujo hace < 10 min
  //    aunque venga con id distinto, no repetir.
  const hash = sha1Short(audioB64);
  const last = lastSpokenHashAt.get(deviceId);
  if (last && last.hash === hash && Date.now() - last.at < SPEAK_CONTENT_TTL_MS) {
    console.log(`[CAO-S] voz ignorada (mismo contenido hace ${Date.now() - last.at}ms)`);
    return;
  }

  const audioMime = speak.mime || "audio/mpeg";
  try {
    const dataUrl = `data:${audioMime};base64,${audioB64}`;
    if (typeof session.audio?.playAudio === "function") {
      await session.audio.playAudio({ audioUrl: dataUrl });
    } else if (typeof session.audio?.play === "function") {
      await session.audio.play({ audioUrl: dataUrl });
    } else if (typeof session.layouts?.playAudio === "function") {
      await session.layouts.playAudio({ audioUrl: dataUrl });
    } else if (typeof session.speaker?.play === "function") {
      await session.speaker.play({ audioUrl: dataUrl });
    } else {
      console.warn("[CAO-S] No encuentro API de audio en la sesión");
      return;
    }
    lastSpokenId.set(deviceId, speakId);
    lastSpokenHashAt.set(deviceId, { hash, at: Date.now() });
    console.log(`[CAO-S] 🔊 voz reproducida id=${speakId}`);
  } catch (e) {
    console.error("[CAO-S] Error reproduciendo voz:", e?.message || e);
  }
}

async function handlePhoto(session, deviceId) {
  const now = Date.now();
  const last = lastPhotoAt.get(deviceId) || 0;
  if (photoInFlight.get(deviceId)) {
    console.log("[CAO-S] foto en curso, ignoro disparo extra");
    return;
  }
  if (now - last < PHOTO_DEBOUNCE_MS) {
    console.log(`[CAO-S] foto debounced (${now - last}ms desde la última)`);
    return;
  }
  photoInFlight.set(deviceId, true);
  lastPhotoAt.set(deviceId, now);

  try {
    showWallOnce(session, deviceId, "Capturando...");

    let photo;
    if (typeof session?.camera?.requestPhoto === "function") {
      photo = await session.camera.requestPhoto();
    } else if (typeof session?.photos?.requestPhoto === "function") {
      photo = await session.photos.requestPhoto();
    } else if (typeof session?.camera?.takePhoto === "function") {
      photo = await session.camera.takePhoto();
    } else if (typeof session?.capturePhoto === "function") {
      photo = await session.capturePhoto();
    } else if (typeof session?.requestPhoto === "function") {
      photo = await session.requestPhoto();
    } else {
      console.error("[CAO-S] No hay API de foto en esta sesión");
      showWallOnce(session, deviceId, "Cámara no disponible");
      return;
    }

    const raw =
      photo?.base64 || photo?.data || photo?.image || photo?.buffer || null;
    const mime = photo?.mimeType || photo?.mime || "image/jpeg";

    if (!raw) {
      console.error("[CAO-S] La foto llegó pero sin datos:", photo);
      showWallOnce(session, deviceId, "Foto vacía");
      return;
    }

    const base64 =
      typeof raw === "string" ? raw : Buffer.from(raw).toString("base64");

    const result = await sendToCaos({
      device_id: deviceId,
      event_type: "photo",
      photo_base64: base64,
      photo_mime: mime,
      battery_level: session.device?.batteryLevel ?? null,
      device_model: session.device?.model ?? "Mentra",
      captured_at: new Date().toISOString(),
    });

    if (!result.ok) {
      showWallOnce(session, deviceId, `Error ${result.status || ""}`.trim());
      return;
    }

    if (result.body?.includes("glasses_orphan")) {
      showWallOnce(session, deviceId, "Gafas sin dueño. Reclámalas en CAO-S.");
    } else if (result.body?.includes("no_target_work")) {
      showWallOnce(session, deviceId, "Sin obra activa en CAO-S.");
    } else if (result.data?.duplicate) {
      // Reintento del mismo evento ya guardado: no machacar pantalla ni voz
      console.log("[CAO-S] foto duplicada según servidor → silencio");
    } else {
      showWallOnce(session, deviceId, "Foto enviada al diario ✓");
    }

    await speakOnGlasses(session, deviceId, result.data);
  } catch (e) {
    console.error("[CAO-S] Excepción foto:", e?.message || e);
    showWallOnce(session, deviceId, "Error al capturar");
  } finally {
    photoInFlight.set(deviceId, false);
  }
}

function normalize(s) {
  return (s || "")
    .toString()
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,;:!?¿¡"'()\-_/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const WAKE = /\boye\s+(c|k)aos\b/;
const PHOTO_CMDS = [
  /\bfoto\b/,
  /\bfotografia\b/,
  /\bhaz(me)?\s+(una\s+)?foto\b/,
  /\bsaca(me)?\s+(una\s+)?foto\b/,
  /\btomar?\s+(una\s+)?foto\b/,
];

function matchCommand(textNorm) {
  if (!textNorm) return null;
  if (PHOTO_CMDS.some((rx) => rx.test(textNorm))) return "photo";
  return "unknown";
}

const armed = new Map();

async function runCommand(session, deviceId, raw) {
  const cmd = matchCommand(raw);
  console.log(`[CAO-S] Comando: "${raw}" → ${cmd}`);
  if (cmd === "photo") return handlePhoto(session, deviceId);
  showWallOnce(session, deviceId, "Ese comando aún no lo entiendo", { durationMs: 2000 });
}

function handleHeardText(session, deviceId, rawText) {
  const text = normalize(rawText);
  if (!text) return;
  console.log(`[CAO-S] 🎙️  oído: "${text}"`);

  const hasWake = WAKE.test(text);

  if (hasWake) {
    const tail = text.replace(WAKE, "").trim();
    if (tail) { runCommand(session, deviceId, tail); return; }
    if (armed.has(deviceId)) clearTimeout(armed.get(deviceId));
    armed.set(deviceId, setTimeout(() => armed.delete(deviceId), WAKE_WINDOW_MS));
    showWallOnce(session, deviceId, "Te escucho…", { durationMs: WAKE_WINDOW_MS });
    console.log(`[CAO-S] Wake activo ${WAKE_WINDOW_MS / 1000}s (${deviceId})`);
    return;
  }

  if (!armed.has(deviceId)) {
    console.log(`[CAO-S] (ignorado, falta "oye caos"): "${text}"`);
    return;
  }
  clearTimeout(armed.get(deviceId));
  armed.delete(deviceId);
  runCommand(session, deviceId, text);
}

async function pollVoiceNotice(session, deviceId, deviceModel) {
  const r = await sendToCaos({
    device_id: deviceId,
    event_type: "fetch_notice",
    device_model: deviceModel,
    battery_level: session.device?.batteryLevel ?? null,
  });
  if (r.ok) await speakOnGlasses(session, deviceId, r.data);
}

class CaosServer extends ServerBase {
  async onSession(session, sessionId, userId) {
    const deviceId = String(userId);
    try {
      console.log("[CAO-S] events disponibles:", Object.keys(session.events || {}));
      console.log("[CAO-S] session keys:", Object.keys(session || {}));
    } catch (e) { console.log("[CAO-S] no pude listar events:", e?.message); }

    const deviceModel = session.device?.model ?? "Mentra";
    console.log(`[CAO-S] Sesión abierta device_id=${deviceId} model=${deviceModel}`);

    showWallOnce(session, deviceId, "CAO-S conectado. Di \"oye caos, foto\" o pulsa el botón.");

    lastSpokenId.delete(deviceId);
    lastSpokenHashAt.delete(deviceId);
    lastWallAt.delete(deviceId);
    lastPhotoAt.delete(deviceId);
    photoInFlight.set(deviceId, false);

    // Latido inicial: MUDO. No pasamos por speakOnGlasses.
    await sendToCaos({
      device_id: deviceId,
      event_type: "heartbeat",
      device_model: deviceModel,
      battery_level: session.device?.batteryLevel ?? null,
    });

    const hbTimer = setInterval(() => {
      sendToCaos({
        device_id: deviceId,
        event_type: "heartbeat",
        device_model: session.device?.model ?? deviceModel,
        battery_level: session.device?.batteryLevel ?? null,
      }).catch(() => {});
    }, HEARTBEAT_MS);

    const noticeTimer = setInterval(() => {
      pollVoiceNotice(session, deviceId, deviceModel).catch(() => {});
    }, NOTICE_POLL_MS);

    sessionTimers.set(deviceId, { hb: hbTimer, notice: noticeTimer });

    session.events.onDisconnected?.(() => {
      console.log(`[CAO-S] Sesión cerrada device_id=${deviceId}`);
      const t = sessionTimers.get(deviceId);
      if (t) { clearInterval(t.hb); clearInterval(t.notice); }
      sessionTimers.delete(deviceId);
      lastSpokenId.delete(deviceId);
      lastSpokenHashAt.delete(deviceId);
      lastWallAt.delete(deviceId);
      lastPhotoAt.delete(deviceId);
      photoInFlight.delete(deviceId);
    });

    session.events.onTranscription?.(async (data) => {
      try {
        if (!data?.isFinal) return;
        handleHeardText(session, deviceId, data.text || "");
      } catch (e) { console.error("[CAO-S] Voz:", e?.message || e); }
    });

    session.events.onButtonPress?.(async () => {
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
