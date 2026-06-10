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
const DEPLOYMENT_ID_CONTENT = process.env.VITE_COMFYDEPLOY_CONTENT_DEPLOYMENT_ID || 'f9822b81-9ebc-48e2-b39c-0e8034e90554'  // Fase 4 UGC - ComfyDeploy (14 slots)
const COMFYCLOUD_API_KEY     = process.env.COMFYCLOUD_API_KEY || ''
const WORKFLOW_SEXY_CONTEXTO = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'workflow-sexy-contexto.json'), 'utf8')) }
  catch (e) { console.warn('[WARN] data/workflow-sexy-contexto.json no encontrado:', e.message); return null }
})()
const SUPABASE_URL          = process.env.VITE_SUPABASE_URL || ''
const SUPABASE_KEY          = process.env.VITE_SUPABASE_ANON_KEY || ''
const SUPABASE_BUCKET       = process.env.SUPABASE_BUCKET || 'zami-images'
const PORT                  = process.env.PORT || 3333
const HOST                  = process.env.HOST || '0.0.0.0'
const PKG_VERSION           = (() => { try { return require('./package.json').version } catch { return '0.0.0' } })()
const CD_BASE               = 'api.comfydeploy.com'
const DATA_DIR              = path.join(__dirname, 'data')
const INFLUENCERS_FILE      = path.join(DATA_DIR, 'influencers.json')
const MAX_JSON_BODY_BYTES   = 25 * 1024 * 1024
const MAX_UPLOAD_BYTES      = 8 * 1024 * 1024
const ALLOWED_IMAGE_TYPES   = new Set(['image/jpeg', 'image/png', 'image/webp'])
const IMAGE_EXTENSIONS      = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
let influencerWriteQueue    = Promise.resolve()
const CC_SEXY_POLL_MS = 3000
const CC_SEXY_OUTPUT_WAIT_LIMIT = 10
const CC_SEXY_EMPTY_PROMPT_MAX_RETRIES = 2
const comfyCloudSexyRuns = new Map()

function isEmptyPromptError(message) {
  if (!message) return false
  return String(message).includes("Field 'prompt' cannot be empty")
}

function nowIso() {
  return new Date().toISOString()
}

function sanitizeLoneSurrogates(value) {
  const s = String(value)
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = s.charCodeAt(i + 1)
      if (next >= 0xDC00 && next <= 0xDFFF) {
        out += s[i] + s[i + 1]
        i++
      }
      continue
    }
    if (code >= 0xDC00 && code <= 0xDFFF) continue
    out += s[i]
  }
  return out
}

function sanitizeForJson(value) {
  if (typeof value === 'string') return sanitizeLoneSurrogates(value)
  if (Array.isArray(value)) return value.map(sanitizeForJson)
  if (value && typeof value === 'object') {
    const clean = {}
    for (const [key, val] of Object.entries(value)) clean[key] = sanitizeForJson(val)
    return clean
  }
  return value
}

function safeJsonStringify(value) {
  return JSON.stringify(sanitizeForJson(value))
}

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

// ── ComfyUI Cloud (cloud.comfy.org) — sexy workflow con contexto ─────────────
async function uploadToComfyCloud(imageUrl) {
  const imgRes = await fetch(imageUrl)
  if (!imgRes.ok) throw new Error(`No se pudo descargar imagen: ${imageUrl}`)
  const imgBuffer = Buffer.from(await imgRes.arrayBuffer())
  const rawExt    = imageUrl.split('?')[0].split('.').pop().toLowerCase()
  const ext       = ['jpg','jpeg','png','webp'].includes(rawExt) ? rawExt : 'jpg'
  const filename  = `upload_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`

  const boundary = `----CCBoundary${Date.now()}`
  const pre  = `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: image/jpeg\r\n\r\n`
  const mid  = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\ninput\r\n--${boundary}--\r\n`
  const body = Buffer.concat([Buffer.from(pre), imgBuffer, Buffer.from(mid)])

  const res = await fetch('https://cloud.comfy.org/api/upload/image', {
    method: 'POST',
    headers: { 'X-API-Key': COMFYCLOUD_API_KEY, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  })
  if (!res.ok) throw new Error(`ComfyCloud upload ${res.status}: ${await res.text()}`)
  const data = await res.json()
  if (!data.name) throw new Error(`ComfyCloud upload sin nombre: ${JSON.stringify(data)}`)
  return data.name
}

function pushCcSexyLog(run, event, details = {}) {
  if (!run) return
  run.logs.push({ at: nowIso(), event, ...details })
  if (run.logs.length > 40) run.logs.splice(0, run.logs.length - 40)
  const suffix = Object.keys(details).length ? ` ${JSON.stringify(details)}` : ''
  console.log(`[CC-SEXY-MONITOR] ${run.id} ${event}${suffix}`)
}

function parseComfyCloudErrorMessage(raw) {
  if (!raw) return ''
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return parsed.exception_message || parsed.message || String(raw)
  } catch {
    return String(raw)
  }
}

async function comfyCloudJson(apiPath) {
  const res = await fetch(`https://cloud.comfy.org${apiPath}`, {
    headers: { 'X-API-Key': COMFYCLOUD_API_KEY },
  })
  const text = await res.text()
  let body
  try { body = text ? JSON.parse(text) : {} }
  catch { body = { raw: text } }
  return { ok: res.ok, status: res.status, body }
}

async function resolveComfyCloudViewUrl(img) {
  if (img._url) return img._url
  const params = new URLSearchParams({
    filename: img.filename,
    subfolder: img.subfolder || '',
    type: img.type || 'output',
  })
  const viewRes = await fetch(`https://cloud.comfy.org/api/view?${params}`, {
    headers: { 'X-API-Key': COMFYCLOUD_API_KEY },
    redirect: 'manual',
  })
  const redirectUrl = viewRes.headers.get('location')
  if (redirectUrl) return redirectUrl
  if (viewRes.ok && viewRes.url) return viewRes.url
  return null
}

