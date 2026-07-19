import * as THREE from 'three';
import { R, RI, pick } from '../rng.js';

// Крепление — приближённая позиция над лендмарком 10 (лоб) в anchor-local
// координатах (начало координат анкера — кончик носа, см. tracking.js).
// Как и в brows.js — не калибровано под конкретное лицо, это оценка по
// типичным пропорциям в единицах IPD=1.
const FOREHEAD_Y = .95;
const FOREHEAD_Z = 0;

function hueShift(color, amount){
  const hsl = {h:0,s:0,l:0};
  color.getHSL(hsl);
  return new THREE.Color().setHSL((hsl.h+amount)%1, hsl.s, hsl.l);
}

// 60% solid, 20% glass, 20% wire — те же пропорции, что у осколков (фаза 1).
function pickKind(){
  const k = R();
  if(k<.2) return 'wire';
  if(k<.4) return 'glass';
  return 'solid';
}

function makeMaterial(kind, color){
  if(kind==='wire') return new THREE.MeshBasicMaterial({ color, wireframe:true, side:THREE.DoubleSide });
  if(kind==='glass') return new THREE.MeshBasicMaterial({ color, transparent:true, opacity:R(.6,.3), side:THREE.DoubleSide });
  return new THREE.MeshStandardMaterial({
    color, side:THREE.DoubleSide, flatShading:R()<.5,
    roughness:R(.9,.2), metalness:R(.6,0)
  });
}

/* ────────────────────────── силуэтные семейства ───────────────────────── */
// Каждая функция строит основу в локальных координатах группы (y=0 — уровень
// крепления/лоб, дальше вверх). Симметрия обязательна — либо форма сама
// рационально-симметрична (dome/halo/rays/tiers), либо строится на одну
// сторону и зеркалится явно (horns).

function addDome(radius, cols, group){
  const thetaLen = Math.PI*.55;
  const faceted = R()<.5;
  const wSeg = faceted ? RI(10,6) : RI(28,16);
  const hSeg = faceted ? RI(6,4) : RI(16,8);
  const geo = new THREE.SphereGeometry(radius, wSeg, hSeg, 0, Math.PI*2, 0, thetaLen);
  const rimY = radius*Math.cos(thetaLen); // может быть отрицательным — купол чуть ниже экватора сферы
  geo.translate(0, -rimY, 0);
  const mat = makeMaterial(pickKind(), pick(cols));
  if ('flatShading' in mat) mat.flatShading = faceted;
  group.add(new THREE.Mesh(geo, mat));
}

