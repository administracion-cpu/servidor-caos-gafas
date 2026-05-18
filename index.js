// Servidor puente CAO-S <-> Gafas Mentra
// Wake word: "oye caos" + comando ("foto"). Reenvía foto/latido al webhook.
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
  PORT = "8080",
} = process.env;

if (!MENTRA_API_KEY || !MENTRA_PACKAGE_NAME || !MENTRA_BRIDGE_SECRET || !CAOS_BRIDGE_URL) {
  console.error("[CAO-S] Faltan variables: MENTRA_API_KEY / MENTRA_PACKAGE_NAME / MENTRA_BRIDGE_SECRET / CAOS_BRIDGE_URL");
  process.exit(1);
}

// ──────────────────────────────────────────────────────────────
// Envío al webhook de CAO-S (foto o latido). Log claro siempre.
// ──────────────────────────────────────────────────────────────
async function postToCaos(payload, label) {
  try {
    const r = await fetch(CAOS_BRIDGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-mentra-secret": MENTRA_BRIDGE_SECRET,
      },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    console.log(`[CAO-S] ${label} → ${r.status} ${text.slice(0, 200)}`);
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, json };
  } catch (e) {
    console.error(`[CAO-S] ${label} FALLÓ:`, e?.message || e);
    return { ok: false, status: 0, json: null };
  }
}

// Reproducir audio en gafas si el webhook devuelve { speak: { audio_base64, text } }
async function speakIfPresent(session, resp) {
  const spk = resp?.json?.speak;
  if (!spk) return;
  try {
    if (spk.audio_base64 && session.audio?.playAudio) {
      await session.audio.playAudio({ audioBase64: spk.audio_base64, mime: spk.mime || "audio/mpeg" });
    } else if (spk.text && session.layouts?.showTextWall) {
      session.layouts.showTextWall(spk.text, { durationMs: 3000 });
    }
  } catch (e) {
    console.warn("[CAO-S] No pude reproducir confirmación:", e?.message || e);
  }
}

// ──────────────────────────────────────────────────────────────
// Tomar foto y mandarla
// ──────────────────────────────────────────────────────────────
async function handlePhoto(session, deviceId, extra = {}) {
  try {
    if (session.layouts?.showTextWall) session.layouts.showTextWall("📸 Haciendo foto…", { durationMs: 1500 });
    const photo = await session.camera.requestPhoto();
    const base64 = photo?.buffer
      ? Buffer.from(photo.buffer).toString("base64")
      : photo?.base64 || null;
    if (!base64) {
      console.warn("[CAO-S] La cámara devolvió vacío");
      return;
    }
    const resp = await postToCaos({
      device_id: deviceId,
      event_type: "photo",
      photo_base64: base64,
      photo_mime: photo?.mimeType || "image/jpeg",
      battery_level: session.device?.batteryLevel ?? null,
      device_model: session.device?.model ?? null,
      captured_at: new Date().toISOString(),
      ...extra,
    }, `FOTO ${deviceId}`);
    await speakIfPresent(session, resp);
  } catch (e) {
    console.error("[CAO-S] Foto falló:", e?.message || e);
    if (session.layouts?.showTextWall) session.layouts.showTextWall("⚠️ No pude hacer la foto", { durationMs: 2000 });
  }
}

// ──────────────────────────────────────────────────────────────
// Wake word "oye caos" + comando
// ──────────────────────────────────────────────────────────────
const WAKE = /\boye\s+ca[oó]s\b/i;
const PHOTO_CMDS = [/\bfoto\b/i, /\bhazme\s+(una\s+)?foto\b/i, /\bsaca(?:r)?\s+(una\s+)?foto\b/i];

function matchCommand(text) {
  if (!text) return null;
  if (PHOTO_CMDS.some((rx) => rx.test(text))) return "photo";
  return "unknown";
}