async function extractComfyCloudSexyImages(jobData) {
  const outputs = jobData.outputs || {}
  const sexyFiles = []
  for (const nodeOutputs of Object.values(outputs)) {
    if (!nodeOutputs || typeof nodeOutputs !== 'object') continue
    const images = nodeOutputs.images || nodeOutputs.imgs || []
    for (const img of images) {
      if (!img) continue
      if (typeof img === 'string') {
        const fname = img.split('/').pop().split('?')[0]
        if (/ZSEXY\d+/.test(fname)) sexyFiles.push({ filename: fname, display_name: fname, subfolder: '', type: 'output', _url: img })
      } else if (img.filename) {
        const displayName = img.display_name || img.filename
        if (/ZSEXY\d+/.test(displayName)) {
          sexyFiles.push({
            filename: img.filename,
            display_name: displayName,
            subfolder: img.subfolder || '',
            type: img.type || 'output',
          })
        }
      }
    }
  }

  sexyFiles.sort((a, b) => {
    const aKey = a.display_name || a.filename
    const bKey = b.display_name || b.filename
    const aNum = parseInt(aKey.match(/ZSEXY(\d+)/)?.[1] || '0')
    const bNum = parseInt(bKey.match(/ZSEXY(\d+)/)?.[1] || '0')
    return aNum - bNum
  })

  const sexyImages = (await Promise.all(sexyFiles.map(resolveComfyCloudViewUrl))).filter(Boolean)
  return { sexyFiles, sexyImages }
}

function publicCcSexyStatus(run) {
  return {
    status: run.status,
    runId: 'ccsx:' + run.id,
    message: run.message,
    cloudStatus: run.cloudStatus || null,
    queueRemaining: run.queueRemaining ?? null,
    retryCount: run.retryCount || 0,
    maxRetries: CC_SEXY_EMPTY_PROMPT_MAX_RETRIES,
    pollMs: CC_SEXY_POLL_MS,
    updatedAt: run.updatedAt,
    sexyImages: run.sexyImages || undefined,
    logs: run.logs.slice(-12),
  }
}

function stopCcSexyMonitor(run) {
  if (run && run.timer) {
    clearInterval(run.timer)
    run.timer = null
  }
}

async function retryComfyCloudSexyRun(run, reason) {
  if (run.retryCount >= CC_SEXY_EMPTY_PROMPT_MAX_RETRIES) {
    run.status = 'error'
    run.message = `${reason}; retry limit reached (${run.retryCount}/${CC_SEXY_EMPTY_PROMPT_MAX_RETRIES})`
    run.updatedAt = nowIso()
    stopCcSexyMonitor(run)
    pushCcSexyLog(run, 'retry-limit', { reason })
    return
  }
  const nextRetry = run.retryCount + 1
  pushCcSexyLog(run, 'retry-start', { reason, nextRetry })
  stopCcSexyMonitor(run)
  const retryRunId = await startComfyCloudSexyRun(run.faceUrl, run.bodyUrl, run.contextoUrl, nextRetry)
  run.status = 'retrying'
  run.message = `ComfyUI Cloud devolvio un prompt vacio; reintentando (${nextRetry}/${CC_SEXY_EMPTY_PROMPT_MAX_RETRIES})`
  run.nextRunId = retryRunId
  run.updatedAt = nowIso()
}

async function pollComfyCloudSexyRun(ccId) {
  const run = comfyCloudSexyRuns.get(ccId)
  if (!run || run.polling || ['success', 'error', 'retrying'].includes(run.status)) return
  run.polling = true
  try {
    const queueRes = await comfyCloudJson('/api/prompt')
    if (queueRes.ok) run.queueRemaining = queueRes.body?.exec_info?.queue_remaining ?? null

    const statusRes = await comfyCloudJson(`/api/job/${ccId}/status`)
    if (!statusRes.ok) {
      run.status = statusRes.status >= 500 ? 'running' : 'error'
      run.message = statusRes.status >= 500 ? `ComfyUI Cloud temporal ${statusRes.status}; reintentando monitor` : `ComfyUI Cloud API error ${statusRes.status}`
      run.updatedAt = nowIso()
      pushCcSexyLog(run, 'status-http-error', { http: statusRes.status })
      if (run.status === 'error') stopCcSexyMonitor(run)
      return
    }

    const statusData = statusRes.body
    const st = statusData.status || ''
    run.cloudStatus = st
    run.assignedInference = statusData.assigned_inference || null
    run.lastStateUpdate = statusData.last_state_update || null
    run.updatedAt = nowIso()
    pushCcSexyLog(run, 'status', { cloudStatus: st, queueRemaining: run.queueRemaining })

    if (['completed', 'success'].includes(st)) {
      const jobRes = await comfyCloudJson(`/api/jobs/${ccId}`)
      if (!jobRes.ok) {
        run.status = 'running'
        run.message = `Job terminado; esperando detalles (${jobRes.status})`
        pushCcSexyLog(run, 'details-wait', { http: jobRes.status })
        return
      }
      const jobData = jobRes.body
      const { sexyFiles, sexyImages } = await extractComfyCloudSexyImages(jobData)
      run.outputNames = sexyFiles.map(f => f.display_name || f.filename)
      run.outputsCount = jobData.outputs_count || 0
      pushCcSexyLog(run, 'outputs-check', { files: sexyFiles.length, urls: sexyImages.length, outputsCount: run.outputsCount })
      if (sexyImages.length >= 10) {
        run.status = 'success'
        run.message = `10 imagenes resueltas: ${sexyImages.length}`
        run.sexyImages = sexyImages.slice(0, 10)
        run.updatedAt = nowIso()
        stopCcSexyMonitor(run)
        return
      }
      run.outputWaits = (run.outputWaits || 0) + 1
      run.status = 'running'
      run.message = `Cloud termino, esperando 10 outputs ZSEXY (${sexyImages.length}/10, chequeo ${run.outputWaits}/${CC_SEXY_OUTPUT_WAIT_LIMIT})`
      if (run.outputWaits >= CC_SEXY_OUTPUT_WAIT_LIMIT) {
        run.status = 'error'
        run.message = `Cloud termino con ${sexyImages.length}/10 outputs ZSEXY tras ${CC_SEXY_OUTPUT_WAIT_LIMIT} chequeos`
        stopCcSexyMonitor(run)
      }
      return
    }

    if (['error', 'failed', 'cancelled'].includes(st)) {
      const message = parseComfyCloudErrorMessage(statusData.error_message || st)
      pushCcSexyLog(run, 'terminal-error', { cloudStatus: st, message })
      if (isEmptyPromptError(message)) {
        await retryComfyCloudSexyRun(run, message.trim())
        return
      }
      run.status = 'error'
      run.message = message
      run.updatedAt = nowIso()
      stopCcSexyMonitor(run)
      return
    }

    run.status = 'running'
    run.message = `ComfyUI Cloud: ${st || 'running'}${run.queueRemaining !== null ? ` | cola: ${run.queueRemaining}` : ''}`
  } catch (err) {
    run.status = 'running'
    run.message = `Monitor ComfyUI temporal: ${err.message}`
    run.updatedAt = nowIso()
    pushCcSexyLog(run, 'monitor-error', { message: err.message })
  } finally {
    run.polling = false
  }
}

