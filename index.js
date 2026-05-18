// Servidor puente CAO-S <-> Gafas Mentra
// - Manda LATIDOS a CAO-S cuando las gafas se encienden y cada 30s.
// - Manda FOTOS cuando dices "foto" o pulsas el botón.
// - Usa device_id estable (el userId de Mentra) para que CAO-S sepa quién es.

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
  console.error("[CAO-S] Faltan variables de entorno: MENTRA_API_KEY, MENTRA_PACKAGE_NAME, MENTRA_BRIDGE_SECRET, CAOS_BRIDGE_URL");
  process.exit(1);
}

const HEARTBEAT_MS = 30_000;

const server = new ServerBase({
  packageName: MENTRA_PACKAGE_NAME,
  apiKey: MENTRA_API_KEY,
  port: Number(PORT),
});

// Llamada genérica al puente de CAO-S
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
    console.error("[CAO-S] Error de red llamando al puente:", e?.message || e);
    return { ok: false, error: String(e) };
  }
}

server.onSession(async (session, sessionId, userId) => {
  const deviceId = String(userId); // Identificador estable de estas gafas
  const deviceModel = session.device?.model ?? "Mentra";
  console.log(`[CAO-S] Sesión abierta. device_id=${deviceId} model=${deviceModel}`);

  session.layouts.showTextWall("CAO-S conectado. Di 'foto' o pulsa el botón.");

  // 1) Latido inmediato para que CAO-S registre las gafas
  await sendToCaos({
    device_id: deviceId,
    event_type: "heartbeat",
    device_model: deviceModel,
    battery_level: session.device?.batteryLevel ?? null,
  });

  // 2) Latido periódico mientras la sesión esté abierta
  const heartbeatTimer = setInterval(() => {
    sendToCaos({
      device_id: deviceId,
      event_type: "heartbeat",
      device_model: session.device?.model ?? deviceModel,
      battery_level: session.device?.batteryLevel ?? null,
    });
  }, HEARTBEAT_MS);

  // Cuando se cierre la sesión, parar latidos
  session.events.onDisconnected?.(() => {
    console.log(`[CAO-S] Sesión cerrada device_id=${deviceId}`);
    clearInterval(heartbeatTimer);
  });

  // 3) Escuchar voz: "foto" / "captura" / "saca foto"
  session.events.onTranscription(async (data) => {
    if (!data.isFinal) return;
    const text = (data.text || "").toLowerCase().trim();
    if (/\b(foto|captura|capturar|saca\s+foto)\b/.test(text)) {
      await takePhoto(session, deviceId);
    }
  });

  // 4) Botón físico de las gafas (si el firmware lo emite)
  session.events.onButtonPress?.(async () => {
    await takePhoto(session, deviceId);
  });
});

async function takePhoto(session, deviceId) {
  try {
    session.layouts.showTextWall("Capturando...");
    const photo = await session.camera.requestPhoto(); // { buffer, mimeType }
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
      session.layouts.showTextWall(`Error ${result.status || ""}`.trim());
      return;
    }

    // Mensaje según respuesta de CAO-S
    if (result.body?.includes("glasses_orphan")) {
      session.layouts.showTextWall("Gafas sin dueño. Reclámalas en CAO-S ('Son mías').");
    } else if (result.body?.includes("no_target_work")) {
      session.layouts.showTextWall("Sin obra activa. Empieza una en CAO-S.");
    } else {
      session.layouts.showTextWall("Foto enviada al diario ✓");
    }
  } catch (e) {
    console.error("[CAO-S] Excepción capturando foto:", e);
    session.layouts.showTextWall("Error al capturar");
  }
}

server.start().then(() => {
  console.log(`[CAO-S] Servidor de gafas escuchando en puerto ${PORT}`);
  console.log(`[CAO-S] Reenviando a: ${CAOS_BRIDGE_URL}`);
});
