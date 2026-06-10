'use strict'

// ── Configuración central: env, constantes, deployment IDs ──────────────────
// Movimiento puro desde server.cjs (FASE 1). No cambia comportamiento.

const fs   = require('fs')
const path = require('path')

const ROOT_DIR = path.join(__dirname, '..')

// ── load .env manually (no external deps) ───────────────────────────────────
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

function loadEnv() {
  const envPath = path.join(ROOT_DIR, '.env')
  if (!fs.existsSync(envPath)) return
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)$/)
    if (m) process.env[m[1]] = cleanEnvValue(m[2])
  })
}
loadEnv()

const WORKFLOW_SEXY_CONTEXTO = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'data', 'workflow-sexy-contexto.json'), 'utf8')) }
  catch (e) { console.warn('[WARN] data/workflow-sexy-contexto.json no encontrado:', e.message); return null }
})()

module.exports = {
  ROOT_DIR,
  cleanEnvValue,
  loadEnv,

  API_KEY:               process.env.VITE_COMFYDEPLOY_API_KEY || '',
  ANTHROPIC_KEY:         process.env.ANTHROPIC_API_KEY || '',
  ANTHROPIC_MODEL:       process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
  DEPLOYMENT_ID_AION:    process.env.VITE_COMFYDEPLOY_AION_DEPLOYMENT_ID || 'e833a575-893b-49f2-8687-4aa5291d31cc',
  DEPLOYMENT_ID_CONTENT: process.env.VITE_COMFYDEPLOY_CONTENT_DEPLOYMENT_ID || 'f9822b81-9ebc-48e2-b39c-0e8034e90554',  // Fase 4 UGC - ComfyDeploy (14 slots)
  COMFYCLOUD_API_KEY:    process.env.COMFYCLOUD_API_KEY || '',
  WORKFLOW_SEXY_CONTEXTO,

  SUPABASE_URL:    process.env.VITE_SUPABASE_URL || '',
  SUPABASE_KEY:    process.env.VITE_SUPABASE_ANON_KEY || '',
  SUPABASE_BUCKET: process.env.SUPABASE_BUCKET || 'zami-images',

  PORT:        process.env.PORT || 3333,
  HOST:        process.env.HOST || '0.0.0.0',
  PKG_VERSION: (() => { try { return require('../package.json').version } catch { return '0.0.0' } })(),
  NODE_ENV:    process.env.NODE_ENV || '',

  CD_BASE:          'api.comfydeploy.com',
  DATA_DIR:         path.join(ROOT_DIR, 'data'),
  INFLUENCERS_FILE: path.join(ROOT_DIR, 'data', 'influencers.json'),
  PUBLIC_DIR:       path.join(ROOT_DIR, 'public'),
  HERO_PHOTO_PATH:  path.join(ROOT_DIR, 'Foto inicio', 'Nano Banana Pro_00001_.png'),

  MAX_JSON_BODY_BYTES: 25 * 1024 * 1024,
  MAX_UPLOAD_BYTES:    8 * 1024 * 1024,
  ALLOWED_IMAGE_TYPES: new Set(['image/jpeg', 'image/png', 'image/webp']),
  IMAGE_EXTENSIONS:    { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' },

  CC_SEXY_POLL_MS:                  3000,
  CC_SEXY_OUTPUT_WAIT_LIMIT:        10,
  CC_SEXY_EMPTY_PROMPT_MAX_RETRIES: 2,
}