function startCcSexyMonitor(ccId) {
  const run = comfyCloudSexyRuns.get(ccId)
  if (!run || run.timer) return
  run.timer = setInterval(() => { pollComfyCloudSexyRun(ccId).catch(err => pushCcSexyLog(run, 'monitor-crash', { message: err.message })) }, CC_SEXY_POLL_MS)
  pollComfyCloudSexyRun(ccId).catch(err => pushCcSexyLog(run, 'monitor-crash', { message: err.message }))
}

async function startComfyCloudSexyRun(faceUrl, bodyUrl, contextoUrl, retryCount = 0) {
  if (!COMFYCLOUD_API_KEY) throw new Error('Agrega COMFYCLOUD_API_KEY en tu .env')
  if (!WORKFLOW_SEXY_CONTEXTO) throw new Error('No se encontró data/workflow-sexy-contexto.json')

  console.log('  [CC-SEXY] Subiendo 3 imágenes a cloud.comfy.org...')
  const [rostroName, cuerpoName, contextoName] = await Promise.all([
    uploadToComfyCloud(faceUrl),
    uploadToComfyCloud(bodyUrl),
    uploadToComfyCloud(contextoUrl),
  ])
  console.log(`  [CC-SEXY] uploads: ${rostroName} | ${cuerpoName} | ${contextoName}`)

  const workflow = JSON.parse(JSON.stringify(WORKFLOW_SEXY_CONTEXTO))
  workflow['727']['inputs']['image'] = rostroName
  workflow['728']['inputs']['image'] = cuerpoName
  workflow['729']['inputs']['image'] = contextoName

  const res = await fetch('https://cloud.comfy.org/api/prompt', {
    method: 'POST',
    headers: { 'X-API-Key': COMFYCLOUD_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, extra_data: { api_key_comfy_org: COMFYCLOUD_API_KEY } }),
  })
  if (!res.ok) throw new Error(`ComfyCloud prompt ${res.status}: ${await res.text()}`)
  const data = await res.json()
  console.log(`  [CC-SEXY] prompt_id: ${data.prompt_id}`)
  comfyCloudSexyRuns.set(data.prompt_id, {
    id: data.prompt_id,
    faceUrl,
    bodyUrl,
    contextoUrl,
    retryCount,
    status: 'running',
    message: 'Run enviado a ComfyUI Cloud; monitor activo cada 3s',
    logs: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    outputWaits: 0,
  })
  pushCcSexyLog(comfyCloudSexyRuns.get(data.prompt_id), 'submitted', { retryCount, pollMs: CC_SEXY_POLL_MS })
  startCcSexyMonitor(data.prompt_id)
  return 'ccsx:' + data.prompt_id
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

REGLA FÍSICA CRÍTICA: Para rasgos físicos visibles (lunares, pecas, tatuajes, piercings, cicatrices), describe ÚNICAMENTE lo que veas claramente en las imágenes. Si no lo ves → escribe "No visible". El resto de campos (personalidad, gustos, historia) SÍ son creativos.

Datos:
- Nombre artístico: ${nombre}
- Nicho: ${nicho}
${faceUrl ? '- Imagen ROSTRO adjunta: úsala para color de ojos, tono de piel, cabello.' : ''}
${bodyUrl ? '- Imagen CUERPO adjunta: úsala para altura estimada y constitución.' : ''}

RESPONDE ÚNICAMENTE con un array JSON válido. Sin texto antes ni después. Sin markdown. Sin bloques de código. Solo el JSON puro.

