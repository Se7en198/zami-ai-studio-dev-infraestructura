# GUÍA DE EJECUCIÓN PARA AGENTES — Zami AI Studio

> **Compañera de:** `docs/PLAN_MEJORAS_UI_INFRA_v1.md` (el QUÉ y el PORQUÉ viven allá; aquí vive el CÓMO)
> **Modelos ejecutores previstos:** Claude Sonnet / Opus en Claude Code
> **Uso:** copia el bloque "PROMPT PARA EL AGENTE" de cada fase y pégalo como instrucción inicial de una sesión nueva. Una fase = una sesión = un PR (o commits directos a una rama de fase).

---

## REGLAS GLOBALES (van implícitas en todos los prompts)

Estas reglas están embebidas en cada prompt de fase. Si ejecutas una tarea suelta fuera de las fases, inclúyelas igual.

```
REGLAS OBLIGATORIAS:
1. Lee CLAUDE.md y docs/PLAN_MEJORAS_UI_INFRA_v1.md COMPLETOS antes de tocar código.
2. INVARIANTES INTOCABLES (romper cualquiera rompe el pipeline en producción):
   - Payload AION: keys exactas 'imagen rostro'="Nano Banana Pro", 'save_image'="ComfyUI",
     'photo_type' siempre presente, los 7 body params SIEMPRE en el payload ("auto" explícito
     si no hay selección), 'model'/'image_model'/'resolution' validados contra sus enums.
   - Detección face/body: includes('ComfyUI'). PROHIBIDO regex sobre "Nano Banana Pro".
   - Prefijos de runId: sin prefijo = AION (e833a575), 'cdc:' = contenido (f9822b81),
     'ccsx:' = ComfyUI Cloud sexy.
   - Filtros de outputs: ZCS\d+ por filename (contenido), ZSEXY\d+ por display_name (sexy).
   - Inputs de Fase 4: 14 slots 'rostro N'/'cuerpo N'/'prompt contenido N'/'contenido final N',
     slots 9-14 con prompts reciclados (GeminiImage2Node exige prompt no vacío).
   - Polling: 8s ComfyDeploy / 3s ComfyUI Cloud. Timeouts: 10 min AION, 20 min contenido/sexy.
3. NO ejecutes rutas de generación reales (gastan créditos de ComfyDeploy/Anthropic/ComfyCloud)
   salvo instrucción explícita del usuario. Smoke seguro: GET /, /hero-photo.png, /api/health,
   /api/influencers, /api/config.
4. Tras CADA cambio: node --check sobre los .cjs tocados + npm test + levantar server y
   verificar las rutas de smoke seguro.
5. Commits pequeños, un tema por commit, mensajes en español descriptivos.
6. UI en español; prompts hacia modelos de imagen en inglés (como hoy).
7. Al cerrar la fase: actualizar CLAUDE.md (sección de arquitectura/rutas/decisiones) y marcar
   la fase como completada en docs/GUIA_EJECUCION_AGENTES.md (tabla de estado de abajo).
8. Si encuentras una ambigüedad que cambia el diseño, PREGUNTA al usuario antes de decidir.
   Si es un detalle menor, decide con el criterio del plan y documenta la decisión en el commit.
```

## ESTADO DE EJECUCIÓN (el agente actualiza esta tabla al cerrar su fase)

| Fase | Estado | Rama/PR | Fecha | Notas |
|---|---|---|---|---|
| F0 — Red de seguridad | ⬜ Pendiente | — | — | — |
| F1 — Modularización | ⬜ Pendiente | — | — | depende de F0 |
| F2 — Jobs + estado real ★ | ⬜ Pendiente | — | — | depende de F1 |
| F3 — UI profesional | ⬜ Pendiente | — | — | depende de F2 |
| F4 — Equipo + Railway | ⬜ Pendiente | — | — | depende de F2 (paralelizable con F3) |
| F5 — Robustez backend | ⬜ Pendiente | — | — | depende de F2 |

---

# FASE 0 — Red de seguridad

**Entrada:** repo en estado actual, working tree limpio. **Salida:** tests + health + CI, comportamiento idéntico.

### PROMPT PARA EL AGENTE — F0

