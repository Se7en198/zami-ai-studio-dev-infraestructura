'use strict'

// Smoke tests de funciones puras de server.cjs — node:test, sin dependencias.
// Contratos tomados de CLAUDE.md (payload AION, filtros ZCS, overrides de cuerpo).

const { test } = require('node:test')
const assert = require('node:assert')

const { _internal } = require('../server.cjs')
const {
  extractImages,
  filterAndSortZcs,
  inferBodyParamOverridesFromText,
  normalizeAionPayload,
  sanitizeLoneSurrogates,
  buildBodyPromptReinforcement,
  parseComfyCloudErrorMessage,
} = _internal

// ── extractImages ────────────────────────────────────────────────────────────
test('extractImages: formato array de outputs ComfyDeploy ({data:{images:[{url}]}})', () => {
  const outputs = [
    { data: { images: [{ url: 'https://s3/x/Nano%20Banana%20Pro_00001_.png' }] } },
    { data: { images: [{ url: 'https://s3/x/ComfyUI_00001_.png' }, 'https://s3/x/extra.png'] } },
    { data: { other: 'ignorar' } },
  ]
  assert.deepStrictEqual(extractImages(outputs), [
    'https://s3/x/Nano%20Banana%20Pro_00001_.png',
    'https://s3/x/ComfyUI_00001_.png',
    'https://s3/x/extra.png',
  ])
})

test('extractImages: outputs null/vacíos devuelven []', () => {
  assert.deepStrictEqual(extractImages(null), [])
  assert.deepStrictEqual(extractImages(undefined), [])
  assert.deepStrictEqual(extractImages([]), [])
})

test('extractImages: formato objeto con .images', () => {
  const outputs = { images: [{ url: 'https://s3/a.png' }, 'https://s3/b.png'] }
  assert.deepStrictEqual(extractImages(outputs), ['https://s3/a.png', 'https://s3/b.png'])
})

// ── filterAndSortZcs ─────────────────────────────────────────────────────────
test('filterAndSortZcs: filtra skips y ordena numéricamente (ZCS2 antes que ZCS10)', () => {
  const urls = [
    'https://s3/out/ZCS10_00001_.png',
    'https://s3/out/skip9_00001_.png',
    'https://s3/out/ZCS2_00001_.png',
    'https://s3/out/ZCS1_00001_.png',
    'https://s3/out/skip14_00001_.png',
  ]
  assert.deepStrictEqual(filterAndSortZcs(urls).map(u => u.split('/').pop()), [
    'ZCS1_00001_.png', 'ZCS2_00001_.png', 'ZCS10_00001_.png',
  ])
})

test('filterAndSortZcs: input vacío/null → []', () => {
  assert.deepStrictEqual(filterAndSortZcs([]), [])
  assert.deepStrictEqual(filterAndSortZcs(null), [])
})

// ── inferBodyParamOverridesFromText ──────────────────────────────────────────
test('overrides: "súper curvy con trasero enorme" fuerza enums extremos', () => {
  const o = inferBodyParamOverridesFromText('súper curvy con trasero enorme')
  assert.strictEqual(o.body_type, 'curvy fuller figure')
  assert.strictEqual(o.glutes, 'massive oversized glutes ultra-exaggerated')
  assert.strictEqual(o.waist, 'very narrow waist extreme hourglass')
})

test('overrides: "tetona" sube el busto y define silueta', () => {
  const o = inferBodyParamOverridesFromText('tetona')
  assert.strictEqual(o.bust, 'large bust')
  assert.strictEqual(o.body_type, 'hourglass figure')
})

test('overrides: texto neutro no fuerza nada', () => {
  assert.deepStrictEqual(inferBodyParamOverridesFromText('mujer parisina sofisticada de ojos azules'), {})
  assert.deepStrictEqual(inferBodyParamOverridesFromText(''), {})
  assert.deepStrictEqual(inferBodyParamOverridesFromText(null), {})
})

// ── normalizeAionPayload ─────────────────────────────────────────────────────
test('normalizeAionPayload: rellena defaults y los 7 body params con "auto"', () => {
  const inputs = normalizeAionPayload({})
  assert.strictEqual(inputs['imagen rostro'], 'Nano Banana Pro')
  assert.strictEqual(inputs['save_image'], 'ComfyUI')
  assert.strictEqual(inputs['photo_type'], '-- Not selected / System inferred --')
  assert.strictEqual(inputs['model'], 'gemini-3.1-pro-preview')
  assert.strictEqual(inputs['image_model'], 'Nano Banana Pro (gemini-3-pro-image-preview)')
  assert.strictEqual(inputs['resolution'], '512px')
  for (const key of ['body_type', 'bust', 'waist', 'glutes', 'hips', 'legs', 'shoulders']) {
    assert.strictEqual(inputs[key], 'auto', `body param ${key} debe ser "auto" explícito`)
  }
})

test('normalizeAionPayload: respeta valores válidos enviados', () => {
  const inputs = normalizeAionPayload({ bust: 'full bust', resolution: '2K' })
  assert.strictEqual(inputs.bust, 'full bust')
  assert.strictEqual(inputs.resolution, '2K')
})

test('normalizeAionPayload: enum inválido lanza error 400', () => {
  assert.throws(() => normalizeAionPayload({ model: 'gpt-9000' }), err => err.statusCode === 400)
  assert.throws(() => normalizeAionPayload({ bust: 'invalid-bust' }), err => err.statusCode === 400)
})

// ── sanitizeLoneSurrogates ───────────────────────────────────────────────────
test('sanitizeLoneSurrogates: elimina surrogates solitarios, conserva emojis', () => {
  assert.strictEqual(sanitizeLoneSurrogates('hola\uD800mundo'), 'holamundo')
  assert.strictEqual(sanitizeLoneSurrogates('\uDC00inicio'), 'inicio')
  assert.strictEqual(sanitizeLoneSurrogates('ok 😀 fin'), 'ok 😀 fin')
  assert.strictEqual(sanitizeLoneSurrogates('limpio'), 'limpio')
})

// ── buildBodyPromptReinforcement ─────────────────────────────────────────────
test('buildBodyPromptReinforcement: vacío sin overrides, refuerzo con overrides', () => {
  assert.strictEqual(buildBodyPromptReinforcement('x', {}), '')
  const out = buildBodyPromptReinforcement('curvy', { bust: 'large bust', body_type: 'curvy fuller figure' })
  assert.match(out, /large bust/)
  assert.match(out, /curvy fuller figure overall silhouette/)
})

// ── parseComfyCloudErrorMessage ──────────────────────────────────────────────
test('parseComfyCloudErrorMessage: extrae exception_message de JSON y tolera strings', () => {
  assert.strictEqual(parseComfyCloudErrorMessage('{"exception_message":"boom"}'), 'boom')
  assert.strictEqual(parseComfyCloudErrorMessage('{"message":"fallo"}'), 'fallo')
  assert.strictEqual(parseComfyCloudErrorMessage('texto plano'), 'texto plano')
  assert.strictEqual(parseComfyCloudErrorMessage(''), '')
})