Estructura exacta (llena cada "val" en español, creativamente, coherente con el nicho):
[
  {"title":"📛 Alias","fields":[
    {"key":"Stage Name","val":"${nombre}"},
    {"key":"Nombre Real","val":""},
    {"key":"Handle","val":"@"},
    {"key":"Apodos","val":""},
    {"key":"Edad","val":""},
    {"key":"Cumpleaños","val":""},
    {"key":"Signo Zodiacal","val":""}
  ]},
  {"title":"📏 Físico & Apariencia","fields":[
    {"key":"Altura","val":""},
    {"key":"Talla de zapatos","val":""},
    {"key":"Color y estilo de cabello","val":""},
    {"key":"Color de ojos","val":""},
    {"key":"Tono de piel","val":""},
    {"key":"Rasgos Distintivos","val":""}
  ]},
  {"title":"🌍 Origen & Ubicación","fields":[
    {"key":"Etnicidad","val":""},
    {"key":"Ciudad natal","val":""},
    {"key":"Ubicación actual","val":""},
    {"key":"Cómo la conocieron los fans","val":""}
  ]},
  {"title":"🐾 Estilo de Vida","fields":[
    {"key":"Mascotas","val":""},
    {"key":"Trabajo","val":""},
    {"key":"Familia","val":""}
  ]},
  {"title":"🍣 Favoritos & Antojos","fields":[
    {"key":"Comida favorita","val":""},
    {"key":"Restaurante favorito","val":""},
    {"key":"Bebida favorita","val":""},
    {"key":"Comida trampa","val":""}
  ]},
  {"title":"🎵 Vibe Musical","fields":[
    {"key":"Géneros musicales","val":""},
    {"key":"Artistas favoritos","val":""},
    {"key":"Canción de cabecera","val":""}
  ]},
  {"title":"🎬 Entretenimiento","fields":[
    {"key":"Géneros favoritos","val":""},
    {"key":"Series o películas top","val":""},
    {"key":"Para relajarse","val":""}
  ]},
  {"title":"💫 Hobbies & Hábitos","fields":[
    {"key":"Hobby 1","val":""},
    {"key":"Hobby 2","val":""},
    {"key":"Hobby 3","val":""},
    {"key":"Talento secreto","val":""}
  ]},
  {"title":"📲 Huella Digital","fields":[
    {"key":"Emojis más usados","val":""},
    {"key":"Frase típica 1","val":""},
    {"key":"Frase típica 2","val":""},
    {"key":"Frase típica 3","val":""},
    {"key":"Estilo al escribir","val":""}
  ]},
  {"title":"🔥 Persona de Contenido","fields":[
    {"key":"Nicho","val":"${nicho}"},
    {"key":"Estilo de representación","val":""},
    {"key":"Temas recurrentes","val":""},
    {"key":"Lo que más les gusta a sus fans","val":""}
  ]},
  {"title":"🖋️ Modificaciones Corporales","fields":[
    {"key":"Tatuajes","val":""},
    {"key":"Piercings","val":""},
    {"key":"Cicatrices/Marcas","val":""}
  ]},
  {"title":"🧠 Personalidad","fields":[
    {"key":"3 palabras que la describen","val":""},
    {"key":"Nivel de coqueteo","val":""},
    {"key":"Arquetipo","val":""},
    {"key":"Fantasía principal","val":""}
  ]}
]` })

  const payload = safeJsonStringify({
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
          const text = data.content[0].text.trim()
          const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim()
          try {
            resolve(JSON.parse(cleaned))
          } catch (parseErr) {
            console.error('[PERSONA JSON PARSE ERROR] raw text:', text.slice(0, 300))
            reject(new Error('Claude no devolvió JSON válido para el perfil. Intenta de nuevo.'))
          }
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

  const payload = safeJsonStringify({
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

  const noRepeatBlock = weekHistory && weekHistory.length > 0
    ? `NO REPETIR — YA SE USARON EN SEMANAS ANTERIORES:\n${weekHistory.map((w, i) => {
        const parts = [`Semana ${i + 1}: ${w.theme}`]
        if (w.summary)       parts.push(`  Resumen: ${w.summary}`)
        if (w.scenes)        parts.push(`  Escenas/locaciones: ${w.scenes}`)
        if (w.hashtags)      parts.push(`  Hashtags usados: ${w.hashtags}`)
        if (w.captions_tone) parts.push(`  Tono de captions: ${w.captions_tone}`)
        return parts.join('\n')
      }).join('\n\n')}`
    : 'Es la primera semana de contenido de esta influencer — sin historial previo.'

  content.push({ type: 'text', text: `Eres el director creativo personal de esta influencer. Tu trabajo es capturar un momento real de su vida esta semana.

IDENTIDAD DEL PERSONAJE:
Nombre: ${nombre}
Nicho: ${nicho}

AI PERSONA COMPLETO (su vida real, personalidad, hábitos, lugares, frases, estilo):
${persona}

${noRepeatBlock}

DIVERSIDAD OBLIGATORIA:
- NINGÚN hashtag repetido del historial anterior
- NINGUNA escena en la misma locación que semanas anteriores
- NINGÚN tema genérico de influencer (matcha, brunch genérico, playa genérica, salida con amigas) a menos que esté explícitamente en su AI Persona
- Los momentos deben nacer de SU vida específica, no de arquetipos de Instagram

CÓMO ELEGIR EL TEMA DE ESTA SEMANA:
1. Lee el AI Persona completo — sus hobbies, rutinas, lugares favoritos, relaciones, miedos, ambiciones, frases típicas
2. Decide qué está viviendo ESTA persona ESTA semana específicamente: ¿un viaje corto? ¿una situación de trabajo? ¿un mood específico de temporada? ¿una decisión pequeña de su vida diaria? ¿algo nuevo que está probando? Que sea concreto y personal, no genérico
3. Ese momento-de-vida real ES el hilo narrativo de la semana
4. Los 8 posts son perspectivas o momentos distintos de ese mismo hilo — naturales, como si alguien la siguiera con una cámara su propio teléfono

