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

// Tragar errores raros del SDK por mensajes desconocidos
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

async function handlePhoto(session, userId) {
  try {
    // 1) Log de qué tiene la sesión por dentro
    console.log("[CAO-S] session keys:", Object.keys(session || {}));
    console.log("[CAO-S] camera?:", !!session?.camera,
                "| photos?:", !!session?.photos,
                "| capture?:", typeof session?.capturePhoto);

    // 2) Probar todos los nombres conocidos
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
      session.layouts?.showTextWall?.("Cámara no disponible");
      return;
    }

    console.log("[CAO-S] Foto OK, tipo:", typeof photo, "claves:", photo && Object.keys(photo));

    // 3) Sacar el base64 (varía según versión: photo.base64 / photo.data / photo.image)
    const base64 =
      photo?.base64 || photo?.data || photo?.image || photo?.buffer || null;
    const mime = photo?.mimeType || photo?.mime || "image/jpeg";

    if (!base64) {
      console.error("[CAO-S] La foto llegó pero sin base64:", photo);
      session.layouts?.showTextWall?.("Foto vacía");
      return;
    }

    const res = await sendToCaos({
      device_id: userId,
      event_type: "photo",
      photo_base64: typeof base64 === "string" ? base64 : Buffer.from(base64).toString("base64"),
      photo_mime: mime,
    });

    session.layouts?.showTextWall?.(res?.ok ? "Foto enviada ✓" : "Sin obra activa");
  } catch (e) {
    console.error("[CAO-S] Excepción foto:", e?.message || e);
    session.layouts?.showTextWall?.("Error al capturar");
  }
}


// ✅ HAY QUE SUBCLASEAR y sobrescribir onSession, no pasarlo como callback
class CaosServer extends ServerBase {
  async onSession(session, sessionId, userId) {
    const deviceId = String(userId);
    const deviceModel = session.device?.model ?? "Mentra";
    console.log(`[CAO-S] Sesión abierta device_id=${deviceId} model=${deviceModel}`);

    try { session.layouts.showTextWall("CAO-S conectado. Di 'foto' o pulsa el botón."); } catch {}

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

    session.events.onTranscription?.(async (data) => {
      try {
        if (!data?.isFinal) return;
        const text = (data.text || "").toLowerCase().trim();
        if (/\b(foto|captura|capturar|saca\s+foto)\b/.test(text)) {
          await takePhoto(session, deviceId);
        }
      } catch (e) { console.error("[CAO-S] Voz:", e?.message || e); }
    });

    session.events.onButtonPress?.(async () => {
      try { await takePhoto(session, deviceId); }
      catch (e) { console.error("[CAO-S] Botón:", e?.message || e); }
    });
  }
}

async function takePhoto(session, deviceId) {
  try {
    try { session.layouts.showTextWall("Capturando..."); } catch {}
    const photo = await session.camera.requestPhoto();
    const b64 = Buffer.from(photo.buffer).toString("base64");

    const result = await sendToCaos({
      device_id: deviceId,
      event_type: "photo",
      photo_base64: b64,
      photo_mime: photo.mimeType || "image/jpeg",
      battery_level: session.device?.batteryLevel ?? null,
      device_model: session.device?.model ?? "Mentra",
      captured_at: new Date().toISOString(),
    });

    if (!result.ok) {
      try { session.layouts.showTextWall(`Error ${result.status || ""}`.trim()); } catch {}
      return;
    }
    if (result.body?.includes("glasses_orphan")) {
      try { session.layouts.showTextWall("Gafas sin dueño. Reclámalas en CAO-S."); } catch {}
    } else if (result.body?.includes("no_target_work")) {
      try { session.layouts.showTextWall("Sin obra activa en CAO-S."); } catch {}
    } else {
      try { session.layouts.showTextWall("Foto enviada al diario ✓"); } catch {}
    }
  } catch (e) {
    console.error("[CAO-S] Excepción foto:", e?.message || e);
    try { session.layouts.showTextWall("Error al capturar"); } catch {}
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
