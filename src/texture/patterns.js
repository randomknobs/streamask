import * as THREE from 'three';

// Общий модуль генеративных паттернов. Contract:
//   GLSL_SOURCE   — строка с набором `float pattern_NAME(vec2 uv, vec4 p)`
//                   (каждая возвращает 0..1 — доля цвета переднего плана)
//                   плюс диспетчер `float patternById(int id, vec2 uv, vec4 p)`
//   PATTERN_IDS   — { name: int } — те же id, что использует диспетчер в GLSL
//   pickPattern(rng, opts) — JS-подбор паттерна и параметров из rng
//   pickContrastingPair(rng, cols, minDiff) — подбор пары цветов с гарантией контраста
//
// Используется crown.js (фаза 8b), дальше будет использован skin.js (фаза 3) —
// поэтому здесь нет ничего специфичного для головных уборов.

export const GLSL_SOURCE = `
float ptn_hash21(vec2 p){ return fract(sin(dot(p, vec2(41.3,289.1)))*43758.5453); }
float ptn_noise2(vec2 p){
  vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(ptn_hash21(i),ptn_hash21(i+vec2(1,0)),f.x),
             mix(ptn_hash21(i+vec2(0,1)),ptn_hash21(i+vec2(1,1)),f.x), f.y);
}

float pattern_plain(vec2 uv, vec4 p){ return 0.0; }

float pattern_zebra(vec2 uv, vec4 p){
  float scale = p.x, warp = p.y;
  float x = uv.x*scale + ptn_noise2(uv*scale*2.0)*warp;
  float v = fract(x);
  float w = fwidth(v)*1.5 + 1e-4;
  return smoothstep(0.5-w, 0.5+w, v);
}

float pattern_leopard(vec2 uv, vec4 p){
  float scale = p.x;
  vec2 q = uv*scale;
  vec2 c = floor(q), f = fract(q);
  float minD = 10.0;
  vec2 nearCell = c;
  for(int oy=-1; oy<=1; oy++){
    for(int ox=-1; ox<=1; ox++){
      vec2 cell = c + vec2(float(ox), float(oy));
      vec2 jitter = vec2(ptn_hash21(cell), ptn_hash21(cell+7.3));
      vec2 point = vec2(float(ox), float(oy)) + jitter - f;
      float d = length(point);
      if(d < minD){ minD = d; nearCell = cell; }
    }
  }
  float spotR = 0.22 + ptn_hash21(nearCell)*0.14;
  float w = fwidth(minD)*1.5 + 1e-4;
  return 1.0 - smoothstep(spotR-w, spotR+w, minD);
}

float pattern_giraffe(vec2 uv, vec4 p){
  float scale = p.x, gap = p.y;
  vec2 q = uv*scale;
  vec2 c = floor(q), f = fract(q);
  float minD = 10.0, secondD = 10.0;
  for(int oy=-1; oy<=1; oy++){
    for(int ox=-1; ox<=1; ox++){
      vec2 cell = c + vec2(float(ox), float(oy));
      vec2 jitter = vec2(ptn_hash21(cell), ptn_hash21(cell+3.1));
      vec2 point = vec2(float(ox), float(oy)) + jitter - f;
      float d = length(point);
      if(d < minD){ secondD = minD; minD = d; } else if(d < secondD){ secondD = d; }
    }
  }
  float edge = secondD - minD;
  float w = fwidth(edge)*1.5 + 1e-4;
  return smoothstep(gap-w, gap+w, edge);
}

float pattern_waffle(vec2 uv, vec4 p){
  float scale = p.x;
  vec2 q = fract(uv*scale)-0.5;
  float edge = max(abs(q.x), abs(q.y));
  float w = fwidth(edge)*1.5 + 1e-4;
  return 1.0 - smoothstep(0.40-w, 0.40+w, edge);
}

float pattern_checker(vec2 uv, vec4 p){
  float scale = p.x;
  vec2 c = floor(uv*scale);
  return mod(c.x+c.y, 2.0);
}

float pattern_stripes(vec2 uv, vec4 p){
  float scale = p.x, angle = p.y;
  float s = sin(angle), co = cos(angle);
  float x = uv.x*co - uv.y*s;
  float v = fract(x*scale);
  float w = fwidth(v)*1.5 + 1e-4;
  return smoothstep(0.5-w, 0.5+w, v);
}

float pattern_dots(vec2 uv, vec4 p){
  float scale = p.x;
  vec2 q = fract(uv*scale)-0.5;
  float d = length(q);
  float w = fwidth(d)*1.5 + 1e-4;
  return 1.0 - smoothstep(0.3-w, 0.3+w, d);
}

float pattern_speckle(vec2 uv, vec4 p){
  float scale = p.x;
  float n = ptn_hash21(floor(uv*scale));
  return step(0.7, n);
}

float pattern_bands(vec2 uv, vec4 p){
  float scale = p.x;
  return mod(floor(uv.y*scale), 2.0);
}

float patternById(int id, vec2 uv, vec4 p){
  if(id==1) return pattern_zebra(uv,p);
  if(id==2) return pattern_leopard(uv,p);
  if(id==3) return pattern_giraffe(uv,p);
  if(id==4) return pattern_waffle(uv,p);
  if(id==5) return pattern_checker(uv,p);
  if(id==6) return pattern_stripes(uv,p);
  if(id==7) return pattern_dots(uv,p);
  if(id==8) return pattern_speckle(uv,p);
  if(id==9) return pattern_bands(uv,p);
  return pattern_plain(uv,p);
}
`;

