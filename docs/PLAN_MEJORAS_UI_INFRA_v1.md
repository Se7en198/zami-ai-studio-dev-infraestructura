# PLAN MAESTRO — Mejoras UI/UX + Infraestructura — Zami AI Studio

> **Versión:** 1.0 — 2026-06-10
> **Autor del análisis:** Fable 5 (ingeniería) — ejecución prevista con Sonnet/Opus
> **Estado:** PROPUESTA — pendiente de aprobación del usuario
> **Alcance decidido por el usuario:**
> 1. La app se desplegará en web para **uso interno del equipo** (multi-usuario ligero)
> 2. Destino: **local + Railway pronto** → seguridad y persistencia cloud entran al plan
> 3. Identidad visual: **se mantiene** (Acid Lime `#C8FF00` + Bebas Neue + dark) — se refina, no se rediseña

---

## CÓMO USAR ESTE DOCUMENTO (instrucciones para el agente ejecutor)

Este plan se ejecuta **por fases, en orden**. Cada fase es un PR/commit independiente que deja la app funcionando. Reglas obligatorias para cualquier agente (Sonnet/Opus) que implemente:

1. **Lee `CLAUDE.md` completo antes de tocar nada.** Contiene los contratos exactos de los payloads ComfyDeploy/Anthropic. Romperlos rompe el pipeline.
2. **Invariantes que NUNCA se tocan sin orden explícita:**
   - Payload AION: keys `imagen rostro`="Nano Banana Pro", `save_image`="ComfyUI", `photo_type`, los 7 body params siempre presentes (con `"auto"` explícito), `model`/`image_model`/`resolution`.
   - Detección face/body por `includes('ComfyUI')` (nunca regex sobre "Nano Banana Pro" porque se URL-encoda).
   - Prefijos de runId: sin prefijo = AION, `cdc:` = contenido, `ccsx:` = sexy cloud.
   - Filtros de outputs: `ZCS\d+` (contenido), `ZSEXY\d+` por `display_name` (sexy).
   - IDs de deployment y el formato de inputs de los 14 slots de Fase 4 (`rostro N`, `cuerpo N`, `prompt contenido N`, `contenido final N`).
3. **Después de cada fase:** correr `node --check server.cjs` (o el entrypoint nuevo), correr los smoke tests de Fase 0, levantar el servidor y verificar manualmente que `/` carga, `/hero-photo.png` responde y `/api/influencers` responde. Estas tres rutas no gastan APIs.
4. **No gastar créditos de APIs en pruebas** salvo que el usuario lo pida: las rutas de generación llaman ComfyDeploy/Anthropic/ComfyCloud reales.
5. **Commits pequeños y descriptivos**, un tema por commit. Antes de empezar cada fase, verificar que `main` (o la rama de trabajo) está limpia.
6. **El idioma de la UI es español.** Los prompts hacia los modelos de imagen van en inglés (ya es así).
7. Cada fase termina actualizando `CLAUDE.md` con lo que cambió (rutas nuevas, archivos nuevos, decisiones).

---

## RESUMEN DEL DIAGNÓSTICO

### Lo que está bien (no tocar el enfoque)
- Pipeline end-to-end operativo y probado (tag `v1.0-stable`).
- Servidor sin dependencias npm: arranque trivial, deploy trivial, sin supply chain.
- Escritura atómica de `influencers.json` con cola de escritura (`updateInfluencers`) — correcto.
- Validación de uploads (magic bytes, tamaño, tipos) — correcta.
- El monitor server-side de runs `ccsx:` (Map + setInterval + logs) es el patrón correcto; el problema es que **solo** existe para el flujo sexy.
- Auto-retry de semanas parciales (`pollWithRetry`) y recuperación parcial de imágenes en runs fallidos — buen diseño.

### Los 5 problemas raíz (todo lo demás deriva de aquí)

