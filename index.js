// Servidor puente CAO-S <-> Gafas Mentra
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
const WAKE_MS = 8_000;

// ───────────────────────────────────────────────
// Enviar evento a CAO-S
// ───────────────────────────────────────────────
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
      JSON.stringify({ ok: data?.ok, reason: data?.reason, work_id: data?.work_id })
    );
    return { ok: res.ok, status: res.status, body: text, data };
  } catch (e) {
    console.error("[CAO-S] Error enviando a CAO-S:", e?.message || e);
    return { ok: false, status: 0, body: "", data: null };
  }
}

// ───────────────────────────────────────────────
// Reproducir audio de CAOS IA en las gafas
// (prueba varios métodos del SDK; si no hay audio,
// muestra el texto en pantalla como respaldo)
// ───────────────────────────────────────────────
async function speakOnGlasses(session, speak) {
  if (!speak) return;
  const { text, audio_base64, mime = "audio/mpeg" } = speak;

  if (audio_base64) {
    try {
      const buf = Buffer.from(audio_base64, "base64");
      const dataUrl = `data:${mime};base64,${audio_base64}`;

      // Probar APIs conocidas del SDK Mentra para reproducir audio
      if (typeof session?.audio?.playBuffer === "function") {
        await session.audio.playBuffer(buf, { mime });
        return;
      }
      if (typeof session?.audio?.play === "function") {
        await session.audio.play(buf, { mime });
        return;
      }
      if (typeof session?.audio?.playUrl === "function") {
        await session.audio.playUrl(dataUrl);
        return;
      }
      if (typeof session?.speaker?.play === "function") {
        await session.speaker.play(buf, { mime });
        return;
      }
      if (typeof session?.playAudio === "function") {
        await session.playAudio(buf, { mime });
        return;
      }
      console.warn("[CAO-S] SDK sin API de audio. Claves session:", Object.keys(session || {}));
    } catch (e) {
      console.warn("[CAO-S] Audio falló, usando texto:", e?.message || e);
    }
  }

  // Fallback: texto en pantalla
  try { session.layouts?.showTextWall?.(text || "", { duration: 2500 }); } catch {}
}

// ───────────────────────────────────────────────
// Normalizar texto
// ───────────────────────────────────────────────
function normalizeText(s = "") {
  return s
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ───────────────────────────────────────────────
// Capturar foto
// ───────────────────────────────────────────────
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

    // Confirmación por voz CAOS IA (o texto si no hay audio)
    if (result.data?.speak) {
      await speakOnGlasses(session, result.data.speak);
      return;
    }

    // Sin "speak" (errores de red): respaldo en pantalla
    if (!result.ok) {
      try { session.layouts?.showTextWall?.(`Error ${result.status || ""}`.trim()); } catch {}
    } else {
      try { session.layouts?.showTextWall?.("Foto enviada ✓"); } catch {}
    }
  } catch (e) {
    console.error("[CAO-S] Excepción foto:", e?.message || e);
    try { session.layouts?.showTextWall?.("Error al capturar"); } catch {}
  }
}

// ───────────────────────────────────────────────
// Servidor Mentra
// ───────────────────────────────────────────────
class CaosServer extends ServerBase {
  async onSession(session, sessionId, userId) {
    const deviceId = String(userId);
    const deviceModel = session.device?.model ?? "Mentra";
    console.log(`[CAO-S] Sesión abierta device_id=${deviceId} model=${deviceModel}`);

    try { session.layouts.showTextWall("CAO-S listo. Di 'hola caos' para activar."); } catch {}

    await sendToCaos({
      device_id: deviceId,
      event_type: "heartbeat",
      device_model: deviceModel,
      battery_level: session.device?.batteryLevel ?? null,
    });

    const timer = setInterval(() => {
      sendToCaos({
        device_id: deviceId,
        event_type: "heartbeat",
        device_model: session.device?.model ?? deviceModel,
        battery_level: session.device?.batteryLevel ?? null,
      }).catch(() => {});
    }, HEARTBEAT_MS);

    session.events.onDisconnected?.(() => {
      console.log(`[CAO-S] Sesión cerrada device_id=${deviceId}`);
      clearInterval(timer);
    });

    let awakeUntil = 0;

    session.events.onTranscription?.(async (data) => {
      try {
        if (!data?.isFinal) return;
        const text = normalizeText(data.text || "");
        if (!text) return;

        if (text.includes("hola caos")) {
          awakeUntil = Date.now() + WAKE_MS;
          console.log("[CAO-S] Despierto 8s");
          try { session.layouts?.showTextWall?.("Caos te escucha", { duration: 1500 }); } catch {}
        }

        if (/\b(foto|captura|capturar|saca\s+foto)\b/.test(text)) {
          if (Date.now() < awakeUntil) {
            console.log("[CAO-S] Foto por voz");
            await handlePhoto(session, deviceId);
          } else {
            console.log("[CAO-S] 'foto' ignorada (gafas dormidas)");
          }
        }
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
