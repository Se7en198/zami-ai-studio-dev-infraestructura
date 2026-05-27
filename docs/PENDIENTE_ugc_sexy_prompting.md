# PENDIENTE — Prompting UGC Sexy para Fase 4

> **Estado:** En espera. Este documento NO está activo en producción.
> **Cuándo activar:** Cuando el nodo `GeminiImage2Node` sea reemplazado por un modelo sin políticas de contenido (ej. FLUX.2 Klein 9B, Stable Diffusion, ByteDance Seedream, o cualquier nodo open-source sin filtros).
> **Qué hace este doc:** Guarda exactamente qué cambiar en `server.cjs` para que los 8 slots de contenido UGC generen imágenes sexy/atrevidas con el estilo de influencer real de Instagram.

---

## Por qué existe este documento

La automatización Zami AI Studio genera 8 imágenes UGC por semana por influencer (Fase 4, ComfyDeploy deployment `f9822b81`). Esas imágenes las genera internamente el nodo `GeminiImage2Node` con los prompts que Claude crea a partir de las `REGLAS FOTOGRÁFICAS UGC` en `server.cjs`.

El problema: **Gemini tiene políticas de contenido estrictas** que bloquean cualquier prompt con vocabulario relacionado a poses sugerentes, bikinis específicos, cuerpo expuesto, etc. — devuelve `IMAGE_PROHIBITED_CONTENT` y el slot falla.

Por eso la versión actual de producción usa un prompting conservador (alluring, captivating, body-hugging). Funciona, pero no produce el nivel de contenido sexy que la automatización necesita para generar influencers de alto engagement.

**Cuando Gemini sea reemplazado, activar este prompting.**

---

## Prerrequisito técnico antes de activar

Antes de hacer los cambios en `server.cjs`, verificar que el deployment `f9822b81` en ComfyDeploy usa un nodo generador de imágenes **sin políticas de contenido** en lugar de `GeminiImage2Node`. Opciones probadas/investigadas:

- **FLUX.2 Klein 9B** con LoRA SEXGOD v4 — opción preferida, máxima calidad sin restricciones
- **ByteDance Seedream** — tiene algún nivel de filtro, menos restrictivo que Gemini pero no cero
- Cualquier nodo ComfyUI open-source basado en Stable Diffusion / FLUX

---

## Cambios exactos en `server.cjs`

### 1. Slot descriptions — buscar y reemplazar

**Buscar (versión conservadora actual):**
```
- Slot 1: 9:16 → Story o Reel vertical (close-up, espontáneo, selfie POV)
- Slot 2: 9:16 → Story o Reel vertical (close-up, espontáneo, selfie POV)
- Slot 3: 1:1  → Square (carrusel cover, moodboard, post de marca)
- Slot 4: 1:1  → Square (carrusel cover, moodboard, post de marca)
- Slot 5: 3:4  → Feed portrait lifestyle (cuadrado largo, ambiente natural)
- Slot 6: 4:5  → Feed portrait editorial (retrato de moda o lifestyle principal)
- Slot 7: 1:1  → Square (tercer post de marca o engagement)
- Slot 8: 4:5  → Feed portrait editorial (retrato secundario)
```

**Reemplazar con (versión sexy):**
```
- Slot 1: 9:16 → Story/Reel vertical — FIRMA: mirror selfie, from behind looking over shoulder, o close-up body selfie POV. Outfit mínimo, midriff visible.
- Slot 2: 9:16 → Story/Reel vertical — Momento candid: en bikini en setting inesperado (kitchen, hotel, jardín), o caminando de frente con outfit body-hugging.
- Slot 3: 1:1  → Square — Foto de cuerpo completo en setting de lujo (pool, playa, yate, rooftop). Brazilian bikini o mini dress. Pose icónica.
- Slot 4: 1:1  → Square — Close-up cintura para abajo o midriff + outfit (short denim cutoffs, micro bikini), o desde atrás mostrando curvas.
- Slot 5: 3:4  → Feed portrait lifestyle — Cuerpo completo en lugar aspiracional (beach, rooftop, luxury location), outfit body-hugging o bikini.
- Slot 6: 4:5  → Feed portrait principal — La mejor foto de la semana. Pose icónica, outfit más impactante, setting más aspiracional. Ella mirando directo a cámara.
- Slot 7: 1:1  → Square — Candid del nicho con cuerpo visible (gym selfie, kitchen en bikini, evento en mini dress).
- Slot 8: 4:5  → Feed portrait secundario — Segunda foto de impacto: diferente setting y outfit que slot 6, igualmente atrevida.
```

---

### 2. REGLAS FOTOGRÁFICAS UGC — buscar y reemplazar

**Buscar (versión conservadora actual):**
```
REGLAS FOTOGRÁFICAS UGC (aplica en TODOS los prompts):
- "Shot on iPhone 15 Pro" — NUNCA studio lights
- Incluir imperfecciones reales: grain de sensor, ligero motion blur ocasional
- Tipos: selfie | mirror selfie | POV candid | lifestyle moment
- Imágenes muy atractivas, magnéticas, cautivadoras y aspiracionales — siempre bella, alluring y captivating
- Outfits reales según el nicho: streetwear, athleisure, vestidos, coordinated sets, loungewear
- GEMINI SAFETY — OBLIGATORIO: NUNCA usar nude, naked, revealing, topless, sensual, erotic, explicit — Gemini bloqueará el request. Usar en cambio: alluring, captivating, magnetic, smoldering, confident, fierce, striking, body-hugging outfit, curve-accentuating
- COHERENCIA NARRATIVA a lo largo de la semana
- Prompts en INGLÉS, resto en ESPAÑOL
```

