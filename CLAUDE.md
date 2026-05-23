# Zami AI Studio — Documentación Técnica v4 AION

## REGLA ABSOLUTA — COMANDOS SIEMPRE COMPLETOS

**NUNCA entregues un comando sin el `cd` correcto primero.**
La carpeta del proyecto es `C:\Users\LENOVO\zami-ai-studio-dev`.
Cada vez que des un comando git, bat o node — SIEMPRE incluye el cd al inicio:

```
cd C:\Users\LENOVO\zami-ai-studio-dev
git pull origin main
.\iniciar.bat
```

Si el usuario está en otra carpeta y ejecuta solo `git pull` o `.\iniciar.bat`, falla. Siempre entrega el bloque completo.

---

## INICIO DE SESIÓN — leer primero

Cuando el usuario diga **"vamos a trabajar"**, **"iniciemos"**, **"empecemos"**, **"start"** o cualquier frase de apertura, responde EXACTAMENTE con esto sin preguntar nada:

```
cd C:\Users\LENOVO\zami-ai-studio-dev
git pull origin main
.\iniciar.bat
```

Luego di: **"Abre http://127.0.0.1:3333 en el browser."**

No pidas confirmación. No preguntes por el .env. No expliques nada más.

---

## QUÉ ES ESTE PROYECTO

Automatización para crear influencers virtuales con IA — cualquier etnia, cualquier nicho.
El usuario configura el rostro manualmente vía AION (imágenes de referencia + parámetros hiperpersonalizados) y la IA genera el cuerpo y el perfil de personalidad.

**Stack operativo:**
- `server.cjs` — servidor Node.js local, cerebro de toda la automatización
- `server-ui.html` — interfaz visual en el browser (todo en un solo HTML)
- `iniciar.bat` — lanzador Windows
- `.env` — variables de entorno (nunca commitear)
- `data/influencers.json` — persistencia local de influencers y su historial de semanas

**Carpeta local:** `C:\Users\LENOVO\zami-ai-studio-dev`
**Rama activa:** `main`

---

## CÓMO FUNCIONA EL SERVIDOR

`iniciar.bat` mata cualquier proceso Node previo (`taskkill`) y lanza `node server.cjs`.
El browser abre `http://127.0.0.1:3333` — siempre IPv4, nunca `localhost`.
El servidor lee `.env` automáticamente al arrancar. No necesita `npm install`.

### Pipeline AION v4 — Fase 1: Generación de Rostro (Manual)

El usuario configura el nombre, nicho y parámetros de rostro, luego hace clic en **"▶ Generar influencer completa"**. La UI muestra 4 pasos animados:

```
PASO 1 — Generación de rostro con AION
  Browser: POST /api/generate-face {
    photo_type,           ← siempre requerido
    images: {             ← solo si toggle A está ON
      ojos, cejas, nariz, labios, frente,
      pomulos, piel, menton, cabello, "rostro completo"
    },
    params: {             ← solo si toggle B está ON
      43 COMBO params de AION
    },
    prompt: "..."         ← solo si toggle C está ON
  }
  Server:  POST ComfyDeploy /api/run/deployment/queue
           deployment_id: c6e6b7f0-e574-4aa8-9012-54e8507202e2
           inputs: { photo_type, "imagen final": "Nano Banana Pro", ...images, ...params, prompt? }
           ⚠️  "imagen final" es el prefijo del nombre del archivo de salida — siempre "Nano Banana Pro"
  Browser: polling GET /api/status/:runId cada 8s
  Result:  URL de imagen de rostro → se muestra en pantalla

PASO 2 — Prompt de cuerpo con Claude
  Browser: POST /api/generate-body-prompt { nombre, nicho, face_description }
           face_description = texto construido desde los inputs manuales del usuario
  Server:  POST Anthropic /v1/messages — Claude genera prompt de cuerpo
  Result:  prompt de texto para ComfyDeploy

PASO 3 — Generación de cuerpo
  Browser: POST /api/generate-body { prompt, input_image: <url_rostro> }
  Server:  POST ComfyDeploy /api/run/deployment/queue
           deployment_id: cabf22a3-a697-485c-a6df-b6c09ee4f2f1
  Browser: polling GET /api/status/:runId cada 8s
  Result:  URL de imagen de cuerpo → se muestra en pantalla

PASO 4 — Perfil AI Persona
  Browser: POST /api/generate-persona { nombre, nicho, face_url, body_url }
  Server:  POST Anthropic /v1/messages — Claude recibe ambas imágenes + template en español
  Result:  perfil completo en texto → renderizado como profile card editable
```

