// Servidor puente CAO-S <-> Gafas Mentra
// Foto por voz ("oye caos, foto") + botón + videollamada WebRTC directa
// (mismo modo "Stream Here" que usa la app oficial de Mentra).
// Nunca toca RTMP.

import * as MentraSDK from "@mentra/sdk";
import fetch from "node-fetch";

const ServerBase =
  MentraSDK.AppServer ||
  MentraSDK.TpaServer ||
  MentraSDK.default?.AppServer ||
  MentraSDK.default?.TpaServer;

if (!ServerBase) {
  console.error("[CAO-S] No se encontró AppServer/TpaServer en @mentra/sdk");
  process.exit(1);
}

const {
  MENTRA_PACKAGE_NAME,
  MENTRA_API_KEY,
  PORT = "3000",
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

if (!MENTRA_PACKAGE_NAME || !MENTRA_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("[CAO-S] Faltan variables de entorno obligatorias");
  process.exit(1);
}

const BRIDGE_URL = `${SUPABASE_URL}/functions/v1/mentra-bridge`;

async function callBridge(payload) {
  try {
    const res = await fetch(BRIDGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error("[CAO-S] Bridge error:", res.status, txt);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error("[CAO-S] Bridge fetch failed:", e?.message || e);
    return null;
  }
}

async function handlePhoto(session, deviceId) {
  try {
    const photo = await session.camera?.requestPhoto?.();
    if (!photo?.buffer) {
      console.warn("[CAO-S] requestPhoto no devolvió buffer");
      return;
    }
    const base64 = Buffer.from(photo.buffer).toString("base64");
    await callBridge({
      event_type: "photo",
      device_id: deviceId,
      device_model: session.device?.model || "mentra",
      battery_level: session.device?.batteryLevel ?? null,
      photo_base64: base64,
      mime: photo.mimeType || "image/jpeg",
    });
    console.log("[CAO-S] Foto enviada al puente");
  } catch (e) {
    console.error("[CAO-S] Error capturando foto:", e?.message || e);
  }
}

class CaosServer extends ServerBase {
  async onSession(session, sessionId, userId) {
    const deviceId = userId || sessionId;
    console.log("[CAO-S] Sesión abierta:", deviceId);

    // Aviso inicial al puente
    await callBridge({
      event_type: "session_open",
      device_id: deviceId,
      device_model: session.device?.model || "mentra",
      battery_level: session.device?.batteryLevel ?? null,
    });

    // ===== LATIDO REAL CADA 20s =====
    // Solo se manda mientras la sesión sigue viva de verdad.
    // Si las gafas se apagan, la sesión cae y dejamos de mandarlo.
    const heartbeat = setInterval(async () => {
      try {
        await callBridge({
          event_type: "heartbeat",
          device_id: deviceId,
          device_model: session.device?.model || "mentra",
          battery_level: session.device?.batteryLevel ?? null,
        });
      } catch (e) {
        console.error("[CAO-S] Heartbeat error:", e?.message || e);
      }
    }, 20_000);

    // ===== LIMPIEZA AL DESCONECTAR =====
    session.events?.onDisconnected?.(async () => {
      clearInterval(heartbeat);
      console.log("[CAO-S] Sesión cerrada:", deviceId);
      await callBridge({
        event_type: "session_close",
        device_id: deviceId,
      });
    });

    // Voz: "oye caos, foto"
    session.events?.onTranscription?.(async (text) => {
      try {
        const t = (text || "").toLowerCase();
        if (t.includes("caos") && t.includes("foto")) {
          await handlePhoto(session, deviceId);
        }
      } catch (e) { console.error("[CAO-S] Voz:", e?.message || e); }
    });

    // Botón físico
    session.events?.onButtonPress?.(async () => {
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
