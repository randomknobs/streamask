import * as THREE from 'three';
import { FaceLandmarker } from
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.12/vision_bundle.mjs';
import { R, RI, pick } from '../rng.js';
import { toWorld } from '../tracking.js';
import { CANONICAL_UV } from '../uv.js';
import { GLSL_SOURCE, pickPattern, pickContrastingPair } from '../texture/patterns.js';
import {
  GLSL_SOURCE as ZONES_GLSL_SOURCE, ZONE_COUNT, NOSE_UV,
  SCHEME_IDS, pickScheme
} from '../texture/zones.js';

// стек из 2–4 слоёв паттернов поверх базового градиента, каждый со своим
// паттерном/масштабом (из patterns.js), углом поворота UV и режимом
// смешивания. Слот всегда 4 (максимум диапазона), неиспользуемые слоты
// получают patternId=0 (pattern_plain даёт m≡0 — слой становится
// no-op вне зависимости от режима смешивания, отдельный "активен" не нужен).
const MAX_LAYERS = 4;
const BLEND_MODES = ['over','multiply','screen','mask','outline'];
// фиксированный "нейтральный" цвет для сброса неиспользуемых слотов (id=0
// значит pattern_plain, m≡0 — сам цвет уже не важен для рендера, но должен
// быть детерминированным, не оставшимся от предыдущей маски). .copy() при
// записи в uniform, поэтому один общий объект безопасен.
const NEUTRAL_ZONE_COLOR = new THREE.Color(1,1,1);

// ─── фаза 7: реакция на звук (см. setAudioReactivity) ──────────────────
// mid=1 (макс. после клампа в audio.js) -> скорость анимации паттернов
// утраивается; high=1 -> интенсивность контурных линий растёт в 2.5 раза.
// Оба коэффициента — множители к уже существующим t*spd/orn*0.7 членам
// шейдера, а не отдельная система — при audio выключенном (mid=high=0)
// визуально ничего не меняется (audioSpeedMul=1, contourBoost=1).
const AUDIO_SKIN_SPEED_K = 2.0;
const AUDIO_SKIN_CONTOUR_K = 1.5;

function buildTriangles(){
  const t = FaceLandmarker.FACE_LANDMARKS_TESSELATION;
  const idx = [];
  for (let i=0; i+2<t.length; i+=3) idx.push(t[i].start, t[i+1].start, t[i+2].start);
  return new Uint16Array(idx);
}

// FACE_LANDMARKS_FACE_OVAL — несвязный список рёбер {start,end}, не готовое
// кольцо (тот же случай, что и с контуром губ в mouth.js). Граф — простой
// цикл (у каждой вершины ровно 2 соседа, проверено в node), поэтому
// достаточно пройти по смежности от произвольной стартовой точки.
function orderRing(edges){
  const adj = new Map();
  for (const {start, end} of edges){
    if (!adj.has(start)) adj.set(start, []);
    if (!adj.has(end)) adj.set(end, []);
    adj.get(start).push(end);
    adj.get(end).push(start);
  }
  const startNode = edges[0].start;
  const ring = [startNode];
  let prev = -1, cur = startNode;
  while (true){
    const neighbors = adj.get(cur);
    const next = neighbors[0] === prev ? neighbors[1] : neighbors[0];
    if (next === startNode) break;
    ring.push(next);
    prev = cur; cur = next;
  }
  return ring;
}

const OVAL_RING = orderRing(FaceLandmarker.FACE_LANDMARKS_FACE_OVAL);
const OVAL_N = OVAL_RING.length; // 36
// Фиксировано (не из сида): число колец меняет размер буферов, а меш кожи
// живёт постоянно и не пересоздаётся между масками (см. комментарий ниже) —
// сид управляет только СИЛОЙ удлинения (genExtension), не топологией.
const RING_COUNT = 4;
const EXT_VERTEX_START = 468; // после исходных 468 лендмарков лица.
// Слоты 468-477 раньше просто копировали ирисы (468..477 из живых
// лендмарков) в буфер, но индексный буфер их никогда не использовал —
// тесселяция ссылается только на 0..467. Так что это место было мёртвым,
// теперь тут наши собственные вершины удлинения.
const EXT_VERTEX_COUNT = OVAL_N * RING_COUNT;
const TOTAL_VERTS = EXT_VERTEX_START + EXT_VERTEX_COUNT;

