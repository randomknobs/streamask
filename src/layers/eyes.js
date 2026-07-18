import * as THREE from 'three';
import { createRng } from '../rng.js';
import { toWorld } from '../tracking.js';

const RING_RIGHT = [33,7,163,144,145,153,154,155,133,173,157,158,159,160,161,246];
const RING_LEFT  = [263,249,390,373,374,380,381,382,362,398,384,385,386,387,388,466];
const IRIS_RIGHT = 468;
const IRIS_LEFT  = 473;

function contrastColor(cols){
  const hsl = {h:0,s:0,l:0};
  let best = cols[0], bestL = Infinity;
  for (const c of cols){
    c.getHSL(hsl);
    if (hsl.l < bestL){ bestL = hsl.l; best = c; }
  }
  return best;
}

// концентрические кольца — случайное количество и толщина
function buildRings(rng, cols, group){
  const n = rng.RI(4,2);
  for (let i=0;i<n;i++){
    const outer = rng.R(.95,.35);
    const thick = rng.R(.16,.04);
    const geo = new THREE.RingGeometry(Math.max(.02, outer-thick), outer, rng.RI(32,12));
    const mat = new THREE.MeshBasicMaterial({ color:rng.pick(cols), side:THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.z = rng.R(.02,-.02);
    group.add(mesh);
  }
}

// спираль по CatmullRomCurve3
function buildSpiral(rng, cols, group){
  const turns = rng.R(2.6,1.2);
  const maxR = rng.R(.9,.45);
  const N = 28;
  const pts = [];
  for (let i=0;i<=N;i++){
    const a = (i/N)*Math.PI*2*turns;
    const r = (i/N)*maxR;
    pts.push(new THREE.Vector3(Math.cos(a)*r, Math.sin(a)*r, 0));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const geo = new THREE.TubeGeometry(curve, 64, rng.R(.05,.015), 6, false);
  const mat = new THREE.MeshBasicMaterial({ color:rng.pick(cols) });
  group.add(new THREE.Mesh(geo, mat));
}

// гранёный многоугольник, плоская заливка
function buildPolygon(rng, cols, group){
  const sides = rng.RI(9,5);
  const geo = new THREE.CircleGeometry(rng.R(.9,.5), sides);
  const mat = new THREE.MeshBasicMaterial({ color:rng.pick(cols), side:THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.z = rng.R(6.28);
  mesh.position.z = rng.R(.03,-.03);
  group.add(mesh);
}

// пучок ресниц — тонкие конусы по радиусу
function buildLashes(rng, cols, group){
  const n = rng.RI(14,5);
  const color = rng.pick(cols);
  const arcStart = rng.R(6.28), arcSpan = rng.R(6.28,3.0);
  for (let i=0;i<n;i++){
    const a = arcStart + (n>1 ? i/(n-1) : 0)*arcSpan;
    const len = rng.R(.55,.2);
    const geo = new THREE.ConeGeometry(rng.R(.05,.015), len, 5);
    const mat = new THREE.MeshBasicMaterial({ color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(Math.cos(a), Math.sin(a), 0);
    mesh.rotation.z = a - Math.PI/2;
    group.add(mesh);
  }
}

// вложенный «зрачок» — сфера или диск контрастного цвета
function buildPupil(rng, cols, group){
  const r = rng.R(.38,.15);
  const geo = rng.R()<.5
    ? new THREE.SphereGeometry(r, 12, 8)
    : new THREE.CircleGeometry(r, rng.RI(24,10));
  const mat = new THREE.MeshBasicMaterial({ color: contrastColor(cols) });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.z = rng.R(.06,.02);
  group.add(mesh);
}

const BUILDERS = [buildRings, buildSpiral, buildPolygon, buildLashes, buildPupil];

function pickSubset(rng, arr, count){
  const pool = [...arr], chosen = [];
  for (let i=0;i<count && pool.length;i++){
    chosen.push(pool.splice(rng.RI(pool.length),1)[0]);
  }
  return chosen;
}

// сборка одного глаза — 2..5 случайных элементов из BUILDERS, в локальном
// unit-пространстве (радиус ~1), масштаб под живую ширину глаза выставляется
// в updateOneEye каждый кадр.
function buildEye(rng, cols){
  const group = new THREE.Group();
  const count = rng.RI(6,2);
  for (const b of pickSubset(rng, BUILDERS, count)) b(rng, cols, group);
  return group;
}

const _invAnchor = new THREE.Matrix4();
const _wp = new THREE.Vector3();
const _localCenter = new THREE.Vector3();
const _localPt = new THREE.Vector3();

function updateOneEye(eyeGroup, ring, irisIdx, landmarks, aspect, invAnchor, blink, jawOpenVal){
  toWorld(landmarks[irisIdx], aspect, _wp);
  _localCenter.copy(_wp).applyMatrix4(invAnchor);

  let minX=Infinity, maxX=-Infinity;
  for (const li of ring){
    toWorld(landmarks[li], aspect, _wp);
    _localPt.copy(_wp).applyMatrix4(invAnchor);
    if (_localPt.x<minX) minX=_localPt.x;
    if (_localPt.x>maxX) maxX=_localPt.x;
  }
  const width = Math.max(1e-4, maxX-minX);

  const s = width * (1 + jawOpenVal*.1);
  const yBlink = THREE.MathUtils.lerp(1, .15, Math.min(1, Math.max(0, blink)));

  eyeGroup.position.copy(_localCenter);
  eyeGroup.scale.set(s, s*yBlink, s);
}

// объекты вместо дырок под глаза — привязаны к центру радужки, левый и
// правый генерируются НЕЗАВИСИМЫМИ сидами (seedNum и seedNum^golden), чтобы
// не быть зеркальными копиями друг друга.
export function create(ctx){
  const { palette: cols, seedNum } = ctx;

  const rngRight = createRng(seedNum >>> 0);
  const rngLeft  = createRng((seedNum ^ 0x9E3779B9) >>> 0);

  const group = new THREE.Group();
  const rightEye = buildEye(rngRight, cols);
  const leftEye  = buildEye(rngLeft, cols);
  group.add(rightEye, leftEye);

  return {
    object3D: group,

    updateGeometry(landmarks, aspect, anchor, blinkRight, blinkLeft, jawOpenVal){
      _invAnchor.copy(anchor.matrixWorld).invert();
      updateOneEye(rightEye, RING_RIGHT, IRIS_RIGHT, landmarks, aspect, _invAnchor, blinkRight, jawOpenVal);
      updateOneEye(leftEye, RING_LEFT, IRIS_LEFT, landmarks, aspect, _invAnchor, blinkLeft, jawOpenVal);
    },

    dispose(){
      group.traverse(o=>{ o.geometry?.dispose(); o.material?.dispose?.(); });
    }
  };
}
