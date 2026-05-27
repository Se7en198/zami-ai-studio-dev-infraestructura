'use strict'

const http   = require('http')
const https  = require('https')
const fs     = require('fs')
const path   = require('path')
const url    = require('url')
const crypto = require('crypto')

// ── load .env manually (no external deps) ───────────────────────────────────
function loadEnv() {
  const envPath = path.join(__dirname, '.env')
  if (!fs.existsSync(envPath)) return
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)$/)
    if (m) process.env[m[1]] = cleanEnvValue(m[2])
  })
}

function cleanEnvValue(value) {
  let v = value.trim()
  if (!v) return ''
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1)
  }
  const hash = v.search(/\s#/)
  if (hash !== -1) v = v.slice(0, hash).trim()
  return v.replace(/^["']|["']$/g, '')
}
loadEnv()

const API_KEY               = process.env.VITE_COMFYDEPLOY_API_KEY || ''
const ANTHROPIC_KEY         = process.env.ANTHROPIC_API_KEY || ''
const ANTHROPIC_MODEL       = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'
const DEPLOYMENT_ID_AION    = process.env.VITE_COMFYDEPLOY_AION_DEPLOYMENT_ID || 'e833a575-893b-49f2-8687-4aa5291d31cc'
const DEPLOYMENT_ID_BODY    = process.env.VITE_COMFYDEPLOY_BODY_DEPLOYMENT_ID || 'cabf22a3-a697-485c-a6df-b6c09ee4f2f1'
const DEPLOYMENT_ID_CONTENT = 'f9822b81-9ebc-48e2-b39c-0e8034e90554'  // Fase 4 UGC — ComfyDeploy (14 slots)
const SUPABASE_URL          = process.env.VITE_SUPABASE_URL || ''
const SUPABASE_KEY          = process.env.VITE_SUPABASE_ANON_KEY || ''
const SUPABASE_BUCKET       = process.env.SUPABASE_BUCKET || 'zami-images'
const PORT                  = 3333
const HOST                  = '127.0.0.1'
const CD_BASE               = 'api.comfydeploy.com'
const DATA_DIR              = path.join(__dirname, 'data')
const INFLUENCERS_FILE      = path.join(DATA_DIR, 'influencers.json')
const MAX_JSON_BODY_BYTES   = 25 * 1024 * 1024
const MAX_UPLOAD_BYTES      = 8 * 1024 * 1024
const ALLOWED_IMAGE_TYPES   = new Set(['image/jpeg', 'image/png', 'image/webp'])
const IMAGE_EXTENSIONS      = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
let influencerWriteQueue    = Promise.resolve()

// ── Influencers persistence ──────────────────────────────────────────────────
function loadInfluencers() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  if (!fs.existsSync(INFLUENCERS_FILE)) fs.writeFileSync(INFLUENCERS_FILE, JSON.stringify({ influencers: [] }))
  try { return JSON.parse(fs.readFileSync(INFLUENCERS_FILE, 'utf8')) }
  catch (err) {
    const backup = path.join(DATA_DIR, `influencers.corrupt.${Date.now()}.json`)
    try { fs.copyFileSync(INFLUENCERS_FILE, backup) } catch {}
    throw new Error(`data/influencers.json corrupto; backup creado en ${path.basename(backup)}. ${err.message}`)
  }
}

function saveInfluencers(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = `${INFLUENCERS_FILE}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, INFLUENCERS_FILE)
}

function updateInfluencers(mutator) {
  const job = influencerWriteQueue.then(() => {
    const data = loadInfluencers()
    const result = mutator(data)
    saveInfluencers(data)
    return result
  })
  influencerWriteQueue = job.catch(() => {})
  return job
}

// ── ComfyDeploy helpers ──────────────────────────────────────────────────────
function cdRequest(method, cdPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null
    const opts = {
      hostname: CD_BASE,
      path: cdPath,
      method,
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type':  'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }
    const req = https.request(opts, res => {
      let raw = ''
      res.on('data', d => raw += d)
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }) }
        catch { resolve({ status: res.statusCode, body: raw }) }
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

// ── Content UGC generation → vía ComfyDeploy (deployment f9822b81, 14 slots) ─
// prompts8: array de 8 strings. Slots 9-14 se envían vacíos (el workflow los necesita).
// Devuelve 'cdc:{run_id}' — prefijo permite detectar branch correcto en /api/status.
async function startComfyDeployContentRun(faceUrl, bodyUrl, prompts8) {
  const inputs = {}

  // Slots 1-8: prompts reales de Claude + prefijo ZCS para identificar en outputs
  for (let i = 1; i <= 8; i++) {
    inputs[`rostro ${i}`]           = faceUrl
    inputs[`cuerpo ${i}`]           = bodyUrl
    inputs[`prompt contenido ${i}`] = String(prompts8[i - 1] || '')
    inputs[`contenido final ${i}`]  = `ZCS${i}`
  }
  // Slots 9-14: el deployment los requiere — GeminiImage2Node exige prompt min_length=1.
  // Reutilizamos los primeros prompts cíclicamente para evitar el error de validación.
  for (let i = 9; i <= 14; i++) {
    inputs[`rostro ${i}`]           = faceUrl
    inputs[`cuerpo ${i}`]           = bodyUrl
    inputs[`prompt contenido ${i}`] = String(prompts8[(i - 9) % prompts8.length] || 'Lifestyle editorial portrait of this influencer')
    inputs[`contenido final ${i}`]  = `skip${i}`
  }

  console.log('  [CD-CONTENT] Enviando a ComfyDeploy (14 slots, usando 8)...')
  console.log('  [CD-CONTENT] inputs slot 1:', JSON.stringify({
    'rostro 1':           inputs['rostro 1'],
    'cuerpo 1':           inputs['cuerpo 1'],
    'prompt contenido 1': inputs['prompt contenido 1'],
    'contenido final 1':  inputs['contenido final 1'],
  }, null, 2))
  const res = await cdRequest('POST', '/api/run/deployment/queue', {
    deployment_id: DEPLOYMENT_ID_CONTENT,
    inputs,
  })
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`ComfyDeploy content ${res.status}: ${JSON.stringify(res.body)}`)
  }
  const runId = res.body.run_id
  console.log(`  [CD-CONTENT] run_id: ${runId}`)
  return 'cdc:' + runId
}

// ── AION face generation ─────────────────────────────────────────────────────
async function startAionRun(inputs) {
  const res = await cdRequest('POST', `/api/run/deployment/queue`, {
    deployment_id: DEPLOYMENT_ID_AION,
    inputs,
  })
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`ComfyDeploy ${res.status}: ${JSON.stringify(res.body)}`)
  }
  return res.body.run_id
}

// ── Supabase Storage upload ──────────────────────────────────────────────────
function uploadToSupabase(buffer, filename, contentType) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return Promise.reject(new Error('Supabase no configurado. Agrega VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY en .env'))
  }
  const hostname = SUPABASE_URL.replace(/^https?:\/\//, '').split('/')[0]
  return new Promise((resolve, reject) => {
    const opts = {
      hostname,
      path: `/storage/v1/object/${SUPABASE_BUCKET}/${filename}`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  contentType || 'image/jpeg',
        'Content-Length': buffer.length,
        'x-upsert': 'true',
      },
    }
    const req = https.request(opts, res => {
      let raw = ''
      res.on('data', d => raw += d)
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          resolve(`${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${filename}`)
        } else {
          reject(new Error(`Supabase ${res.statusCode}: ${raw}`))
        }
      })
    })
    req.on('error', reject)
    req.write(buffer)
    req.end()
  })
}

// ── Body generation (legacy — deployment cabf22a3) ───────────────────────────
async function startBodyRun(prompt, inputImage) {
  const res = await cdRequest('POST', `/api/run/deployment/queue`, {
    deployment_id: DEPLOYMENT_ID_BODY,
    inputs: {
      input_image:     String(inputImage),
      filename_prefix: 'ComfyUI',
      prompt:          String(prompt),
    },
  })
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`ComfyDeploy ${res.status}: ${JSON.stringify(res.body)}`)
  }
  return res.body.run_id
}

// ── Body generation v2 — Nano Banana Pro (Gemini) via image_rostro (deployment c6e6b7f0) ──
async function startBodyRunV2(faceUrl, promptBody) {
  const res = await cdRequest('POST', `/api/run/deployment/queue`, {
    deployment_id: DEPLOYMENT_ID_AION,
    inputs: {
      'image_rostro': String(faceUrl),
      'prompt_body':  String(promptBody),
      'save_image':   'ComfyUI',
    },
  })
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`ComfyDeploy ${res.status}: ${JSON.stringify(res.body)}`)
  }
  return res.body.run_id
}

// ── Content UGC generation → vía ComfyCloud (startComfyCloudContentRun) ─────
// startContentRun eliminado — deployment c6e6b7f0 ya no tiene nodos de contenido.

// ── AI Persona generation — Claude API ───────────────────────────────────────
async function generatePersona(nombre, nicho, faceUrl, bodyUrl) {
  const content = []
  if (faceUrl) content.push({ type: 'image', source: { type: 'url', url: faceUrl } })
  if (bodyUrl) content.push({ type: 'image', source: { type: 'url', url: bodyUrl } })
  content.push({ type: 'text', text: `Eres un experto en crear perfiles de influencers virtuales para redes sociales y contenido digital.

REGLA FÍSICA CRÍTICA — NO NEGOCIABLE:
Para TODO lo relacionado con apariencia física (rasgos distintivos, lunares, pecas, tatuajes, piercings, cicatrices, marcas de nacimiento), describe ÚNICAMENTE lo que puedas confirmar claramente en las imágenes adjuntas. Si no lo ves con certeza → escribe "No visible". NUNCA inventes rasgos físicos que no estén claramente presentes en las imágenes. El resto de campos (vida, gustos, personalidad, hobbies, historia) SÍ son creativos — invéntale una vida completa, rica y aspiracional.

Datos del personaje:
- Nombre artístico: ${nombre}
- Nicho de contenido: ${nicho}

${faceUrl ? 'Te adjunto la imagen del ROSTRO — úsala para describir: color de ojos, tono de piel, color y estilo de cabello. Para rasgos distintivos (lunares, pecas): SOLO si son claramente visibles en la imagen; si no, escribe "Ninguno visible".' : ''}
${bodyUrl ? 'Te adjunto la imagen del CUERPO — úsala para describir: altura estimada, constitución física y cualquier rasgo claramente visible.' : ''}

Llena CADA campo de forma creativa, específica y coherente con el nicho y las imágenes. Hazla carismática, única, atractiva y SEXY — ella es una influencer aspiracional, magnética, siempre bella y poderosa en su imagen. Responde TODO en español. Escribe SOLO el template llenado, sin comentarios adicionales.

💎 AI PERSONA TEMPLATE 💋

📛 Alias
Stage Name: ${nombre}
Nombre Real: ___
Usuario/Handle: @___
Apodos: ___
Edad: ___
Cumpleaños: ___
Signo Zodiacal: ___

📏 Físico & Apariencia
Altura: ___
Talla de zapatos: ___
Color/Estilo de cabello: ___
Color de ojos: ___
Tono de piel: ___
Rasgos Distintivos (lunares, pecas, etc.): ___ (Solo si claramente visible en imágenes — si no: "Ninguno visible")

🌍 Origen & Ubicación
Etnicidad: ___
Ciudad natal (lo que creen los fans): ___
Ubicación actual (lo que asumen los fans): ___
Cómo la conocieron los fans (momentos virales, rumores): ___

🐾 Estilo de Vida
Mascotas (nombre + tipo): ___
Trabajo (si aplica): ___
Familia (público o privado): ___

🍣 Favoritos & Antojos
Comida favorita: ___
Restaurante favorito: ___
Trago/Bebida favorita: ___
Comida trampa: ___

🎵 Vibe Musical
Géneros musicales: ___
Artistas favoritos: ___
Canción de cabecera: ___

🎬 Entretenimiento
Géneros favoritos de películas/series: ___
Series o películas top: ___
Lo que ve para relajarse: ___

💫 Hobbies & Hábitos
(lista 3–5): ___
Talento secreto: ___

📲 Huella Digital
Emojis más usados: ___
Frases típicas en mensajes:
 - "___"
 - "___"
 - "___"
Estilo al escribir (argot, coqueta, formal, reina de los audios, etc.): ___

🔥 Persona de Contenido
Nicho: ${nicho}
Estilo de representación (glam, chica de al lado, dominante, etc.): ___
Temas recurrentes: ___
Lo que más les gusta a sus fans: ___
Nivel de sensualidad del contenido: Siempre presente — outfits que marcan curvas, poses confiadas y poderosas, siempre bella y magnética sin importar el nicho.

🖋️ Modificaciones Corporales
Tatuajes: ___ (Solo si claramente visible en imágenes — si no: "No visible")
Piercings: ___ (Solo si claramente visible en imágenes — si no: "No visible")
Cicatrices/Marcas de nacimiento: ___ (Solo si claramente visible en imágenes — si no: "No visible")

🧠 Personalidad
3 Palabras que la describen: ___ ___ ___
Nivel de coqueteo: 😇 Bajo / 😏 Medio / 😈 Alto
Arquetipo (ej. femme fatale, chica de al lado, CEO baddie): ___
Fantasía principal que encarna para sus fans: ___` })

  const payload = JSON.stringify({
    model: ANTHROPIC_MODEL,
    max_tokens: 4000,
    messages: [{ role: 'user', content }],
  })

  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
        'content-length':    Buffer.byteLength(payload),
      },
    }
    const req = https.request(opts, res => {
      let raw = ''
      res.on('data', d => raw += d)
      res.on('end', () => {
        try {
          const data = JSON.parse(raw)
          if (res.statusCode !== 200) throw new Error(`Anthropic ${res.statusCode}: ${JSON.stringify(data)}`)
          resolve(data.content[0].text)
        } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

// ── Body prompt generation — Claude API ──────────────────────────────────────
async function generateBodyPrompt(nombre, nicho, faceDescription) {
  const promptText = `You are an expert prompt engineer for a high-fidelity AI image generator.
Create an ultra-detailed, hyperdescriptive prompt in English to generate the full body of a virtual latina influencer named ${nombre} whose content niche is ${nicho}.

${faceDescription ? `Face reference: ${faceDescription}` : ''}

The prompt MUST include ALL of the following with maximum specificity:
- Physical build consistent with the niche (e.g., "athletic toned physique with curves" for fitness)
- Exact outfit typical of her niche (e.g., "high-waist sports leggings, cropped sports bra, Nike sneakers")
- Accessories and styling details
- Pose (e.g., "standing three-quarter view, hand on hip, confident stance")
- Setting/background
- Lighting (e.g., "soft studio lighting, slight warm gradient")
- Quality tags (e.g., "full body shot, fashion photography, 35mm lens, 8k, photorealistic")

Output ONLY the prompt text. No explanations, no quotes, no labels.`

  const payload = JSON.stringify({
    model: ANTHROPIC_MODEL,
    max_tokens: 500,
    messages: [{ role: 'user', content: promptText }],
  })

  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
        'content-length':    Buffer.byteLength(payload),
      },
    }
    const req = https.request(opts, res => {
      let raw = ''
      res.on('data', d => raw += d)
      res.on('end', () => {
        try {
          const data = JSON.parse(raw)
          if (res.statusCode !== 200) throw new Error(`Anthropic ${res.statusCode}: ${JSON.stringify(data)}`)
          resolve(data.content[0].text.trim())
        } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

// ── Content plan generation — Claude API ─────────────────────────────────────
async function generateContentPlan(nombre, nicho, persona, faceUrl, bodyUrl, weekHistory) {
  const content = []
  if (faceUrl) content.push({ type: 'image', source: { type: 'url', url: faceUrl } })
  if (bodyUrl) content.push({ type: 'image', source: { type: 'url', url: bodyUrl } })

  const historyBlock = weekHistory && weekHistory.length > 0
    ? `\nHISTORIAL DE SEMANAS ANTERIORES:\n${weekHistory.map((w, i) => `Semana ${i + 1}: ${w.theme} — ${w.summary || ''}`).join('\n')}\n`
    : '\nEs la primera semana de contenido de esta influencer.\n'

  content.push({ type: 'text', text: `Eres un director creativo de contenido digital especializado en influencers latinas para Instagram.

PERFIL DEL PERSONAJE:
Nombre: ${nombre}
Nicho: ${nicho}

AI PERSONA COMPLETO:
${persona}
${historyBlock}
TAREA:
Genera exactamente 8 piezas de contenido UGC para la semana (Lunes a Viernes). Tú decides el tema. No hay input del usuario.
Distribuye los 8 posts así: Lunes 2, Martes 1, Miércoles 2, Jueves 1, Viernes 2.

SLOTS Y SUS ASPECT RATIOS (fijos en el workflow — no puedes cambiarlos):
- Slot 1: 9:16 → Story o Reel vertical (close-up, espontáneo, selfie POV)
- Slot 2: 9:16 → Story o Reel vertical (close-up, espontáneo, selfie POV)
- Slot 3: 1:1  → Square (carrusel cover, moodboard, post de marca)
- Slot 4: 1:1  → Square (carrusel cover, moodboard, post de marca)
- Slot 5: 3:4  → Feed portrait lifestyle (cuadrado largo, ambiente natural)
- Slot 6: 4:5  → Feed portrait editorial (retrato de moda o lifestyle principal)
- Slot 7: 1:1  → Square (tercer post de marca o engagement)
- Slot 8: 4:5  → Feed portrait editorial (retrato secundario)

Asigna el tipo de contenido al slot que mejor encaje con su formato.
Stories/Reels → slots 1-2. Square → slots 3,4,7. Portrait editorial → slots 6,8. Lifestyle → slot 5.

REGLAS FOTOGRÁFICAS UGC (aplica en TODOS los prompts):
- "Shot on iPhone 15 Pro" — NUNCA studio lights
- Incluir imperfecciones reales: grain de sensor, ligero motion blur ocasional
- Tipos: selfie | mirror selfie | POV candid | lifestyle moment
- Imágenes muy atractivas, magnéticas, cautivadoras y aspiracionales — siempre bella, alluring y captivating
- Outfits reales según el nicho: streetwear, athleisure, vestidos, coordinated sets, loungewear
- GEMINI SAFETY — OBLIGATORIO: NUNCA usar nude, naked, revealing, topless, sensual, erotic, explicit — Gemini bloqueará el request. Usar en cambio: alluring, captivating, magnetic, smoldering, confident, fierce, striking, body-hugging outfit, curve-accentuating
- COHERENCIA NARRATIVA a lo largo de la semana
- Prompts en INGLÉS, resto en ESPAÑOL

FORMATO: ÚNICAMENTE JSON válido. Sin markdown.

{
  "theme": "string",
  "summary": "string",
  "week": [
    {
      "slot": 1,
      "format": "9:16",
      "contentType": "Story/Reel",
      "day": "Lunes",
      "scene": "descripción en español",
      "caption": "texto con emojis",
      "hashtags": ["#tag"],
      "prompt": "Shot on iPhone 15 Pro..."
    }
  ]
}

Exactamente 8 objetos en "week", slots 1–8 en orden. Formatos obligatorios por slot:
slot1=9:16, slot2=9:16, slot3=1:1, slot4=1:1, slot5=3:4, slot6=4:5, slot7=1:1, slot8=4:5` })

  const payload = JSON.stringify({
    model: ANTHROPIC_MODEL,
    max_tokens: 8000,
    messages: [{ role: 'user', content }],
  })

  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
        'content-length':    Buffer.byteLength(payload),
      },
    }
    const req = https.request(opts, res => {
      let raw = ''
      res.on('data', d => raw += d)
      res.on('end', () => {
        try {
          const data = JSON.parse(raw)
          if (res.statusCode !== 200) throw new Error(`Anthropic ${res.statusCode}: ${JSON.stringify(data)}`)
          let text = data.content[0].text.trim()
          if (text.startsWith('```')) text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
          resolve(JSON.parse(text))
        } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

// ── AION Body Params (AionBodyReferenceNode — 7 direct enums) ────────────────
const BODY_PARAM_OPTIONS = {
  body_type: ['auto','slim lean build','slim-athletic build','athletic toned build','hourglass figure','pear-shaped figure','curvy fuller figure','plus-size full build','petite frame','tall statuesque frame','muscular defined build'],
  bust:      ['auto','flat chest','small bust','moderate bust','full bust','large bust','extra large bust','extremely large bust exaggerated proportions','hyper-voluminous bust fantasy proportions','massive oversized bust ultra-exaggerated'],
  waist:     ['auto','very narrow waist extreme hourglass','narrow defined waist','moderate waist','straight waist','full waist'],
  glutes:    ['auto','flat glutes','small glutes','moderate rounded glutes','full prominent glutes','large voluminous glutes','extra large glutes exaggerated proportions','extremely large glutes hyper-voluminous rear','massive oversized glutes ultra-exaggerated'],
  hips:      ['auto','narrow hips','balanced proportionate hips','wide hips','very wide hips','full rounded hips exaggerated width'],
  legs:      ['auto','long lean legs','slim legs','athletic legs defined quads','full thick thighs','muscular legs','wide thighs full legs'],
  shoulders: ['auto','narrow shoulders','proportionate shoulders','broad shoulders','sloped shoulders','square shoulders'],
}
const BODY_MODEL_OPTIONS      = ['gemini-3.1-pro-preview','gemini-3-flash-preview','gemini-2.5-pro','gemini-2.5-flash']
const BODY_IMAGE_MODEL_OPTIONS = ['Nano Banana Pro (gemini-3-pro-image-preview)','Nano Banana 2 (gemini-3.1-flash-image-preview)']
const BODY_RESOLUTION_OPTIONS  = ['512px','1K','2K','4K']

// ── AION Expert Params — Claude selects from natural language ────────────────
const AION_EXPERT_SYSTEM_PROMPT = `You are AION Casting Director, a world-class expert in creating hyperrealistic virtual influencer faces for AI image generation workflows.

Your task: analyze the user's description (and reference images if provided) and select the optimal AION parameters to generate the most beautiful, sexy, and photorealistic face possible.

STRICT RULES:
1. Optimize for maximum beauty and photographic realism within the requested traits
2. For traits not specified, choose the most photogenic and beautiful option — no lazy defaults
3. AVOID "auto" — choose a specific value for every single parameter
4. Result must look like a real photograph, NOT AI-generated
5. Skin: prefer natural, realistic texture — "natural skin grain", "natural pore variation", "none visible" imperfections
6. Defects group (wrinkles, scars, deformations, tone_loss, skin_marks, vitiligo, under_eye): ALWAYS use "none" unless the user explicitly requests otherwise
7. Expression: default to "serene neutral" or "gentle warmth" for beauty/influencer shots
8. If reference images are provided: carefully extract specific aesthetic traits and map them to the closest parameter values
9. Sex: default to "female" unless specified otherwise

AVAILABLE PARAMETERS — use ONLY these exact strings:
sex: ["auto","unspecified","female","male","androgynous"]
ethnicity: ["auto","unspecified","East Asian","South Asian","Southeast Asian","Central Asian","Middle Eastern","North African","Horn of Africa","Sub-Saharan African","Northern European","Southern European","Eastern European","Western European","North American","Latin American","Mestizo","Caribbean","Indigenous American","Pacific Islander","Melanesian","Australian Aboriginal","Mixed heritage"]
eye_shape: ["auto","almond-shaped","round","hooded","monolid","upturned","downturned","deep-set","prominent","wide-set","close-set"]
eye_size: ["auto","small","medium","large","very large","proportionate"]
eye_tilt: ["auto","neutral tilt","slight upward tilt","moderate upward tilt","slight downward tilt","horizontal"]
eye_color: ["auto","dark brown","medium brown","light brown","hazel","amber","green","blue-green","light blue","deep blue","gray","dark gray","black"]
eyebrow_thickness: ["auto","thin","medium thickness","thick","very thick","sparse","dense and full"]
eyebrow_shape: ["auto","straight","soft arch","high arch","rounded","angled","flat","S-shaped","naturally unruly"]
eyebrow_color: ["auto","black","dark brown","medium brown","light brown","auburn","dark blonde","blonde","gray","reddish brown"]
nose_profile: ["auto","straight profile","slightly concave","slightly convex","aquiline","button nose profile","flat bridge","high bridge","broad bridge","narrow bridge"]
nose_base: ["auto","narrow base","medium base","wide base","flared nostrils","compact nostrils","rounded base","angular base"]
nose_tip: ["auto","rounded tip","pointed tip","bulbous tip","upturned tip","downturned tip","refined tip","broad tip","narrow tip"]
lips_volume: ["auto","thin lips","medium volume","full lips","very full lips","naturally plump","delicate and refined"]
cupid_bow: ["auto","pronounced cupid's bow","subtle cupid's bow","flat cupid's bow","heart-shaped cupid's bow","rounded cupid's bow","sharply defined bow"]
lips_proportion: ["auto","balanced upper and lower","fuller lower lip","fuller upper lip","equal proportion","slightly fuller lower","slightly fuller upper"]
lips_color: ["auto","soft pink","rosy pink","mauve","dusty rose","berry toned","warm peach","neutral beige","deep rose","brownish pink","coral toned"]
forehead: ["auto","broad forehead","narrow forehead","high forehead","low forehead","slightly rounded","flat forehead","prominent forehead","average proportion"]
cheekbones: ["auto","high cheekbones","low cheekbones","prominent cheekbones","subtle cheekbones","wide-set cheekbones","angular cheekbones","soft rounded cheekbones","flat cheekbones"]
jawline: ["auto","strong jawline","soft jawline","angular jawline","rounded jawline","square jawline","tapered jawline","wide jaw","narrow jaw","defined jawline"]
chin: ["auto","pointed chin","rounded chin","square chin","narrow chin","broad chin","prominent chin","receding chin","cleft chin","soft chin"]
cheeks: ["auto","full cheeks","hollow cheeks","soft rounded cheeks","flat cheeks","naturally plump","slightly sunken","apple cheeks","lean cheeks"]
submental: ["auto","tight submental area","soft submental area","defined under-chin","slight fullness","clean jawline transition","natural softness"]
face_neck_transition: ["auto","smooth transition","defined angle","soft gradual transition","sharp jaw-neck angle","naturally blended","elongated neck line"]
hair_structure: ["auto","straight","wavy","curly","coily","kinky","loosely wavy","tightly curled","fine and silky","coarse and thick"]
hair_length: ["auto","buzz cut","very short","short","ear length","chin length","shoulder length","mid-back length","long","very long","bald","shaved sides"]
hair_volume: ["auto","flat and sleek","low volume","medium volume","high volume","very voluminous","thick and dense","thin and fine","fluffy"]
hair_color: ["auto","jet black","dark brown","medium brown","light brown","dark blonde","golden blonde","platinum blonde","strawberry blonde","auburn","copper red","deep red","silver gray","white","salt and pepper"]
skin_tone: ["auto","very fair","fair","light","light-medium","medium","medium-tan","tan","olive","deep tan","brown","dark brown","deep brown","ebony"]
skin_undertone: ["auto","cool undertone","warm undertone","neutral undertone","olive undertone","pink undertone","golden undertone","peach undertone","red undertone"]
skin_texture: ["auto","smooth natural grain","fine skin texture","slightly rough texture","soft velvety texture","natural skin grain","matte natural texture"]
skin_micro_texture: ["auto","visible fine pores","subtle pore detail","barely visible pores","natural pore variation","light textural detail","realistic micro detail"]
skin_imperfections: ["auto","none visible","light freckles","subtle blemishes","faint redness zones","small moles","soft under-eye shadows","light freckles and moles","minor sun spots","natural skin variation"]
skin_reflection: ["auto","matte natural finish","soft skin sheen","subtle light diffusion","natural dewy glow","satin finish","minimal shine"]
wrinkles: ["auto","none","fine forehead lines","crow's feet","nasolabial folds","frown lines","neck wrinkles","deep forehead furrows","perioral wrinkles","under-eye wrinkles","bunny lines","marionette lines","horizontal neck bands"]
scars: ["auto","none","small facial scar","acne scarring","surgical scar","burn scar","cleft lip scar","eyebrow scar","cheek scar","forehead scar","ice-pick acne scars","boxcar acne scars","rolling acne scars","keloid scar"]
deformations: ["auto","none","asymmetric features","deviated nose","drooping eyelid","facial paralysis trace","cleft palate trace","micrognathia","prognathism","hemifacial microsomia","facial asymmetry left side","facial asymmetry right side","bell's palsy trace"]
tone_loss: ["auto","none","mild jowling","sagging cheeks","loose neck skin","drooping brow","hollow temples","sunken cheeks","loose eyelid skin","loss of jawline definition","nasolabial fold deepening","thinning lips from aging","overall facial volume loss"]
skin_marks: ["auto","none","post-acne dark spots","post-acne red marks","hyperpigmentation patches","melasma","age spots","sun damage spots","cherry angiomas","seborrheic keratosis","port wine stain","cafe au lait spots","liver spots"]
vitiligo: ["auto","none","perioral vitiligo","periocular vitiligo","forehead vitiligo","hands vitiligo","scattered patches","segmental vitiligo","universal vitiligo","focal vitiligo on cheek","symmetrical facial vitiligo","vitiligo on nose bridge"]
under_eye: ["auto","none","mild dark circles","deep dark circles","puffy under-eye bags","hollow tear troughs","blue-tinted dark circles","brown-tinted dark circles","hereditary dark circles","malar bags","festoons","crepey under-eye skin"]
expression: ["auto","neutral","happiness","sadness","anger","surprise","fear","disgust","contempt"]
expression_variant: ["auto","Duchenne smile","social smile","bitter smile","coy smile","broad grin","closed-lip smile","smirk","radiant joy","gentle warmth","laughing","tearful","melancholic gaze","lip tremble","downcast eyes","subtle grief","resigned sadness","nostalgic sadness","holding back tears","cold fury","simmering rage","tight jaw anger","flared nostrils anger","stern disapproval","controlled anger","frustrated scowl","indignant look","wide-eyed shock","mild surprise","open-mouth gasp","raised brows surprise","stunned disbelief","pleasant surprise","startled","wide-eyed fear","frozen terror","anxious worry","nervous tension","subtle unease","panicked expression","deer-in-headlights","mild distaste","strong revulsion","nose wrinkle disgust","lip curl disgust","nauseated look","subtle aversion","one-sided smirk","dismissive look","superior gaze","subtle disdain","eye-roll contempt","sardonic expression","serene neutral","pensive","stoic","blank stare","composed calm","thoughtful gaze","distant look","wistful","determined"]

BODY PARAMETERS — also select these 7 fields based on the influencer description and niche. Use ONLY these exact strings:
body_type: ["auto","slim lean build","slim-athletic build","athletic toned build","hourglass figure","pear-shaped figure","curvy fuller figure","plus-size full build","petite frame","tall statuesque frame","muscular defined build"]
bust: ["auto","flat chest","small bust","moderate bust","full bust","large bust","extra large bust","extremely large bust exaggerated proportions","hyper-voluminous bust fantasy proportions","massive oversized bust ultra-exaggerated"]
waist: ["auto","very narrow waist extreme hourglass","narrow defined waist","moderate waist","straight waist","full waist"]
glutes: ["auto","flat glutes","small glutes","moderate rounded glutes","full prominent glutes","large voluminous glutes","extra large glutes exaggerated proportions","extremely large glutes hyper-voluminous rear","massive oversized glutes ultra-exaggerated"]
hips: ["auto","narrow hips","balanced proportionate hips","wide hips","very wide hips","full rounded hips exaggerated width"]
legs: ["auto","long lean legs","slim legs","athletic legs defined quads","full thick thighs","muscular legs","wide thighs full legs"]
shoulders: ["auto","narrow shoulders","proportionate shoulders","broad shoulders","sloped shoulders","square shoulders"]

BODY SELECTION RULES:
- NEVER use "auto" for body params — always pick the best value for the niche
- Niche inference: fitness/sport=athletic toned build+full bust+narrow defined waist; gamer/alt=curvy fuller figure+full bust+moderate waist; fashion/luxury=hourglass figure+full bust+very narrow waist; lifestyle=slim-athletic build; curvy niche=curvy fuller figure+large bust+wide hips+full prominent glutes

INTENSITY MAPPING — scale enum choice to match the intensity of the user's language:
- EXTREME words (súper, muy, enorme, ultra, exagerado, massive, huge, enormous, gigantic, oversized, hyper, máximo, grandísimo, XXL, ridiculously, beyond natural, demasiado, extremo):
    bust → "massive oversized bust ultra-exaggerated" or "hyper-voluminous bust fantasy proportions"
    glutes → "massive oversized glutes ultra-exaggerated" or "extremely large glutes hyper-voluminous rear"
    hips → "full rounded hips exaggerated width"
    waist (curvy context) → "very narrow waist extreme hourglass"
- HIGH words (grande, big, prominente, voluminoso, curvy, pronounced, significant, ample, notable, well-developed):
    bust → "extra large bust" or "extremely large bust exaggerated proportions"
    glutes → "extra large glutes exaggerated proportions"
    hips → "very wide hips"
- MODERATE words (medium, average, normal, moderado, regular, balanced, natural):
    use mid-range options for all params
- When extreme or high intensity proportions are requested, ALSO reinforce them explicitly in "prompt_body":
    e.g. "Dramatically voluminous bust and hyper-developed glutes, ultra-wide hips creating maximum curvature, extreme hourglass silhouette with striking proportions."

OUTPUT RULES:
- Return ONLY a valid JSON object — no markdown, no code blocks, no explanation, no extra text
- Include ALL 43 face parameters + 7 body parameters + "prompt_body" field (51 fields total)
- Use ONLY the exact string values listed above for face and body params
- "prompt_body": a 60–100 word English supplementary description for additional body detail (skin quality, posture, overall aesthetic). NEVER use: nude, naked, revealing, sensual, erotic, sexy — use instead: alluring, captivating, magnetic, aspirational, striking.
- Example: {"sex":"female","ethnicity":"Latin American","eye_shape":"almond-shaped",...,"body_type":"hourglass figure","bust":"full bust","waist":"narrow defined waist","glutes":"full prominent glutes","hips":"wide hips","legs":"long lean legs","shoulders":"proportionate shoulders","prompt_body":"Smooth tan skin with subtle natural texture, confident upright posture, editorial magazine quality, aspirational athletic build."}`

async function generateAionParams(description, referenceImages, photoType, nombre, nicho) {
  const content = []

  if (referenceImages && referenceImages.length > 0) {
    for (const img of referenceImages) {
      if (img && img.data && img.type) {
        content.push({ type: 'image', source: { type: 'base64', media_type: img.type, data: img.data } })
      }
    }
  }

  const typeHint = photoType && photoType !== '-- Not selected / System inferred --'
    ? `Photo type: "${photoType}"\n\n`
    : ''
  const nichoHint = nicho ? `Content niche: ${nicho}\nInfluencer name: ${nombre || 'unknown'}\n\n` : ''
  content.push({ type: 'text', text: `${typeHint}${nichoHint}Influencer description: ${description}` })

  const payload = JSON.stringify({
    model: ANTHROPIC_MODEL,
    max_tokens: 2000,
    system: AION_EXPERT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  })

  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
        'content-length':    Buffer.byteLength(payload),
      },
    }
    const req = https.request(opts, res => {
      let raw = ''
      res.on('data', d => raw += d)
      res.on('end', () => {
        try {
          const data = JSON.parse(raw)
          if (res.statusCode !== 200) throw new Error(`Anthropic ${res.statusCode}: ${JSON.stringify(data)}`)
          let text = data.content[0].text.trim()
          if (text.startsWith('```')) text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
          resolve(JSON.parse(text))
        } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

async function getRun(runId) {
  const res = await cdRequest('GET', `/api/run/${runId}`)
  if (res.status !== 200) throw new Error(`Poll ${res.status}`)
  return res.body
}

// ── Extract images from ComfyDeploy outputs ──────────────────────────────────
function extractImages(outputs) {
  const results = []
  if (!outputs) return results

  if (Array.isArray(outputs)) {
    for (const out of outputs) {
      const data = out?.data
      if (!data || typeof data !== 'object') continue
      for (const key of Object.keys(data)) {
        const items = data[key]
        if (!Array.isArray(items)) continue
        for (const item of items) {
          if (typeof item === 'string' && item.startsWith('http')) results.push(item)
          else if (item?.url) results.push(item.url)
        }
      }
    }
    if (results.length) return results
  }

  if (typeof outputs === 'object' && Array.isArray(outputs.images)) {
    outputs.images.forEach(i => { if (i?.url) results.push(i.url); else if (typeof i === 'string') results.push(i) })
  }
  return results
}

// ── HTTP server ──────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    let total = 0
    req.on('data', d => {
      total += d.length
      if (total > MAX_JSON_BODY_BYTES) {
        const err = new Error(`Body demasiado grande. Max ${(MAX_JSON_BODY_BYTES / 1024 / 1024).toFixed(0)}MB`)
        err.statusCode = 413
        req.destroy(err)
        return
      }
      raw += d
    })
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')) }
      catch {
        const err = new Error('JSON invalido')
        err.statusCode = 400
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function json(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(body)
}

function fail(res, err) {
  json(res, err.statusCode || 500, { error: err.message })
}

function decodeBase64Image(data, type) {
  if (!ALLOWED_IMAGE_TYPES.has(type)) {
    const err = new Error('Tipo de imagen no permitido. Usa JPEG, PNG o WebP.')
    err.statusCode = 400
    throw err
  }
  if (typeof data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) {
    const err = new Error('Imagen base64 invalida')
    err.statusCode = 400
    throw err
  }
  const buffer = Buffer.from(data, 'base64')
  if (!buffer.length || buffer.length > MAX_UPLOAD_BYTES) {
    const err = new Error(`Imagen demasiado grande. Max ${(MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(0)}MB.`)
    err.statusCode = 413
    throw err
  }
  if (!looksLikeImage(buffer, type)) {
    const err = new Error('El contenido no coincide con el tipo de imagen declarado')
    err.statusCode = 400
    throw err
  }
  return buffer
}

function looksLikeImage(buffer, type) {
  if (type === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  if (type === 'image/png')  return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (type === 'image/webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  return false
}

function isAllowedOrigin(origin) {
  return !origin || origin === `http://${HOST}:${PORT}`
}

const server = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url, true)
  const pathname = parsed.pathname
  const origin   = req.headers.origin

  if (req.method === 'OPTIONS') {
    if (!isAllowedOrigin(origin)) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }
    res.writeHead(204, { 'Access-Control-Allow-Origin': `http://${HOST}:${PORT}`, 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' })
    res.end()
    return
  }

  if (!isAllowedOrigin(origin)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }

  // Serve UI
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'server-ui.html'))
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
    return
  }

  // Serve hero photo
  if (req.method === 'GET' && pathname === '/hero-photo.png') {
    try {
      const img = fs.readFileSync(path.join(__dirname, 'Foto inicio', 'Nano Banana Pro_00001_.png'))
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' })
      res.end(img)
    } catch { res.writeHead(404); res.end('Not found') }
    return
  }

  // POST /api/upload-image — upload reference image to Supabase Storage
  if (req.method === 'POST' && pathname === '/api/upload-image') {
    try {
      const body = await readBody(req)
      const { name, data, type } = body
      if (!name || !data) { json(res, 400, { error: 'name y data requeridos' }); return }

      const imageType = type || 'image/jpeg'
      const buffer   = decodeBase64Image(data, imageType)
      const ext      = IMAGE_EXTENSIONS[imageType]
      const filename = `refs/${Date.now()}-${name.replace(/[^a-z0-9]/gi, '_')}.${ext}`

      console.log(`\n[UPLOAD-IMAGE] name="${name}" size=${(buffer.length / 1024).toFixed(1)}KB`)
      const imageUrl = await uploadToSupabase(buffer, filename, type || 'image/jpeg')
      console.log(`  url: ${imageUrl}`)

      json(res, 200, { url: imageUrl })
    } catch (err) {
      console.error('[UPLOAD-IMAGE ERROR]', err.message)
      fail(res, err)
    }
    return
  }

  // POST /api/generate-face — AION face + AionBodyReferenceNode (run unificado)
  if (req.method === 'POST' && pathname === '/api/generate-face') {
    try {
      const body   = await readBody(req)
      const inputs = {}

      inputs['photo_type']    = body.photo_type || '-- Not selected / System inferred --'
      inputs['imagen rostro'] = 'Nano Banana Pro'
      inputs['save_image']    = 'ComfyUI'

      // Body quality params (AionBodyReferenceNode model/resolution)
      inputs['model']       = body.body_model       || 'gemini-3.1-pro-preview'
      inputs['image_model'] = body.body_image_model || 'Nano Banana Pro (gemini-3-pro-image-preview)'
      inputs['resolution']  = body.body_resolution  || '512px'

      if (body.prompt && body.prompt.trim()) {
        inputs['prompt'] = body.prompt.trim()
      }

      if (body.images) {
        const imageKeys = ['eyes','eyebrows','nose','lips','forehead','jawline','hairline','skin','full_face']
        for (const key of imageKeys) {
          if (body.images[key]) inputs[key] = body.images[key]
        }
      }

      if (body.params) {
        const bodyParamKeys = new Set(Object.keys(BODY_PARAM_OPTIONS))
        for (const [key, val] of Object.entries(body.params)) {
          if (!bodyParamKeys.has(key)) inputs[key] = val
        }
      }

      // 7 direct body enum params — pass if not 'auto'
      if (body.body_params) {
        const allowedBodyKeys = new Set(Object.keys(BODY_PARAM_OPTIONS))
        for (const [key, val] of Object.entries(body.body_params)) {
          if (allowedBodyKeys.has(key) && val && val !== 'auto') inputs[key] = val
        }
      }

      // body_description passed directly as brief_text (no Claude processing needed)
      if (body.body_description && body.body_description.trim()) {
        inputs['prompt_body'] = body.body_description.trim()
      }

      const imgCount   = Object.keys(body.images  || {}).filter(k => (body.images  || {})[k]).length
      const paramCount = Object.keys(body.params  || {}).filter(k => { const v = (body.params || {})[k]; return v && v !== 'auto' && v !== '-- Not selected / System inferred --' }).length
      const bodyCount  = Object.keys(body.body_params || {}).filter(k => { const v = (body.body_params || {})[k]; return v && v !== 'auto' }).length
      console.log(`\n[GENERATE-FACE] photo_type="${inputs['photo_type']}" images=${imgCount} face_params=${paramCount} body_params=${bodyCount} prompt_body=${!!inputs['prompt_body']} model="${inputs['model']}" res="${inputs['resolution']}"`)

      const runId = await startAionRun(inputs)
      console.log(`  run: ${runId}`)

      json(res, 200, { runId, prompt_body: inputs['prompt_body'] || null })
    } catch (err) {
      console.error('[GENERATE-FACE ERROR]', err.message)
      fail(res, err)
    }
    return
  }

  // POST /api/claude-guided-face — Claude selects AION params from natural language + optional ref images
  if (req.method === 'POST' && pathname === '/api/claude-guided-face') {
    try {
      const body        = await readBody(req)
      const description = (body.description || '').trim()
      const photoType   = (body.photo_type  || '-- Not selected / System inferred --').trim()
      const refImages   = body.reference_images || []
      const nombre      = (body.nombre || '').trim()
      const nicho       = (body.nicho  || '').trim()

      if (!description)   { json(res, 400, { error: 'description requerida' }); return }
      if (!ANTHROPIC_KEY) { json(res, 500, { error: 'Agrega ANTHROPIC_API_KEY en tu .env' }); return }
      if (!Array.isArray(refImages) || refImages.filter(Boolean).length > 4) {
        json(res, 400, { error: 'reference_images debe tener maximo 4 imagenes' }); return
      }
      for (const img of refImages.filter(Boolean)) {
        decodeBase64Image(img.data, img.type)
      }

      console.log(`\n[CLAUDE-GUIDED] desc="${description.slice(0, 80)}..." refImages=${refImages.filter(Boolean).length} photoType="${photoType}" nicho="${nicho}"`)

      const allParams = await generateAionParams(description, refImages, photoType, nombre, nicho)
      const bodyParamKeys = new Set(Object.keys(BODY_PARAM_OPTIONS))
      const { prompt_body: promptBody, ...restParams } = allParams
      const bodyParams = {}
      const faceParams = {}
      for (const [k, v] of Object.entries(restParams)) {
        if (bodyParamKeys.has(k)) bodyParams[k] = v
        else faceParams[k] = v
      }
      console.log(`  Claude seleccionó ${Object.keys(faceParams).length} face params + ${Object.keys(bodyParams).length} body params, prompt_body=${promptBody ? promptBody.length + ' chars' : 'none'}`)
      console.log('  Selected face params:', JSON.stringify(faceParams, null, 2))
      console.log('  Selected body params:', JSON.stringify(bodyParams, null, 2))
      if (promptBody) console.log('  prompt_body:', promptBody.slice(0, 120) + '...')

      const inputs = {
        'photo_type':    photoType,
        'imagen rostro': 'Nano Banana Pro',
        'save_image':    'ComfyUI',
        'model':         'gemini-3.1-pro-preview',
        'image_model':   'Nano Banana Pro (gemini-3-pro-image-preview)',
        'resolution':    '512px',
        ...faceParams,
      }
      // 7 direct body enum params — pass if not 'auto'
      for (const [k, v] of Object.entries(bodyParams)) {
        if (v && v !== 'auto') inputs[k] = v
      }
      if (promptBody) inputs['prompt_body'] = promptBody

      const runId = await startAionRun(inputs)
      console.log(`  run: ${runId}`)

      json(res, 200, { runId, selected_params: { ...faceParams, ...bodyParams }, prompt_body: promptBody || null })
    } catch (err) {
      console.error('[CLAUDE-GUIDED ERROR]', err.message)
      fail(res, err)
    }
    return
  }

  // POST /api/generate-body — v2: { face_url, prompt_body } → GPT Image 2 via image_rostro
  if (req.method === 'POST' && pathname === '/api/generate-body') {
    try {
      const body       = await readBody(req)
      const faceUrl    = (body.face_url    || '').trim()
      const promptBody = (body.prompt_body || '').trim()

      // v2 path: face_url + prompt_body → GPT Image 2 (same deployment c6e6b7f0)
      if (faceUrl) {
        if (!promptBody) { json(res, 400, { error: 'prompt_body requerido con face_url' }); return }
        console.log(`\n[GENERATE-BODY-V2] face_url="${faceUrl.slice(0, 60)}..." prompt_body="${promptBody.slice(0, 60)}..."`)
        const runId = await startBodyRunV2(faceUrl, promptBody)
        console.log(`  run: ${runId}`)
        json(res, 200, { runId })
        return
      }

      // legacy path: { prompt, input_image } → deployment cabf22a3
      const prompt     = (body.prompt || '').trim()
      const inputImage = (body.input_image || '').trim()
      if (!prompt)     { json(res, 400, { error: 'face_url o prompt requerido' }); return }
      if (!inputImage) { json(res, 400, { error: 'input_image requerido' }); return }

      console.log(`\n[GENERATE-BODY-LEGACY] prompt="${prompt.slice(0, 60)}..."`)
      const runId = await startBodyRun(prompt, inputImage)
      console.log(`  run: ${runId}`)

      json(res, 200, { runIds: [runId] })
    } catch (err) {
      console.error('[GENERATE-BODY ERROR]', err.message)
      fail(res, err)
    }
    return
  }

  // POST /api/generate-body-prompt — Claude generates body prompt from face description
  if (req.method === 'POST' && pathname === '/api/generate-body-prompt') {
    try {
      const body            = await readBody(req)
      const nombre          = (body.nombre || '').trim()
      const nicho           = (body.nicho  || '').trim()
      const faceDescription = (body.face_description || '').trim()

      if (!nombre) { json(res, 400, { error: 'nombre requerido' }); return }
      if (!nicho)  { json(res, 400, { error: 'nicho requerido' }); return }
      if (!ANTHROPIC_KEY) { json(res, 500, { error: 'Agrega ANTHROPIC_API_KEY en tu .env' }); return }

      console.log(`\n[BODY-PROMPT] nombre="${nombre}" nicho="${nicho}"`)
      const prompt = await generateBodyPrompt(nombre, nicho, faceDescription)
      console.log(`  prompt (${prompt.length} chars)`)

      json(res, 200, { prompt })
    } catch (err) {
      console.error('[BODY-PROMPT ERROR]', err.message)
      fail(res, err)
    }
    return
  }

  // POST /api/generate-persona
  if (req.method === 'POST' && pathname === '/api/generate-persona') {
    try {
      const body    = await readBody(req)
      const nombre  = (body.nombre || '').trim()
      const nicho   = (body.nicho  || '').trim()
      const faceUrl = (body.face_url || '').trim()
      const bodyUrl = (body.body_url || '').trim()

      if (!nombre) { json(res, 400, { error: 'nombre requerido' }); return }
      if (!nicho)  { json(res, 400, { error: 'nicho requerido' }); return }
      if (!ANTHROPIC_KEY) { json(res, 500, { error: 'Agrega ANTHROPIC_API_KEY en tu .env' }); return }

      console.log(`\n[GENERATE-PERSONA] nombre="${nombre}" nicho="${nicho}" face=${!!faceUrl} body=${!!bodyUrl}`)
      const persona = await generatePersona(nombre, nicho, faceUrl, bodyUrl)
      console.log(`  persona generada (${persona.length} chars)`)

      json(res, 200, { persona })
    } catch (err) {
      console.error('[GENERATE-PERSONA ERROR]', err.message)
      fail(res, err)
    }
    return
  }

  // GET /api/influencers
  if (req.method === 'GET' && pathname === '/api/influencers') {
    try { json(res, 200, loadInfluencers()) }
    catch (err) { fail(res, err) }
    return
  }

  // POST /api/influencers
  if (req.method === 'POST' && pathname === '/api/influencers') {
    try {
      const body    = await readBody(req)
      const nombre  = (body.nombre  || '').trim()
      const nicho   = (body.nicho   || '').trim()
      const faceUrl = (body.face_url || '').trim()
      const bodyUrl = (body.body_url || '').trim()
      const persona = (body.persona  || '').trim()

      if (!nombre)  { json(res, 400, { error: 'nombre requerido' }); return }
      if (!nicho)   { json(res, 400, { error: 'nicho requerido' }); return }
      if (!faceUrl) { json(res, 400, { error: 'face_url requerido' }); return }

      const influencer = await updateInfluencers(data => {
        const item = {
          id:         crypto.randomUUID(),
          nombre,
          nicho,
          face_url:   faceUrl,
          body_url:   bodyUrl,
          persona,
          created_at: new Date().toISOString(),
          weeks:      [],
        }
        data.influencers.push(item)
        return item
      })
      console.log(`\n[INFLUENCER SAVED] "${nombre}" id=${influencer.id}`)
      json(res, 200, { influencer })
    } catch (err) {
      console.error('[INFLUENCER SAVE ERROR]', err.message)
      fail(res, err)
    }
    return
  }

  // POST /api/influencers/:id/weeks
  const weekMatch = pathname.match(/^\/api\/influencers\/([^/]+)\/weeks$/)
  if (req.method === 'POST' && weekMatch) {
    try {
      const influencerId = weekMatch[1]
      const body = await readBody(req)
      const { theme, summary, plan } = body

      const result = await updateInfluencers(data => {
        const influencer = data.influencers.find(i => i.id === influencerId)
        if (!influencer) {
          const err = new Error('influencer no encontrada')
          err.statusCode = 404
          throw err
        }
        const week = {
          week_id:      crypto.randomUUID(),
          generated_at: new Date().toISOString(),
          theme:        theme   || '',
          summary:      summary || '',
          plan:         plan    || null,
        }
        influencer.weeks.push(week)
        return { week, influencer }
      })
      console.log(`\n[WEEK SAVED] influencer="${result.influencer.nombre}" theme="${theme}"`)
      json(res, 200, { week_id: result.week.week_id, influencer_id: influencerId })
    } catch (err) {
      console.error('[WEEK SAVE ERROR]', err.message)
      fail(res, err)
    }
    return
  }

  // POST /api/generate-content-plan
  if (req.method === 'POST' && pathname === '/api/generate-content-plan') {
    try {
      const body        = await readBody(req)
      const persona     = (body.persona  || '').trim()
      const nombre      = (body.nombre   || '').trim()
      const nicho       = (body.nicho    || '').trim()
      const faceUrl     = (body.face_url || '').trim()
      const bodyUrl     = (body.body_url || '').trim()
      const weekHistory = body.week_history || []

      if (!persona) { json(res, 400, { error: 'persona requerido' }); return }
      if (!nombre)  { json(res, 400, { error: 'nombre requerido' }); return }
      if (!nicho)   { json(res, 400, { error: 'nicho requerido' }); return }
      if (!ANTHROPIC_KEY) { json(res, 500, { error: 'Agrega ANTHROPIC_API_KEY en tu .env' }); return }

      console.log(`\n[CONTENT-PLAN] nombre="${nombre}" nicho="${nicho}" historial=${weekHistory.length} semanas`)
      const plan = await generateContentPlan(nombre, nicho, persona, faceUrl, bodyUrl, weekHistory)
      console.log(`  plan generado: theme="${plan.theme}" dias=${plan.week?.length || 0}`)

      json(res, 200, { plan })
    } catch (err) {
      console.error('[CONTENT-PLAN ERROR]', err.message)
      fail(res, err)
    }
    return
  }

  // POST /api/generate-content-day
  if (req.method === 'POST' && pathname === '/api/generate-content-day') {
    try {
      const body    = await readBody(req)
      const faceUrl = (body.face_url || '').trim()
      const bodyUrl = (body.body_url || '').trim()
      const prompts = body.prompts || []

      if (!faceUrl) { json(res, 400, { error: 'face_url requerido' }); return }
      if (!bodyUrl) { json(res, 400, { error: 'body_url requerido' }); return }
      if (!Array.isArray(prompts) || prompts.length !== 8) {
        json(res, 400, { error: 'prompts debe ser un array de exactamente 8 strings' }); return
      }

      console.log(`\n[CONTENT-RUN] slots=8 face=${faceUrl.split('/').pop()} body=${bodyUrl.split('/').pop()}`)
      const runId = await startComfyDeployContentRun(faceUrl, bodyUrl, prompts)
      console.log(`  run: ${runId}`)

      json(res, 200, { runId })
    } catch (err) {
      console.error('[CONTENT-RUN ERROR]', err.message)
      fail(res, err)
    }
    return
  }

  // GET /api/status/:runId
  const statusMatch = pathname.match(/^\/api\/status\/([^/]+)$/)
  if (req.method === 'GET' && statusMatch) {
    try {
      const runId = decodeURIComponent(statusMatch[1])

      // ── ComfyDeploy Content run (prefijo cdc:) ───────────────────────────
      if (runId.startsWith('cdc:')) {
        const cdcId = runId.slice(4)
        const data  = await getRun(cdcId)
        const st    = data.status || ''
        console.log(`[CDC-STATUS] ${cdcId} -> ${st}`)

        if (st === 'success') {
          console.log('CDC OUTPUTS:', JSON.stringify(data.outputs, null, 2))
          const images = extractImages(data.outputs)
          // Filtrar solo los ZCS1-ZCS8 (skip9-skip14 se excluyen automáticamente)
          const contentImages = images
            .filter(u => /\/ZCS\d+[_]/.test(u) || /[?&]file=ZCS\d+/.test(u) || u.split('/').pop().startsWith('ZCS'))
            .sort((a, b) => {
              const aNum = parseInt(a.split('/').pop().match(/ZCS(\d+)/)?.[1] || '0')
              const bNum = parseInt(b.split('/').pop().match(/ZCS(\d+)/)?.[1] || '0')
              return aNum - bNum
            })
          console.log(`  [CDC] contentImages: ${contentImages.length}`, contentImages.map(u => u.split('/').pop()))
          return json(res, 200, { status: 'success', contentImages })
        }
        if (['failed', 'cancelled', 'timeout'].includes(st)) {
          console.log(`[CDC-ERROR] ${cdcId} -> ${st}`)
          console.log(`[CDC-ERROR] full response:`, JSON.stringify(data, null, 2))
          return json(res, 200, { status: 'error', message: st })
        }
        return json(res, 200, { status: 'running' })
      }

      // ── ComfyDeploy run (sin prefijo) ────────────────────────────────────
      const data  = await getRun(runId)
      const st    = data.status || ''

      if (st === 'success') {
        console.log(`\n[STATUS] ${runId} -> success`)
        console.log('OUTPUTS:', JSON.stringify(data.outputs, null, 2))
        const images = extractImages(data.outputs)
        console.log(`  images extracted: ${images.length}`, images.map(u => u.split('/').pop()))
        // face: "Nano Banana Pro" prefix (URL-encoded, no 'ComfyUI')
        // body: "ComfyUI" prefix
        const body_url = images.find(u => u.includes('ComfyUI')) || null
        const face_url = images.find(u => !u.includes('ComfyUI')) || null
        console.log(`  face_url: ${face_url ? face_url.split('/').pop() : 'none'}`)
        console.log(`  body_url: ${body_url ? body_url.split('/').pop() : 'none'}`)
        json(res, 200, { status: 'success', images, face_url, body_url })
      } else if (['failed', 'cancelled', 'timeout'].includes(st)) {
        console.log(`[STATUS] ${runId} -> ${st}`)
        json(res, 200, { status: 'error', message: st })
      } else {
        json(res, 200, { status: 'running' })
      }
    } catch (err) {
      console.error('[STATUS ERROR]', err.message)
      fail(res, err)
    }
    return
  }

  res.writeHead(404)
  res.end('Not found')
})

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Puerto ${HOST}:${PORT} ocupado. Cierra el proceso que usa ese puerto y vuelve a ejecutar iniciar.bat.`)
  } else {
    console.error('Error del servidor:', err.message)
  }
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
    if (!fs.existsSync(INFLUENCERS_FILE)) fs.writeFileSync(INFLUENCERS_FILE, JSON.stringify({ influencers: [] }))
    const db = loadInfluencers()
    console.log(`\nZami AI Studio v3 AION`)
    console.log(`   http://${HOST}:${PORT}`)
    console.log(`   ComfyDeploy: ${API_KEY ? API_KEY.slice(0, 8) + '...' : 'NO CONFIGURADA'}`)
    console.log(`   Anthropic:   ${ANTHROPIC_KEY ? ANTHROPIC_KEY.slice(0, 8) + '...' : 'NO CONFIGURADA'}`)
    console.log(`   Modelo:      ${ANTHROPIC_MODEL}`)
    console.log(`   AION deploy: ${DEPLOYMENT_ID_AION}`)
    console.log(`   Content deploy: ${DEPLOYMENT_ID_CONTENT}`)
    console.log(`   Supabase:    ${SUPABASE_URL || 'NO CONFIGURADA'} / bucket: ${SUPABASE_BUCKET}`)
    console.log(`   Influencers: ${db.influencers.length} guardadas`)
    console.log()
  } catch (err) {
    console.error('Error al iniciar:', err.message)
    process.exit(1)
  }
})