| # | Problema | Evidencia | Consecuencia |
|---|----------|-----------|--------------|
| P1 | **Todo el estado de ejecución vive en variables JS del browser** (`generatedFaceUrl`, `lastContentRunId1`, etc.) | `server-ui.html:1177-1198` | Un F5, un cierre de tab o un crash del browser pierde runs de 5-20 min que SÍ siguen corriendo en ComfyDeploy. Imposible para uso en equipo: nadie más ve lo que está generándose. |
| P2 | **El usuario no sabe qué está pasando en pasos largos** — el caso señalado: AI Persona muestra un texto estático "Claude generando perfil completo... (~30 seg)" sin timer, sin spinner, sin reintento | `server-ui.html:1810`, `setStep()` | Ansiedad, doble clic, recargas que destruyen el run. El servidor además **colapsa** los estados reales de ComfyDeploy (`queued/started/uploading`) a un único `'running'` (`server.cjs:1860,1883`), tirando información que ya tiene. |
| P3 | **Cero seguridad para web**: `isAllowedOrigin()` devuelve `true` siempre (`server.cjs:1297-1299`), no hay auth, no hay rate limit | `server.cjs` | En Railway, cualquiera con la URL gasta los créditos de ComfyDeploy/Anthropic y lee/escribe las influencers. |
| P4 | **Persistencia en archivo local** `data/influencers.json` | `server.cjs:104-132` | En Railway el filesystem es efímero: cada redeploy borra todas las influencers y su historial. |
| P5 | **Monolitos de 2,710 y 1,924 líneas** sin tests | `server-ui.html`, `server.cjs` | Cada cambio es de alto riesgo; los agentes ejecutores trabajarán a ciegas. |

### Inventario completo de hallazgos

**UI/UX (server-ui.html):**
- U1. Paso 4 (AI Persona) sin feedback vivo ni botón de reintento — si `generate-persona` falla (p. ej. Claude devuelve JSON inválido), el usuario tiene que **regenerar rostro y cuerpo** (gastando créditos) para reintentar un paso que solo necesita las URLs ya generadas.
- U2. Paso 3 "Resultado listo" es decorativo: siempre se marca `done` junto con el paso 2 (`server-ui.html:1804-1807`). Confunde más de lo que informa.
- U3. Estados intermedios falsos en el flujo sexy: `pollCount === 3` asume que "Analizando" terminó (`server-ui.html:2605-2614`). El servidor SÍ tiene el estado real (`cloudStatus`, `logs`, `queueRemaining` en `publicCcSexyStatus`) y la UI lo ignora.
- U4. Errores inconsistentes: `alert()` para validación (`generateAll`, `generateWithClaude`, `generateSexyFromContent`), status-bar para Fase 4, step-detail para pipeline, toasts para semanas. Cuatro sistemas distintos.
- U5. **Bug de contraste real**: la regla genérica `button { background:#C8FF00; color:#fff }` (`server-ui.html:126-131`) hace que `#btn-generate-plan` y todo botón sin override muestre **texto blanco sobre lima** — viola la propia regla WCAG documentada en CLAUDE.md.
- U6. No hay lightbox: cada imagen abre `window.open` en tab nuevo. Para un estudio de contenido visual esto es muy pobre (no hay zoom, comparación, navegación entre las 8/10 imágenes, ni selección).
- U7. Influencer guardada no muestra su persona: `selectInfluencer()` solo setea variables y oculta `create-section`. No existe vista de detalle, ni edición, ni eliminación (tampoco existe `DELETE /api/influencers/:id` en el servidor).
- U8. El JSON completo de la influencer (persona incluida) se incrusta en `data-inf` de cada botón del sidebar (`server-ui.html:1684`) — frágil y pesado; debería referenciarse por id contra un store.
- U9. Página única sin navegación: "Crear influencer" + Fase 4 + panel sexy apilados verticalmente; Fase 4 visible incluso cuando no aplica. Falta estructura de vistas (Crear / Influencer activa / Contenido).
- U10. Hero landing a pantalla completa en **cada carga** — correcto para demo, fricción diaria para un equipo. Debe mostrarse solo si no hay sesión/primer uso, o desactivarse con flag.
- U11. Sin protección contra acciones concurrentes: durante un run se puede seleccionar otra influencer o cambiar de tab y los `generatedFaceUrl/BodyUrl` se pisan (race conditions de UI).
- U12. "Guardar Influencer" es manual y fácil de olvidar tras una generación costosa. Sin autosave ni warning al salir (`beforeunload`).
- U13. Formularios: validación solo al submit, inputs se pierden con F5, sin draft persistence (localStorage).
- U14. Accesibilidad: textos `#444/#555` sobre `#0d0d0d` por debajo de 4.5:1; sin `aria-live` en zonas de estado (los lectores no anuncian cambios); foco no gestionado al cambiar de vista.
- U15. `copyPersona()` usa el global deprecado `event` (`server-ui.html:2002`) — funciona en Chrome, frágil.
- U16. Polling sin indicador de conexión: si la red cae, los `catch` silencian todo y el usuario ve "Generando..." infinito.

