// Servidor puente CAO-S <-> Gafas Mentra
// - Sin latidos, sin sondeos.
// - Solo un saludo al conectar.
// - Voz/Botón: una foto. Si falla → cartel y se anula. No reintenta.
// - Anti-rebote foto 5 s. Anti-parpadeo cartel 30 s.
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
  if (m.includes("Unrecognized message type")) return;
  console.error("[CAO-S] uncaughtException:", err);
});
process.on("unhandledRejection", (r) => {
  const m = String(r?.message || r);
  if (m.includes("Unrecognized message type")) return;
  console.error("[CAO-S] unhandledRejection:", r);
});

const WAKE_WINDOW_MS = 8_000;
const PHOTO_DEBOUNCE_MS = 5_000;
const WALL_CONTENT_TTL_MS = 30_000;
const FAIL_WALL_MS = 4_000;

const lastSpokenId = new Map();
const lastWallAt = new Map();
const lastPhotoAt = new Map();
const photoInFlight = new Map();

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
    console.log(`[CAO-S] ${res.ok ? "OK" : "FAIL"} ${payload.event_type} → ${JSON.stringify(data).slice(0,300)}`);
    return { ok: res.ok, status: res.status, body: text, data };
  } catch (e) {
    console.error("[CAO-S] Error red:", e?.message || e);
    return { ok: false, status: 0, body: "", data: null };
  }
}

async function speakOnGlasses(session, deviceId, data) {
  const speak = data?.speak;
  if (!speak?.audio_base64) return;
  const speakId = speak.id || null;
  if (!speakId) return;
  if (lastSpokenId.get(deviceId) === speakId) return;

  const audioMime = speak.mime || "audio/mpeg";
  try {
    const dataUrl = `data:${audioMime};base64,${speak.audio_base64}`;
    if (typeof session.audio?.playAudio === "function") await session.audio.playAudio({ audioUrl: dataUrl });
    else if (typeof session.audio?.play === "function") await session.audio.play({ audioUrl: dataUrl });
    else if (typeof session.layouts?.playAudio === "function") await session.layouts.playAudio({ audioUrl: dataUrl });
    else if (typeof session.speaker?.play === "function") await session.speaker.play({ audioUrl: dataUrl });
    else return;
    lastSpokenId.set(deviceId, speakId);
  } catch (e) {
    console.error("[CAO-S] Error voz:", e?.message || e);
  }
}

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

    const raw = photo?.base64 || photo?.data || photo?.image || photo?.buffer || null;
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

    if (result.data?.duplicate) {
      console.log("[CAO-S] foto duplicada → silencio");
      return;
    }

    showWallOnce(session, deviceId, "Foto enviada al diario ✓");
    await speakOnGlasses(session, deviceId, result.data);
  } catch (e) {
    console.error("[CAO-S] Excepción foto:", e?.message || e);
    cancel("Error al capturar. Repítela.");
  } finally {
    photoInFlight.set(deviceId, false);
  }
}

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

const armed = new Map();

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

class CaosServer extends ServerBase {
  async onSession(session, sessionId, userId) {
    const deviceId = String(userId);
    const deviceModel = session.device?.model ?? "Mentra";
    console.log(`[CAO-S] Sesión abierta device_id=${deviceId}`);

    showWallOnce(session, deviceId, "CAO-S conectado. Di \"oye caos, foto\" o pulsa el botón.");

    lastSpokenId.delete(deviceId);
    lastWallAt.delete(deviceId);
    lastPhotoAt.delete(deviceId);
    photoInFlight.set(deviceId, false);

    // ÚNICA llamada de cortesía al conectar.
    await sendToCaos({
      device_id: deviceId,
      event_type: "heartbeat",
      device_model: deviceModel,
      battery_level: session.device?.batteryLevel ?? null,
    });

    session.events.onDisconnected?.(() => {
      console.log(`[CAO-S] Sesión cerrada device_id=${deviceId}`);
      lastSpokenId.delete(deviceId);
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
