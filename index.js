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

// Ventana de escucha tras oír "oye caos"
const WAKE_WINDOW_MS = 8000;

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
// Normaliza: minúsculas, sin acentos, sin signos, espacios colapsados
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

function tryAttach(session, name, cb) {
  // Probamos 3 formas de enganchar el evento, según cómo lo exponga el SDK
  try {
    if (typeof session?.events?.[name] === "function") {
      session.events[name](cb);
      return `events.${name}`;
    }
  } catch {}
  try {
    if (typeof session?.[name] === "function") {
      session[name](cb);
      return name;
    }
  } catch {}
  try {
    if (typeof session?.events?.on === "function") {
      session.events.on(name, cb);
      return `events.on("${name}")`;
    }
  } catch {}
  return null;
}

function attachTranscript(session, deviceId) {
  const candidates = [
    "onTranscription", "onTranscript", "onUserTranscript",
    "onSpeech", "onSpeechRecognition", "onVoice", "onUtterance",
  ];
  const cb = (evt) => {
    const text = (evt?.text ?? evt?.transcript ?? evt?.utterance ?? evt ?? "").toString().trim();
    if (!text) return;
    console.log(`[CAO-S] 🎙️  ${text}`);
    handleHeardText(session, deviceId, text);
  };
  const hooked = [];
  for (const name of candidates) {
    const how = tryAttach(session, name, cb);
    if (how) hooked.push(how);
  }
  if (hooked.length) console.log(`[CAO-S] Escucha de voz activa vía: ${hooked.join(", ")}`);
  else console.warn("[CAO-S] ⚠️ No encontré evento de transcripción en el SDK. Claves disponibles:",
    session.events ? Object.keys(session.events) : "(sin events)");
}

// Estado de "ventana de comando" tras oír "oye caos"
const armed = new Map(); // deviceId -> timeoutId

function handleHeardText(session, deviceId, rawText) {
  const text = normalize(rawText);
  const hasWake = WAKE.test(text);

  if (hasWake) {
    const tail = text.replace(WAKE, "").trim();
    if (tail) {
      runCommand(session, deviceId, tail);
      return;
    }
    // Solo "oye caos" → abre ventana de escucha
    if (armed.has(deviceId)) clearTimeout(armed.get(deviceId));
    armed.set(deviceId, setTimeout(() => armed.delete(deviceId), WAKE_WINDOW_MS));
    if (session.layouts?.showTextWall) session.layouts.showTextWall("Te escucho…", { durationMs: WAKE_WINDOW_MS });
    console.log(`[CAO-S] Wake activo, esperando comando ${WAKE_WINDOW_MS / 1000}s (${deviceId})`);
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
  const cb = () => handlePhoto(session, deviceId);
  for (const name of candidates) {
    const how = tryAttach(session, name, cb);
    if (how) {
      console.log(`[CAO-S] Botón físico activo vía ${how}`);
      return;
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