```
Ejecuta la FASE 0 del plan en docs/PLAN_MEJORAS_UI_INFRA_v1.md (sección "FASE 0 — Red de
seguridad"). Aplica las REGLAS OBLIGATORIAS de docs/GUIA_EJECUCION_AGENTES.md.

Tareas exactas, en orden, un commit por tarea:
1. Crea el tag git v1.1-pre-refactor sobre HEAD actual (no lo pushees hasta el final de la fase).
2. Agrega GET /api/health a server.cjs: { ok, version (de package.json), uptimeSec,
   influencers: <count>, env: { comfydeploy, anthropic, supabase, comfycloud } } donde cada
   env.* es boolean de "la key está configurada". JAMÁS incluyas valores de keys.
3. Crea test/smoke.test.cjs usando node:test y assert nativo (cero dependencias npm). Para
   testear funciones privadas de server.cjs, agrega al final de server.cjs:
   module.exports._internal = { extractImages, inferBodyParamOverridesFromText,
   normalizeAionPayload, sanitizeLoneSurrogates, buildBodyPromptReinforcement,
   parseComfyCloudErrorMessage }
   PROBLEMA: server.cjs llama server.listen() al cargarse. Soluciónalo con guard:
   if (require.main === module) { server.listen(...) } — y exporta el server también.
   Tests mínimos (usa los contratos documentados en CLAUDE.md como fuente de verdad):
   a) extractImages: array de outputs formato ComfyDeploy ({data:{images:[{url}]}}) → URLs;
      outputs vacíos/null → []; objeto con .images → URLs.
   b) inferBodyParamOverridesFromText: "súper curvy con trasero enorme" → body_type
      'curvy fuller figure', glutes 'massive oversized glutes ultra-exaggerated';
      "tetona" → bust alto; texto neutro ("elegante parisina") → {}.
   c) normalizeAionPayload: payload mínimo → los 7 body params presentes con 'auto',
      model/image_model/resolution con defaults; enum inválido → throw con statusCode 400.
   d) sanitizeLoneSurrogates: surrogate solitario eliminado, pares válidos (emoji) intactos.
   e) Filtro/orden ZCS: urls con ZCS10/ZCS2/skip9 → orden numérico ZCS2, ZCS10, sin skip.
4. Agrega "test": "node --test test/" a package.json scripts.
5. Crea .github/workflows/ci.yml: en push/PR ejecutar node --check server.cjs && npm test
   sobre node 18.
Cierre: npm test verde, node server.cjs arranca y sirve / y /api/health idénticos en
comportamiento al estado previo (salvo la ruta nueva). Pushea rama + tag. Actualiza la tabla
de estado en docs/GUIA_EJECUCION_AGENTES.md y CLAUDE.md (ruta /api/health).
```

### Checklist de verificación del usuario tras F0
- [ ] `npm test` pasa en local
- [ ] `http://127.0.0.1:3333/api/health` responde JSON con `ok: true`
- [ ] La app se ve y funciona exactamente igual

---

# FASE 1 — Modularización sin cambio de comportamiento

**Entrada:** F0 completada. **Salida:** estructura `src/` + `public/`, app idéntica.

### PROMPT PARA EL AGENTE — F1