**Backend/Infra (server.cjs):**
- B1. CORS/auth/rate-limit inexistentes (P3).
- B2. Persistencia local (P4). No hay endpoints `PUT/DELETE` de influencers ni de semanas.
- B3. Sin registro de jobs server-side para AION y contenido (`cdc:`); solo `ccsx:` tiene monitor. El run "vive" en el browser (P1).
- B4. `/api/status` descarta granularidad: `queued/started/uploading` → `'running'` sin más datos (P2).
- B5. **Cinco copias casi idénticas** del cliente Anthropic vía `https.request` (`generatePersona`, `generateBodyPrompt`, `generateContentPlan`, `generateAionParams` + parse repetido). Sin retry/backoff ante 429/529/overloaded, sin timeout.
- B6. Si Claude devuelve JSON inválido en persona, se rechaza sin reintento server-side (`server.cjs:691-696`) — debería reintentar 1 vez automáticamente antes de fallar (es barato comparado con regenerar imágenes).
- B7. Código legacy muerto: `startBodyRun` (deployment `cabf22a3`), `startBodyRunV2`, `generateBodyPrompt`, rutas `/api/generate-body` y `/api/generate-body-prompt`, `DEPLOYMENT_ID_BODY`. La UI no las llama; CLAUDE.md las marca legacy. Eliminar.
- B8. `/api/generate-content-2weeks` existe en el servidor pero la UI orquesta las 2 semanas client-side (duplicación). Con el registro de jobs (Fase 2) la orquestación debe vivir **en el servidor** y la UI solo observar.
- B9. `cdRequest`/`fetch` sin timeout ni retry ante fallos de red transitorios.
- B10. Sin endpoint de health (`/api/health`) para Railway healthchecks.
- B11. `cachedHtml` se lee una sola vez al boot: bien para prod, molesto para dev (cada cambio de UI requiere reinicio). Falta modo dev (releer del disco si `NODE_ENV !== 'production'`).
- B12. Cero tests, cero CI. Hay funciones puras perfectamente testeables (`extractImages`, `inferBodyParamOverridesFromText`, `normalizeAionPayload`, `sanitizeLoneSurrogates`, `parseComfyCloudErrorMessage`, filtros ZCS/ZSEXY).
- B13. Logs no estructurados y muy verbosos (`CDC OUTPUTS:` vuelca el JSON completo). Suficiente para local, ruido para Railway. Niveles de log por env var.
- B14. Las listas de parámetros AION (43 face + 7 body) están **duplicadas** en 3 lugares: `AION_EXPERT_SYSTEM_PROMPT` (server), `BODY_PARAM_OPTIONS` (server) y `AION_PARAMS`/`BODY_PARAMS` (UI). Una sola fuente de verdad servida por endpoint `/api/config` o módulo compartido.
- B15. Doc drift menor: CLAUDE.md dice `max_tokens: 1500` para claude-guided-face en una sección y `2000` en otra; el código usa 2000.

---

## ARQUITECTURA OBJETIVO

```
zami-ai-studio/
├── server.cjs                  # entrypoint delgado: boot + wiring (≤150 líneas)
├── src/
│   ├── config.cjs              # env, constantes, deployment IDs
│   ├── http-utils.cjs          # readBody, json, fail, requestWithTimeout
│   ├── auth.cjs                # token de equipo + CORS allowlist (Fase 4)
│   ├── jobs.cjs                # ★ registro de jobs server-side (Fase 2)
│   ├── store/
│   │   ├── influencers-file.cjs    # driver actual (local)
│   │   └── influencers-supabase.cjs# driver Postgres/Supabase (Fase 4)
│   ├── services/
│   │   ├── anthropic.cjs       # callClaude() único con retry/backoff/timeout
│   │   ├── comfydeploy.cjs     # cdRequest, startAionRun, startContentRun, getRun
│   │   ├── comfycloud.cjs      # flujo sexy completo (upload, submit, monitor)
│   │   ├── supabase-storage.cjs# upload de imágenes de referencia
│   │   └── prompts.cjs         # AION_EXPERT_SYSTEM_PROMPT, persona, plan semanal
│   ├── domain/
│   │   ├── aion-params.cjs     # ★ fuente única de los 43+7 params y opciones
│   │   └── body-overrides.cjs  # inferBodyParamOverridesFromText etc.
│   └── routes/
│       ├── generate.cjs        # generate-face, claude-guided-face
│       ├── persona.cjs         # generate-persona
│       ├── content.cjs         # plan, day, 2weeks, sexy
│       ├── influencers.cjs     # CRUD completo
│       └── status.cjs          # status/:runId + /api/jobs + SSE
├── public/
│   ├── index.html              # estructura (≤400 líneas)
│   ├── css/
│   │   ├── tokens.css          # design tokens (los actuales, consolidados)
│   │   ├── base.css            # reset, tipografía, layout
│   │   └── components.css      # botones, cards, steps, toasts, modal, etc.
│   └── js/
│       ├── api.js              # apiFetch, polling, SSE client
│       ├── state.js            # ★ store central de la UI + persistencia draft
│       ├── components/         # status-tracker, lightbox, toasts, steps
│       └── views/              # crear, influencer, contenido, sexy
├── test/
│   └── *.test.cjs              # node:test — sin dependencias
└── data/                       # igual que hoy (modo local)
```

