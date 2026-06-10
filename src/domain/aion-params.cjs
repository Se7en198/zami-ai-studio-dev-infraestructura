'use strict'

// ── Fuente única de los parámetros AION (43 rostro + 7 cuerpo + calidad) ─────
// FASE 1: consolida la triplicación (server BODY_PARAM_OPTIONS + UI AION_PARAMS/
// BODY_PARAMS). Las enums del server son movimiento puro desde server.cjs.
// AION_PARAMS/BODY_PARAMS/IMAGE_SLOTS/PHOTO_TYPES se copian VERBATIM desde
// server-ui.html para que /api/config sea la única definición consumida por la UI.

// ── Server-side enums (validación de payload) ───────────────────────────────
const BODY_PARAM_OPTIONS = {
  body_type: ['auto','slim lean build','slim-athletic build','athletic toned build','hourglass figure','pear-shaped figure','curvy fuller figure','plus-size full build','petite frame','tall statuesque frame','muscular defined build'],
  bust:      ['auto','flat chest','small bust','moderate bust','full bust','large bust','extra large bust','extremely large bust exaggerated proportions','hyper-voluminous bust fantasy proportions','massive oversized bust ultra-exaggerated'],
  waist:     ['auto','very narrow waist extreme hourglass','narrow defined waist','moderate waist','straight waist','full waist'],
  glutes:    ['auto','flat glutes','small glutes','moderate rounded glutes','full prominent glutes','large voluminous glutes','extra large glutes exaggerated proportions','extremely large glutes hyper-voluminous rear','massive oversized glutes ultra-exaggerated'],
  hips:      ['auto','narrow hips','balanced proportionate hips','wide hips','very wide hips','full rounded hips exaggerated width'],
  legs:      ['auto','long lean legs','slim legs','athletic legs defined quads','full thick thighs','muscular legs','wide thighs full legs'],
  shoulders: ['auto','narrow shoulders','proportionate shoulders','broad shoulders','sloped shoulders','square shoulders'],
}
const BODY_MODEL_OPTIONS       = ['gemini-3.1-pro-preview','gemini-3-flash-preview','gemini-2.5-pro','gemini-2.5-flash']
const BODY_IMAGE_MODEL_OPTIONS = ['Nano Banana Pro (gemini-3-pro-image-preview)','Nano Banana 2 (gemini-3.1-flash-image-preview)']
const BODY_RESOLUTION_OPTIONS  = ['512px','1K','2K','4K']
const BODY_PARAM_KEYS          = Object.keys(BODY_PARAM_OPTIONS)
const AION_IMAGE_KEYS          = ['eyes','eyebrows','nose','lips','forehead','jawline','hairline','skin','full_face']

