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
    if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  })
}
loadEnv()

const API_KEY               = process.env.VITE_COMFYDEPLOY_API_KEY || ''
const ANTHROPIC_KEY         = process.env.ANTHROPIC_API_KEY || ''
const DEPLOYMENT_ID_AION    = process.env.VITE_COMFYDEPLOY_AION_DEPLOYMENT_ID || 'c6e6b7f0-e574-4aa8-9012-54e8507202e2'
const DEPLOYMENT_ID_BODY    = 'cabf22a3-a697-485c-a6df-b6c09ee4f2f1'
const DEPLOYMENT_ID_CONTENT = process.env.VITE_COMFYDEPLOY_CONTENT_DEPLOYMENT_ID || '8d4702cb-c504-4bf2-8284-ee17d6e66633'
const SUPABASE_URL          = process.env.VITE_SUPABASE_URL || ''
const SUPABASE_KEY          = process.env.VITE_SUPABASE_ANON_KEY || ''
const SUPABASE_BUCKET       = process.env.SUPABASE_BUCKET || 'zami-images'
const PORT                  = 3333
const HOST                  = '127.0.0.1'
const CD_BASE               = 'api.comfydeploy.com'
const DATA_DIR              = path.join(__dirname, 'data')
const INFLUENCERS_FILE      = path.join(DATA_DIR, 'influencers.json')

// ── Influencers persistence ──────────────────────────────────────────────────
function loadInfluencers() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  if (!fs.existsSync(INFLUENCERS_FILE)) fs.writeFileSync(INFLUENCERS_FILE, JSON.stringify({ influencers: [] }))
  try { return JSON.parse(fs.readFileSync(INFLUENCERS_FILE, 'utf8')) }
  catch { return { influencers: [] } }
}

function saveInfluencers(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(INFLUENCERS_FILE, JSON.stringify(data, null, 2))
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

// ── Body generation ──────────────────────────────────────────────────────────
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

// ── Content UGC generation ───────────────────────────────────────────────────
async function startContentDayRun(faceUrl, bodyUrl, prompts) {
  if (!DEPLOYMENT_ID_CONTENT) throw new Error('VITE_COMFYDEPLOY_CONTENT_DEPLOYMENT_ID no configurado en .env')
  const res = await cdRequest('POST', `/api/run/deployment/queue`, {
    deployment_id: DEPLOYMENT_ID_CONTENT,
    inputs: {
      'prompt 1':          String(prompts[0] || ''),
      'input_image 1':     String(faceUrl),
      'input_image 2':     String(bodyUrl),
      'filename_prefix 1': 'ComfyUI',
      'prompt 2':          String(prompts[1] || ''),
      'input_image 3':     String(faceUrl),
      'input_image 4':     String(bodyUrl),
      'filename_prefix 2': 'ComfyUI',
      'prompt 3':          String(prompts[2] || ''),
      'input_image 5':     String(faceUrl),
      'input_image 6':     String(bodyUrl),
      'filename_prefix 3': 'ComfyUI',
      'prompt 4':          String(prompts[3] || ''),
      'input_image 7':     String(faceUrl),
      'input_image 8':     String(bodyUrl),
      'filename_prefix 4': 'ComfyUI',
    },
  })
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`ComfyDeploy ${res.status}: ${JSON.stringify(res.body)}`)
  }
  return res.body.run_id
}