### Upload de imágenes de referencia (Toggle A)

```
Browser: FileReader → base64
Browser: POST /api/upload-image { name, data: "<base64>", type: "image/jpeg" }
Server:  decodifica base64 → buffer binary → POST Supabase Storage REST API
         /storage/v1/object/zami-images/refs/{timestamp}-{name}.{ext}
         Authorization: Bearer {SUPABASE_ANON_KEY}
         x-upsert: true
Server:  returns { url: "https://{SUPABASE_URL}/storage/v1/object/public/zami-images/refs/..." }
Browser: guarda url en uploadedImages[slotId]
```

### Fase 4 — Contenido UGC Semanal (sin cambios respecto a v3)

```
FASE 4 — Contenido Semanal (se repite cada semana por cada influencer)
  Usuario: selecciona influencer del panel → clic "Generar Plan Semanal"

  Paso A — Plan semanal:
    Browser: POST /api/generate-content-plan { persona, nombre, nicho, face_url, body_url, week_history }
    Server:  POST Anthropic /v1/messages
             Claude recibe AI Persona + historial de semanas previas + imágenes
             Genera autónomamente el tema de la semana y 5 días de contenido
             Cada día: escena, caption, hashtags, 4 variaciones de prompt (inglés, 80-120 palabras c/u)
    Result:  JSON con theme, summary, week[5 días × 4 variaciones]

  Paso B — Imágenes:
    Usuario: edita prompts si quiere → clic "Generar Semana Completa"
    Browser: POST /api/generate-content-day { face_url, body_url, prompts[4] } × 5 días en paralelo
    Server:  POST ComfyDeploy /api/run/deployment/queue × 5 runs simultáneos
             deployment_id: 8d4702cb-c504-4bf2-8284-ee17d6e66633
    Browser: polling cada run hasta success → muestra 4 imágenes por día (20 total)

  Paso C — Guardar semana:
    Browser: POST /api/influencers/:id/weeks { theme, summary, plan }
    Server:  Agrega semana al historial en data/influencers.json
```

---

## AION — PARÁMETROS Y MODOS

### Workflow deployment AION
- **Deployment ID:** `c6e6b7f0-e574-4aa8-9012-54e8507202e2`
- **Input `imagen final`:** siempre hardcodeado como `"Nano Banana Pro"` (prefijo del archivo de salida SaveImage)
- **Input `photo_type`:** siempre enviado; default `"-- Not selected / System inferred --"`

### Modos del nodo AION (determinados internamente por el nodo según qué inputs recibe)
- **auto_detect** — cuando se proveen imágenes de referencia (Toggle A ON)
- **manual_select** — cuando se proveen COMBO params (Toggle B ON)
- **generate_new** — cuando solo se provee prompt de texto (Toggle C ON)

### Toggle A — 10 slots de imágenes de referencia
Los slots se incluyen en el payload solo si tienen URL subida. Keys del objeto `images`:
```
ojos, cejas, nariz, labios, frente, pomulos, piel, menton, cabello, "rostro completo"
```
Cada imagen se sube a Supabase antes de enviarse a ComfyDeploy.

### Toggle B — 43 COMBO params
Grupos: Demographics, Eyes, Eyebrows, Nose, Lips, Structure, Volumes, Hair, Skin, Defects, Expression.
Se incluyen en el payload solo si el toggle B está ON. Si el toggle está OFF, las keys se omiten del payload (AION usa sus defaults internos).

### Toggle C — Prompt libre
Texto libre que describe el rostro. Se incluye solo si toggle C está ON y hay texto escrito.

---

## API CALLS — FORMATO EXACTO

### ComfyDeploy — AION Face Generation
```
POST https://api.comfydeploy.com/api/run/deployment/queue
Authorization: Bearer {VITE_COMFYDEPLOY_API_KEY}
Content-Type: application/json

{
  "deployment_id": "c6e6b7f0-e574-4aa8-9012-54e8507202e2",
  "inputs": {
    "photo_type": "...",
    "imagen final": "Nano Banana Pro",
    "prompt": "...",            ← solo si toggle C ON
    "ojos": "https://...",      ← solo si toggle A ON y slot tiene imagen
    "cejas": "https://...",
    ... (hasta 10 image slots)
    "sex": "Female",            ← solo si toggle B ON
    "ethnicity": "...",
    ... (hasta 43 COMBO params)
  }
}
→ { "run_id": "xxx" }
```