// ── UI definitions (copiadas verbatim desde server-ui.html) ─────────────────
const AION_PARAMS = [
  { name:'sex',        label:'Sex',        group:'Demographics', options:['auto','unspecified','female','male','androgynous'] },
  { name:'ethnicity',  label:'Ethnicity',  group:'Demographics', options:['auto','unspecified','East Asian','South Asian','Southeast Asian','Central Asian','Middle Eastern','North African','Horn of Africa','Sub-Saharan African','Northern European','Southern European','Eastern European','Western European','North American','Latin American','Mestizo','Caribbean','Indigenous American','Pacific Islander','Melanesian','Australian Aboriginal','Mixed heritage'] },
  { name:'eye_shape',  label:'Eye Shape',  group:'Eyes', options:['auto','almond-shaped','round','hooded','monolid','upturned','downturned','deep-set','prominent','wide-set','close-set'] },
  { name:'eye_size',   label:'Eye Size',   group:'Eyes', options:['auto','small','medium','large','very large','proportionate'] },
  { name:'eye_tilt',   label:'Eye Tilt',   group:'Eyes', options:['auto','neutral tilt','slight upward tilt','moderate upward tilt','slight downward tilt','horizontal'] },
  { name:'eye_color',  label:'Eye Color',  group:'Eyes', options:['auto','dark brown','medium brown','light brown','hazel','amber','green','blue-green','light blue','deep blue','gray','dark gray','black'] },
  { name:'eyebrow_thickness', label:'Eyebrow Thickness', group:'Eyebrows', options:['auto','thin','medium thickness','thick','very thick','sparse','dense and full'] },
  { name:'eyebrow_shape',    label:'Eyebrow Shape',    group:'Eyebrows', options:['auto','straight','soft arch','high arch','rounded','angled','flat','S-shaped','naturally unruly'] },
  { name:'eyebrow_color',    label:'Eyebrow Color',    group:'Eyebrows', options:['auto','black','dark brown','medium brown','light brown','auburn','dark blonde','blonde','gray','reddish brown'] },
  { name:'nose_profile', label:'Nose Profile', group:'Nose', options:['auto','straight profile','slightly concave','slightly convex','aquiline','button nose profile','flat bridge','high bridge','broad bridge','narrow bridge'] },
  { name:'nose_base',   label:'Nose Base',   group:'Nose', options:['auto','narrow base','medium base','wide base','flared nostrils','compact nostrils','rounded base','angular base'] },
  { name:'nose_tip',    label:'Nose Tip',    group:'Nose', options:['auto','rounded tip','pointed tip','bulbous tip','upturned tip','downturned tip','refined tip','broad tip','narrow tip'] },
  { name:'lips_volume',     label:'Lips Volume',     group:'Lips', options:['auto','thin lips','medium volume','full lips','very full lips','naturally plump','delicate and refined'] },
  { name:'cupid_bow',       label:"Cupid's Bow",      group:'Lips', options:["auto","pronounced cupid's bow","subtle cupid's bow","flat cupid's bow","heart-shaped cupid's bow","rounded cupid's bow","sharply defined bow"] },
  { name:'lips_proportion', label:'Lips Proportion', group:'Lips', options:['auto','balanced upper and lower','fuller lower lip','fuller upper lip','equal proportion','slightly fuller lower','slightly fuller upper'] },
  { name:'lips_color',      label:'Lip Color',       group:'Lips', options:['auto','soft pink','rosy pink','mauve','dusty rose','berry toned','warm peach','neutral beige','deep rose','brownish pink','coral toned'] },
  { name:'forehead',    label:'Forehead',    group:'Structure', options:['auto','broad forehead','narrow forehead','high forehead','low forehead','slightly rounded','flat forehead','prominent forehead','average proportion'] },
  { name:'cheekbones',  label:'Cheekbones',  group:'Structure', options:['auto','high cheekbones','low cheekbones','prominent cheekbones','subtle cheekbones','wide-set cheekbones','angular cheekbones','soft rounded cheekbones','flat cheekbones'] },
  { name:'jawline',     label:'Jawline',     group:'Structure', options:['auto','strong jawline','soft jawline','angular jawline','rounded jawline','square jawline','tapered jawline','wide jaw','narrow jaw','defined jawline'] },
  { name:'chin',        label:'Chin',        group:'Structure', options:['auto','pointed chin','rounded chin','square chin','narrow chin','broad chin','prominent chin','receding chin','cleft chin','soft chin'] },
  { name:'cheeks',      label:'Cheeks',      group:'Volumes', options:['auto','full cheeks','hollow cheeks','soft rounded cheeks','flat cheeks','naturally plump','slightly sunken','apple cheeks','lean cheeks'] },
  { name:'submental',           label:'Submental',           group:'Volumes', options:['auto','tight submental area','soft submental area','defined under-chin','slight fullness','clean jawline transition','natural softness'] },
  { name:'face_neck_transition',label:'Face-Neck Transition',group:'Volumes', options:['auto','smooth transition','defined angle','soft gradual transition','sharp jaw-neck angle','naturally blended','elongated neck line'] },
  { name:'hair_structure', label:'Hair Structure', group:'Hair', options:['auto','straight','wavy','curly','coily','kinky','loosely wavy','tightly curled','fine and silky','coarse and thick'] },
  { name:'hair_length',   label:'Hair Length',   group:'Hair', options:['auto','buzz cut','very short','short','ear length','chin length','shoulder length','mid-back length','long','very long','bald','shaved sides'] },
  { name:'hair_volume',   label:'Hair Volume',   group:'Hair', options:['auto','flat and sleek','low volume','medium volume','high volume','very voluminous','thick and dense','thin and fine','fluffy'] },
  { name:'hair_color',    label:'Hair Color',    group:'Hair', options:['auto','jet black','dark brown','medium brown','light brown','dark blonde','golden blonde','platinum blonde','strawberry blonde','auburn','copper red','deep red','silver gray','white','salt and pepper'] },
  { name:'skin_tone',          label:'Skin Tone',       group:'Skin', options:['auto','very fair','fair','light','light-medium','medium','medium-tan','tan','olive','deep tan','brown','dark brown','deep brown','ebony'] },
  { name:'skin_undertone',     label:'Skin Undertone',  group:'Skin', options:['auto','cool undertone','warm undertone','neutral undertone','olive undertone','pink undertone','golden undertone','peach undertone','red undertone'] },
  { name:'skin_texture',       label:'Skin Texture',    group:'Skin', options:['auto','smooth natural grain','fine skin texture','slightly rough texture','soft velvety texture','natural skin grain','matte natural texture'] },
  { name:'skin_micro_texture', label:'Micro-Texture',   group:'Skin', options:['auto','visible fine pores','subtle pore detail','barely visible pores','natural pore variation','light textural detail','realistic micro detail'] },
  { name:'skin_imperfections', label:'Imperfections',   group:'Skin', options:['auto','none visible','light freckles','subtle blemishes','faint redness zones','small moles','soft under-eye shadows','light freckles and moles','minor sun spots','natural skin variation'] },
  { name:'skin_reflection',    label:'Skin Reflection', group:'Skin', options:['auto','matte natural finish','soft skin sheen','subtle light diffusion','natural dewy glow','satin finish','minimal shine'] },
  { name:'wrinkles',     label:'Wrinkles',    group:'Defects', options:["auto","none","fine forehead lines","crow's feet","nasolabial folds","frown lines","neck wrinkles","deep forehead furrows","perioral wrinkles","under-eye wrinkles","bunny lines","marionette lines","horizontal neck bands"] },
  { name:'scars',        label:'Scars',       group:'Defects', options:['auto','none','small facial scar','acne scarring','surgical scar','burn scar','cleft lip scar','eyebrow scar','cheek scar','forehead scar','ice-pick acne scars','boxcar acne scars','rolling acne scars','keloid scar'] },
  { name:'deformations', label:'Deformations',group:'Defects', options:["auto","none","asymmetric features","deviated nose","drooping eyelid","facial paralysis trace","cleft palate trace","micrognathia","prognathism","hemifacial microsomia","facial asymmetry left side","facial asymmetry right side","bell's palsy trace"] },
  { name:'tone_loss',    label:'Tone Loss',   group:'Defects', options:['auto','none','mild jowling','sagging cheeks','loose neck skin','drooping brow','hollow temples','sunken cheeks','loose eyelid skin','loss of jawline definition','nasolabial fold deepening','thinning lips from aging','overall facial volume loss'] },
  { name:'skin_marks',   label:'Skin Marks',  group:'Defects', options:['auto','none','post-acne dark spots','post-acne red marks','hyperpigmentation patches','melasma','age spots','sun damage spots','cherry angiomas','seborrheic keratosis','port wine stain','cafe au lait spots','liver spots'] },
  { name:'vitiligo',     label:'Vitiligo',    group:'Defects', options:['auto','none','perioral vitiligo','periocular vitiligo','forehead vitiligo','hands vitiligo','scattered patches','segmental vitiligo','universal vitiligo','focal vitiligo on cheek','symmetrical facial vitiligo','vitiligo on nose bridge'] },
  { name:'under_eye',    label:'Under-Eye',   group:'Defects', options:['auto','none','mild dark circles','deep dark circles','puffy under-eye bags','hollow tear troughs','blue-tinted dark circles','brown-tinted dark circles','hereditary dark circles','malar bags','festoons','crepey under-eye skin'] },
  { name:'expression',         label:'Expression',         group:'Expression', options:['auto','neutral','happiness','sadness','anger','surprise','fear','disgust','contempt'] },
  { name:'expression_variant', label:'Expression Variant', group:'Expression', options:['auto','Duchenne smile','social smile','bitter smile','coy smile','broad grin','closed-lip smile','smirk','radiant joy','gentle warmth','laughing','tearful','melancholic gaze','lip tremble','downcast eyes','subtle grief','resigned sadness','nostalgic sadness','holding back tears','cold fury','simmering rage','tight jaw anger','flared nostrils anger','stern disapproval','controlled anger','frustrated scowl','indignant look','wide-eyed shock','mild surprise','open-mouth gasp','raised brows surprise','stunned disbelief','pleasant surprise','startled','wide-eyed fear','frozen terror','anxious worry','nervous tension','subtle unease','panicked expression','deer-in-headlights','mild distaste','strong revulsion','nose wrinkle disgust','lip curl disgust','nauseated look','subtle aversion','one-sided smirk','dismissive look','superior gaze','subtle disdain','eye-roll contempt','sardonic expression','serene neutral','pensive','stoic','blank stare','composed calm','thoughtful gaze','distant look','wistful','determined'] },
]