SLOTS Y SUS ASPECT RATIOS (fijos en el workflow — no puedes cambiarlos):
- Slot 1: 9:16 → Story o Reel vertical (close-up, espontáneo, selfie POV)
- Slot 2: 9:16 → Story o Reel vertical (close-up, espontáneo, selfie POV)
- Slot 3: 1:1  → Square (momento estético, detalle del ambiente, objeto personal)
- Slot 4: 1:1  → Square (momento candid o moodboard del hilo narrativo)
- Slot 5: 3:4  → Feed portrait lifestyle (ambiente natural del hilo)
- Slot 6: 4:5  → Feed portrait editorial (ella como protagonista del hilo)
- Slot 7: 1:1  → Square (detalle o momento secundario del hilo)
- Slot 8: 4:5  → Feed portrait editorial (cierre visual del hilo)

Distribuye los 8 posts en la semana de lunes a viernes según la narrativa del hilo. Tú decides cuántos por día.

PHOTOGRAPHY RULES — apply to every single prompt:
Start every prompt with: "Shot on iPhone 15 Pro," — this is the only fixed element.

LIGHTING — do not pick from a list. Read the scene you already described.
The scene's location, time of day, and activity already imply a specific light source.
Name that exact physical light as it exists in that space.
A sauna: steam-diffused reddish heat glow. A 6am gym: cold overhead fluorescents.
A yacht deck: harsh glare reflecting off the water surface. A bedroom at night: single warm lamp.
Describe the actual light, not a generic photography label like "golden hour" or "natural light".
Never reuse the same lighting description across the 8 prompts of a week.

TECHNICAL IMPERFECTION — choose one artifact that is physically caused by the shooting conditions.
A dark selfie → sensor noise. A fast-moving subject → motion blur. A bright outdoor scene
→ blown highlights on skin. A mirror → slight lens distortion. A steamy space → condensation
softening the lens. The imperfection must be a logical consequence of the scene — not a rotation.
Never reuse the same imperfection type across the 8 weekly prompts.

CAMERA: "f/1.8 equivalent, subject sharp, background naturally bokeh-blurred" when applicable.
SKIN: "natural skin texture, pores slightly visible, real complexion" in every close-up.
COMPOSITION: slightly imperfect, off-center, or organic crop — never symmetrically perfect framing.

GEMINI SAFETY — OBLIGATORIO: NUNCA nude, naked, revealing, topless, sensual, erotic, explicit
— usar: alluring, captivating, magnetic, smoldering, confident, fierce, striking,
body-hugging outfit, curve-accentuating.