function attachTranscript(session, deviceId) {
  // Probar varios nombres del SDK para enganchar transcripción
  const candidates = [
    "onTranscription", "onTranscript", "onUserTranscript",
    "onSpeech", "onSpeechRecognition", "onVoice",
  ];
  let attached = null;
  for (const name of candidates) {
    if (typeof session.events?.[name] === "function") {
      try {
        session.events[name]((evt) => {
          const text = (evt?.text ?? evt?.transcript ?? evt?.utterance ?? "").toString().trim();
          if (!text) return;
          console.log(`[CAO-S] 🎙️  ${text}`);
          handleHeardText(session, deviceId, text);
        });
        attached = name;
        break;
      } catch (e) {
        console.warn(`[CAO-S] ${name} no se pudo enganchar:`, e?.message || e);
      }
    }
  }
  if (attached) console.log(`[CAO-S] Escucha de voz activa vía ${attached}`);
  else console.warn("[CAO-S] ⚠️ No encontré evento de transcripción en el SDK. Claves disponibles:",
    session.events ? Object.keys(session.events) : "(sin events)");
}

// Estado de "ventana de comando" tras oír "oye caos"
const armed = new Map(); // deviceId -> timeoutId

function handleHeardText(session, deviceId, text) {
  const hasWake = WAKE.test(text);
  // Si la frase ya contiene wake + comando, ejecuta de una
  if (hasWake) {
    const tail = text.replace(WAKE, "").trim();
    if (tail) {
      runCommand(session, deviceId, tail);
      return;
    }
    // Solo "oye caos" → abre ventana de 5s
    if (armed.has(deviceId)) clearTimeout(armed.get(deviceId));
    armed.set(deviceId, setTimeout(() => armed.delete(deviceId), 5000));
    if (session.layouts?.showTextWall) session.layouts.showTextWall("Te escucho…", { durationMs: 1500 });
    console.log(`[CAO-S] Wake activo, esperando comando 5s (${deviceId})`);
    return;
  }
  // Sin wake previo, ignorar
  if (!armed.has(deviceId)) return;
  clearTimeout(armed.get(deviceId));
  armed.delete(deviceId);
  runCommand(session, deviceId, text);
}

async function runCommand(session, deviceId, raw) {
  const cmd = matchCommand(raw);
  console.log(`[CAO-S] Comando: "${raw}" → ${cmd}`);
  if (cmd === "photo") return handlePhoto(session, deviceId);
  if (session.layouts?.showTextWall) session.layouts.showTextWall("Ese comando aún no lo entiendo", { durationMs: 2000 });
}

// ──────────────────────────────────────────────────────────────
// Botón físico
// ──────────────────────────────────────────────────────────────
function attachButton(session, deviceId) {
  const candidates = ["onButtonPress", "onButton", "onHardwareButton", "onTap"];
  for (const name of candidates) {
    if (typeof session.events?.[name] === "function") {
      try {
        session.events[name](() => handlePhoto(session, deviceId));
        console.log(`[CAO-S] Botón físico activo vía ${name}`);
        return;
      } catch {}
    }
  }
  console.warn("[CAO-S] ⚠️ No encontré evento de botón en el SDK");
}

// ──────────────────────────────────────────────────────────────
// Latidos periódicos
// ──────────────────────────────────────────────────────────────
function attachHeartbeat(session, deviceId) {
  const id = setInterval(() => {
    postToCaos({
      device_id: deviceId,
      event_type: "heartbeat",
      battery_level: session.device?.batteryLevel ?? null,
      device_model: session.device?.model ?? null,
    }, `LATIDO ${deviceId}`);
  }, 60_000);
  session.onDisconnect?.(() => clearInterval(id));
}

// ──────────────────────────────────────────────────────────────
// Servidor
// ──────────────────────────────────────────────────────────────
class CaosServer extends ServerBase {
  async onSession(session, sessionId, userId) {
    const deviceId = session.device?.id || sessionId || userId || "unknown";
    console.log(`[CAO-S] Sesión abierta · user=${userId} · device=${deviceId}`);

    attachHeartbeat(session, deviceId);
    attachTranscript(session, deviceId);
    attachButton(session, deviceId);

    // Saludo inicial
    if (session.layouts?.showTextWall) {
      session.layouts.showTextWall("CAO-S listo · di \"oye caos, foto\"", { durationMs: 2500 });
    }
  }
}

const server = new CaosServer({
  packageName: MENTRA_PACKAGE_NAME,
  apiKey: MENTRA_API_KEY,
  port: Number(PORT),
});

server.start().then(() => {
  console.log(`[CAO-S] Servidor escuchando puerto ${PORT} → ${CAOS_BRIDGE_URL}`);
});
