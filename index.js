// Servidor puente CAO-S <-> Gafas Mentra
// Recibe fotos desde las gafas Mentra y las reenvía al diario de obra del usuario en CAO-S.
// Arreglar import appServer
import { AppServer } from "@mentra/sdk";
import fetch from "node-fetch";

const {
  MENTRA_API_KEY,
  MENTRA_PACKAGE_NAME,
  MENTRA_BRIDGE_SECRET,
  CAOS_BRIDGE_URL,
  PORT = 3000,
} = process.env;

if (!MENTRA_API_KEY || !MENTRA_PACKAGE_NAME || !MENTRA_BRIDGE_SECRET || !CAOS_BRIDGE_URL) {
  console.error("[CAO-S] Faltan variables de entorno. Revisa MENTRA_API_KEY, MENTRA_PACKAGE_NAME, MENTRA_BRIDGE_SECRET, CAOS_BRIDGE_URL");
  process.exit(1);
}

// Mapa en memoria: userId Mentra -> pairing_code CAO-S del usuario.
// El operario dice por voz "emparejar 123456" para vincular las gafas.
const pairingByUser = new Map();

const server = new AppServer({
  packageName: MENTRA_PACKAGE_NAME,
  apiKey: MENTRA_API_KEY,
  port: Number(PORT),
});

server.onSession(async (session, sessionId, userId) => {
  console.log(`[CAO-S] Sesión abierta: user=${userId}`);
  session.layouts.showTextWall("CAO-S listo. Di 'emparejar 123456' para vincular.");

  // Escuchar transcripciones para capturar el código de emparejamiento
  session.events.onTranscription(async (data) => {
    if (!data.isFinal) return;
    const text = (data.text || "").toLowerCase().trim();

    // "emparejar 123456" o "vincular 123456"
    const m = text.match(/(?:empareja(?:r)?|vincula(?:r)?)\s+(\d{6})/);
    if (m) {
      const code = m[1];
      pairingByUser.set(userId, code);
      console.log(`[CAO-S] user=${userId} emparejado con ${code}`);
      session.layouts.showTextWall(`Emparejado con CAO-S (${code}). Di 'foto' para capturar.`);
      return;
    }

    // "foto" o "captura" -> sacar foto
    if (/\b(foto|captura|capturar|saca foto)\b/.test(text)) {
      await takePhoto(session, userId);
    }
  });

  // Algunos firmwares emiten un evento de botón al pulsar las gafas
  session.events.onButtonPress?.(async () => {
    await takePhoto(session, userId);
  });
});

async function takePhoto(session, userId) {
  const pairingCode = pairingByUser.get(userId);
  if (!pairingCode) {
    session.layouts.showTextWall("No emparejado. Di 'emparejar 123456'.");
    return;
  }
  try {
    session.layouts.showTextWall("Capturando...");
    const photo = await session.camera.requestPhoto(); // { buffer, mimeType }
    const b64 = Buffer.from(photo.buffer).toString("base64");

    const battery = session.device?.batteryLevel ?? null;
    const model = session.device?.model ?? "Mentra";

    const res = await fetch(CAOS_BRIDGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-mentra-secret": MENTRA_BRIDGE_SECRET,
      },
      body: JSON.stringify({
        pairing_code: pairingCode,
        photo_base64: b64,
        photo_mime: photo.mimeType || "image/jpeg",
        battery_level: battery,
        device_model: model,
        captured_at: new Date().toISOString(),
      }),
    });

    if (!res.ok) {
      const txt = await res.text();
      console.error("[CAO-S] Error subiendo foto:", res.status, txt);
      session.layouts.showTextWall("Error: " + res.status);
      return;
    }
    session.layouts.showTextWall("Foto enviada al diario ✓");
  } catch (e) {
    console.error("[CAO-S] Excepción foto:", e);
    session.layouts.showTextWall("Error al capturar");
  }
}

server.start().then(() => {
  console.log(`[CAO-S] Servidor de gafas escuchando en puerto ${PORT}`);
});