Sin `npm install` en runtime (se mantiene node nativo). `node:test` viene con Node ≥18. Railway ejecuta `npm start` igual que hoy.

---

# FASES DE EJECUCIÓN

## FASE 0 — Red de seguridad (prerequisito, ~1 sesión corta)

**Objetivo:** poder cambiar código sin miedo. Cero cambios de comportamiento.

| Paso | Qué | Dónde | Cómo |
|---|---|---|---|
| 0.1 | Tag checkpoint | git | `git tag v1.1-pre-refactor` sobre el estado actual |
| 0.2 | Endpoint health | `server.cjs` | `GET /api/health` → `{ ok: true, version, uptime, influencers: n, env: { comfydeploy: bool, anthropic: bool, supabase: bool, comfycloud: bool } }` (booleanos de configuración, jamás las keys) |
| 0.3 | Smoke tests | `test/smoke.test.cjs` | Con `node:test` + `assert`: (a) `extractImages` con fixtures reales de outputs (copiar estructura de los logs `OUTPUTS:`/`CDC OUTPUTS:`); (b) `inferBodyParamOverridesFromText` con los casos documentados (curvy/tetona/extremo→enums exactos del payload aprobado en CLAUDE.md); (c) `normalizeAionPayload` rellena los 7 body params con "auto" y valida enums; (d) `sanitizeLoneSurrogates`; (e) filtro+orden ZCS y ZSEXY. Para testear funciones hoy privadas, exportarlas con `module.exports._internal = {...}` (sin mover nada todavía) |
| 0.4 | Script test | `package.json` | `"test": "node --test test/"` |
| 0.5 | CI mínimo | `.github/workflows/ci.yml` | En cada push: `node --check server.cjs` + `npm test`. Nada más. |

**Criterio de aceptación:** `npm test` verde; `/api/health` responde; el server arranca y sirve la UI idéntica.

---

## FASE 1 — Modularización sin cambio de comportamiento (~1-2 sesiones)

**Objetivo:** partir los monolitos en la estructura objetivo. **Movimientos puros de código** — prohibido "mejorar mientras se mueve".

| Paso | Qué | Detalle |
|---|---|---|
| 1.1 | Extraer backend a `src/` | En este orden (cada uno un commit): `config.cjs` → `http-utils.cjs` → `domain/aion-params.cjs` → `services/anthropic.cjs` (aún 5 funciones; se unifican en Fase 5) → `services/comfydeploy.cjs` → `services/comfycloud.cjs` → `services/supabase-storage.cjs` → `services/prompts.cjs` → `store/influencers-file.cjs` → `routes/*.cjs`. `server.cjs` queda como router/boot. |
| 1.2 | Servir estáticos | `server.cjs`: handler `GET /public/*` con whitelist de extensiones (css, js, png, svg, woff2), `Content-Type` correcto y `Cache-Control: no-cache` en dev / `max-age` en prod. **No usar `path` del usuario sin `path.normalize` + verificación de prefijo** (path traversal). |
| 1.3 | Partir la UI | `server-ui.html` → `public/index.html` + `public/css/{tokens,base,components}.css` + `public/js/{api,state,...}.js`. Mover el CSS tal cual (consolidando los overrides "2026 DESIGN UPGRADES" que hoy redefinen reglas anteriores — aplanar a una sola definición por selector). JS en módulos ES (`<script type="module">`). |
| 1.4 | Fuente única de params | La UI deja de hardcodear `AION_PARAMS`/`BODY_PARAMS`: `GET /api/config` devuelve `{ aionParams, bodyParams, imageSlots, photoTypes, pollIntervalMs }` desde `domain/aion-params.cjs`. Elimina la triplicación B14. |
| 1.5 | Modo dev | Si `NODE_ENV !== 'production'`, releer archivos del disco en cada request (B11). `iniciar.bat` no cambia. |
| 1.6 | Borrar legacy | Eliminar `startBodyRun`, `startBodyRunV2`, `generateBodyPrompt`, `/api/generate-body`, `/api/generate-body-prompt`, `DEPLOYMENT_ID_BODY` (B7). Actualizar CLAUDE.md. |