```
Ejecuta la FASE 1 del plan en docs/PLAN_MEJORAS_UI_INFRA_v1.md (sección "FASE 1") con la
estructura objetivo de la sección "ARQUITECTURA OBJETIVO". Aplica las REGLAS OBLIGATORIAS de
docs/GUIA_EJECUCION_AGENTES.md.

PRINCIPIO RECTOR: movimientos puros de código. PROHIBIDO mejorar, renombrar lógica, cambiar
strings de prompts o "aprovechar para arreglar" nada — eso viene en fases posteriores. La única
excepción permitida es la tarea 6 (borrar legacy) y el aplanado CSS de la tarea 3.

Orden de extracción backend (un commit por módulo, npm test tras cada uno):
1. src/config.cjs — todas las constantes/env del tope de server.cjs (loadEnv, cleanEnvValue,
   keys, deployment IDs, límites, PORT/HOST).
2. src/http-utils.cjs — readBody, json, fail, decodeBase64Image, looksLikeImage,
   sanitizeLoneSurrogates, sanitizeForJson, safeJsonStringify, nowIso.
3. src/domain/aion-params.cjs — BODY_PARAM_OPTIONS, BODY_MODEL_OPTIONS,
   BODY_IMAGE_MODEL_OPTIONS, BODY_RESOLUTION_OPTIONS, BODY_PARAM_KEYS, AION_IMAGE_KEYS,
   + NUEVO: AION_PARAMS y BODY_PARAMS con labels/grupos (cópialos desde server-ui.html líneas
   ~1104-1162 — esta es la única "fuente única" nueva), + IMAGE_SLOTS y PHOTO_TYPES.
4. src/domain/body-overrides.cjs — normalizeTextForMatching, isAllowedBodyParam,
   requireAllowedEnum, applyBodyParam, inferBodyParamOverridesFromText,
   buildBodyPromptReinforcement, normalizeAionPayload, auditAionPayload, prepareAionPayload.
5. src/services/{anthropic,comfydeploy,comfycloud,supabase-storage,prompts}.cjs y
   src/store/influencers-file.cjs según el plan. anthropic.cjs conserva las 4 funciones tal
   cual (se unifican en F5).
6. src/routes/{generate,persona,content,influencers,status}.cjs — cada handler movido tal
   cual; server.cjs queda como boot + dispatch (≤150 líneas). BORRA el legacy listado en
   F1.6 del plan (startBodyRun, startBodyRunV2, generateBodyPrompt, /api/generate-body,
   /api/generate-body-prompt, DEPLOYMENT_ID_BODY).
7. Handler GET /public/* : whitelist de extensiones {css,js,png,svg,woff2,jpg,webp},
   path.normalize + verificación de que el path resuelto empieza con el dir public/ (anti
   path traversal), Content-Type correcto, Cache-Control: no-cache si NODE_ENV!=='production'.
8. Partir server-ui.html → public/index.html + public/css/{tokens,base,components}.css +
   public/js/ con type="module": api.js (apiFetch, sleep, escHtml, escAttr), state.js
   (variables globales actuales convertidas a un objeto store exportado), views/crear.js,
   views/contenido.js, views/sexy.js, components/{steps,toasts,influencers-panel}.js.
   Al mover CSS, APLANA los selectores duplicados (la capa "2026 DESIGN UPGRADES" redefine
   #workspace, .toggle-body, .status-bar, @keyframes pulse, etc. — deja UNA definición final
   por selector con el valor que hoy gana en cascada; verifica visualmente).
   GET / sirve public/index.html. server-ui.html se elimina al final, en commit propio.
9. GET /api/config → { aionParams, bodyParams, imageSlots, photoTypes, pollIntervalMs: 8000 }
   desde domain/aion-params.cjs. La UI construye sus grids desde este endpoint (elimina los
   arrays hardcodeados de la UI).
10. Actualiza los tests de F0 para importar desde los módulos nuevos (elimina _internal).

Cierre: npm test verde; abrir la app y recorrer visualmente TODAS las secciones (hero, crear
manual con 4 toggles abiertos, tab Claude, panel Fase 4, panel sexy) comparando contra una
captura previa; actualizar CLAUDE.md v14 (estructura de archivos nueva, /api/config,
/public/*, legacy eliminado) y la tabla de estado de esta guía.
```

### Checklist del usuario tras F1
- [ ] La app se ve idéntica (recorrer las 5 secciones)
- [ ] `git log` muestra ~10 commits pequeños, no uno gigante
- [ ] `server.cjs` quedó corto; existe `src/` y `public/`

---

# FASE 2 — Registro de jobs + estado en tiempo real ★

**Entrada:** F1 completada. **Salida:** servidor = fuente de verdad de toda generación; UI reanudable; AI Persona con feedback vivo y retry.

### PROMPT PARA EL AGENTE — F2