Each prompt: 80–120 words, one dense paragraph, generation-ready, in English.

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

  const payload = safeJsonStringify({
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
const BODY_PARAM_KEYS          = Object.keys(BODY_PARAM_OPTIONS)
const AION_IMAGE_KEYS          = ['eyes','eyebrows','nose','lips','forehead','jawline','hairline','skin','full_face']

function normalizeTextForMatching(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function isAllowedBodyParam(key, value) {
  return Boolean(BODY_PARAM_OPTIONS[key]?.includes(value))
}

function requireAllowedEnum(key, value, options, label) {
  if (options.includes(value)) return
  const err = new Error(`${label || key} invalido: "${value}". Opciones validas: ${options.join(', ')}`)
  err.statusCode = 400
  throw err
}

function applyBodyParam(target, key, value, { overwrite = true } = {}) {
  if (!isAllowedBodyParam(key, value)) return
  if (!overwrite && target[key]) return
  target[key] = value
}

function inferBodyParamOverridesFromText(...parts) {
  const text = normalizeTextForMatching(parts.filter(Boolean).join(' '))
  if (!text.trim()) return {}

  const has = pattern => pattern.test(text)
  const overrides = {}

  const extreme = has(/\b(super|muy|enorme|ultra|exagerad\w*|massive|huge|enormous|gigantic|oversized|hyper|maximo|grandisimo|xxl|ridiculously|demasiad\w*|extrem\w*)\b/)
  const high = extreme || has(/\b(grand\w*|big|wide|anch\w*|prominent\w*|prominente\w*|voluminos\w*|curvy|curvi\w*|curviline\w*|pronounced|significant|ample|notable|desarrollad\w*|marcad\w*)\b/)

  const wantsCurvy = has(/\b(curvy|curvi\w*|curviline\w*|voluptuos\w*|reloj de arena|hourglass|cuerpazo|thick|thicc|baddie)\b/)
  const wantsBust = has(/\b(busto|pecho|pechos|seno|senos|teta|tetas|tetona|pechugona|busty|bust|boobs?|breasts?|chest|delantera)\b/)
  const wantsGlutes = has(/\b(trasero|culo|culona|cola|nalgas?|nalgona|gluteos?|glutes?|butt|booty|bootylicious|rear)\b/)
  const wantsHips = has(/\b(cadera|caderas|hips?)\b/)
  const wantsWaist = has(/\b(cintura|waist|reloj de arena|hourglass)\b/)
  const wantsLegs = has(/\b(piernas?|legs?|muslos?|thighs?)\b/)

  if (wantsCurvy) {
    applyBodyParam(overrides, 'body_type', 'curvy fuller figure')
    applyBodyParam(overrides, 'waist', high ? 'very narrow waist extreme hourglass' : 'narrow defined waist')
    applyBodyParam(overrides, 'bust', high ? 'extra large bust' : 'large bust')
    applyBodyParam(overrides, 'glutes', high ? 'extra large glutes exaggerated proportions' : 'large voluminous glutes')
    applyBodyParam(overrides, 'hips', high ? 'very wide hips' : 'wide hips')
    applyBodyParam(overrides, 'legs', 'full thick thighs')
  }

  if (wantsBust) {
    applyBodyParam(overrides, 'bust', extreme ? 'massive oversized bust ultra-exaggerated' : (high ? 'extremely large bust exaggerated proportions' : 'large bust'))
  }
  if (wantsGlutes) {
    applyBodyParam(overrides, 'glutes', extreme ? 'massive oversized glutes ultra-exaggerated' : (high ? 'extra large glutes exaggerated proportions' : 'large voluminous glutes'))
  }
  if (wantsHips) {
    applyBodyParam(overrides, 'hips', extreme ? 'full rounded hips exaggerated width' : (high ? 'very wide hips' : 'wide hips'))
  }
  if (wantsWaist) {
    applyBodyParam(overrides, 'waist', high ? 'very narrow waist extreme hourglass' : 'narrow defined waist')
    if (!overrides.body_type && (wantsBust || wantsGlutes || wantsHips || wantsCurvy)) {
      applyBodyParam(overrides, 'body_type', 'hourglass figure')
    }
  }
  if (wantsLegs) {
    applyBodyParam(overrides, 'legs', high ? 'wide thighs full legs' : 'full thick thighs')
  }

  if ((wantsBust || wantsGlutes || wantsHips) && !overrides.body_type) {
    applyBodyParam(overrides, 'body_type', wantsHips || wantsGlutes ? 'curvy fuller figure' : 'hourglass figure')
  }
  if ((wantsBust || wantsGlutes || wantsHips || wantsCurvy) && !overrides.waist) {
    applyBodyParam(overrides, 'waist', 'narrow defined waist')
  }

  return overrides
}

function buildBodyPromptReinforcement(description, overrides) {
  const clauses = []
  if (overrides.body_type) clauses.push(`${overrides.body_type} overall silhouette`)
  if (overrides.bust) clauses.push(`${overrides.bust}`)
  if (overrides.waist) clauses.push(`${overrides.waist}`)
  if (overrides.glutes) clauses.push(`${overrides.glutes}`)
  if (overrides.hips) clauses.push(`${overrides.hips}`)
  if (overrides.legs) clauses.push(`${overrides.legs}`)
  if (!clauses.length) return ''
  return ` Body proportions must clearly reflect the user's request: ${clauses.join(', ')}. Keep the result anatomically coherent, adult, photorealistic, and faithful to the selected body enum parameters.`
}

function normalizeAionPayload(inputs) {
  inputs['photo_type']    = inputs['photo_type']    || '-- Not selected / System inferred --'
  inputs['imagen rostro'] = inputs['imagen rostro'] || 'Nano Banana Pro'
  inputs['save_image']    = inputs['save_image']    || 'ComfyUI'
  inputs['model']         = inputs['model']         || 'gemini-3.1-pro-preview'
  inputs['image_model']   = inputs['image_model']   || 'Nano Banana Pro (gemini-3-pro-image-preview)'
  inputs['resolution']    = inputs['resolution']    || '512px'

  requireAllowedEnum('model', inputs['model'], BODY_MODEL_OPTIONS, 'body model')
  requireAllowedEnum('image_model', inputs['image_model'], BODY_IMAGE_MODEL_OPTIONS, 'body image_model')
  requireAllowedEnum('resolution', inputs['resolution'], BODY_RESOLUTION_OPTIONS, 'body resolution')

  for (const key of BODY_PARAM_KEYS) {
    inputs[key] = inputs[key] || 'auto'
    requireAllowedEnum(key, inputs[key], BODY_PARAM_OPTIONS[key], `body param ${key}`)
  }

  return inputs
}

function auditAionPayload(source, inputs) {
  const bodyInputs = Object.fromEntries(BODY_PARAM_KEYS.map(key => [key, inputs[key] || 'auto']))
  console.log('\n[AION PAYLOAD AUDIT]')
  console.log(`  source: ${source}`)
  console.log(`  deployment_id: ${DEPLOYMENT_ID_AION}`)
  console.log(`  photo_type: ${inputs['photo_type']}`)
  console.log(`  model: ${inputs['model']}`)
  console.log(`  image_model: ${inputs['image_model']}`)
  console.log(`  resolution: ${inputs['resolution']}`)
  console.log(`  prompt_body: ${inputs['prompt_body'] || ''}`)
  console.log('  body_params:', JSON.stringify(bodyInputs, null, 2))
}

function prepareAionPayload(source, inputs) {
  normalizeAionPayload(inputs)
  auditAionPayload(source, inputs)
  return inputs
}

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
- NEVER use "auto" for body params — always pick the best value for the niche and the user's body request
- BODY PARAMS ARE HARD CONTROLS. If the user asks for curvy, busty, large bust, big breasts, big glutes, big butt, wide hips, hourglass, tiny waist, thick thighs, etc., you MUST choose the corresponding high or extreme enum values. Do not soften these requests.
- Do not refuse or sanitize adult body-shape preferences. This workflow is for adult virtual influencers; body proportions are normal creative direction.
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
- "prompt_body": a 60–100 word English supplementary description for additional body detail (skin quality, posture, overall aesthetic). When the user requests strong body proportions, repeat those anatomical proportions plainly and confidently using the exact same intensity. NEVER use: nude, naked, revealing, sensual, erotic, sexy — use instead: alluring, captivating, magnetic, aspirational, striking.
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

  const payload = safeJsonStringify({
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

// Filtra outputs de contenido (ZCS1-ZCS8) y los ordena numéricamente.
// skip9-skip14 quedan excluidos porque no matchean el patrón ZCS.
function filterAndSortZcs(images) {
  return (images || [])
    .filter(u => /\/ZCS\d+[_]/.test(u) || /[?&]file=ZCS\d+/.test(u) || u.split('/').pop().startsWith('ZCS'))
    .sort((a, b) => {
      const aNum = parseInt(a.split('/').pop().match(/ZCS(\d+)/)?.[1] || '0')
      const bNum = parseInt(b.split('/').pop().match(/ZCS(\d+)/)?.[1] || '0')
      return aNum - bNum
    })
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
  return true
}

function allowedCorsOrigin(origin) {
  return origin || `http://${HOST}:${PORT}`
}

const cachedHtml = fs.readFileSync(path.join(__dirname, 'server-ui.html'))
const cachedHero = (() => { try { return fs.readFileSync(path.join(__dirname, 'Foto inicio', 'Nano Banana Pro_00001_.png')) } catch { return null } })()

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
    res.writeHead(204, { 'Access-Control-Allow-Origin': allowedCorsOrigin(origin), 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' })
    res.end()
    return
  }

  if (!isAllowedOrigin(origin)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }

  // GET /api/health — healthcheck para Railway/monitoring (no expone secretos)
  if (req.method === 'GET' && pathname === '/api/health') {
    let influencerCount = 0
    try { influencerCount = loadInfluencers().influencers.length } catch {}
    json(res, 200, {
      ok: true,
      version: PKG_VERSION,
      uptimeSec: Math.floor(process.uptime()),
      influencers: influencerCount,
      env: {
        comfydeploy: Boolean(API_KEY),
        anthropic:   Boolean(ANTHROPIC_KEY),
        supabase:    Boolean(SUPABASE_URL && SUPABASE_KEY),
        comfycloud:  Boolean(COMFYCLOUD_API_KEY),
      },
    })
    return
  }

  // Serve UI
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(cachedHtml)
    return
  }

  // Serve hero photo
  if (req.method === 'GET' && pathname === '/hero-photo.png') {
    if (!cachedHero) { res.writeHead(404); res.end('Not found'); return }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' })
    res.end(cachedHero)
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
        for (const key of AION_IMAGE_KEYS) {
          if (body.images[key]) inputs[key] = body.images[key]
        }
      }

      if (body.params) {
        for (const [key, val] of Object.entries(body.params)) {
          if (!BODY_PARAM_OPTIONS[key]) inputs[key] = val
        }
      }

      // 7 direct body enum params — validate now; normalizeAionPayload fills missing keys as "auto".
      if (body.body_params) {
        for (const [key, val] of Object.entries(body.body_params)) {
          if (!BODY_PARAM_OPTIONS[key]) continue
          const selected = val || 'auto'
          requireAllowedEnum(key, selected, BODY_PARAM_OPTIONS[key], `body param ${key}`)
          if (selected !== 'auto') inputs[key] = selected
        }
      }

      // body_description passed directly as brief_text (no Claude processing needed)
      if (body.body_description && body.body_description.trim()) {
        inputs['prompt_body'] = body.body_description.trim()
      }

      const inferredBodyParams = inferBodyParamOverridesFromText(body.body_description, body.prompt, body.nicho)
      for (const [key, val] of Object.entries(inferredBodyParams)) {
        applyBodyParam(inputs, key, val, { overwrite: false })
      }
      if (Object.keys(inferredBodyParams).length) {
        const reinforcement = buildBodyPromptReinforcement(body.body_description || body.prompt || body.nicho, inferredBodyParams)
        inputs['prompt_body'] = `${inputs['prompt_body'] || ''}${reinforcement}`.trim()
        console.log('  Body params inferred from text:', JSON.stringify(inferredBodyParams, null, 2))
      }

      const imgCount   = Object.keys(body.images  || {}).filter(k => (body.images  || {})[k]).length
      const paramCount = Object.keys(body.params  || {}).filter(k => { const v = (body.params || {})[k]; return v && v !== 'auto' && v !== '-- Not selected / System inferred --' }).length
      const bodyCount  = Object.keys(inputs).filter(k => BODY_PARAM_OPTIONS[k] && inputs[k] && inputs[k] !== 'auto').length
      console.log(`\n[GENERATE-FACE] photo_type="${inputs['photo_type']}" images=${imgCount} face_params=${paramCount} body_params=${bodyCount} prompt_body=${!!inputs['prompt_body']} model="${inputs['model']}" res="${inputs['resolution']}"`)

      prepareAionPayload('manual-generate-face', inputs)
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
        if (bodyParamKeys.has(k)) {
          requireAllowedEnum(k, v || 'auto', BODY_PARAM_OPTIONS[k], `Claude body param ${k}`)
          bodyParams[k] = v || 'auto'
        }
        else faceParams[k] = v
      }
      const bodyOverrides = inferBodyParamOverridesFromText(description, nicho)
      if (Object.keys(bodyOverrides).length) {
        Object.assign(bodyParams, bodyOverrides)
        console.log('  Body params forced from user text:', JSON.stringify(bodyOverrides, null, 2))
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
      // 7 direct body enum params — normalizeAionPayload fills any missing key as "auto".
      for (const [k, v] of Object.entries(bodyParams)) {
        if (v && v !== 'auto') inputs[k] = v
      }
      const reinforcedPromptBody = `${promptBody || ''}${buildBodyPromptReinforcement(description, bodyOverrides)}`.trim()
      if (reinforcedPromptBody) inputs['prompt_body'] = reinforcedPromptBody

      prepareAionPayload('claude-guided-face', inputs)
      const runId = await startAionRun(inputs)
      console.log(`  run: ${runId}`)

      const finalBodyParams = Object.fromEntries(BODY_PARAM_KEYS.map(k => [k, inputs[k]]))
      json(res, 200, { runId, selected_params: { ...faceParams, ...finalBodyParams }, prompt_body: reinforcedPromptBody || null })
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

  // POST /api/generate-content-2weeks — Plan + Run para 2 semanas en secuencia
  if (req.method === 'POST' && pathname === '/api/generate-content-2weeks') {
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

      console.log(`\n[CONTENT-2WEEKS] nombre="${nombre}" nicho="${nicho}" historial=${weekHistory.length}`)

      const plan1 = await generateContentPlan(nombre, nicho, persona, faceUrl, bodyUrl, weekHistory)
      console.log(`  Semana 1 plan: theme="${plan1.theme}"`)
      const prompts1 = plan1.week.map(w => w.prompt || '')
      const runId1   = await startComfyDeployContentRun(faceUrl, bodyUrl, prompts1)
      console.log(`  Semana 1 run: ${runId1}`)

      const extendedHistory = [...weekHistory, { theme: plan1.theme, summary: plan1.summary || '' }]
      const plan2 = await generateContentPlan(nombre, nicho, persona, faceUrl, bodyUrl, extendedHistory)
      console.log(`  Semana 2 plan: theme="${plan2.theme}"`)
      const prompts2 = plan2.week.map(w => w.prompt || '')
      const runId2   = await startComfyDeployContentRun(faceUrl, bodyUrl, prompts2)
      console.log(`  Semana 2 run: ${runId2}`)

      json(res, 200, {
        week1: { plan: plan1, runId: runId1 },
        week2: { plan: plan2, runId: runId2 },
      })
    } catch (err) {
      console.error('[CONTENT-2WEEKS ERROR]', err.message)
      fail(res, err)
    }
    return
  }

  // POST /api/generate-sexy-from-content — ComfyUI Cloud (ccsx:) con contexto
  if (req.method === 'POST' && pathname === '/api/generate-sexy-from-content') {
    try {
      const body        = await readBody(req)
      const faceUrl     = (body.face_url     || '').trim()
      const bodyUrl     = (body.body_url     || '').trim()
      const contextoUrl = (body.contexto_url || '').trim()
      if (!faceUrl)     { json(res, 400, { error: 'face_url requerido' }); return }
      if (!bodyUrl)     { json(res, 400, { error: 'body_url requerido' }); return }
      if (!contextoUrl) { json(res, 400, { error: 'contexto_url requerido' }); return }
      console.log(`\n[CC-SEXY-RUN] face=${faceUrl.split('/').pop()} contexto=${contextoUrl.split('/').pop()}`)
      const runId = await startComfyCloudSexyRun(faceUrl, bodyUrl, contextoUrl)
      json(res, 200, { runId })
    } catch (err) {
      console.error('[CC-SEXY ERROR]', err.message)
      fail(res, err)
    }
    return
  }

  // GET /api/status/:runId
  const statusMatch = pathname.match(/^\/api\/status\/([^/]+)$/)
  if (req.method === 'GET' && statusMatch) {
    try {
      const runId = decodeURIComponent(statusMatch[1])

      // ComfyUI Cloud sexy run con contexto (prefijo ccsx:)
      if (runId.startsWith('ccsx:')) {
        const ccId = runId.slice(5)
        if (!comfyCloudSexyRuns.has(ccId)) {
          comfyCloudSexyRuns.set(ccId, {
            id: ccId,
            retryCount: CC_SEXY_EMPTY_PROMPT_MAX_RETRIES,
            status: 'running',
            message: 'Watcher read-only creado para run existente',
            logs: [],
            createdAt: nowIso(),
            updatedAt: nowIso(),
            outputWaits: 0,
          })
          pushCcSexyLog(comfyCloudSexyRuns.get(ccId), 'watch-existing', { pollMs: CC_SEXY_POLL_MS })
          startCcSexyMonitor(ccId)
        }
        const monitoredRun = comfyCloudSexyRuns.get(ccId)
        if (monitoredRun.status === 'retrying' && monitoredRun.nextRunId) {
          return json(res, 200, { ...publicCcSexyStatus(monitoredRun), runId: monitoredRun.nextRunId })
        }
        return json(res, 200, publicCcSexyStatus(monitoredRun))
      }

      // ── ComfyDeploy Content run (prefijo cdc:) ───────────────────────────
      if (runId.startsWith('cdc:')) {
        const cdcId = runId.slice(4)
        const data  = await getRun(cdcId)
        const st    = data.status || ''
        console.log(`[CDC-STATUS] ${cdcId} -> ${st}`)

        if (st === 'success') {
          console.log('CDC OUTPUTS:', JSON.stringify(data.outputs, null, 2))
          // Filtrar solo los ZCS1-ZCS8 (skip9-skip14 se excluyen automáticamente)
          const contentImages = filterAndSortZcs(extractImages(data.outputs))
          console.log(`  [CDC] contentImages: ${contentImages.length}`, contentImages.map(u => u.split('/').pop()))
          return json(res, 200, { status: 'success', contentImages })
        }
        if (['failed', 'cancelled', 'timeout'].includes(st)) {
          console.log(`[CDC-ERROR] ${cdcId} -> ${st}`)
          // Try to salvage partial images before declaring failure
          const contentImages = filterAndSortZcs(extractImages(data.outputs))
          console.log(`[CDC-PARTIAL] ${contentImages.length}/8 imágenes recuperadas de run fallido`)
          if (contentImages.length > 0) {
            return json(res, 200, { status: 'partial', contentImages, failedCount: 8 - contentImages.length, message: st })
          }
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

// Exporta funciones puras para tests (test/smoke.test.cjs). El server solo
// escucha cuando se ejecuta directamente (node server.cjs), no al hacer require.
module.exports = {
  server,
  _internal: {
    extractImages,
    filterAndSortZcs,
    inferBodyParamOverridesFromText,
    normalizeAionPayload,
    sanitizeLoneSurrogates,
    buildBodyPromptReinforcement,
    parseComfyCloudErrorMessage,
  },
}

if (require.main === module) {

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

} // end require.main guard