**Criterio de aceptación:** la app se ve y se comporta EXACTAMENTE igual; `npm test` verde; diff de comportamiento = solo la ruta `/public/*` nueva y `/api/config`.

---

## FASE 2 — Registro de jobs server-side + estado en tiempo real (la fase ★, ~2 sesiones)

**Objetivo:** resolver P1 y P2. El servidor se vuelve la fuente de verdad de todo lo que está generándose; la UI solo observa. Esto es lo que pediste explícitamente: que el usuario siempre entienda qué está pasando (AI Persona incluido).

### 2.A Backend — `src/jobs.cjs`

Generalizar el patrón que ya existe para `ccsx:` a TODOS los flujos:

```js
// Job = unidad observable de trabajo
{
  id: 'job_<uuid>',
  kind: 'create-influencer' | 'content-2weeks' | 'sexy',
  influencer: { nombre, nicho },         // contexto para mostrar
  status: 'running' | 'success' | 'error' | 'partial',
  createdAt, updatedAt, finishedAt,
  steps: [                                // ★ el corazón del feedback
    { id:'params',  label:'Preparando parámetros',      status:'done',    detail:'Claude eligió 51 params', startedAt, endedAt },
    { id:'image',   label:'Generando rostro y cuerpo',  status:'active',  detail:'ComfyDeploy: uploading', meta:{ cloudStatus:'uploading', elapsed: 184 } },
    { id:'persona', label:'Creando AI Persona',         status:'pending', retryable: true },
  ],
  result: { face_url, body_url, persona, plans, images... },
  error: null,
  logs: [ { at, msg } ]                   // últimas ~40 entradas, como ccsx
}
```

- Map en memoria + **persistencia a disco** (`data/jobs.json`, escritura atómica igual que influencers) para sobrevivir reinicios del server. Al boot, los jobs `running` se re-adoptan: se relanza el monitor de polling contra ComfyDeploy/ComfyCloud con el runId guardado (los runs externos siguen vivos).
- Monitores server-side (setInterval cada 8s ComfyDeploy / 3s ComfyCloud) actualizan el job — exactamente el patrón actual de `pollComfyCloudSexyRun`, generalizado.
- `/api/status/:runId` se mantiene por compatibilidad, pero ahora **pasa el estado granular**: `{ status, cloudStatus: 'queued|started|uploading|...', queuePosition?, elapsedMs }` en vez de colapsar a `running` (B4).

### 2.B Backend — orquestación server-side

- `POST /api/jobs/create-influencer` — recibe lo que hoy reciben `generate-face`/`claude-guided-face` + `nombre`/`nicho`, y ejecuta TODO el pipeline en el servidor: params → run AION → poll → persona (con 1 retry automático si el JSON es inválido, B6) → respuesta. La UI ya no encadena pasos.
- `POST /api/jobs/content-2weeks` — mueve la orquestación de `generateContent2Weeks()` (hoy 140 líneas client-side) al servidor reutilizando el endpoint `/api/generate-content-2weeks` que ya existe (B8), ampliado con polling interno + retry de parciales (la lógica de `pollWithRetry` se traslada).
- `POST /api/jobs/:id/retry-step` — reintenta un step fallido **sin repetir los anteriores**. Caso clave: persona falló → reintenta solo persona con las URLs ya generadas (U1). Aplica a: persona, run de imágenes de una semana, run sexy.
- `GET /api/jobs?active=1` y `GET /api/jobs/:id` — para que la UI (de cualquier miembro del equipo, en cualquier tab) descubra y observe jobs.
- **SSE**: `GET /api/jobs/:id/events` con `text/event-stream` (módulos nativos, ~30 líneas). Fallback automático a polling de `GET /api/jobs/:id` cada 3s si SSE falla. SSE elimina los 8s de latencia percibida.

### 2.C Frontend — componente `status-tracker`

Un único componente de progreso reutilizable que reemplaza los 3 sistemas actuales (steps del pipeline, wc-steps de semanas, sx-steps sexy):

