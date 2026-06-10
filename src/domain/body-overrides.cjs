'use strict'

// ── Lógica de body params: overrides, validación, normalización, audit ──────
// Movimiento puro desde server.cjs (FASE 1). No cambia comportamiento.

const { DEPLOYMENT_ID_AION } = require('../config.cjs')
const {
  BODY_PARAM_OPTIONS,
  BODY_MODEL_OPTIONS,
  BODY_IMAGE_MODEL_OPTIONS,
  BODY_RESOLUTION_OPTIONS,
  BODY_PARAM_KEYS,
} = require('./aion-params.cjs')

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

module.exports = {
  normalizeTextForMatching,
  isAllowedBodyParam,
  requireAllowedEnum,
  applyBodyParam,
  inferBodyParamOverridesFromText,
  buildBodyPromptReinforcement,
  normalizeAionPayload,
  auditAionPayload,
  prepareAionPayload,
}