const BODY_PARAMS = [
  // 7 params directos → AionBodyReferenceNode
  { name:'body_type', label:'Tipo de cuerpo',  group:'Cuerpo', options:['auto','slim lean build','slim-athletic build','athletic toned build','hourglass figure','pear-shaped figure','curvy fuller figure','plus-size full build','petite frame','tall statuesque frame','muscular defined build'] },
  { name:'bust',      label:'Busto',           group:'Cuerpo', options:['auto','flat chest','small bust','moderate bust','full bust','large bust','extra large bust','extremely large bust exaggerated proportions','hyper-voluminous bust fantasy proportions','massive oversized bust ultra-exaggerated'] },
  { name:'waist',     label:'Cintura',         group:'Cuerpo', options:['auto','very narrow waist extreme hourglass','narrow defined waist','moderate waist','straight waist','full waist'] },
  { name:'glutes',    label:'Glúteos',         group:'Cuerpo', options:['auto','flat glutes','small glutes','moderate rounded glutes','full prominent glutes','large voluminous glutes','extra large glutes exaggerated proportions','extremely large glutes hyper-voluminous rear','massive oversized glutes ultra-exaggerated'] },
  { name:'hips',      label:'Caderas',         group:'Cuerpo', options:['auto','narrow hips','balanced proportionate hips','wide hips','very wide hips','full rounded hips exaggerated width'] },
  { name:'legs',      label:'Piernas',         group:'Cuerpo', options:['auto','long lean legs','slim legs','athletic legs defined quads','full thick thighs','muscular legs','wide thighs full legs'] },
  { name:'shoulders', label:'Hombros',         group:'Cuerpo', options:['auto','narrow shoulders','proportionate shoulders','broad shoulders','sloped shoulders','square shoulders'] },
  // Calidad del motor de cuerpo
  { name:'body_model',       label:'Modelo IA',       group:'Calidad cuerpo', options:['gemini-3.1-pro-preview','gemini-3-flash-preview','gemini-2.5-pro','gemini-2.5-flash'] },
  { name:'body_image_model', label:'Image model',     group:'Calidad cuerpo', options:['Nano Banana Pro (gemini-3-pro-image-preview)','Nano Banana 2 (gemini-3.1-flash-image-preview)'] },
  { name:'body_resolution',  label:'Resolución',      group:'Calidad cuerpo', options:['512px','1K','2K','4K'] },
]