- Por cada step: dot animado + label + **detail vivo** + **timer transcurrido** (`1m 24s`) + estimación (`~2-5 min`) + sub-estado real del cloud (`En cola (3 delante)`, `Subiendo outputs...`) tomado de `meta.cloudStatus`/`queuePosition` — se acabaron los estados inventados por `pollCount` (U3).
- Step en error → botón **"Reintentar este paso"** (llama `retry-step`) + mensaje de error legible + botón "Ver detalle técnico" que expande `job.logs` (el feed que el server ya genera y la UI ignoraba).
- `aria-live="polite"` en el contenedor de detail (U14).
- **Paso 4 / AI Persona concretamente:** pasa de texto estático a: `Creando AI Persona — Claude está analizando rostro y cuerpo · 18s · ~30s estimado` con spinner, y si falla: `Error: Claude no devolvió un perfil válido (reintento automático 1/1 también falló) → [Reintentar Persona]` sin regenerar imágenes.
- Eliminar el paso decorativo "Resultado listo" (U2): quedan 3 pasos reales (Parámetros → Imagen → Persona).

### 2.D Frontend — reanudación

- Al cargar la página: `GET /api/jobs?active=1`. Si hay jobs vivos → banner "Hay 1 generación en curso: Valentina (rostro+cuerpo, 3m 12s) [Ver]" y el status-tracker se re-conecta. **Un F5 ya no pierde nada.**
- `beforeunload` con warning solo si hay un job en estado donde el server aún no tomó control (ventana de ms; con orquestación server-side casi desaparece).

**Criterio de aceptación:** matar el browser a mitad de una generación, reabrir, y ver el job continuar y completarse; un step de persona forzado a fallar se reintenta solo con su botón; dos browsers distintos ven el mismo job en vivo.

---

## FASE 3 — UI profesional (refinamiento visual + flujos, ~2 sesiones)

**Objetivo:** elevar a herramienta interna profesional manteniendo la identidad Acid Lime/Bebas/dark.

### 3.A Sistema y consistencia
1. **Fix de contraste (bug U5):** regla global `button { color:#000 }` cuando el fondo es `--c-accent`; auditar TODOS los botones. Subir grises de texto mínimos a `#9a9a9a` sobre fondos `#0d0d0d` (U14).
2. **Un solo sistema de feedback (U4):** validación de formularios → inline bajo el campo (borde rojo + mensaje); errores de operación → toast + estado en el status-tracker; eliminar todos los `alert()`.
3. Consolidar la hoja de estilos: una definición por selector (hoy `#workspace`, `.toggle-body`, `.status-bar`, `pulse` están definidos dos veces por la capa "2026 UPGRADES").
4. Estados de foco visibles (`:focus-visible`) y orden de tabulación en formularios.

### 3.B Navegación y vistas (U7, U9, U10)
1. **Tres vistas** con tabs superiores (o sidebar de secciones): **Crear** · **Influencers** · **Contenido**. La vista activa es la única visible; deep-link con `location.hash` (`#/crear`, `#/influencer/<id>`, `#/contenido`).
2. **Vista de detalle de influencer** (no existe hoy): foto rostro+cuerpo grande, persona card completa (la misma `renderPersona`, reutilizada), historial de semanas con sus themes, botones: Generar contenido · Editar persona · Eliminar (con confirmación). Requiere backend: `GET /api/influencers/:id`, `PUT /api/influencers/:id` (persona editada), `DELETE /api/influencers/:id` — añadirlos en esta fase.
3. Sidebar: las cards referencian por `id` (matar `data-inf` con el JSON completo, U8); badge de "generando" en la card si esa influencer tiene un job activo.
4. Hero landing: solo si `localStorage.zami_seen_hero` no existe; tecla Esc lo salta; en Railway (env `SHOW_HERO=false` expuesto vía `/api/config`) desactivado por defecto.

### 3.C Trabajo con imágenes (U6)
1. **Lightbox modal**: clic en cualquier imagen → modal con imagen a tamaño completo, navegación ←/→ entre las imágenes del mismo grupo (8 de semana, 10 sexy, rostro/cuerpo), zoom, botones Descargar y "✦ Más Sexy" dentro del modal, cierre con Esc/click-fuera. Un componente, usado en todos los grids.
2. Descarga en lote: "Descargar semana (8)" — itera `downloadImage` o genera zip client-side simple (sin libs: descargas secuenciales está bien).
3. Indicador de aspect-ratio correcto en placeholders/skeletons (los slots 9:16 deben verse altos ya desde el skeleton, no todos 4:5).

