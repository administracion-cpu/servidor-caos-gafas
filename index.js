// Servidor puente CAO-S <-> Gafas Mentra
// - Filtro "oye caos" + comando foto por voz/botón
// - Reproducción de voz de CAO-S con anti-repetición por marca única
// - Avisos de mensaje nuevo de CAO-S vía respuesta de latido
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
const WAKE_WINDOW_MS = 8000;

const lastSpokenId = new Map();

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

async function speakOnGlasses(session, deviceId, data, { allowWithoutId = false } = {}) {
  const speak = data?.speak;
  const audioB64 = speak?.audio_base64 || data?.audio_base64;
  if (!audioB64) return;

  const speakId = speak?.id || data?.speak_id || null;

  if (speakId) {
    if (lastSpokenId.get(deviceId) === speakId) {
      console.log(`[CAO-S] voz ignorada (id repetido ${speakId})`);
      return;
    }
  } else if (!allowWithoutId) {
    console.log("[CAO-S] voz sin id → ignorada para evitar eco");
    return;
  }

  const audioMime = speak?.mime || speak?.audio_mime || "audio/mpeg";
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
      console.warn(
        "[CAO-S] No encuentro API de audio. session keys:",
        Object.keys(session || {}),
        "audio keys:",
        session?.audio ? Object.keys(session.audio) : "(sin audio)"
      );
      return;
    }
    if (speakId) lastSpokenId.set(deviceId, speakId);
    console.log(`[CAO-S] 🔊 voz reproducida (id=${speakId || "-"}, ${audioB64.length} b64)`);
  } catch (e) {
    console.error("[CAO-S] Error reproduciendo voz:", e?.message || e);
  }
}

async function handlePhoto(session, deviceId) {
  try {
    try { session.layouts?.showTextWall?.("Capturando..."); } catch {}

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
      try { session.layouts?.showTextWall?.("Cámara no disponible"); } catch {}
      return;
    }

    const raw =
      photo?.base64 || photo?.data || photo?.image || photo?.buffer || null;
    const mime = photo?.mimeType || photo?.mime || "image/jpeg";

    if (!raw) {
      console.error("[CAO-S] La foto llegó pero sin datos:", photo);
      try { session.layouts?.showTextWall?.("Foto vacía"); } catch {}
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
      try { session.layouts?.showTextWall?.(`Error ${result.status || ""}`.trim()); } catch {}
      return;
    }

    if (result.body?.includes("glasses_orphan")) {
      try { session.layouts?.showTextWall?.("Gafas sin dueño. Reclámalas en CAO-S."); } catch {}
    } else if (result.body?.includes("no_target_work")) {
      try { session.layouts?.showTextWall?.("Sin obra activa en CAO-S."); } catch {}
    } else {
      try { session.layouts?.showTextWall?.("Foto enviada al diario ✓"); } catch {}
    }

    await speakOnGlasses(session, deviceId, result.data, { allowWithoutId: true });
  } catch (e) {
    console.error("[CAO-S] Excepción foto:", e?.message || e);
    try { session.layouts?.showTextWall?.("Error al capturar"); } catch {}
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
  try { session.layouts?.showTextWall?.("Ese comando aún no lo entiendo", { durationMs: 2000 }); } catch {}
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
    try { session.layouts?.showTextWall?.("Te escucho…", { durationMs: WAKE_WINDOW_MS }); } catch {}
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

class CaosServer extends ServerBase {
  async onSession(session, sessionId, userId) {
    const deviceId = String(userId);
    try {
      console.log("[CAO-S] events disponibles:", Object.keys(session.events || {}));
      console.log("[CAO-S] session keys:", Object.keys(session || {}));
    } catch (e) { console.log("[CAO-S] no pude listar events:", e?.message); }

    const deviceModel = session.device?.model ?? "Mentra";
    console.log(`[CAO-S] Sesión abierta device_id=${deviceId} model=${deviceModel}`);

    try { session.layouts.showTextWall("CAO-S conectado. Di \"oye caos, foto\" o pulsa el botón."); } catch {}

    lastSpokenId.delete(deviceId);

    const hb = await sendToCaos({
      device_id: deviceId,
      event_type: "heartbeat",
      device_model: deviceModel,
      battery_level: session.device?.batteryLevel ?? null,
    });
    await speakOnGlasses(session, deviceId, hb.data);

    const timer = setInterval(() => {
      sendToCaos({
        device_id: deviceId,
        event_type: "heartbeat",
        device_model: session.device?.model ?? deviceModel,
        battery_level: session.device?.batteryLevel ?? null,
      }).then((r) => speakOnGlasses(session, deviceId, r.data)).catch(() => {});
    }, HEARTBEAT_MS);

    session.events.onDisconnected?.(() => {
      console.log(`[CAO-S] Sesión cerrada device_id=${deviceId}`);
      clearInterval(timer);
      lastSpokenId.delete(deviceId);
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