function extVertexIndex(ringIdx, i){ return EXT_VERTEX_START + ringIdx*OVAL_N + i; }

// Треугольники полосы между двумя кольцами одинаковой длины (a[i]..b[i]).
// Порядок вершин подобран так, чтобы нормаль смотрела наружу от центра лица
// (проверено в node — см. итоговое сообщение по фазе).
function stripIndices(idxOut, ringA, ringB, n){
  for (let i=0;i<n;i++){
    const a0 = ringA(i), a1 = ringA((i+1)%n);
    const b0 = ringB(i), b1 = ringB((i+1)%n);
    idxOut.push(a0, b0, a1);
    idxOut.push(a1, b0, b1);
  }
}

function buildFullIndices(){
  const idx = Array.from(buildTriangles());
  stripIndices(idx, i => OVAL_RING[i], i => extVertexIndex(0,i), OVAL_N);
  for (let r=0;r<RING_COUNT-1;r++){
    stripIndices(idx, i => extVertexIndex(r,i), i => extVertexIndex(r+1,i), OVAL_N);
  }
  return new Uint16Array(idx);
}

// меш «кожи» живёт всё время работы приложения — тесселяция и UV из живых
// лендмарков не пересоздаются между масками, реролл только перекрашивает
// материал (см. applyPalette). Так сохраняется поведение до рефакторинга.
export function create(ctx){
  const { scene } = ctx;

  const material = new THREE.ShaderMaterial({
    // кожа всегда полностью непрозрачна — честно перекрывает всё за собой
    // и пишет глубину, без отдельной ветки на порог непрозрачности.
    transparent:false, side:THREE.DoubleSide, depthWrite:true,
    extensions:{ derivatives:true }, // fwidth() — используется паттернами (АА краёв) и режимом outline
    uniforms:{ t:{value:0}, opacity:{value:1},
               audioSpeedMul:{value:1}, contourBoost:{value:1}, beatFlash:{value:0},
               cA:{value:new THREE.Color()}, cB:{value:new THREE.Color()},
               cC:{value:new THREE.Color()}, freq:{value:12}, warp:{value:1},
               bands:{value:0}, spd:{value:.3},
               layerId:{value:[0,0,0,0]},
               layerParams:{value:[new THREE.Vector4(),new THREE.Vector4(),new THREE.Vector4(),new THREE.Vector4()]},
               layerColor:{value:[new THREE.Color(),new THREE.Color(),new THREE.Color(),new THREE.Color()]},
               layerBlend:{value:[0,0,0,0]},
               layerAngle:{value:[0,0,0,0]},
               // 3c/3d: зоны лица — 9 стилевых слотов (по одному на зону,
               // см. zones.js), схема раскладки и обводка границ зон.
               scheme:{value:0}, bandCount:{value:4},
               zoneStyleId:{value:new Array(ZONE_COUNT).fill(0)},
               zoneStyleParams:{value:Array.from({length:ZONE_COUNT},()=>new THREE.Vector4())},
               zoneStyleColor:{value:Array.from({length:ZONE_COUNT},()=>new THREE.Color())},
               zoneStyleBlend:{value:new Array(ZONE_COUNT).fill(0)},
               zoneStyleAngle:{value:new Array(ZONE_COUNT).fill(0)},
               contourColor:{value:new THREE.Color()},
               noseUV:{value:new THREE.Vector2(NOSE_UV[0], NOSE_UV[1])} },
    vertexShader:`varying vec2 vU; varying vec3 vP;
      void main(){ vU=uv; vP=position;
        gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader:`precision highp float;
      uniform float t,freq,warp,bands,spd,opacity; uniform vec3 cA,cB,cC;
      uniform float audioSpeedMul, contourBoost, beatFlash;
      uniform int layerId[4]; uniform vec4 layerParams[4];
      uniform vec3 layerColor[4]; uniform int layerBlend[4]; uniform float layerAngle[4];
      uniform int scheme, bandCount;
      uniform int zoneStyleId[${ZONE_COUNT}]; uniform vec4 zoneStyleParams[${ZONE_COUNT}];
      uniform vec3 zoneStyleColor[${ZONE_COUNT}]; uniform int zoneStyleBlend[${ZONE_COUNT}];
      uniform float zoneStyleAngle[${ZONE_COUNT}];
      uniform vec3 contourColor; uniform vec2 noseUV;
      varying vec2 vU; varying vec3 vP;
      float h(vec2 p){return fract(sin(dot(p,vec2(41.3,289.1)))*43758.5453);}
      float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
        return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}

      ${GLSL_SOURCE}
      ${ZONES_GLSL_SOURCE}

      vec2 rotUV(vec2 uv, float ang){
        vec2 c=uv-0.5; float s=sin(ang), co=cos(ang);
        return vec2(c.x*co-c.y*s, c.x*s+c.y*co)+0.5;
      }

      void main(){
        vec2 p=vU*freq;
        // фаза 7: middle-полоса ускоряет анимацию паттернов — множитель на
        // spd везде, где spd управляет скоростью, а не на t напрямую (t —
        // общие часы маски, трогать их означало бы рассинхронизировать
        // кожу с рэту/осколками).
        float aspd = spd*audioSpeedMul;
        float w=n(p*.5+t*aspd)*warp;
        float v=sin(p.x+p.y*.6+w*3.0+t*aspd*2.0)*.5+.5;
        if(bands>.5) v=step(.5,v)*.85+v*.15;
        vec3 c=mix(cA,cB,v);
        c=mix(c,cC,smoothstep(.3,.9,n(p*.3-t*aspd*.5)));

        // Стек паттернов поверх базового градиента. mask/outline читают m
        // ПРЕДЫДУЩЕГО слоя (prevM) — «нижний прошёл порог» / «края нижнего»,
        // как в SPEC.md. Для первого слоя нижнего нет, prevM=1.0 (всегда
        // "прошёл порог", outline на пустом месте не даёт краёв).
        float prevM = 1.0;
        for (int i=0; i<4; i++){
          vec2 puv = rotUV(vU, layerAngle[i]);
          float m = patternById(layerId[i], puv, layerParams[i]);
          vec3 fg = layerColor[i];
          int mode = layerBlend[i];
          if (mode==1){ // multiply
            c = mix(c, c*fg, m);
          } else if (mode==2){ // screen
            vec3 scr = 1.0-(1.0-c)*(1.0-fg);
            c = mix(c, scr, m);
          } else if (mode==3){ // mask — слой виден только там, где нижний прошёл порог
            float gate = step(0.5, prevM);
            c = mix(c, fg, m*gate);
          } else if (mode==4){ // outline — только края нижнего слоя
            float e = smoothstep(0.0, 0.2, fwidth(prevM));
            c = mix(c, fg, e);
          } else { // over
            c = mix(c, fg, m);
          }
          prevM = m;
        }

        // 3c: региональная заливка по зонам лица/схеме раскладки.
        // zoneAndMargin — анатомическая зона (argmin эллиптических
        // расстояний, определён для любой точки — дыр в покрытии нет по
        // построению) и margin (разница двух ближайших расстояний, мал у
        // границы двух зон, велик в глубине зоны).
        float zMargin;
        int zone = zoneAndMargin(vU, zMargin);
        int region = regionId(vU, zone, scheme, bandCount);

        // radial-схема красит полярными координатами вокруг кончика носа
        // (расходящийся от носа узор), остальные схемы — обычным vU.
        vec2 fillUV = vU;
        if (scheme==4){
          vec2 rel = vU - noseUV;
          float ang = atan(rel.y, rel.x);
          float rad = length(rel);
          fillUV = vec2(ang/6.2831853+0.5, rad);
        }

        // Выбор стиля региона через loop+if по индексу (а не zoneStyle[region]
        // напрямую) — динамическая индексация uniform-массива произвольным
        // int ненадёжна на части WebGL1-драйверов, индексация по счётчику
        // ограниченного for — портируемый паттерн (как и в цикле layerId[i]
        // выше).
        vec3 zFg = vec3(0.0); int zId=0; vec4 zParams=vec4(0.0);
        int zBlend=0; float zAngle=0.0;
        for (int i=0;i<${ZONE_COUNT};i++){
          if (i==region){
            zFg=zoneStyleColor[i]; zId=zoneStyleId[i]; zParams=zoneStyleParams[i];
            zBlend=zoneStyleBlend[i]; zAngle=zoneStyleAngle[i];
          }
        }

        vec2 zpuv = rotUV(fillUV, zAngle);
        float zm = patternById(zId, zpuv, zParams);
        // Те же пять режимов, что и в глобальном стеке. mask/outline тут
        // читают prevM — хвост последнего слоя глобального стека (i=3):
        // дешёвая, не идеальная, но осмысленная привязка вместо ввода ещё
        // одного набора uniform только под эти два режима зон.
        if (zBlend==1){ c = mix(c, c*zFg, zm); }
        else if (zBlend==2){ vec3 zscr=1.0-(1.0-c)*(1.0-zFg); c=mix(c,zscr,zm); }
        else if (zBlend==3){ float gate=step(0.5,prevM); c=mix(c,zFg,zm*gate); }
        else if (zBlend==4){ float ze=smoothstep(0.0,0.2,fwidth(prevM)); c=mix(c,zFg,ze); }
        else { c = mix(c, zFg, zm); }

        // 3d: орнамент — тонкий контур по краю СВОЕЙ ЖЕ маски zm (реюз уже
        // посчитанного паттерна региона вместо отдельного набора uniform под
        // "орнамент"), поверх заливки, цветом контура.
        float orn = smoothstep(0.0, 0.35, fwidth(zm)*3.0);
        c = mix(c, contourColor, min(1.0, orn*0.7*contourBoost));

        // 3d: обводка анатомических границ зон. margin непрерывна (в
        // отличие от zoneId — целочисленного, у него fwidth ненулевой
        // только в одном пикселе-кварте на самой границе), поэтому её
        // экранная производная даёт устойчивую, не зависящую от разрешения
        // толщину линии — стандартный приём для hairline-контуров.
        float zEdgePx = fwidth(zMargin) * 2.5;
        float zEdge = 1.0 - smoothstep(0.0, max(zEdgePx,1e-5), zMargin);
        c = mix(c, contourColor, min(1.0, zEdge*contourBoost));

        // фаза 7: кратковременная (100мс, см. main.js beatFlashUntil)
        // инверсия всей заливки на удар низких частот — универсальная
        // альтернатива повороту hue матрицей (не завязана на конкретную
        // схему зон вроде checker) и не требует HSL-конверсии в шейдере.
        c = mix(c, vec3(1.0)-c, beatFlash);

        gl_FragColor=vec4(c,opacity);
      }`
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TOTAL_VERTS*3),3));
  const uvAttr = new THREE.BufferAttribute(new Float32Array(TOTAL_VERTS*2),2);
  // UV лица (0..467) — статичные, из канонической модели, проставляются один
  // раз. Живые лендмарки для UV не используются: они плывут при повороте
  // головы, и любой регулярный паттерн на коже поехал бы вместе с ними.
  uvAttr.array.set(CANONICAL_UV, 0);
  geometry.setAttribute('uv', uvAttr);
  geometry.setIndex(new THREE.BufferAttribute(buildFullIndices(),1));

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  scene.add(mesh);

  const v = new THREE.Vector3();

  // extension/widthExtension — та же логика: genExtension/genWidthExtension
  // из сида действуют только до первого касания соответствующего слайдера,
  // дальше слайдер — абсолютное значение, реролл его не переопределяет.
  // Независимость друг от друга (вертикаль только от ext, латераль только
  // от wext) не меняется — см. applyExtension.
  let genExtension = 0, extensionOverride = null;
  let genWidthExtension = 0, widthExtensionOverride = null;

  // рабочие векторы для расширения — переиспользуются каждый кадр, без
  // аллокаций в цикле по 36×4 вершинам.
  const tmpEyeR = new THREE.Vector3(), tmpEyeL = new THREE.Vector3();
  const tmpFore = new THREE.Vector3(), tmpChin = new THREE.Vector3();
  const ax = new THREE.Vector3(), ay = new THREE.Vector3(), az = new THREE.Vector3();
  // ax не гарантированно ортогонален ay (оба берутся из независимых пар
  // лендмарков) — axOrtho переортогонализует латеральную ось через
  // cross(ay,az) так, чтобы {axOrtho, ay, az} был точным ортонормированным
  // базисом. Без этого разложение offset на три оси теряет часть длины в
  // остатке и вертикаль/латераль/глубина перестают быть независимыми.
  const axOrtho = new THREE.Vector3();
  const centroid = new THREE.Vector3(), ovalPos = new THREE.Vector3(), offset = new THREE.Vector3();
  const vertVec = new THREE.Vector3(), lateralVec = new THREE.Vector3(), depthVec = new THREE.Vector3();
  const newPos = new THREE.Vector3();
  const uvCentroid = { x:0, y:0 };

  // Рост неравномерный по кольцу: сильно вверх (лоб/виски), почти не растём
  // у подбородка. verticality — проекция офсета от центроида на ay (-1
  // подбородок, +1 макушка/виски), по бокам она естественно ~0 — средний
  // рост получается сам, без отдельного случая.
  const GROWTH_CHIN = .1, GROWTH_TOP = 1.1;
  const OUT_SCALE = .9, BACK_SCALE = .55;
  // Латеральный рост (ширина) зависит ТОЛЬКО от wext, никогда от ext — иначе
  // слайдер удлинения снова начал бы раздувать лицо вбок, как до фикса.
  // На wext=1 самое дальнее кольцо расширяется на 70% от исходного офсета —
  // калибровка на глаз (лендмарков ушей MediaPipe не даёт), докручивается
  // пользователем через слайдер.
  const WIDTH_LATERAL_SCALE = .7;
  // Уши торчат вбок И вперёд относительно линии скул — плоское расширение
  // пройдёт перед ними. WIDTH_BACK_SCALE толкает вбок растущие точки назад
  // по -az пропорционально их "латеральности" (offset.dot(axOrtho)/offLen):
  // у носа/подбородка/лба латеральность ~0 и заворота почти нет, у скул/
  // висков — максимальная, там и нужно обогнуть ухо.
  const WIDTH_BACK_SCALE = .9;
  // "назад" = -az. az строится тем же cross(ax,ay), что и анкер в tracking.js,
  // и там +Z (тот же az) — направление "к камере" (осколки летят на +pz,
  // это подтверждённое рабочее поведение). Значит "обратно, вокруг черепа,
  // от камеры" — это -az.
  const BACKWARD_SIGN = -1;

  function applyExtension(landmarks, aspect){
    const pos = geometry.attributes.position.array;
    const uv  = geometry.attributes.uv.array;
    const ext = extensionOverride !== null ? extensionOverride : genExtension;
    const wext = widthExtensionOverride !== null ? widthExtensionOverride : genWidthExtension;

    toWorld(landmarks[33], aspect, tmpEyeR);
    toWorld(landmarks[263], aspect, tmpEyeL);
    toWorld(landmarks[10], aspect, tmpFore);
    toWorld(landmarks[152], aspect, tmpChin);
    ax.copy(tmpEyeL).sub(tmpEyeR).normalize();
    ay.copy(tmpFore).sub(tmpChin).normalize();
    az.crossVectors(ax, ay).normalize();
    axOrtho.crossVectors(ay, az).normalize();

    centroid.set(0,0,0);
    for (const oi of OVAL_RING) centroid.set(centroid.x+pos[oi*3], centroid.y+pos[oi*3+1], centroid.z+pos[oi*3+2]);
    centroid.multiplyScalar(1/OVAL_N);

    uvCentroid.x = 0; uvCentroid.y = 0;
    for (const oi of OVAL_RING){ uvCentroid.x += uv[oi*2]; uvCentroid.y += uv[oi*2+1]; }
    uvCentroid.x /= OVAL_N; uvCentroid.y /= OVAL_N;

    for (let i=0;i<OVAL_N;i++){
      const oi = OVAL_RING[i];
      ovalPos.set(pos[oi*3], pos[oi*3+1], pos[oi*3+2]);
      offset.subVectors(ovalPos, centroid);

      const offLen = offset.length();
      const vertScalar = offset.dot(ay);
      const lateralScalar = offset.dot(axOrtho);
      const depthScalar = offset.dot(az);
      vertVec.copy(ay).multiplyScalar(vertScalar);
      lateralVec.copy(axOrtho).multiplyScalar(lateralScalar);
      depthVec.copy(az).multiplyScalar(depthScalar);

      const vert = offLen > 1e-6 ? vertScalar/offLen : 0;    // -1 подбородок .. +1 макушка/виски
      const lateral = offLen > 1e-6 ? lateralScalar/offLen : 0; // -1..+1, максимум по модулю у скул/висков
      const t = (vert+1)/2;
      const growth = THREE.MathUtils.lerp(GROWTH_CHIN, GROWTH_TOP, t);

      const ou = uv[oi*2] - uvCentroid.x, ov = uv[oi*2+1] - uvCentroid.y;

      for (let r=0;r<RING_COUNT;r++){
        const k = (r+1)/RING_COUNT;
        const vertGrowthAmt = ext*growth*k*OUT_SCALE;
        const backAmt = ext*growth*k*BACK_SCALE*BACKWARD_SIGN;
        const lateralMult = 1 + WIDTH_LATERAL_SCALE*wext*k;
        const widthBackAmt = wext*Math.abs(lateral)*k*WIDTH_BACK_SCALE*BACKWARD_SIGN;

        newPos.copy(centroid)
          .addScaledVector(vertVec, 1+vertGrowthAmt)
          .addScaledVector(lateralVec, lateralMult)
          .add(depthVec)
          .addScaledVector(az, backAmt+widthBackAmt);

        const vi = extVertexIndex(r, i);
        pos[vi*3]=newPos.x; pos[vi*3+1]=newPos.y; pos[vi*3+2]=newPos.z;
        // UV не кодирует глубину — горизонталь тянется тем же lateralMult,
        // что и 3D-латераль, вертикаль тем же vertGrowthAmt, что и 3D-ay.
        uv[vi*2] = uvCentroid.x + ou*lateralMult;
        uv[vi*2+1] = uvCentroid.y + ov*(1+vertGrowthAmt);
      }
    }
  }

  // Общий для 3b (глобальный стек) и 3c (стили зон) розыгрыш одного
  // "стиля": паттерн из patterns.js + гарантированно контрастный цвет +
  // случайные угол/режим смешивания.
  function drawStyle(rngLike, cols){
    const patternInfo = pickPattern(rngLike, {});
    const { fg } = pickContrastingPair(rngLike, cols, .2);
    return { id: patternInfo.id, params: patternInfo.params, color: fg,
             blend: RI(BLEND_MODES.length), angle: R(Math.PI*2,0) };
  }
  function setZoneSlot(i, style){
    material.uniforms.zoneStyleId.value[i] = style.id;
    material.uniforms.zoneStyleParams.value[i].set(...style.params);
    material.uniforms.zoneStyleColor.value[i].copy(style.color);
    material.uniforms.zoneStyleBlend.value[i] = style.blend;
    material.uniforms.zoneStyleAngle.value[i] = style.angle;
  }

  const api = {
    object3D: mesh,
    zoneScheme: null, // имя схемы зон (mirror/split/...) — обновляется в applyPalette, для панели (фаза 4)

    applyPalette(cols){
      material.uniforms.cA.value.copy(cols[0]);
      material.uniforms.cB.value.copy(cols[1] || cols[0]);
      material.uniforms.cC.value.copy(cols[2] || cols[0]);
      material.uniforms.freq.value = R(28,4);
      material.uniforms.warp.value = R(3,0);
      material.uniforms.bands.value = R()<.45 ? 1 : 0;
      material.uniforms.spd.value = R(.8,.05);
      genExtension = R(1,0);
      genWidthExtension = R(1,0);

      const rngLike = { R, RI, pick };
      const numLayers = RI(5,2); // 2..4 включительно
      for (let i=0;i<MAX_LAYERS;i++){
        if (i < numLayers){
          const style = drawStyle(rngLike, cols);
          material.uniforms.layerId.value[i] = style.id;
          material.uniforms.layerParams.value[i].set(...style.params);
          material.uniforms.layerColor.value[i].copy(style.color);
          material.uniforms.layerBlend.value[i] = style.blend;
          material.uniforms.layerAngle.value[i] = style.angle;
        } else {
          // pattern_plain даёт m≡0 — слот полностью no-op для рендера, но
          // uniform'ы материала переживают между масками (skin создаётся
          // один раз, applyPalette дальше только перезаписывает поля) —
          // не обнулить их значило бы оставить цвет/параметры от ПРЕДЫДУЩЕЙ
          // маски висеть в состоянии до следующего касания этого слота.
          // Невидимо на рендере (см. выше), но рекол должен воспроизводить
          // маску по состоянию, а не только по картинке — обнуляем всё.
          material.uniforms.layerId.value[i] = 0;
          material.uniforms.layerParams.value[i].set(0,0,0,0);
          material.uniforms.layerColor.value[i].set(1,1,1);
          material.uniforms.layerBlend.value[i] = 0;
          material.uniforms.layerAngle.value[i] = 0;
        }
      }

      // 3c: зоны лица — схема раскладки из сида, стили зон по схеме.
      const scheme = pickScheme(rngLike);
      material.uniforms.scheme.value = SCHEME_IDS[scheme];
      api.zoneScheme = scheme;

      const bandCount = scheme === 'bands' ? RI(6,3) : 4; // 3..5 для bands
      material.uniforms.bandCount.value = bandCount;

      // 3d: цвет контура — крайняя точка палитры по светлоте (тёмная или
      // светлая, пополам из сида).
      {
        const hsl = { h:0, s:0, l:0 };
        let darkest = cols[0], lightest = cols[0], minL = Infinity, maxL = -Infinity;
        for (const c of cols){
          c.getHSL(hsl);
          if (hsl.l < minL){ minL = hsl.l; darkest = c; }
          if (hsl.l > maxL){ maxL = hsl.l; lightest = c; }
        }
        material.uniforms.contourColor.value.copy(pick([darkest, lightest]));
      }

      // Схемы split/bands/radial заполняют не все 9 слотов (regionId для
      // них игнорирует zoneId и физически не может выбрать "лишний" слот —
      // невидимо на рендере), но uniform'ы материала переживают между
      // масками (skin создаётся один раз) — не сбросить их значило бы
      // оставить стиль зоны от ПРЕДЫДУЩЕЙ маски висеть немым, но реальным
      // состоянием до следующего касания слота. Обнуляем ВСЕ 9 заранее
      // фиксированным нейтральным стилем, не тратя на это rng, дальше
      // switch ниже перезаписывает только те слоты, что реально использует.
      for (let i=0;i<ZONE_COUNT;i++){
        setZoneSlot(i, { id:0, params:[0,0,0,0], color:NEUTRAL_ZONE_COLOR, blend:0, angle:0 });
      }

      switch (scheme){
        case 'patchwork': {
          // каждая зона независима
          for (let i=0;i<ZONE_COUNT;i++) setZoneSlot(i, drawStyle(rngLike, cols));
          break;
        }
        case 'mirror': {
          // левая/правая половина одинаковые: eyeBandLeft копирует
          // eyeBandRight, cheekLeft копирует cheekRight, остальные зоны
          // (без пары) — независимы.
          const forehead = drawStyle(rngLike, cols);
          const eyeBandRight = drawStyle(rngLike, cols);
          const noseBridge = drawStyle(rngLike, cols);
          const cheekRight = drawStyle(rngLike, cols);
          const mouthArea = drawStyle(rngLike, cols);
          const chin = drawStyle(rngLike, cols);
          const jawline = drawStyle(rngLike, cols);
          setZoneSlot(0, forehead);
          setZoneSlot(1, eyeBandRight); setZoneSlot(2, eyeBandRight);
          setZoneSlot(3, noseBridge);
          setZoneSlot(4, cheekRight); setZoneSlot(5, cheekRight);
          setZoneSlot(6, mouthArea);
          setZoneSlot(7, chin);
          setZoneSlot(8, jawline);
          break;
        }
        case 'maskEyes': {
          // акцентная полоса через глаза, остальное однотонное (один и тот
          // же стиль во всех незонах-глазах).
          const rest = drawStyle(rngLike, cols);
          const accent = drawStyle(rngLike, cols);
          for (let i=0;i<ZONE_COUNT;i++) setZoneSlot(i, rest);
          setZoneSlot(1, accent); setZoneSlot(2, accent); // eyeBandRight/Left
          break;
        }
        case 'split': {
          // режется по X насквозь (regionId игнорирует zoneId) — слоты 0/1
          // соответствуют region 0 (uv.x<0.5) / region 1.
          setZoneSlot(0, drawStyle(rngLike, cols));
          setZoneSlot(1, drawStyle(rngLike, cols));
          break;
        }
        case 'bands': {
          // горизонтальные полосы по V (regionId игнорирует zoneId) —
          // слоты 0..bandCount-1 соответствуют полосам снизу вверх.
          for (let i=0;i<bandCount;i++) setZoneSlot(i, drawStyle(rngLike, cols));
          break;
        }
        case 'radial': {
          // единый стиль, расходится от кончика носа полярными координатами
          // (regionId всегда 0) — слот 0.
          setZoneSlot(0, drawStyle(rngLike, cols));
          break;
        }
      }
    },

    setExtensionOverride(v){ extensionOverride = v; },
    setWidthExtensionOverride(v){ widthExtensionOverride = v; },

    updateGeometry(landmarks, aspect){
      const pos = geometry.attributes.position.array;
      for (let i=0;i<468;i++){
        toWorld(landmarks[i], aspect, v);
        pos[i*3]=v.x; pos[i*3+1]=v.y; pos[i*3+2]=v.z + .002;
      }
      applyExtension(landmarks, aspect);
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.uv.needsUpdate = true;
      geometry.computeVertexNormals();
    },

    setTime(t){ material.uniforms.t.value = t; },

    // кожа всегда transparent:false/depthWrite:true (см. создание материала
    // выше) — честно перекрывает и пишет глубину, пока полностью видна.
    // Единственное исключение — окно затухания при потере трекинга лица
    // (main.js): на время v<1 временно включаем transparent и выключаем
    // depthWrite, а по возврату к v===1 возвращаем оба флага как есть.
    setOpacity(v){
      material.uniforms.opacity.value = v;
      const fading = v < 1;
      material.transparent = fading;
      material.depthWrite = !fading;
    },

    // фаза 7: mid ускоряет анимацию паттернов, high усиливает контурные
    // линии, beatFlash (0..1) — окно кратковременной инверсии на удар
    // низких (main.js держит его открытым 100мс и сам считает затухание).
    // Все три — независимые визуальные каналы полос, без общего состояния.
    setAudioReactivity({ mid = 0, high = 0, beatFlash = 0 } = {}){
      material.uniforms.audioSpeedMul.value = 1 + mid*AUDIO_SKIN_SPEED_K;
      material.uniforms.contourBoost.value = 1 + high*AUDIO_SKIN_CONTOUR_K;
      material.uniforms.beatFlash.value = beatFlash;
    },

    dispose(){ geometry.dispose(); material.dispose(); scene.remove(mesh); }
  };
  return api;
}