```
Ejecuta la FASE 2 del plan en docs/PLAN_MEJORAS_UI_INFRA_v1.md (secciones 2.A a 2.D, con el
shape de Job documentado allí). Aplica las REGLAS OBLIGATORIAS de la guía. Esta es la fase de
mayor calado: trabaja en este orden estricto para que la app siga funcionando entre commits.

ETAPA 1 — src/jobs.cjs (sin tocar rutas existentes):
- createJob(kind, ctx), getJob(id), listJobs({active}), updateStep(jobId, stepId, patch),
  pushLog(jobId, msg), finishJob(jobId, result|error).
- Persistencia: data/jobs.json con escritura atómica (copia el patrón de
  store/influencers-file.cjs: tmp + rename + cola de escrituras). Retención: máx 50 jobs,
  poda los terminados más viejos.
- Re-adopción al boot: jobs con status 'running' y un runId externo guardado relanzan su
  monitor de polling (generaliza el patrón watch-existing de comfycloud.cjs).
- Monitores server-side: pollComfyDeployRun(runId, onUpdate) cada 8s que reporta el status
  CRUDO de ComfyDeploy (queued/started/running/uploading/success/failed/cancelled/timeout)
  vía onUpdate — NO lo colapses a 'running'.

ETAPA 2 — Orquestación server-side (rutas nuevas; las viejas siguen vivas):
- POST /api/jobs/create-influencer: body = unión de los bodies actuales de /api/generate-face
  y /api/claude-guided-face + { mode: 'manual'|'claude', nombre, nicho }. Pipeline completo
  en servidor con steps: params → image → persona.
  · Step params: para mode claude llama generateAionParams (guarda selected_params y
    prompt_body en job.result); para manual prepara inputs como hoy.
  · Step image: startAionRun + monitor; en cada poll actualiza meta.cloudStatus y
    meta.elapsedMs; al success calcula face_url/body_url con la regla includes('ComfyUI').
  · Step persona: generatePersona con 1 reintento automático si el JSON es inválido; si
    ambos fallan, el step queda 'error' con retryable:true PERO el job queda 'partial' (las
    imágenes ya están en result — no se pierden).
- POST /api/jobs/content-2weeks: body = el de /api/generate-content-2weeks + influencerId.
  Steps por semana: plan-1 → send-1 → gen-1 → plan-2 → send-2 → gen-2. Traslada aquí la
  lógica de pollWithRetry de la UI (1 reintento de run completo ante resultado parcial,
  segundo parcial → step 'partial' con las imágenes obtenidas en result).
- POST /api/jobs/:id/retry-step: reintenta SOLO ese step usando lo ya acumulado en
  job.result (persona usa face_url/body_url; gen-N reenvía el run con los prompts del plan
  ya generado). Valida que el step sea retryable.
- GET /api/jobs?active=1, GET /api/jobs/:id.
- GET /api/jobs/:id/events: SSE nativo (Content-Type: text/event-stream, write de
  `data: ${JSON.stringify(job)}\n\n` en cada cambio + heartbeat de comentario cada 25s,
  cleanup en 'close'). El job emite a sus suscriptores en cada update.
- /api/status/:runId NO se elimina (compat) pero ahora incluye cloudStatus crudo y elapsedMs.

ETAPA 3 — Frontend:
- public/js/components/status-tracker.js: componente único render(job) → para cada step:
  dot (pending/active/done/error/partial) + label + detail + timer vivo (Xm Ys desde
  startedAt) + sub-estado real (mapea cloudStatus: queued→'En cola', started/running→
  'Generando', uploading→'Subiendo resultados') + estimación estática por step
  (~2-5 min imagen, ~30s persona, ~45s plan). Step error → botón "Reintentar este paso"
  (POST retry-step) + "Ver detalle técnico" colapsable con job.logs. Contenedor con
  aria-live="polite". Elimina el paso decorativo "Resultado listo" (quedan 3 steps reales).
- Conexión: EventSource a /api/jobs/:id/events con fallback a polling GET /api/jobs/:id
  cada 3s si EventSource falla o se cierra con error 2 veces.
- Migra generateAll(), generateWithClaude() y generateContent2Weeks() a crear el job y
  observarlo (borra la orquestación client-side: pollForBoth, pollWithRetry,
  pollWeekContentRun quedan obsoletos — elimínalos). El flujo sexy se migra igual a un job
  kind 'sexy' reutilizando el monitor ccsx existente del servidor, eliminando los estados
  falsos por pollCount: los steps upload/analyze/generate se derivan de job.logs/cloudStatus.
- Reanudación: en DOMContentLoaded, GET /api/jobs?active=1 → si hay jobs: banner
  "⚡ Generación en curso: {nombre} · {step actual} · {elapsed} [Ver]" que reconecta el
  status-tracker y restaura la vista correspondiente (incl. re-render de planes/imágenes
  parciales desde job.result).

PRUEBAS (sin gastar APIs): tests de jobs.cjs con monitores mockeados (inyecta un fake
pollFn); test de SSE con http request al server en puerto efímero; test de retry-step.
Validación E2E real (UNA generación de influencer + UNA tanda de contenido) SOLO cuando el
usuario dé luz verde — pídesela al cerrar la fase, con el caso de prueba: matar el browser a
mitad del run, reabrir y verificar reanudación.

Cierre: actualizar CLAUDE.md (rutas /api/jobs*, shape del Job, decisión de orquestación
server-side) y la tabla de estado de la guía.
```

