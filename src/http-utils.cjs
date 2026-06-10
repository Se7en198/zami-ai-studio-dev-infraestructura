'use strict'

// ── HTTP/JSON helpers + sanitización ────────────────────────────────────────
// Movimiento puro desde server.cjs (FASE 1). No cambia comportamiento.

const {
  MAX_JSON_BODY_BYTES,
  MAX_UPLOAD_BYTES,
  ALLOWED_IMAGE_TYPES,
} = require('./config.cjs')

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

function looksLikeImage(buffer, type) {
  if (type === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  if (type === 'image/png')  return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (type === 'image/webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  return false
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

module.exports = {
  nowIso,
  sanitizeLoneSurrogates,
  sanitizeForJson,
  safeJsonStringify,
  readBody,
  json,
  fail,
  looksLikeImage,
  decodeBase64Image,
}