### Supabase Storage — Upload imagen
```
POST https://vtyuylgfjvleywupbdzl.supabase.co/storage/v1/object/zami-images/refs/{filename}
Authorization: Bearer {VITE_SUPABASE_ANON_KEY}
Content-Type: {image/jpeg|image/png|image/webp}
x-upsert: true
Body: binary buffer

→ { "Key": "zami-images/refs/{filename}" }
Public URL: https://vtyuylgfjvleywupbdzl.supabase.co/storage/v1/object/public/zami-images/refs/{filename}
```

**Bucket requerido:** `zami-images` — debe ser público con policy INSERT para rol `anon`.

### Anthropic — Body Prompt
```
POST https://api.anthropic.com/v1/messages
{ "model": "claude-sonnet-4-6", "max_tokens": 500,
  "messages": [{ "role": "user", "content": "<instrucción con face_description>" }] }
→ { "content": [{ "text": "<prompt de cuerpo en inglés>" }] }
```

### ComfyDeploy — Cuerpo
```
{ "deployment_id": "cabf22a3-a697-485c-a6df-b6c09ee4f2f1",
  "inputs": { "input_image": "<url_rostro>", "prompt": "...", "filename_prefix": "ComfyUI" } }
```

### ComfyDeploy — Fase 4 UGC
```
{ "deployment_id": "8d4702cb-c504-4bf2-8284-ee17d6e66633",
  "inputs": {
    "prompt 1": "...", "input_image 1": "<face>", "input_image 2": "<body>", "filename_prefix 1": "ComfyUI",
    "prompt 2": "...", "input_image 3": "<face>", "input_image 4": "<body>", "filename_prefix 2": "ComfyUI",
    "prompt 3": "...", "input_image 5": "<face>", "input_image 6": "<body>", "filename_prefix 3": "ComfyUI",
    "prompt 4": "...", "input_image 7": "<face>", "input_image 8": "<body>", "filename_prefix 4": "ComfyUI"
  } }
```

### ComfyDeploy — Polling de estado
```
GET https://api.comfydeploy.com/api/run/{run_id}
→ { "status": "queued|running|started|uploading|success|failed|cancelled|timeout",
    "outputs": [{ "data": { [nodeKey]: [{ "url": "https://...", "type": "image/png" }] } }] }

Estados terminales: success, failed, cancelled, timeout
El browser hace polling cada 8 segundos.
extractImages() parsea: array de outputs con data.[nodeKey][].url
```

### Anthropic — Perfil AI Persona
```
POST https://api.anthropic.com/v1/messages
{ "model": "claude-sonnet-4-6", "max_tokens": 4000,
  "messages": [{ "role": "user", "content": [
    { "type": "image", "source": { "type": "url", "url": "<face_url>" } },
    { "type": "image", "source": { "type": "url", "url": "<body_url>" } },
    { "type": "text", "text": "<template en español con 12 secciones>" }
  ]}] }
```

### Anthropic — Plan de Contenido Semanal
```
POST https://api.anthropic.com/v1/messages
{ "model": "claude-sonnet-4-6", "max_tokens": 8000,
  "messages": [{ "role": "user", "content": [
    { "type": "image", "source": { "type": "url", "url": "<face_url>" } },
    { "type": "image", "source": { "type": "url", "url": "<body_url>" } },
    { "type": "text", "text": "<AI Persona + historial + instrucciones>" }
  ]}] }
→ JSON con: { theme, summary, week[5] } — cada día tiene scene, caption, hashtags, variations[4]
```

---

## ENDPOINTS DEL SERVIDOR LOCAL