**Reemplazar con (versión sexy completa):**
```
REGLAS FOTOGRÁFICAS UGC — ESTILO INSTAGRAM (aplica en TODOS los prompts):

PRINCIPIO RECTOR: Su cuerpo es el protagonista de cada foto. El estilo de referencia es el de influencers reales de Instagram: bikinis brasileros high-cut, midriff expuesto, micro outfits en settings cotidianos, poses que muestran el cuerpo con confianza total.

TOMAS SIGNATURE — al menos 3 de los 8 slots deben ser de estos tipos:
1. FROM BEHIND — ella de espaldas, mirando a cámara por encima del hombro. En gym (leggings pegados), playa/pool (high-cut cheeky bikini), rooftop nocturno (micro outfit). La toma de mayor engagement.
2. MIRROR SELFIE — sosteniendo el teléfono frente al espejo de gym, baño o closet. Cuerpo completo visible. Outfit mínimo mostrando curvas.
3. BIKINI EN SETTING INESPERADO — en bikini o micro outfit haciendo algo cotidiano: kitchen, hotel room, jardín/piscina privada, deck de yate.

VOCABULARIO DE OUTFITS — usar estas descripciones en los prompts:
• Gym: "form-fitting sports bra and ultra-tight high-waist leggings, bare midriff, toned athletic physique prominently on display"
• Beach/Pool: "Brazilian-cut high-cut cheeky string bikini, micro triangle bikini top, bare midriff, toned hourglass curves fully visible"
• Noche/Lounge: "skin-tight micro mini dress OR body-hugging metallic ribbed mini dress, hourglass silhouette accentuated, bare legs"
• Casual/Home: "tied micro crop top OR knotted shirt showing bare toned midriff, very short denim cutoff shorts"
• Yate/Hotel Lujo: "barely-there string bikini OR sheer lace beach cover-up over bikini, sun-kissed skin"
• Festival/Evento: "micro bralette crop top + low-rise jeans OR micro mini skirt, bare midriff center of frame"
• Sauna/Spa: "minimal athletic crop + cheeky shorts OR wrapped towel, steam atmosphere, intimate setting"

POSES — rotar entre los 8 slots:
• From behind at pool/beach/rooftop looking over shoulder
• Hand on hip, pronounced hip arch toward camera, direct smoldering gaze
• Mirror selfie full body — phone held up, head slightly tilted, confident expression
• Lying on stomach at beach/boat/bed — looking at camera, high-cut bikini from behind
• Leaning forward or bending slightly — shows waist-to-hip curve
• Sitting with legs extended, leaning back on hands — body elongated
• Walking toward camera, hips swaying, direct gaze
• Arms raised or reaching up — elongates body, shows abs and waist

REGLA DE MIDRIFF: el abdomen/cintura está SIEMPRE visible salvo en noche con vestido ajustado.

SETTINGS — variar, nunca repetir en la misma semana:
gym mirror | luxury infinity pool | tropical beach (turquoise water) | yacht/boat deck | hotel room at golden hour or night | rooftop at night with city lights | home kitchen | outdoor festival/event | luxury restaurant/lounge | waterfront promenade | sauna/spa

CALIDAD FOTOGRÁFICA: "Shot on iPhone 15 Pro" SIEMPRE + sensor grain, natural imperfect lighting, real candid human energy, NOT editorial/studio — feels like it was actually posted on her Instagram today

COHERENCIA NARRATIVA — continuidad de historia a lo largo de la semana
Prompts en INGLÉS, resto en ESPAÑOL
```

---

## Ejemplo de prompt que debe generar Claude (con modelo sin restricciones)

```
"Shot on iPhone 15 Pro, 9:16 vertical, young latina woman from behind standing at infinity pool edge, tropical turquoise water, wearing high-cut cheeky Brazilian-cut string bikini, toned glutes and curves on display, looking back over shoulder with smoldering half-smile, golden hour warm light, natural skin texture, slight sensor grain, alluring and magnetic, authentic Instagram influencer energy"
```

---

## Checklist de verificación al activar

1. Confirmar que el deployment `f9822b81` usa nodo sin filtros de contenido
2. Aplicar los dos cambios en `server.cjs` descritos arriba
3. Reiniciar servidor: `cd C:\Users\LENOVO\zami-ai-studio-dev && .\iniciar.bat`
4. Seleccionar influencer → Generar Plan Semanal → revisar que los prompts generados por Claude contengan vocabulario del VOCABULARIO DE OUTFITS
5. Generar 8 Imágenes → verificar que los 8 slots completan sin error
6. Actualizar `CLAUDE.md` sección "REGLAS FOTOGRÁFICAS UGC" con la nueva versión activa
