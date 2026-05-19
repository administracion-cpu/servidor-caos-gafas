// Servidor puente CAO-S <-> Gafas Mentra
// - El latido NO lleva audio nunca.
// - Los avisos de "mensaje nuevo de CAO-S" se piden en un canal aparte (fetch_notice).
// - "Foto añadida al diario" suena UNA sola vez (dedupe por id en gafas).
// - Botón y voz "oye caos, foto" con anti-rebote (5s).
import * as MentraSDK from "@mentra/sdk";
import fetch from "node-fetch";

const ServerBase =
  MentraSDK.AppServer ||
  MentraSDK.TpaServer ||
  MentraSDK.default?.AppServer ||
  MentraSDK.default?.TpaServer;

if (!ServerBase) {
  console.error("[CAO-S] No encuentro servidor Mentra en el SDK.");
  process.exit(1);
}

const {
  MENTRA_PACKAGE_NAME,
  MENTRA_API_KEY,
  CAOS_BRIDGE_URL,         // p.ej. https://xnawzzrfbwumhnbmrswk.functions.supabase.co/mentra-bridge
  CAOS_BRIDGE_SECRET,      // = MENTRA_BRIDGE_SECRET en Supabase
  PORT = 3000,
  HEARTBEAT_MS = 30000,
  NOTICE_POLL_MS = 8000,   // sondeo de avisos de voz
  PHOTO_DEBOUNCE_MS = 5000,
} = process.env;

if (!MENTRA_PACKAGE_NAME || !MENTRA_API_KEY || !CAOS_BRIDGE_URL || !CAOS_BRIDGE_SECRET) {
  console.error("[CAO-S] Faltan variables de entorno obligatorias.");
  process.exit(1);
}

// ---------- Estado por gafa ----------
const lastSpokenId = new Map();   // deviceId -> Set<string> (ids ya reproducidos)
const lastPhotoAt  = new Map();   // deviceId -> timestamp ms de la última foto procesada
const timers       = new Map();   // deviceId -> { heartbeat, notice }

function rememberSpoken(deviceId, id) {
  if (!id) return false;
  let set = lastSpokenId.get(deviceId);
  if (!set) { set = new Set(); lastSpokenId.set(deviceId, set); }
  if (set.has(id)) return false;
  set.add(id);
  // pequeño tope para no crecer sin control
  if (set.size > 200) {
    const first = set.values().next().value;
    set.delete(first);
  }
  return true;
}

function canTakePhoto(deviceId) {
  const now = Date.now();
  const prev = lastPhotoAt.get(deviceId) || 0;
  if (now - prev < Number(PHOTO_DEBOUNCE_MS)) return false;
  lastPhotoAt.set(deviceId, now);
  return true;
}

// ---------- Reproducción de voz en gafas ----------
async function speakOnGlasses(session, deviceId, speak, { allowWithoutId = false } = {}) {
  if (!speak || !speak.audio_base64) return;
  if (!speak.id && !allowWithoutId) return;
  if (speak.id && !rememberSpoken(deviceId, speak.id)) {
    console.log("[CAO-S] Audio repetido ignorado:", speak.id);
    return;
  }
  try {
    const buf = Buffer.from(speak.audio_base64, "base64");
    if (session?.audio?.playAudio) {
      await session.audio.playAudio({ data: buf, mime: speak.mime || "audio/mpeg" });
    } else if (session?.playAudio) {
      await session.playAudio({ data: buf, mime: speak.mime || "audio/mpeg" });
    } else {
      console.warn("[CAO-S] No hay API de audio en la sesión.");
    }
  } catch (e) {
    console.warn("[CAO-S] Error reproduciendo audio:", e?.message || e);
  }
}

// ---------- Llamada al puente Supabase ----------
async function callBridge(payload) {
  const r = await fetch(CAOS_BRIDGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-mentra-secret": CAOS_BRIDGE_SECRET,
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`bridge ${r.status}: ${txt}`);
  }
  return await r.json();
}

