// ───────────────────────────────────────────────
// Capturar foto (idéntico al código que funcionaba) + voz de respuesta
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

    if (!result.ok) {
      try { session.layouts?.showTextWall?.(`Error ${result.status || ""}`.trim()); } catch {}
      return;
    }

    // Mensaje en pantalla según respuesta
    if (result.body?.includes("glasses_orphan")) {
      try { session.layouts?.showTextWall?.("Gafas sin dueño. Reclámalas en CAO-S."); } catch {}
    } else if (result.body?.includes("no_target_work")) {
      try { session.layouts?.showTextWall?.("Sin obra activa en CAO-S."); } catch {}
    } else {
      try { session.layouts?.showTextWall?.("Foto enviada al diario ✓"); } catch {}
    }

    // 🔊 Reproducir voz de CAO-S si viene en la respuesta
    const speak = result.data?.speak;
    const audioB64 = speak?.audio_base64 || result.data?.audio_base64;
    const audioMime = speak?.mime || speak?.audio_mime || "audio/mpeg";
    if (audioB64) {
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
        }
        console.log(`[CAO-S] 🔊 voz reproducida (${audioB64.length} chars b64)`);
      } catch (e) {
        console.error("[CAO-S] Error reproduciendo voz:", e?.message || e);
      }
    } else {
      console.log("[CAO-S] La respuesta no traía audio para hablar");
    }
  } catch (e) {
    console.error("[CAO-S] Excepción foto:", e?.message || e);
    try { session.layouts?.showTextWall?.("Error al capturar"); } catch {}
  }
}