| Método | Ruta | Body | Descripción |
|---|---|---|---|
| `GET` | `/` | — | Sirve server-ui.html |
| `POST` | `/api/upload-image` | `{ name, data: base64, type }` | Sube imagen a Supabase Storage → retorna `{ url }` |
| `POST` | `/api/generate-face` | `{ photo_type, images?, params?, prompt? }` | AION face generation en ComfyDeploy |
| `POST` | `/api/generate-body-prompt` | `{ nombre, nicho, face_description }` | Claude genera prompt de cuerpo |
| `POST` | `/api/generate-body` | `{ prompt, input_image }` | Genera cuerpo en ComfyDeploy |
| `POST` | `/api/generate-persona` | `{ nombre, nicho, face_url, body_url }` | Claude genera perfil AI Persona |
| `GET` | `/api/status/:runId` | — | Polling de estado ComfyDeploy |
| `GET` | `/api/influencers` | — | Lista influencers guardadas |
| `POST` | `/api/influencers` | `{ nombre, nicho, face_url, body_url, persona }` | Guarda nueva influencer |
| `POST` | `/api/influencers/:id/weeks` | `{ theme, summary, plan }` | Guarda semana en historial |
| `POST` | `/api/generate-content-plan` | `{ persona, nombre, nicho, face_url, body_url, week_history }` | Claude genera plan semanal |
| `POST` | `/api/generate-content-day` | `{ face_url, body_url, prompts[4] }` | Lanza 1 run → 4 imágenes UGC |

**Endpoints eliminados (v4):**
- `POST /api/generate-prompt` — ya no existe; Claude no genera el prompt de rostro
- `POST /api/generate` — reemplazado por `/api/generate-face`

---

## UI — FLUJO VISUAL (server-ui.html v4 AION)

```
┌─────────────────────────────────────────────────┐
│  Zami AI Studio [v3 AION]                       │
│  "Configura el rostro manualmente con AION"     │
├─────────────────────────────────────────────────┤
│  MIS INFLUENCERS                 [+ Nueva]      │
│  ┌────────┐ ┌────────┐                          │
│  │Valentina│ │ Luna   │  ← cards guardadas      │
│  └────────┘ └────────┘                          │
├─────────────────────────────────────────────────┤
│  CREAR INFLUENCER                               │
│                                                 │
│  [NOMBRE ___________] [NICHO ___________]       │
│  [PHOTO TYPE ▼]   ← siempre visible             │
│                                                 │
│  [◉ Toggle A] Imágenes de referencia            │
│    10 slots drag-drop: ojos, cejas, nariz,      │
│    labios, frente, pómulos, piel, mentón,       │
│    cabello, rostro completo                     │
│                                                 │
│  [◉ Toggle B] Parámetros AION                   │
│    43 COMBO dropdowns agrupados por categoría   │
│    (Demographics, Eyes, Eyebrows, Nose, Lips,   │
│     Structure, Volumes, Hair, Skin, Defects,    │
│     Expression)                                 │
│                                                 │
│  [◉ Toggle C] Prompt libre                      │
│    textarea de descripción de rostro            │
│                                                 │
│  [▶ GENERAR INFLUENCER COMPLETA]                │
│                                                 │
│  ○─ 1. Generando rostro con AION                │
│  ○─ 2. Generando prompt de cuerpo con IA        │
│  ○─ 3. Generando cuerpo con ComfyDeploy         │
│  ○─ 4. Generando perfil completo con Claude     │
│                                                 │
│  [Guardar Influencer] ← al terminar             │
├─────────────────────────────────────────────────┤
│  FASE 4 — Contenido Semanal UGC                 │
│  [Generar Plan Semanal]                         │
│  [Generar Semana — 20 imágenes]                 │
│  [Guardar semana en historial]                  │
└─────────────────────────────────────────────────┘
```

---

## ARCHIVOS DEL PROYECTO

| Archivo | Función |
|---|---|
| `server.cjs` | Servidor local — pipeline AION v4 + Fases 2–4 operativas |
| `server-ui.html` | UI v4 AION — 3 toggles + upload + 43 params + 4-step pipeline |
| `iniciar.bat` | Lanzador Windows — mata node previo, arranca server |
| `.env` | Variables de entorno (no commitear nunca) |
| `.env.example` | Template de variables para configurar el proyecto |
| `data/influencers.json` | Persistencia local de influencers y historial de semanas |

---

## VARIABLES DE ENTORNO (`.env`)

