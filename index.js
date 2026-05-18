// Servidor puente CAO-S <-> Gafas Mentra
import * as MentraSDK from "@mentra/sdk";
import fetch from "node-fetch";

const ServerBase =
  MentraSDK.AppServer ||
  MentraSDK.TpaServer ||
  MentraSDK.default?.AppServer ||
  MentraSDK.default?.TpaServer;

if (!ServerBase) {
  console.error("[CAO-S] No encuentro servidor Mentra en el SDK:", Object.keys(MentraSDK));
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

// 🛡️ Tragarse errores que vienen del SDK por mensajes desconocidos de las gafas
// (p.ej. "device_state_update"). Si no, la sesión se cae.
process.on("uncaughtException", (err) => {
  const msg = String(err?.message || err);
  if (msg.includes("Unrecognized message type")) {
    console.warn("[CAO-S] Mensaje desconocido del SDK ignorado:", msg);
    return;
  }
  console.error("[CAO-S] uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  const msg = String(reason?.message || reason);
  if (msg.includes("Unrecognized message type")) {
    console.warn("[CAO-S] Mensaje desconocido del SDK ignorado:", msg);
    return;
  }
  console.error("[CAO-S] unhandledRejection:", reason);
});

const HEARTBEAT_MS = 30_000;

const server = new ServerBase({
  packageName: MENTRA_PACKAGE_NAME,
  apiKey: MENTRA_API_KEY,
  port: Number(PORT),
});

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
    const txt = await res.text();
    if (!res.ok) {
      console.error(`[CAO-S] Puente respondió ${res.status}:`, txt);
      return { ok: false, status: res.status, body: txt };
    }
    console.log(`[CAO-S] OK ${payload.event_type || "photo"} → ${txt}`);
    return { ok: true, status: res.status, body: txt };
  } catch (e) {
    console.error("[CAO-S] Error de red:", e?.message || e);
    return { ok: false, error: String(e) };
  }
}

server.onSession(async (session, sessionId, userId) => {
  try {
    const deviceId = String(userId);
    const deviceModel = session.device?.model ?? "Mentra";
    console.log(`[CAO-S] Sesión abierta. device_id=${deviceId}`);

    try { session.layouts.showTextWall("CAO-S conectado. Di 'foto' o pulsa el botón."); } catch {}

    await sendToCaos({
      device_id: deviceId,
      event_type: "heartbeat",
      device_model: deviceModel,
      battery_level: session.device?.batteryLevel ?? null,
    });

    const heartbeatTimer = setInterval(() => {
      sendToCaos({
        device_id: deviceId,
        event_type: "heartbeat",
        device_model: session.device?.model ?? deviceModel,
        battery_level: session.device?.batteryLevel ?? null,
      }).catch(() => {});
    }, HEARTBEAT_MS);

    session.events.onDisconnected?.(() => {
      console.log(`[CAO-S] Sesión cerrada device_id=${deviceId}`);
      clearInterval(heartbeatTimer);
    });

    session.events.onTranscription?.(async (data) => {
      try {
        if (!data?.isFinal) return;
        const text = (data.text || "").toLowerCase().trim();
        if (/\b(foto|captura|capturar|saca\s+foto)\b/.test(text)) {
          await takePhoto(session, deviceId);
        }
      } catch (e) {
        console.error("[CAO-S] Error en transcripción:", e?.message || e);
      }
    });

    session.events.onButtonPress?.(async () => {
      try { await takePhoto(session, deviceId); }
      catch (e) { console.error("[CAO-S] Error botón:", e?.message || e); }
    });
  } catch (e) {
    console.error("[CAO-S] Error montando sesión:", e?.message || e);
  }
});

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

server.start().then(() => {
  console.log(`[CAO-S] Servidor de gafas escuchando en puerto ${PORT}`);
});