// ---------- Foto ----------
async function handlePhoto(session, deviceId, { caption = "" } = {}) {
  if (!canTakePhoto(deviceId)) {
    console.log("[CAO-S] Foto ignorada (rebote anti-doble).");
    return;
  }
  try {
    const photo = await (session.camera?.takePhoto?.() || session.takePhoto?.());
    if (!photo?.base64) {
      console.warn("[CAO-S] No se obtuvo foto de la cámara.");
      return;
    }
    const payload = {
      device_id: deviceId,
      event_type: "photo",
      photo_base64: photo.base64,
      photo_mime: photo.mime || "image/jpeg",
      caption,
      battery_level: session.device?.battery ?? null,
      device_model: session.device?.model ?? null,
      gps_lat: session.location?.lat ?? null,
      gps_lng: session.location?.lng ?? null,
      captured_at: new Date().toISOString(),
    };
    const resp = await callBridge(payload);
    // La confirmación de foto puede no traer id antiguo; la dejamos pasar siempre,
    // pero el dedupe por id de speak evita que se repita en ciclos siguientes.
    await speakOnGlasses(session, deviceId, resp.speak, { allowWithoutId: true });
  } catch (e) {
    console.warn("[CAO-S] Error en foto:", e?.message || e);
  }
}

// ---------- Latido (sin audio) ----------
async function sendHeartbeat(session, deviceId) {
  try {
    await callBridge({
      device_id: deviceId,
      event_type: "heartbeat",
      battery_level: session.device?.battery ?? null,
      device_model: session.device?.model ?? null,
    });
  } catch (e) {
    console.warn("[CAO-S] Heartbeat error:", e?.message || e);
  }
}

// ---------- Sondeo de avisos de voz ----------
async function pollNotice(session, deviceId) {
  try {
    const resp = await callBridge({
      device_id: deviceId,
      event_type: "fetch_notice",
      battery_level: session.device?.battery ?? null,
      device_model: session.device?.model ?? null,
    });
    if (resp?.speak) {
      await speakOnGlasses(session, deviceId, resp.speak);
    }
  } catch (e) {
    console.warn("[CAO-S] Poll aviso error:", e?.message || e);
  }
}

// ---------- Detección de "oye caos, foto" ----------
function isOyeCaosFoto(text) {
  if (!text) return false;
  const t = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (!t.includes("caos") && !t.includes("caso")) return false;
  return /\bfoto\b|\bfotografia\b|\bhaz una foto\b/.test(t);
}

// ---------- Servidor ----------
class CaosServer extends ServerBase {
  async onSession(session, sessionId, userId) {
    const deviceId =
      session.device?.id ||
      session.glasses?.id ||
      session.deviceId ||
      sessionId;

    console.log("[CAO-S] Sesión abierta:", deviceId);
    lastSpokenId.delete(deviceId);
    lastPhotoAt.delete(deviceId);

    // Limpieza de temporizadores previos
    const prev = timers.get(deviceId);
    if (prev) {
      clearInterval(prev.heartbeat);
      clearInterval(prev.notice);
    }
    const heartbeat = setInterval(() => sendHeartbeat(session, deviceId), Number(HEARTBEAT_MS));
    const notice    = setInterval(() => pollNotice(session, deviceId),    Number(NOTICE_POLL_MS));
    timers.set(deviceId, { heartbeat, notice });

    // Primer latido inmediato
    sendHeartbeat(session, deviceId).catch(() => {});

    // Botón físico → foto
    session.events?.onButton?.((e) => {
      try { handlePhoto(session, deviceId); }
      catch (err) { console.error("[CAO-S] Botón:", err?.message || err); }
    });

    // Voz: "oye caos, foto"
    session.events?.onTranscription?.((e) => {
      try {
        const txt = e?.text || e?.transcript || "";
        if (isOyeCaosFoto(txt)) handlePhoto(session, deviceId);
      } catch (err) { console.error("[CAO-S] Voz:", err?.message || err); }
    });

    // Cierre de sesión
    session.events?.onDisconnect?.(() => {
      const t = timers.get(deviceId);
      if (t) { clearInterval(t.heartbeat); clearInterval(t.notice); }
      timers.delete(deviceId);
      lastSpokenId.delete(deviceId);
      lastPhotoAt.delete(deviceId);
      console.log("[CAO-S] Sesión cerrada:", deviceId);
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