```env
# REQUERIDAS para el pipeline actual
VITE_COMFYDEPLOY_API_KEY=       ← todas las fases de imágenes
ANTHROPIC_API_KEY=              ← body prompt, persona, plan semanal

# DEPLOYMENT IDs activos
VITE_COMFYDEPLOY_AION_DEPLOYMENT_ID=c6e6b7f0-e574-4aa8-9012-54e8507202e2
VITE_COMFYDEPLOY_BODY_DEPLOYMENT_ID=cabf22a3-a697-485c-a6df-b6c09ee4f2f1
VITE_COMFYDEPLOY_CONTENT_DEPLOYMENT_ID=8d4702cb-c504-4bf2-8284-ee17d6e66633

# Supabase Storage (upload de imágenes de referencia)
VITE_SUPABASE_URL=https://vtyuylgfjvleywupbdzl.supabase.co
VITE_SUPABASE_ANON_KEY=         ← anon key del proyecto Supabase
SUPABASE_BUCKET=zami-images     ← bucket público con INSERT policy para anon

# PENDIENTES para fases futuras
VITE_COMFYDEPLOY_NSFW_DEPLOYMENT_ID=
VITE_FAL_API_KEY=
```

---

## ESTADO DEL PIPELINE

| Fase | Nombre | Motor | Estado |
|---|---|---|---|
| 1 | Generación de Rostro AION (manual) | ComfyDeploy `c6e6b7f0` (AION Gemini) | ✅ Operativo |
| 2 | Prompt de Cuerpo | Anthropic `claude-sonnet-4-6` | ✅ Operativo |
| 3 | Generación de Cuerpo | ComfyDeploy `cabf22a3` | ✅ Operativo |
| 4 | Perfil AI Persona | Anthropic `claude-sonnet-4-6` — texto en español | ✅ Operativo |
| Fase 4 | Contenido UGC Semanal | Claude + ComfyDeploy `8d4702cb` | ✅ Operativo |
| Fase 5 | Publicación | Por definir | ⏳ |
| Fase 6 | KPIs | Supabase | ⏳ |

**Eliminado en v4:** Prompt de Rostro con IA (Claude) — reemplazado completamente por inputs manuales AION.

---

## DECISIONES TÉCNICAS IMPORTANTES

- **Sin AI face prompt** — Claude ya no genera el prompt de rostro. El rostro es 100% manual: el usuario controla etnia, rasgos, proporciones via AION.
- **Toggle = omit** — cuando un toggle está OFF, esas keys se omiten del payload de ComfyDeploy completamente. AION usa sus defaults internos para inputs faltantes.
- **Upload Supabase antes de ComfyDeploy** — las imágenes de referencia se suben primero a Supabase Storage y se pasa la URL pública a ComfyDeploy (no se pueden pasar binarios directamente).
- **`imagen final` hardcodeado** — siempre `"Nano Banana Pro"`, es el prefijo del archivo de output del nodo SaveImage en AION. No es configurable por el usuario.
- **face_description para body prompt** — `buildFaceDescription()` construye el texto de descripción del rostro a partir de los inputs manuales del usuario (parámetros AION seleccionados + prompt libre) para pasarlo a Claude en el paso 2.
- **43 COMBO params como ExternalEnum** — cada uno es un nodo `ComfyUIDeployExternalEnum` en el workflow AION. Las opciones deben pasarse como JSON array string.
- **10 image slots como ExternalImage** — cada slot es un nodo `ComfyUIDeployExternalImage`. Se pasa la URL pública de Supabase.
- **pipeline v3 legacy** — `/api/generate` (face con deployment `d3e4cb7d`) fue removido. Si se necesita el viejo rostro, no está disponible.
- **Supabase bucket `zami-images`** — debe ser público. Policy SQL: `CREATE POLICY "anon insert" ON storage.objects FOR INSERT TO anon WITH CHECK (bucket_id = 'zami-images');`
- **`iniciar.bat` hace `taskkill`** — mata cualquier proceso Node previo antes de arrancar. Evita el error "port in use".
- **Polling cada 8 segundos** — ComfyDeploy tarda 1–5 minutos. El browser pregunta automáticamente hasta recibir estado terminal.
- **Fase 4: 1 run por día = 4 imágenes** — el workflow `8d4702cb` genera 4 imágenes en un run. Se lanzan 5 runs en paralelo → 20 imágenes totales.
- **Fase 4 — Outfit siempre variable** — los prompts NUNCA copian el outfit de las imágenes de referencia. El cuerpo es pasaporte biológico (proporciones), no plantilla de ropa.
- **Campos editables en profile card** — `contenteditable="true"` en cada valor. El usuario edita directo en pantalla.

