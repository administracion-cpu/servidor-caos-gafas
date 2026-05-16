# Servidor de las gafas CAO-S

Este servidor hace de puente entre tus gafas Mentra y la app CAO-S.

## Cómo subirlo a Railway (5 minutos)

1. Entra en railway.app y pulsa **New Project → Deploy from GitHub repo** (o **Empty Project** y luego sube esta carpeta como ZIP).
2. Cuando esté creado, ve a la pestaña **Variables** y añade estas 4:

   - `MENTRA_API_KEY` → la API Key que copiaste de console.mentra.glass
   - `MENTRA_PACKAGE_NAME` → el nombre del paquete (ej: `com.caos.gafas`)
   - `MENTRA_BRIDGE_SECRET` → la contraseña secreta que te dio CAO-S
   - `CAOS_BRIDGE_URL` → `https://xnawzzrfbwumhnbmrswk.supabase.co/functions/v1/mentra-bridge`

3. Railway lo arranca solo. Cuando esté en verde, copia la URL pública que te da Railway (algo tipo `https://caos-gafas-production.up.railway.app`).
4. Vuelve a console.mentra.glass, abre tu app y en **Public URL** pega la URL de Railway. Guarda.

## Cómo se usa con las gafas

1. En la app CAO-S, entra en **Mis Gafas** y mira tu código de 6 cifras.
2. Pon las gafas, abre la app de Mentra en el móvil y arranca tu app de CAO-S.
3. Di en voz alta: **"emparejar 123456"** (tu código).
4. Para hacer una foto, di **"foto"** o pulsa el botón de las gafas.
5. La foto aparece sola en el diario de la obra que tengas activa.
