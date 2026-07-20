import * as THREE from 'three';
import { FaceLandmarker } from
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.12/vision_bundle.mjs';
import { R } from '../rng.js';
import { toWorld } from '../tracking.js';

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
    transparent:true, side:THREE.DoubleSide, depthWrite:false,
    uniforms:{ t:{value:0}, cA:{value:new THREE.Color()}, cB:{value:new THREE.Color()},
               cC:{value:new THREE.Color()}, freq:{value:12}, warp:{value:1},
               bands:{value:0}, spd:{value:.3}, op:{value:.9} },
    vertexShader:`varying vec2 vU; varying vec3 vP;
      void main(){ vU=uv; vP=position;
        gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader:`precision highp float;
      uniform float t,freq,warp,bands,spd,op; uniform vec3 cA,cB,cC;
      varying vec2 vU; varying vec3 vP;
      float h(vec2 p){return fract(sin(dot(p,vec2(41.3,289.1)))*43758.5453);}
      float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
        return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
      void main(){
        vec2 p=vU*freq;
        float w=n(p*.5+t*spd)*warp;
        float v=sin(p.x+p.y*.6+w*3.0+t*spd*2.0)*.5+.5;
        if(bands>.5) v=step(.5,v)*.85+v*.15;
        vec3 c=mix(cA,cB,v);
        c=mix(c,cC,smoothstep(.3,.9,n(p*.3-t*spd*.5)));
        gl_FragColor=vec4(c,op);
      }`
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TOTAL_VERTS*3),3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(TOTAL_VERTS*2),2));
  geometry.setIndex(new THREE.BufferAttribute(buildFullIndices(),1));

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  scene.add(mesh);

  const v = new THREE.Vector3();

  // op = genOp (из сида) × opacityMultiplier (ручной слайдер, в сид не пишется).
  // На полной непрозрачности честно перекрываем всё за собой — без этого
  // depthWrite:false даёт просвечивание даже при op=1.
  let genOp = .9, opacityMultiplier = 1;
  function applyOpacity(){
    const finalOp = genOp * opacityMultiplier;
    material.uniforms.op.value = finalOp;
    const opaque = finalOp >= .95;
    material.transparent = !opaque;
    material.depthWrite = opaque;
  }

  // extension = genExtension (из сида) × extensionMultiplier (ручной слайдер,
  // в сид не пишется) — тот же паттерн, что и с непрозрачностью.
  let genExtension = 0, extensionMultiplier = 1;

  // рабочие векторы для расширения — переиспользуются каждый кадр, без
  // аллокаций в цикле по 36×4 вершинам.
  const tmpEyeR = new THREE.Vector3(), tmpEyeL = new THREE.Vector3();
  const tmpFore = new THREE.Vector3(), tmpChin = new THREE.Vector3();
  const ax = new THREE.Vector3(), ay = new THREE.Vector3(), az = new THREE.Vector3();
  const centroid = new THREE.Vector3(), ovalPos = new THREE.Vector3(), offset = new THREE.Vector3();
  const vertVec = new THREE.Vector3(), horizVec = new THREE.Vector3(), newPos = new THREE.Vector3();
  const uvCentroid = { x:0, y:0 };

  // Рост неравномерный по кольцу: сильно вверх (лоб/виски), почти не растём
  // у подбородка. verticality — проекция офсета от центроида на ay (-1
  // подбородок, +1 макушка/виски), по бокам она естественно ~0 — средний
  // рост получается сам, без отдельного случая.
  const GROWTH_CHIN = .1, GROWTH_TOP = 1.1;
  const OUT_SCALE = .9, BACK_SCALE = .55;
  // офсет от центроида раскладывается на вертикальную (вдоль ay) и
  // горизонтальную (остаток) составляющие. growth применяется ТОЛЬКО к
  // вертикальной — иначе на уровне глаз/скул/подбородка, где офсет почти
  // целиком горизонтальный, рост "по вертикали" фактически толкал точку
  // вбок и раздувал лицо в ширину. Горизонтальная растёт максимум на 5%
  // (HORIZ_CAP) при ext=1 на самом дальнем кольце — контур на этом уровне
  // остаётся практически там же, где и исходный овал, при любом extension.
  const HORIZ_CAP = .05;
  // "назад" = -az. az строится тем же cross(ax,ay), что и анкер в tracking.js,
  // и там +Z (тот же az) — направление "к камере" (осколки летят на +pz,
  // это подтверждённое рабочее поведение). Значит "обратно, вокруг черепа,
  // от камеры" — это -az.
  const BACKWARD_SIGN = -1;

  function applyExtension(landmarks, aspect){
    const pos = geometry.attributes.position.array;
    const uv  = geometry.attributes.uv.array;
    const ext = genExtension * extensionMultiplier;

    toWorld(landmarks[33], aspect, tmpEyeR);
    toWorld(landmarks[263], aspect, tmpEyeL);
    toWorld(landmarks[10], aspect, tmpFore);
    toWorld(landmarks[152], aspect, tmpChin);
    ax.copy(tmpEyeL).sub(tmpEyeR).normalize();
    ay.copy(tmpFore).sub(tmpChin).normalize();
    az.crossVectors(ax, ay).normalize();

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
      vertVec.copy(ay).multiplyScalar(vertScalar);
      horizVec.subVectors(offset, vertVec);

      const vert = offLen > 1e-6 ? vertScalar/offLen : 0; // -1 подбородок .. +1 макушка/виски
      const t = (vert+1)/2;
      const growth = THREE.MathUtils.lerp(GROWTH_CHIN, GROWTH_TOP, t);

      const ou = uv[oi*2] - uvCentroid.x, ov = uv[oi*2+1] - uvCentroid.y;

      for (let r=0;r<RING_COUNT;r++){
        const k = (r+1)/RING_COUNT;
        const vertGrowthAmt = ext*growth*k*OUT_SCALE;
        const horizMult = 1 + HORIZ_CAP*ext*k;
        const backAmt = ext*growth*k*BACK_SCALE*BACKWARD_SIGN;

        newPos.copy(centroid)
          .addScaledVector(vertVec, 1+vertGrowthAmt)
          .addScaledVector(horizVec, horizMult)
          .addScaledVector(az, backAmt);

        const vi = extVertexIndex(r, i);
        pos[vi*3]=newPos.x; pos[vi*3+1]=newPos.y; pos[vi*3+2]=newPos.z;
        // UV той же логикой: вертикаль (Y) тянется вместе с ростом вверх,
        // горизонталь (X) почти не меняется — та же причина, что и с 3D.
        uv[vi*2] = uvCentroid.x + ou*horizMult;
        uv[vi*2+1] = uvCentroid.y + ov*(1+vertGrowthAmt);
      }
    }
  }

  return {
    object3D: mesh,

    applyPalette(cols){
      material.uniforms.cA.value.copy(cols[0]);
      material.uniforms.cB.value.copy(cols[1] || cols[0]);
      material.uniforms.cC.value.copy(cols[2] || cols[0]);
      material.uniforms.freq.value = R(28,4);
      material.uniforms.warp.value = R(3,0);
      material.uniforms.bands.value = R()<.45 ? 1 : 0;
      material.uniforms.spd.value = R(.8,.05);
      genOp = R(.98,.86);
      genExtension = R(1,0);
      applyOpacity();
    },

    setOpacityMultiplier(mult){ opacityMultiplier = mult; applyOpacity(); },
    setExtensionMultiplier(mult){ extensionMultiplier = mult; },

    updateGeometry(landmarks, aspect){
      const pos = geometry.attributes.position.array;
      const uv  = geometry.attributes.uv.array;
      for (let i=0;i<468;i++){
        toWorld(landmarks[i], aspect, v);
        pos[i*3]=v.x; pos[i*3+1]=v.y; pos[i*3+2]=v.z + .002;
        uv[i*2]=landmarks[i].x; uv[i*2+1]=1-landmarks[i].y;
      }
      applyExtension(landmarks, aspect);
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.uv.needsUpdate = true;
      geometry.computeVertexNormals();
    },

    setTime(t){ material.uniforms.t.value = t; },

    dispose(){ geometry.dispose(); material.dispose(); scene.remove(mesh); }
  };
}