---

## SUPABASE BUCKET — SETUP

Si el bucket `zami-images` no existe o no está configurado:

1. Ir a https://supabase.com → tu proyecto → Storage
2. Crear bucket `zami-images`, marcar como **Public**
3. En SQL Editor, ejecutar:
```sql
-- Policy para que anon pueda hacer INSERT
CREATE POLICY "anon insert" ON storage.objects
FOR INSERT TO anon
WITH CHECK (bucket_id = 'zami-images');
```
4. Copiar la `anon key` de Settings → API → Project API keys → `anon public`
5. Pegarla en `.env` como `VITE_SUPABASE_ANON_KEY=`

---

## PROMPT DEL NODO COMFYDEPLOY — Fase 4 (deployment `8d4702cb`)

Este texto se configura como instrucción base en el workflow de ComfyDeploy. Si se regenera o migra el deployment, debe replicarse exactamente.

```
You are a professional UGC content photography engine for AI influencer accounts. You ALWAYS generate an image — never text, never explanations.

INPUT:
You receive TWO reference images and ONE creative prompt.
— Reference Image 1: face of the influencer
— Reference Image 2: full-body shot of the influencer
— Creative prompt: describes the exact scene, outfit, pose, location, and shot type for this image

REFERENCE USAGE — READ THIS CAREFULLY:
The reference images are NOT templates to clone. They are biological passports.

From the FACE reference → extract and lock: bone structure, exact skin tone (match hex-level accuracy), eye shape and color, nose bridge and tip shape, lip shape and fullness, jawline, brow shape, hair color and texture, approximate age and ethnicity. This face must appear in the output identically.

From the BODY reference → extract and lock: figure proportions (height-to-width ratio), waist-to-hip ratio, bust size, leg length, skin tone continuity from neck to toe. DO NOT replicate the outfit, background, or any clothing from this image. It exists only to give you body proportions.

OUTFIT PROTOCOL — NON-NEGOTIABLE:
The creative prompt dictates the outfit. NEVER default to the outfit visible in the body reference image.
All outfits must be form-fitting, body-conscious, and sexy — matching the context of the scene.

PHOTOGRAPHY STYLE — UGC PHONE REALISM (MANDATORY):
Device simulation: iPhone 15 Pro or Samsung Galaxy S24 Ultra Portrait mode.
Grain, imperfect focus, motion blur, lens flare, slight overexposure, warm-neutral color grade, off-center composition. These are features, not mistakes.

FINAL OUTPUT:
ONE photograph. Portrait orientation. Instagram-ready. Sexy, real, aspirational.
```

---

## TROUBLESHOOTING

**Error "Not found" en rutas del servidor:**
El proceso node viejo sigue corriendo. Correr `.\iniciar.bat` de nuevo.

**La imagen de rostro no aparece tras `success`:**
Revisar la terminal — buscar `OUTPUTS:` para ver el JSON crudo de la API.

**Upload de imagen falla:**
- Verificar que `VITE_SUPABASE_ANON_KEY` esté en `.env`
- Verificar que bucket `zami-images` sea público con policy INSERT para anon
- Reiniciar servidor después de cambiar `.env`

**AION genera rostro distinto a las imágenes de referencia:**
Las imágenes de referencia se pasan pero el nodo interno AION controla el peso. No es configurable desde la API.

**ComfyDeploy retorna error en `/api/generate-face`:**
Verificar que `VITE_COMFYDEPLOY_AION_DEPLOYMENT_ID` esté en `.env` y que el deployment `c6e6b7f0` esté activo en ComfyDeploy.

**Las imágenes de Fase 4 replican el outfit de la imagen de cuerpo:**
El nodo del workflow `8d4702cb` en ComfyDeploy no tiene el system prompt actualizado. Ver sección "PROMPT DEL NODO COMFYDEPLOY" arriba.

**El servidor no lee cambios del `.env`:**
Siempre reiniciar con `.\iniciar.bat` después de editar el `.env`.

**Regla PowerShell:** Siempre `.\iniciar.bat` con el `.\` — sin el punto barra falla.
**Carpeta correcta:** `C:\Users\LENOVO\zami-ai-studio-dev`