// ── AI Persona generation — Claude API ───────────────────────────────────────
async function generatePersona(nombre, nicho, faceUrl, bodyUrl) {
  const content = []
  if (faceUrl) content.push({ type: 'image', source: { type: 'url', url: faceUrl } })
  if (bodyUrl) content.push({ type: 'image', source: { type: 'url', url: bodyUrl } })
  content.push({ type: 'text', text: `Eres un experto en crear perfiles de influencers virtuales para redes sociales y contenido digital.

Datos del personaje:
- Nombre artístico: ${nombre}
- Nicho de contenido: ${nicho}

${faceUrl ? 'Te adjunto la imagen del ROSTRO — úsala para describir con precisión: color de ojos, tono de piel, color y estilo de cabello, rasgos distintivos (lunares, pecas, etc.).' : ''}
${bodyUrl ? 'Te adjunto la imagen del CUERPO — úsala para describir: altura estimada, constitución física y cualquier rasgo visible.' : ''}

Llena CADA campo de forma creativa, específica y coherente con el nicho y las imágenes. Hazla carismática, única y atractiva. Responde TODO en español. Escribe SOLO el template llenado, sin comentarios adicionales.

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
Rasgos Distintivos (lunares, pecas, etc.): ___

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

🖋️ Modificaciones Corporales
Tatuajes: ___
Piercings: ___
Cicatrices/Marcas de nacimiento: ___

🧠 Personalidad
3 Palabras que la describen: ___ ___ ___
Nivel de coqueteo: 😇 Bajo / 😏 Medio / 😈 Alto
Arquetipo (ej. femme fatale, chica de al lado, CEO baddie): ___
Fantasía principal que encarna para sus fans: ___` })

  const payload = JSON.stringify({
    model: 'claude-sonnet-4-6',
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
    model: 'claude-sonnet-4-6',
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
Genera un calendario de contenido UGC para 5 días (Lunes a Viernes). Tú decides el tema. No hay input del usuario.

REGLAS FOTOGRÁFICAS UGC (aplica en TODOS los prompts):
- "Shot on iPhone 15 Pro" — NUNCA studio lights
- Incluir imperfecciones reales: grain de sensor, ligero motion blur ocasional
- Tipos: selfie | mirror selfie | POV candid | lifestyle moment
- Siempre sexy y sugerente, SFW
- COHERENCIA NARRATIVA a lo largo de la semana
- Prompts en INGLÉS, resto en ESPAÑOL

FORMATO: ÚNICAMENTE JSON válido. Sin markdown.

{
  "theme": "string",
  "summary": "string",
  "week": [
    {
      "day": "Lunes",
      "dayIndex": 0,
      "postType": "single photo",
      "scene": "string en español",
      "caption": "string con emojis",
      "hashtags": ["#tag1"],
      "variations": [
        { "varIndex": 0, "shotType": "selfie", "prompt": "Shot on iPhone 15 Pro..." },
        { "varIndex": 1, "shotType": "mirror selfie", "prompt": "..." },
        { "varIndex": 2, "shotType": "POV candid", "prompt": "..." },
        { "varIndex": 3, "shotType": "lifestyle moment", "prompt": "..." }
      ]
    }
  ]
}

5 días (dayIndex 0–4), 4 variaciones por día (varIndex 0–3).` })

  const payload = JSON.stringify({
    model: 'claude-sonnet-4-6',
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
    req.on('data', d => raw += d)
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) } })
    req.on('error', reject)
  })
}

function json(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(body)
}

const server = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url, true)
  const pathname = parsed.pathname

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' })
    res.end()
    return
  }

  // Serve UI
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'server-ui.html'))
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
    return
  }

  // POST /api/upload-image — upload reference image to Supabase Storage
  if (req.method === 'POST' && pathname === '/api/upload-image') {
    try {
      const body = await readBody(req)
      const { name, data, type } = body
      if (!name || !data) { json(res, 400, { error: 'name y data requeridos' }); return }

      const buffer   = Buffer.from(data, 'base64')
      const ext      = (type || 'image/jpeg').split('/')[1] || 'jpg'
      const filename = `refs/${Date.now()}-${name.replace(/[^a-z0-9]/gi, '_')}.${ext}`

      console.log(`\n[UPLOAD-IMAGE] name="${name}" size=${(buffer.length / 1024).toFixed(1)}KB`)
      const imageUrl = await uploadToSupabase(buffer, filename, type || 'image/jpeg')
      console.log(`  url: ${imageUrl}`)

      json(res, 200, { url: imageUrl })
    } catch (err) {
      console.error('[UPLOAD-IMAGE ERROR]', err.message)
      json(res, 500, { error: err.message })
    }
    return
  }

  // POST /api/generate-face — AION face generation with images, params, and/or prompt
  if (req.method === 'POST' && pathname === '/api/generate-face') {
    try {
      const body   = await readBody(req)
      const inputs = {}

      inputs['photo_type']   = body.photo_type || '-- Not selected / System inferred --'
      inputs['imagen final'] = 'Nano Banana Pro'

      if (body.prompt && body.prompt.trim()) {
        inputs['prompt'] = body.prompt.trim()
      }

      if (body.images) {
        const imageKeys = ['ojos','cejas','nariz','labios','frente','pomulos','piel','menton','cabello','rostro completo']
        for (const key of imageKeys) {
          if (body.images[key]) inputs[key] = body.images[key]
        }
      }

      if (body.params) {
        for (const [key, val] of Object.entries(body.params)) {
          inputs[key] = val
        }
      }

      const imgCount   = Object.keys(body.images  || {}).filter(k => (body.images  || {})[k]).length
      const paramCount = Object.keys(body.params  || {}).filter(k => { const v = (body.params || {})[k]; return v && v !== 'auto' && v !== '-- Not selected / System inferred --' }).length
      console.log(`\n[GENERATE-FACE] photo_type="${inputs['photo_type']}" images=${imgCount} custom_params=${paramCount} prompt=${!!inputs['prompt']}`)

      const runId = await startAionRun(inputs)
      console.log(`  run: ${runId}`)

      json(res, 200, { runIds: [runId] })
    } catch (err) {
      console.error('[GENERATE-FACE ERROR]', err.message)
      json(res, 500, { error: err.message })
    }
    return
  }

  // POST /api/generate-body
  if (req.method === 'POST' && pathname === '/api/generate-body') {
    try {
      const body       = await readBody(req)
      const prompt     = (body.prompt || '').trim()
      const inputImage = (body.input_image || '').trim()
      if (!prompt)     { json(res, 400, { error: 'prompt requerido' }); return }
      if (!inputImage) { json(res, 400, { error: 'input_image requerido' }); return }

      console.log(`\n[GENERATE-BODY] prompt="${prompt.slice(0, 60)}..."`)
      const runId = await startBodyRun(prompt, inputImage)
      console.log(`  run: ${runId}`)

      json(res, 200, { runIds: [runId] })
    } catch (err) {
      console.error('[GENERATE-BODY ERROR]', err.message)
      json(res, 500, { error: err.message })
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
      json(res, 500, { error: err.message })
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
      json(res, 500, { error: err.message })
    }
    return
  }

  // GET /api/influencers
  if (req.method === 'GET' && pathname === '/api/influencers') {
    try { json(res, 200, loadInfluencers()) }
    catch (err) { json(res, 500, { error: err.message }) }
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

      const data = loadInfluencers()
      const influencer = {
        id:         crypto.randomUUID(),
        nombre,
        nicho,
        face_url:   faceUrl,
        body_url:   bodyUrl,
        persona,
        created_at: new Date().toISOString(),
        weeks:      [],
      }
      data.influencers.push(influencer)
      saveInfluencers(data)
      console.log(`\n[INFLUENCER SAVED] "${nombre}" id=${influencer.id}`)
      json(res, 200, { influencer })
    } catch (err) {
      console.error('[INFLUENCER SAVE ERROR]', err.message)
      json(res, 500, { error: err.message })
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

      const data = loadInfluencers()
      const influencer = data.influencers.find(i => i.id === influencerId)
      if (!influencer) { json(res, 404, { error: 'influencer no encontrada' }); return }

      const week = {
        week_id:      crypto.randomUUID(),
        generated_at: new Date().toISOString(),
        theme:        theme   || '',
        summary:      summary || '',
        plan:         plan    || null,
      }
      influencer.weeks.push(week)
      saveInfluencers(data)
      console.log(`\n[WEEK SAVED] influencer="${influencer.nombre}" theme="${theme}"`)
      json(res, 200, { week_id: week.week_id, influencer_id: influencerId })
    } catch (err) {
      console.error('[WEEK SAVE ERROR]', err.message)
      json(res, 500, { error: err.message })
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
      json(res, 500, { error: err.message })
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

      if (!faceUrl)        { json(res, 400, { error: 'face_url requerido' }); return }
      if (!bodyUrl)        { json(res, 400, { error: 'body_url requerido' }); return }
      if (!prompts.length) { json(res, 400, { error: 'prompts requerido' }); return }

      console.log(`\n[CONTENT-DAY] prompts=${prompts.length}`)
      const runId = await startContentDayRun(faceUrl, bodyUrl, prompts)
      console.log(`  run: ${runId}`)

      json(res, 200, { runIds: [runId] })
    } catch (err) {
      console.error('[CONTENT-DAY ERROR]', err.message)
      json(res, 500, { error: err.message })
    }
    return
  }

  // GET /api/status/:runId
  const statusMatch = pathname.match(/^\/api\/status\/([^/]+)$/)
  if (req.method === 'GET' && statusMatch) {
    try {
      const runId = statusMatch[1]
      const data  = await getRun(runId)
      const st    = data.status || ''

      if (st === 'success') {
        console.log(`\n[STATUS] ${runId} -> success`)
        console.log('OUTPUTS:', JSON.stringify(data.outputs, null, 2))
        const images = extractImages(data.outputs)
        console.log(`  images extracted: ${images.length}`)
        json(res, 200, { status: 'success', images })
      } else if (['failed', 'cancelled', 'timeout'].includes(st)) {
        console.log(`[STATUS] ${runId} -> ${st}`)
        json(res, 200, { status: 'error', message: st })
      } else {
        json(res, 200, { status: 'running' })
      }
    } catch (err) {
      console.error('[STATUS ERROR]', err.message)
      json(res, 500, { error: err.message })
    }
    return
  }

  res.writeHead(404)
  res.end('Not found')
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
    console.log(`   AION deploy: ${DEPLOYMENT_ID_AION}`)
    console.log(`   Content:     ${DEPLOYMENT_ID_CONTENT}`)
    console.log(`   Supabase:    ${SUPABASE_URL || 'NO CONFIGURADA'} / bucket: ${SUPABASE_BUCKET}`)
    console.log(`   Influencers: ${db.influencers.length} guardadas`)
    console.log()
  } catch (err) {
    console.error('Error al iniciar:', err.message)
    process.exit(1)
  }
})