### Checklist del usuario tras F2
- [ ] Generar una influencer, **cerrar el browser a mitad**, reabrir → el job sigue y termina
- [ ] Paso AI Persona muestra timer vivo y, si falla, botón "Reintentar" que NO regenera imágenes
- [ ] Dos tabs/PCs ven el mismo job en vivo

---

# FASE 3 — UI profesional

**Entrada:** F2 completada. **Salida:** navegación por vistas, lightbox, CRUD de influencers en UI, autosave, cero `alert()`, contraste corregido.

### PROMPT PARA EL AGENTE — F3

```
Ejecuta la FASE 3 del plan en docs/PLAN_MEJORAS_UI_INFRA_v1.md (secciones 3.A a 3.E completas,
con los IDs de hallazgos U1-U16 como referencia). Aplica las REGLAS OBLIGATORIAS de la guía.
Identidad visual: se MANTIENE (Acid Lime #C8FF00, Bebas Neue, dark #0A0A0A) — refinar, no
rediseñar.

Orden recomendado (un commit por bloque):
1. 3.A Sistema: fix del bug de contraste (regla button → color:#000 con fondo lime; audita
   TODOS los botones, especialmente #btn-generate-plan); grises mínimos #9a9a9a; consolida
   feedback (inline en formularios + toast para operaciones; elimina TODOS los alert());
   :focus-visible global.
2. 3.B Navegación: 3 vistas (Crear / Influencers / Contenido) con hash routing
   (#/crear, #/influencers, #/influencer/<id>, #/contenido). NUEVO backend en
   src/routes/influencers.cjs: GET /api/influencers/:id, PUT /api/influencers/:id
   (nombre, nicho, persona), DELETE /api/influencers/:id (con sus weeks). Vista detalle de
   influencer: fotos grandes, persona card editable reutilizando renderPersona, historial de
   semanas (theme + fecha), acciones Generar contenido / Guardar cambios / Eliminar (modal
   de confirmación). Sidebar: cards referencian por id (elimina data-inf con JSON completo);
   badge "generando" si esa influencer tiene job activo. Hero: solo si
   !localStorage.zami_seen_hero, Esc lo salta, y oculto si /api/config trae showHero:false
   (env SHOW_HERO).
3. 3.C Imágenes: lightbox modal único (zoom, ←/→ dentro del grupo, Descargar, ✦ Más Sexy,
   Esc/click-fuera, focus trap) usado en TODOS los grids (resultado rostro/cuerpo, 8 de
   semana ×2, 10 sexy); "Descargar semana (8)" con descargas secuenciales; skeletons con el
   aspect-ratio real del slot (9:16 altos, 1:1 cuadrados, 3:4/4:5).
4. 3.D Flujo: draft persistente en localStorage (nombre/nicho/descripción/toggles/params,
   debounced 500ms, restaurar al cargar, limpiar al completar); autosave de influencer al
   terminar el pipeline (POST /api/influencers con draft:true — requiere agregar el campo
   draft al store y al render del sidebar con badge "borrador") + barra "Guardada
   automáticamente ✓ [Descartar borrador]"; bloqueo de acciones conflictivas durante job
   activo (deshabilitar con tooltip); validación en vivo de nombre/nicho; banner
   "Reconectando..." si SSE/poll falla 2 veces seguidas.
5. 3.E Detalles: copyPersona(event) con parámetro; botón Cancelar job (POST
   /api/jobs/:id/cancel — marca cancelled y detiene el monitor, best-effort); tooltips en
   español para los 43 params (agrega campo "hint" a domain/aion-params.cjs y úsalo como
   title en los selects).

Cierre: auditoría manual de contraste (ningún texto blanco sobre lime); grep -c "alert(" en
public/js debe dar 0; recorrer los 3 flujos completos con /api/jobs mockeado si hace falta;
actualizar CLAUDE.md (vistas, rutas CRUD nuevas, SHOW_HERO) y la tabla de estado.
```