### 3.D Flujo de creación (U11, U12, U13)
1. **Draft persistente**: nombre, nicho, descripción Claude, toggles y params se guardan en `localStorage` al escribir (debounced) y se restauran al cargar.
2. **Autosave de influencer**: al completar el pipeline, guardar automáticamente como borrador (`POST /api/influencers` con flag `draft: true`) y mostrar "Guardada automáticamente ✓ — [Descartar]". Adiós a perder una generación de 5 minutos por olvidar un clic (U12).
3. Bloqueo de acciones conflictivas durante un job activo: deshabilitar selección de otra influencer / cambio de modo con tooltip "Hay una generación en curso" (U11).
4. Validación en vivo: nombre/nicho requeridos marcados al perder foco; contador de caracteres en descripción de Claude.
5. Indicador de conexión (U16): si dos polls/SSE seguidos fallan → banner amarillo "Reconectando..." que desaparece al volver.

### 3.E Micro-detalles
- `copyPersona(event)` recibir el evento como parámetro (U15).
- Botón "Cancelar" en jobs (best-effort: marca el job cancelado y deja de poll; ComfyDeploy seguirá pero la UI queda limpia).
- Tooltips con `title` en los 43 params (el label técnico en inglés confunde; añadir descripción corta en español en `aion-params.cjs`).

**Criterio de aceptación:** flujo completo navegable por las 3 vistas; lightbox operativo en todos los grids; cero `alert()`; auditoría de contraste pasada (todos los botones lime con texto negro); draft sobrevive a F5.

---

## FASE 4 — Equipo + Railway: seguridad y persistencia (~1-2 sesiones)

**Objetivo:** resolver P3 y P4 para el deploy interno del equipo.

| Paso | Qué | Cómo |
|---|---|---|
| 4.1 | **Auth por token de equipo** | Env `TEAM_ACCESS_TOKEN`. Middleware en `auth.cjs`: toda ruta `/api/*` (excepto `/api/health`) exige header `Authorization: Bearer <token>` o cookie de sesión. UI: pantalla de login simple (un campo de clave) → guarda cookie `HttpOnly` firmada (HMAC con `crypto` nativo, sin libs) con expiración 30 días. Si `TEAM_ACCESS_TOKEN` no está definido (modo local), el middleware es no-op — la experiencia local de hoy no cambia. |
| 4.2 | **CORS real** | `isAllowedOrigin`: allowlist desde env `ALLOWED_ORIGINS` (CSV); en local default `127.0.0.1:3333`. Como la UI es same-origin, esto solo cierra la puerta a terceros (B1). |
| 4.3 | **Rate limit básico** | Map ip→timestamps en memoria: máx N requests/min a rutas de generación (configurable). Suficiente para uso interno; protege los créditos. |
| 4.4 | **Persistencia Supabase** | Implementar `store/influencers-supabase.cjs` contra Supabase REST (`/rest/v1/influencers`, tablas `influencers` y `weeks` — DDL incluido abajo). Driver elegido por env `STORE=file|supabase`. `jobs.json` puede seguir en disco (los jobs son efímeros; perder histórico de jobs en redeploy es aceptable) o tabla `jobs` si se quiere histórico. Incluir script one-shot `scripts/migrate-influencers-to-supabase.cjs` que lee el JSON local y lo sube. |
| 4.5 | **Service role key** | Para el store usar `SUPABASE_SERVICE_KEY` (server-side only, nunca expuesta a la UI). La `ANON_KEY` queda solo para el bucket público de imágenes como hoy. |
| 4.6 | Logging para Railway | `LOG_LEVEL=info|debug`: en `info` no volcar payloads completos (B13). Mantener `[AION PAYLOAD AUDIT]` en `debug` (es la fuente de verdad de troubleshooting según CLAUDE.md). |
| 4.7 | Docs de deploy | `docs/DEPLOY_RAILWAY.md`: variables, healthcheck path `/api/health`, cómo rotar el token de equipo. |

```sql
-- DDL Supabase (Fase 4.4)
create table influencers (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  nicho text not null,
  face_url text not null,
  body_url text,
  persona text,
  draft boolean default false,
  created_at timestamptz default now()
);
create table weeks (
  week_id uuid primary key default gen_random_uuid(),
  influencer_id uuid references influencers(id) on delete cascade,
  theme text, summary text, plan jsonb,
  generated_at timestamptz default now()
);
-- RLS ON, sin policies para anon: solo service_role accede.
alter table influencers enable row level security;
alter table weeks enable row level security;
```