function addCrest(radius, cols, group){
  const jagged = R()<.5;
  const height = R(1.4,.6)*radius;
  const halfLen = radius*.9;
  const N = jagged ? RI(9,7) : 5;
  const pts = [];
  for (let i=0;i<N;i++){
    const t = i/(N-1);
    const z = -halfLen + halfLen*2*t;
    let y = Math.sin(t*Math.PI)*height;
    if (jagged && i>0 && i<N-1 && i%2===1) y *= R(1.3,.7);
    pts.push(new THREE.Vector3(0, y, z));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const geo = new THREE.TubeGeometry(curve, 48, radius*.06, 6, false);
  group.add(new THREE.Mesh(geo, makeMaterial(pickKind(), pick(cols))));
}

function addHalo(radius, cols, group){
  const n = RI(3,1);
  for (let i=0;i<n;i++){
    const r = radius*R(1.1,.75);
    const tube = radius*R(.09,.03);
    const geo = new THREE.TorusGeometry(r, tube, 10, 28);
    const mesh = new THREE.Mesh(geo, makeMaterial(pickKind(), pick(cols)));
    mesh.rotation.x = Math.PI/2 + R(.6,-.6);
    mesh.rotation.z = R(.6,-.6);
    mesh.position.y = radius*R(.9,.5) + i*radius*.15;
    group.add(mesh);
  }
}

function addRays(radius, cols, group){
  const n = RI(25,8);
  for (let i=0;i<n;i++){
    const a = (i/n)*Math.PI*2;
    const len = radius*R(1.1,.4);
    const geo = new THREE.ConeGeometry(radius*R(.12,.04), len, 6);
    const mesh = new THREE.Mesh(geo, makeMaterial(pickKind(), pick(cols)));
    const outwardTilt = R(.9,.3);
    mesh.rotation.order = 'YXZ';
    mesh.rotation.y = -a;
    mesh.rotation.x = outwardTilt;
    mesh.position.set(Math.cos(a)*radius*.6, radius*.5, Math.sin(a)*radius*.6);
    group.add(mesh);
  }
}

function addTiers(radius, cols, group){
  const n = RI(5,2);
  let y = 0;
  for (let i=0;i<n;i++){
    const rTop = Math.max(.06, radius*(1-(i+1)/n)*.85);
    const rBot = Math.max(.1, radius*(1-i/n)*.85);
    const h = radius*R(.5,.25);
    const geo = new THREE.CylinderGeometry(rTop, rBot, h, RI(10,6));
    const mesh = new THREE.Mesh(geo, makeMaterial(pickKind(), pick(cols)));
    mesh.position.y = y + h/2;
    group.add(mesh);
    y += h;
  }
}

function addHorns(radius, cols, group){
  const outward = R()<.5;
  const pts = [
    new THREE.Vector3(radius*.5, radius*.2, 0),
    new THREE.Vector3(radius*.7, radius*.5, radius*.1),
    new THREE.Vector3(outward?radius*1.1:radius*.6, outward?radius*.6:radius*1.2, radius*.15),
  ];
  const curve = new THREE.CatmullRomCurve3(pts);
  const geo = new THREE.TubeGeometry(curve, 24, radius*R(.12,.06), 8, false);
  const right = new THREE.Mesh(geo, makeMaterial(pickKind(), pick(cols)));
  group.add(right);
  const left = right.clone();
  left.scale.x = -1;
  group.add(left);
}

function addWrap(radius, cols, group){
  const n = RI(4,2);
  for (let i=0;i<n;i++){
    const r = radius*R(1.05,.85);
    const tube = radius*R(.05,.02);
    const geo = new THREE.TorusGeometry(r, tube, 8, 32);
    const mesh = new THREE.Mesh(geo, makeMaterial(pickKind(), pick(cols)));
    mesh.rotation.x = Math.PI/2 + R(.5,-.5);
    mesh.rotation.y = R(3.14,0);
    mesh.position.y = radius*R(.6,.15);
    group.add(mesh);
  }
}

function addPlume(radius, cols, group){
  const n = RI(9,4);
  for (let i=0;i<n;i++){
    const spread = n>1 ? (i/(n-1)-.5)*1.2 : 0;
    const len = radius*R(1.6,.7);
    const geo = new THREE.ConeGeometry(radius*R(.07,.03), len, 5);
    const mesh = new THREE.Mesh(geo, makeMaterial(pickKind(), pick(cols)));
    mesh.rotation.order = 'YXZ';
    mesh.rotation.y = spread*.6;
    mesh.rotation.x = -.6 + spread*.3;
    mesh.position.set(Math.sin(spread)*radius*.3, radius*.4, -radius*.5);
    group.add(mesh);
  }
}

const FAMILIES = { dome:addDome, crest:addCrest, halo:addHalo, rays:addRays,
                    tiers:addTiers, horns:addHorns, wrap:addWrap, plume:addPlume };

/* ────────────────────────── бахрома ────────────────────────────────────
   ~60% масок, независимо от семейства. Инстансим — до 80 элементов на
   маску, иначе просядет fps. Один тип материала на всю бахрому (это же
   один "пучок волос", логично, что он однородный). */
function addFringe(radius, cols, group){
  if (R() >= .6) return;

  const perSide = RI(41,10);
  const total = perSide*2;
  const kind = pickKind();
  const geo = new THREE.ConeGeometry(radius*.025, 1, 5);
  const mat = makeMaterial(kind, 0xffffff);
  const imesh = new THREE.InstancedMesh(geo, mat, total);
  imesh.frustumCulled = false;

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  let idx = 0;
  for (const side of [-1,1]){
    for (let i=0;i<perSide;i++){
      const t = perSide>1 ? i/(perSide-1) : .5;
      const arc = (t-.5)*1.2;
      const len = radius*R(1.5,.6)*.9;
      const x = side*radius*.95;
      const z = Math.sin(arc)*radius*.5;
      m.compose(new THREE.Vector3(x, -len/2, z), q, new THREE.Vector3(1,len,1));
      imesh.setMatrixAt(idx, m);
      // setColorAt ждёт linear-space — см. этот же баг в shards.js (фаза 1, п.7)
      imesh.setColorAt(idx, pick(cols).clone().convertSRGBToLinear());
      idx++;
    }
  }
  imesh.instanceMatrix.needsUpdate = true;
  if (imesh.instanceColor) imesh.instanceColor.needsUpdate = true;
  group.add(imesh);
}

/* ────────────────────────── декор ──────────────────────────────────────
   0-12 мелких элементов из словаря примитивов, симметрично, до 20% доли —
   намеренно асимметричные (см. asymRate). */
const DECOR_GEOMS = [
  ()=> new THREE.SphereGeometry(1, RI(12,6), RI(8,5)),
  ()=> new THREE.RingGeometry(.5, 1, RI(16,8)),
  ()=> new THREE.IcosahedronGeometry(1, RI(2)),
  ()=> new THREE.OctahedronGeometry(1, 0),
  ()=> new THREE.CircleGeometry(1, RI(8,5)),
];

function addDecor(radius, cols, group){
  const count = RI(13,0);
  const asymRate = .2;
  for (let i=0;i<count;i++){
    const geo = pick(DECOR_GEOMS)();
    const s = radius*R(.14,.05);
    const mesh = new THREE.Mesh(geo, makeMaterial(pickKind(), pick(cols)));
    const a = R(Math.PI*2), r = radius*R(1.0,.6), y = radius*R(1.1,.2);
    mesh.scale.setScalar(s);
    mesh.position.set(Math.cos(a)*r, y, Math.sin(a)*r);
    mesh.rotation.set(R(6.28),R(6.28),R(6.28));
    group.add(mesh);

    if (R() >= asymRate && Math.abs(mesh.position.x) > 1e-3){
      const mirror = mesh.clone();
      mirror.position.x *= -1;
      group.add(mirror);
    }
  }
}

// головной убор — жёстко крепится к анкеру, фиксированная поза из сида,
// на blendshapes не реагирует (вся жизнь — от движения головы через анкер).
// Полностью пересоздаётся на каждый generate(), как shards/eyes/brows.
export function create(ctx){
  const { palette: cols } = ctx;

  const radius = R(1.8,1.1);
  const tiltDeg = R(20,0) * (R()<.5?-1:1);
  const familyName = pick(Object.keys(FAMILIES));
  const accent = hueShift(cols[0], .5);
  const crownCols = [...cols, accent];

  const group = new THREE.Group();
  group.position.set(0, FOREHEAD_Y, FOREHEAD_Z);
  group.rotation.x = THREE.MathUtils.degToRad(tiltDeg);

  FAMILIES[familyName](radius, crownCols, group);
  addFringe(radius, crownCols, group);
  addDecor(radius, crownCols, group);

  return {
    object3D: group,
    familyName,
    dispose(){ group.traverse(o=>{ o.geometry?.dispose(); o.material?.dispose?.(); }); }
  };
}