### Checklist del usuario tras F3
- [ ] Navegación entre 3 vistas con URLs (#/...) y botón atrás del browser funcional
- [ ] Abrir una influencer guardada muestra su persona completa; editar y borrar funcionan
- [ ] Lightbox con flechas en las imágenes de semana; ningún botón lima con texto blanco

---

# FASE 4 — Equipo + Railway (seguridad + persistencia)

**Entrada:** F2 completada (F3 puede ir en paralelo). **Salida:** app desplegable para el equipo sin riesgo de gasto ajeno ni pérdida de datos.

### PROMPT PARA EL AGENTE — F4

```
Ejecuta la FASE 4 del plan en docs/PLAN_MEJORAS_UI_INFRA_v1.md (pasos 4.1 a 4.7, incluido el
DDL SQL). Aplica las REGLAS OBLIGATORIAS de la guía. Principio: en local SIN las env vars
nuevas, todo debe funcionar idéntico a hoy (middlewares no-op).

1. src/auth.cjs: si TEAM_ACCESS_TOKEN está definido, toda ruta /api/* y /public/* (excepto
   /api/health y /login) exige cookie de sesión válida o Bearer token. Cookie: valor
   `exp.firma` con HMAC-SHA256 (crypto nativo, secreto = TEAM_ACCESS_TOKEN), HttpOnly,
   SameSite=Lax, Secure si X-Forwarded-Proto=https, 30 días. POST /api/login { token } →
   compara con timingSafeEqual → set cookie. UI: vista de login minimal (logo + un input +
   botón, estilo de la app) mostrada ante 401; api.js redirige a login en cualquier 401.
2. CORS: isAllowedOrigin usa env ALLOWED_ORIGINS (CSV); sin la var, permite solo same-origin
   y 127.0.0.1. Mantén el manejo de OPTIONS actual.
3. Rate limit en src/auth.cjs: Map ip→[timestamps], límite por env RATE_LIMIT_GEN_PER_MIN
   (default 10) SOLO en rutas de generación (/api/jobs/*, /api/generate-*,
   /api/claude-guided-face, /api/upload-image). 429 con mensaje claro. Poda periódica del Map.
4. src/store/influencers-supabase.cjs: misma interfaz que influencers-file.cjs (list, get,
   create, update, remove, addWeek), implementada con fetch a {SUPABASE_URL}/rest/v1/
   (headers apikey + Authorization Bearer SUPABASE_SERVICE_KEY, Prefer:
   return=representation). Driver elegido por env STORE=file|supabase (default file).
   Las weeks van en tabla aparte y se ensamblan en el shape actual { influencers:[{...,
   weeks:[]}] } para no tocar la UI. Entrega también scripts/setup-supabase.sql (el DDL del
   plan) y scripts/migrate-influencers-to-supabase.cjs (lee data/influencers.json y hace
   upsert; idempotente; se ejecuta manualmente con node).
5. Logging: util src/log.cjs con niveles por env LOG_LEVEL (info default). En info: una línea
   por request/evento; los volcados grandes (OUTPUTS:, CDC OUTPUTS:, AION PAYLOAD AUDIT,
   payloads completos) pasan a debug.
6. docs/DEPLOY_RAILWAY.md: variables requeridas y opcionales (tabla), healthcheck
   /api/health, STORE=supabase + service key, rotación del token de equipo, nota de que
   data/ es efímero en Railway (jobs.json se pierde en redeploy: aceptado por diseño).

PRUEBAS: tests de auth (sin token env → no-op; con token → 401/200/cookie válida e
inválida/expirada), rate limit, y store supabase contra un mock http local. NO toques la
base Supabase real sin confirmación del usuario.

Cierre: actualizar CLAUDE.md (env vars nuevas, login, STORE) y la tabla de estado.
```

### Checklist del usuario tras F4
- [ ] En local sin env nuevas: cero cambios
- [ ] Con `TEAM_ACCESS_TOKEN`: la app pide clave y sin ella todo da 401
- [ ] Ejecutar `scripts/setup-supabase.sql` en Supabase, `STORE=supabase`, migrar, y verificar que las influencers sobreviven a un reinicio

---

# FASE 5 — Robustez backend

**Entrada:** F2 completada. **Salida:** cliente Claude único con retry, timeouts de red, CLAUDE.md v14 final.

### PROMPT PARA EL AGENTE — F5

```
Ejecuta la FASE 5 del plan en docs/PLAN_MEJORAS_UI_INFRA_v1.md. Aplica las REGLAS
OBLIGATORIAS de la guía.

1. src/services/anthropic.cjs → un único callClaude({ system, content, maxTokens,
   expectJson }) con fetch nativo + AbortController (timeout 120s), retry con backoff
   2s/4s/8s ante HTTP 429/529, error tipo overloaded_error y errores de red; strip de fences
   ```/```json; si expectJson y el parse falla → UN reintento de generación completo antes
   de lanzar error legible. safeJsonStringify siempre. Migra generatePersona,
   generateContentPlan y generateAionParams a este helper conservando sus prompts EXACTOS
   (diff de strings de prompt debe ser cero).
2. src/services/comfydeploy.cjs: timeout 30s por request; retry 3x con backoff solo en GET
   (polls); en POST queue máximo 1 retry y SOLO ante error de red sin respuesta (nunca ante
   respuesta 4xx/5xx, para no duplicar runs).
3. Tests nuevos: callClaude contra http.createServer mock (caso 200, caso 429→200, caso JSON
   inválido→retry→200, timeout); retry de POST queue no duplicado ante 500.
4. Reescritura final de CLAUDE.md a v14: arquitectura nueva completa, todas las rutas, shape
   de Job, env vars, troubleshooting actualizado, corrección del max_tokens documentado
   (claude-guided-face = 2000), eliminación de secciones legacy. CLAUDE.md debe permitir a
   un agente nuevo entender el sistema sin leer este plan.

Cierre: npm test verde con la suite completa; actualizar la tabla de estado de la guía.
```

### Checklist del usuario tras F5
- [ ] `npm test` verde (suite completa)
- [ ] CLAUDE.md v14 describe la app real

---

## DESPUÉS DE LAS 5 FASES — primera mejora recomendada (F6)

**Galería persistente**: las imágenes generadas viven en URLs S3 de ComfyDeploy que expiran — es la pérdida silenciosa más grande del producto. Cuando se apruebe: al completar cada semana/job, el servidor descarga las imágenes y las re-sube al bucket `zami-images` propio (`uploadToSupabase` ya existe), guardando las URLs permanentes en la week/influencer. Pedir prompt detallado cuando llegue el momento.

---

## PROTOCOLO ANTE PROBLEMAS

- **Un test rompe tras un cambio:** no lo "arregles" cambiando el test salvo que el contrato haya cambiado a propósito en esta fase; revisa el código primero.
- **Algo del plan contradice el código real:** el código real manda; documenta la discrepancia en el commit y, si altera el diseño, pregunta al usuario.
- **Necesitas probar generación real:** detente y pide luz verde al usuario (gasta créditos).
- **La fase se vuelve más grande de lo previsto:** corta en sub-PRs funcionales antes que entregar un mega-diff.
- **Rollback:** `v1.1-pre-refactor` (creado en F0) y `v1.0-stable` son los checkpoints seguros.