**Criterio de aceptación:** con `TEAM_ACCESS_TOKEN` seteado, requests sin token → 401 y la UI pide la clave; con `STORE=supabase` el CRUD completo funciona y un redeploy no pierde datos; en local sin envs nuevas todo funciona idéntico a hoy.

---

## FASE 5 — Robustez backend (~1 sesión)

**Objetivo:** B5, B6 (ya parcial en Fase 2), B9, B12-restante.

1. **`services/anthropic.cjs` único**: `callClaude({ system?, content, maxTokens, expectJson })` con:
   - `fetch` nativo + `AbortController` timeout (120s),
   - retry con backoff exponencial (2s/4s/8s) ante 429, 529, `overloaded_error` y errores de red,
   - limpieza de fences ```json y parse con 1 reintento de generación si `expectJson` y el parse falla,
   - `safeJsonStringify` aplicado siempre.
   Migrar las 4 funciones a este helper (−~250 líneas duplicadas).
2. **`cdRequest` con timeout + retry** (3 intentos, backoff) para `GET /api/run/*` (los polls); los `POST queue` solo 1 retry y únicamente ante error de red (nunca ante 4xx/5xx con body, para no duplicar runs) (B9).
3. Tests nuevos: `callClaude` con servidor mock local (`http.createServer` efímero en el test), retry de persona, driver de store con tmp dir, middleware auth (401/200), filtro de jobs.
4. Limpieza final: actualizar CLAUDE.md v14 completo (arquitectura nueva, rutas nuevas, fases, max_tokens correcto — B15) y borrar secciones obsoletas.

---

## FASE 6 — Opcional / siguiente horizonte (no bloquea nada)

Listado para decisión futura, NO incluido en el alcance aprobado:

- **Galería/biblioteca de contenido**: hoy las imágenes generadas solo viven en URLs S3 firmadas de ComfyDeploy (expiran). Persistir las 8+10 imágenes de cada semana al bucket `zami-images` propio y guardar las URLs en la semana → historial visual permanente por influencer. *Recomendado como primera mejora post-plan: es la pérdida de datos silenciosa más grande del producto.*
- Selección/aprobación de imágenes (aprobar/rechazar por slot, regenerar slot individual con su prompt editado).
- Fase 5 del producto (publicación automática) y Fase 6 (KPIs) según CLAUDE.md.
- Editor de prompts del sistema (persona/plan semanal) desde la UI para iterar el "cerebro" sin tocar código.
- Migración de `ANTHROPIC_MODEL` por tarea (params=sonnet, persona/plan=opus) vía env.

---

## ORDEN, DEPENDENCIAS Y ESTIMACIÓN

```
F0 (red de seguridad)      ──►  F1 (modularización)  ──►  F2 (jobs + estado real ★)
                                                            │
                                              F3 (UI profesional) ◄─ depende de F2 (status-tracker usa jobs)
                                                            │
                                              F4 (equipo + Railway) — puede ir en paralelo con F3 tras F2
                                                            │
                                              F5 (robustez backend)
```

| Fase | Sesiones de agente est. | Riesgo | Valor para el usuario |
|---|---|---|---|
| F0 | 0.5 | nulo | base |
| F1 | 1-2 | medio (movimiento masivo, mitigado por F0) | base |
| F2 | 2 | medio | ★★★ — el problema que reportaste |
| F3 | 2 | bajo | ★★★ |
| F4 | 1-2 | bajo | ★★ (bloquea Railway) |
| F5 | 1 | bajo | ★ |

**Política de pruebas con APIs reales:** F0-F1 no requieren gastar créditos. F2 requiere UNA generación real de influencer y UNA tanda de contenido para validar la reanudación (coordinar contigo el momento). F3-F5 de nuevo sin gasto (mockear `/api/jobs` en dev).

---

## CHECKLIST DE APROBACIÓN (para el usuario)

- [ ] ¿Apruebas la estructura de carpetas objetivo (sin npm runtime, sin build step)?
- [ ] ¿Apruebas mover la orquestación de pipeline al servidor (F2)? Es el cambio de mayor calado.
- [ ] ¿Apruebas autosave de influencers como borrador (F3.D.2)?
- [ ] ¿Apruebas auth por token único de equipo (no usuarios individuales) para la v1 web (F4.1)?
- [ ] ¿Apruebas migrar influencers a tablas Supabase con service key (F4.4)?
- [ ] ¿La galería persistente de imágenes (F6) la priorizamos justo después del plan?