const IMAGE_SLOTS = [
  { id:'eyes',      label:'Ojos' },
  { id:'eyebrows',  label:'Cejas' },
  { id:'nose',      label:'Nariz' },
  { id:'lips',      label:'Labios' },
  { id:'forehead',  label:'Frente' },
  { id:'jawline',   label:'Mentón/Mandíbula' },
  { id:'hairline',  label:'Cabello' },
  { id:'skin',      label:'Piel' },
  { id:'full_face', label:'Rostro Completo' },
]

// Opciones del select "Tipo de foto" (copiadas verbatim desde server-ui.html).
// El primer campo `selected:true` marca el default preseleccionado de la UI.
const PHOTO_TYPES = [
  { value:'-- Not selected / System inferred --', label:'-- No seleccionado / Sistema infiere --' },
  { value:'Studio white background', label:'Studio — fondo blanco' },
  { value:'Studio neutral grey background', label:'Studio — fondo gris neutro' },
  { value:'Studio black background', label:'Studio — fondo negro' },
  { value:'Natural light portrait', label:'Retrato luz natural' },
  { value:'Studio 2x2 portrait multi-view grid', label:'Studio 2×2 multi-view grid', selected:true },
  { value:'Studio character sheet 16:9 structured multi-view layout', label:'Character sheet 16:9 multi-view' },
  { value:'Studio 16:9 three-panel portrait triptych', label:'Tríptico 16:9 tres paneles' },
]

module.exports = {
  BODY_PARAM_OPTIONS,
  BODY_MODEL_OPTIONS,
  BODY_IMAGE_MODEL_OPTIONS,
  BODY_RESOLUTION_OPTIONS,
  BODY_PARAM_KEYS,
  AION_IMAGE_KEYS,
  AION_PARAMS,
  BODY_PARAMS,
  IMAGE_SLOTS,
  PHOTO_TYPES,
}