export const PATTERN_IDS = {
  plain:0, zebra:1, leopard:2, giraffe:3, waffle:4,
  checker:5, stripes:6, dots:7, speckle:8, bands:9
};

// крупномасштабные — безопасны на гранёных/сегментированных формах, мелкие
// там превращаются в кашу (см. crown.js, "Соответствие").
export const LARGE_SCALE_PATTERNS = ['plain', 'bands', 'checker'];

function paramsFor(name, rng){
  switch(name){
    case 'zebra':    return [rng.R(10,4), rng.R(.5,.1), 0, 0];   // scale, warp
    case 'leopard':  return [rng.R(9,4), 0, 0, 0];               // scale
    case 'giraffe':  return [rng.R(8,3), rng.R(.35,.12), 0, 0];  // scale, gap
    case 'waffle':   return [rng.R(10,4), 0, 0, 0];              // scale
    case 'checker':  return [rng.R(24,4), 0, 0, 0];              // scale
    case 'stripes':  return [rng.R(14,4), rng.R(Math.PI,0), 0, 0]; // scale, angle
    case 'dots':     return [rng.R(12,4), 0, 0, 0];              // scale
    case 'speckle':  return [rng.R(40,15), 0, 0, 0];             // scale
    case 'bands':    return [rng.R(8,3), 0, 0, 0];               // scale
    default:         return [0, 0, 0, 0];                        // plain
  }
}

// rng: { R, RI, pick } — общий или независимый поток, вызывающий код решает.
export function pickPattern(rng, { largeScaleOnly = false } = {}){
  const pool = largeScaleOnly
    ? Object.keys(PATTERN_IDS).filter(n => LARGE_SCALE_PATTERNS.includes(n))
    : Object.keys(PATTERN_IDS);
  const name = rng.pick(pool);
  return { name, id: PATTERN_IDS[name], params: paramsFor(name, rng) };
}

// Гарантированный контраст по светлоте между фоном и узором. Случайные
// попытки (до maxTries) дают вариативность между масками, но с этой
// палитрой (offs.map(...l*R(1.15,.8)) в palette.js держит все цвета близко
// по светлоте к общей базе) почти никогда не проходят порог сами по себе —
// проверено в node на 1000 масок, 0 честно доходили до 0.25 случайным
// перебором. Поэтому после исчерпания попыток — не "берём что есть", а
// гарантированно лучшая пара из всей палитры (полный перебор, палитра
// маленькая — 4-5 цветов, дёшево).
// tries>1 в возврате значит потребовался переподбор — используется в проверке.
export function pickContrastingPair(rng, cols, minDiff = 0.25, maxTries = 8){
  const hsl = {h:0,s:0,l:0};
  const lightness = c => { c.getHSL(hsl); return hsl.l; };

  let bg, fg, tries = 0;
  do {
    bg = rng.pick(cols);
    fg = rng.pick(cols);
    tries++;
  } while (tries < maxTries && Math.abs(lightness(bg) - lightness(fg)) < minDiff);

  if (Math.abs(lightness(bg) - lightness(fg)) < minDiff){
    let bestDiff = -1;
    for (let i=0;i<cols.length;i++){
      for (let j=0;j<cols.length;j++){
        if (i===j) continue;
        const d = Math.abs(lightness(cols[i]) - lightness(cols[j]));
        if (d > bestDiff){ bestDiff = d; bg = cols[i]; fg = cols[j]; }
      }
    }
  }

  return { bg, fg, tries };
}
