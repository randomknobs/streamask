import { CANONICAL_UV } from '../uv.js';

// Зоны лица — аналитические эллипсы в UV-пространстве кожи (статичные
// канонические UV, см. uv.js), не текстура-маска: дешевле и, per SPEC.md,
// достаточно для карнавальной стилизации, не для анатомической точности.
//
// zoneId(uv) = «ближайшая» зона по нормированному эллиптическому расстоянию
// (анизотропный Voronoi: (uv-center)/radii, длина). Это определено для ЛЮБОЙ
// точки плоскости — дыр в покрытии быть не может по построению, argmin
// всегда возвращает валидный индекс. jawline — не эллипс с центром, а кольцо
// (расстояние до идеальной дуги вокруг лица), участвует в том же argmin как
// ещё один «центр» с собственной метрикой расстояния.

export const ZONE_NAMES = [
  'forehead', 'eyeBandRight', 'eyeBandLeft', 'noseBridge',
  'cheekRight', 'cheekLeft', 'mouthArea', 'chin', 'jawline'
];
export const ZONE_IDS = Object.fromEntries(ZONE_NAMES.map((n, i) => [n, i]));
export const ZONE_COUNT = ZONE_NAMES.length;

// Калибровка на глаз по фактическим UV канонической модели (см. uv.js):
// нос idx1≈(.500,.453), лоб idx10≈(.500,.893), подбородок idx152≈(.500,.046),
// правый угол глаза idx33≈(.280,.624), левый idx263≈(.720,.624). "Правый"/
// "левый" — по имени лендмарка (33=R,263=L), та же конвенция, что и в
// skin.js/tracking.js (tmpEyeR/tmpEyeL), не про итоговое селфи-зеркалирование.
export const ZONE_ELLIPSES = [
  [0.50, 0.80, 0.30, 0.14], // forehead
  [0.28, 0.62, 0.15, 0.09], // eyeBandRight
  [0.72, 0.62, 0.15, 0.09], // eyeBandLeft
  [0.50, 0.58, 0.08, 0.20], // noseBridge
  [0.26, 0.40, 0.16, 0.15], // cheekRight
  [0.74, 0.40, 0.16, 0.15], // cheekLeft
  [0.50, 0.27, 0.15, 0.12], // mouthArea
  [0.50, 0.10, 0.13, 0.09], // chin
];
export const FACE_CENTER = [0.50, 0.47];
export const FACE_RADII = [0.49, 0.45];
export const JAW_RADIUS = 0.86;    // доля FACE_RADII, где проходит кольцо "контур челюсти"
export const JAW_HALFWIDTH = 0.22; // полуширина кольца в тех же нормированных единицах

export const NOSE_UV = [CANONICAL_UV[1 * 2], CANONICAL_UV[1 * 2 + 1]];

function ellipseDist(u, v, cx, cy, rx, ry) {
  const dx = (u - cx) / rx, dy = (v - cy) / ry;
  return Math.sqrt(dx * dx + dy * dy);
}
function faceDist(u, v) {
  return ellipseDist(u, v, FACE_CENTER[0], FACE_CENTER[1], FACE_RADII[0], FACE_RADII[1]);
}
function jawDist(u, v) {
  return Math.abs(faceDist(u, v) - JAW_RADIUS) / JAW_HALFWIDTH;
}

// JS-порт zoneId — используется в node-верификации, должен считать
// БИТ-В-БИТ ту же формулу, что и GLSL_SOURCE ниже (сгенерирован из тех же
// констант ZONE_ELLIPSES/FACE_CENTER/... — один источник правды).
export function zoneMarginJS(u, v) {
  let d0 = Infinity, d1 = Infinity, best = -1;
  for (let i = 0; i < ZONE_ELLIPSES.length; i++) {
    const [cx, cy, rx, ry] = ZONE_ELLIPSES[i];
    const d = ellipseDist(u, v, cx, cy, rx, ry);
    if (d < d0) { d1 = d0; d0 = d; best = i; } else if (d < d1) { d1 = d; }
  }
  const dJaw = jawDist(u, v);
  if (dJaw < d0) { d1 = d0; d0 = dJaw; best = ZONE_IDS.jawline; } else if (dJaw < d1) { d1 = dJaw; }
  return { zone: best, margin: d1 - d0 };
}
export function zoneIdJS(u, v) { return zoneMarginJS(u, v).zone; }

// Развёрнутая цепочка if вместо массива с константным инициализатором —
// GLSL ES 1.00 (WebGL1, дефолт для THREE.ShaderMaterial без glslVersion)
// не поддерживает конструкторы вида vec4[8](...). Дальше по той же причине
// (портируемость на WebGL1 без динамической индексации uniform-массивов)
// выбор стиля зоны в skin.js сделан через loop+if, а не zoneStyle[region].
function glslZoneChecks(varName) {
  return ZONE_ELLIPSES.map(([cx, cy, rx, ry], i) => `
  d = ellipseDist(uv, vec2(${cx.toFixed(4)},${cy.toFixed(4)}), vec2(${rx.toFixed(4)},${ry.toFixed(4)}));
  if(d<d0){ d1=d0; d0=d; ${varName}=${i}; } else if(d<d1){ d1=d; }`).join('');
}

export const GLSL_SOURCE = `
float ellipseDist(vec2 uv, vec2 c, vec2 r){
  vec2 d = (uv-c)/r;
  return length(d);
}

int zoneAndMargin(vec2 uv, out float margin){
  float d0 = 1e9, d1 = 1e9; int best = 0; float d;
  ${glslZoneChecks('best')}
  float faceD = ellipseDist(uv, vec2(${FACE_CENTER[0].toFixed(4)},${FACE_CENTER[1].toFixed(4)}), vec2(${FACE_RADII[0].toFixed(4)},${FACE_RADII[1].toFixed(4)}));
  d = abs(faceD - ${JAW_RADIUS.toFixed(4)})/${JAW_HALFWIDTH.toFixed(4)};
  if(d<d0){ d1=d0; d0=d; best=${ZONE_IDS.jawline}; } else if(d<d1){ d1=d; }
  margin = d1-d0;
  return best;
}

int regionId(vec2 uv, int zone, int scheme, int bandCount){
  if (scheme==1){ // split — режется по X насквозь, зоны игнорируются
    return uv.x < 0.5 ? 0 : 1;
  }
  if (scheme==2){ // bands — горизонтальные полосы по V, зоны игнорируются
    int b = int(clamp(uv.y,0.0,0.999)*float(bandCount));
    if (b<0) b=0; if (b>=bandCount) b=bandCount-1;
    return b;
  }
  if (scheme==4){ // radial — единый стиль, расходится от носа (см. main())
    return 0;
  }
  return zone; // mirror(0), maskEyes(3), patchwork(5) — JS уже развёл стили по слотам
}
`;

export const SCHEME_NAMES = ['mirror', 'split', 'bands', 'maskEyes', 'radial', 'patchwork'];
export const SCHEME_IDS = Object.fromEntries(SCHEME_NAMES.map((n, i) => [n, i]));

export function pickScheme(rng) { return rng.pick(SCHEME_NAMES); }
