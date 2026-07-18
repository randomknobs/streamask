import * as THREE from 'three';
import { R, RI, pick } from '../rng.js';

const GEOMS = [
  ()=> new THREE.IcosahedronGeometry(1, RI(2)),
  ()=> new THREE.TetrahedronGeometry(1, RI(2)),
  ()=> new THREE.OctahedronGeometry(1, RI(2)),
  ()=> new THREE.BoxGeometry(1, R(2.5,.2), R(.6,.05)),
  ()=> new THREE.TorusGeometry(1, R(.4,.06), 8, RI(24,5)),
  ()=> new THREE.ConeGeometry(R(.7,.15), R(2.5,.5), RI(10,3)),
  ()=> new THREE.CylinderGeometry(R(.7,.05), R(.7,.05), R(2,.2), RI(12,3), 1, R()<.4),
  ()=> new THREE.RingGeometry(R(.8,.3), 1, RI(20,4)),
  ()=> new THREE.SphereGeometry(1, RI(14,4), RI(10,3)),
  ()=> new THREE.TorusKnotGeometry(1, R(.35,.08), 48, 6, RI(4,1), RI(4,2)),
];

// категориальный тип материала решается на каждый слот при генерации
// (см. pickKind), а не один раз на группу — иначе для style с фиксированной
// геометрией (rings/spikes) разнообразие схлопывается до одного броска
// на весь пояс. Непрерывные параметры (roughness/metalness/emissive) при
// этом всё же общие на группу — это цена инстансинга.
// ~60% непрозрачных, ~20% полупрозрачных, ~20% wireframe.
function pickKind(){
  const k = R();
  if(k < .2) return 'wire';
  if(k < .4) return 'glass';
  return 'solid';
}

// setColorAt пишет instanceColor в linear-space, а pick(cols) отдаёт цвет
// из HSL-палитры как есть (де-факто sRGB) — без конвертации встроенные
// материалы гамма-кодируют его дважды на выходе, картинка выцветает.
// Кастомный шейдер кожи в этот пайплайн не попадает, поэтому там всё ок
// без конвертации.
const toLinear = c => c.clone().convertSRGBToLinear();

// белый базовый цвет — реальный цвет каждого инстанса задаёт instanceColor,
// иначе умножение material.color × instanceColor даёт грязные тона.
// Прозрачность — привилегия пояса halo, у core/mid все три вида материала
// непрозрачны (различается только сам стиль заливки: wireframe / плоский
// цвет / освещённый PBR).
function makeGroupMaterial(kind, belt, cols){
  const halo = belt === 'halo';
  if(kind === 'wire'){
    return new THREE.MeshBasicMaterial({
      color:0xffffff, wireframe:true,
      transparent:halo, opacity:halo ? R(.55,.25) : 1, depthWrite:!halo
    });
  }
  if(kind === 'glass'){
    return new THREE.MeshBasicMaterial({
      color:0xffffff, side:THREE.DoubleSide,
      transparent:halo, opacity: halo ? R(.45,.18) : 1, depthWrite:!halo
    });
  }
  return new THREE.MeshStandardMaterial({
    color:0xffffff, side:THREE.DoubleSide, flatShading:R()<.6,
    transparent:halo, depthWrite:!halo, opacity: halo ? R(.55,.22) : 1,
    roughness:R(.95, halo?.3:.15), metalness:R(halo?.5:.7,0),
    emissive:R()<.3 ? toLinear(pick(cols)) : 0x000000,
    emissiveIntensity:R(halo?.6:.7,.1)
  });
}

function beltOf(px, py){
  const r = Math.hypot(px, py);
  if (r < .5) return 'core';
  if (r < 1.0) return 'mid';
  return 'halo';
}

const SIZE_RANGE = { core:[.20,.15], mid:[.40,.25], halo:[.75,.44] };

// 3-6 «гнёзд» на лице — вокруг них кучкуется 70% элементов (гауссов разброс),
// остальные 30% сыплются равномерно по общей области. Style влияет на форму
// расстановки гнёзд, но не на итоговый пул позиций.
// Радиус гнезда — линейно от 0, БЕЗ sqrt-коррекции на площадь: так плотность
// точек естественно выше у центра (ядро лица) и ниже к краю — то, что нужно
// для пояса core. Верхняя граница (~0.7) держит гнёзда внутри овала лица,
// а не в районе ушей.
function makeNests(count, style){
  const nests = [];
  for (let i=0;i<count;i++){
    if (style === 'orbit'){
      const a = R(Math.PI*2), rr = R(.65,.15);
      nests.push({ x:Math.cos(a)*rr, y:Math.sin(a)*rr*.85 });
    } else if (style === 'grid'){
      nests.push({ x:(RI(3)-1)*.3, y:(RI(3)-1)*.28 });
    } else {
      const a = R(Math.PI*2), rr = R(.7,0);
      nests.push({ x:Math.cos(a)*rr, y:Math.sin(a)*rr*.85 });
    }
  }
  return nests;
}

function gaussian(sigma){
  const u1 = Math.max(R(), 1e-6), u2 = R();
  return Math.sqrt(-2*Math.log(u1)) * Math.cos(Math.PI*2*u2) * sigma;
}

// объёмные элементы вокруг лица — пересоздаются целиком на каждый generate().
// Много мелких элементов не тянут по FPS через отдельные Mesh — инстансим
// InstancedMesh на каждую комбинацию (geometry × пояс плотности × тип материала).
export function create(ctx){
  const { palette: cols } = ctx;

  const style = pick(['shards','plates','rings','spikes','orbit','grid']);
  const symmetric = R() < .78;
  const asymmetryBias = R(.3, 0);
  const n = RI(60, 38);

  const nests = makeNests(RI(7,3), style);

  const slots = [];
  for (let i=0;i<n;i++){
    const geomIdx = style==='rings' ? 4 : style==='spikes' ? 5 : RI(GEOMS.length);

    let px, py;
    if (R() < .7){
      const nest = nests[RI(nests.length)];
      px = nest.x + gaussian(.22); py = nest.y + gaussian(.18);
    } else {
      px = R(1.1,.05)*(R()<.5?-1:1); py = R(.9,-.9);
    }
    if(!symmetric && R()<.5) px = -px;

    const pz = R(1.0,.15);
    const belt = beltOf(px, py);
    const [sMax,sMin] = SIZE_RANGE[belt];
    const s = R(sMax,sMin) * (style==='spikes' ? R(1.4,.5) : 1);

    const rot = { x:R(6.28), y:R(6.28), z:R(6.28) };
    const spin = new THREE.Vector3(R(.9,-.9),R(.9,-.9),R(.9,-.9)).multiplyScalar(R()<.5?0:1);
    const pulse = R()<.35 ? R(3,.5) : 0;
    const ph = R(6.28);
    const scale = { x:s, y:s*R(1.6,.5), z:s*R(1.4,.4) };
    const color = toLinear(pick(cols));
    const kind = pickKind();
    // реакция на рот: mouthK 0..0.8 (часть элементов не реагирует вовсе),
    // mouthInvert — эта часть сжимается вместо роста при открытии рта.
    const mouthK = R()<.35 ? 0 : R(.8,0);
    const mouthInvert = R()<.25;
    const key = geomIdx + '|' + belt + '|' + kind;

    slots.push({ key, geomIdx, belt, kind, px, py, pz, rot, spin, pulse, ph, scale, color, mouthK, mouthInvert });

    if (symmetric && Math.abs(px) > .08 && R() >= asymmetryBias){
      slots.push({
        key, geomIdx, belt, kind, px:-px, py, pz,
        rot:{ x:rot.x, y:-rot.y, z:-rot.z },
        spin: spin.clone().multiply(new THREE.Vector3(1,-1,-1)),
        pulse, ph, scale:{ ...scale }, color, mouthK, mouthInvert
      });
    }
  }

  const groups = new Map();
  for (const slot of slots){
    if(!groups.has(slot.key)) groups.set(slot.key, []);
    groups.get(slot.key).push(slot);
  }

  const group = new THREE.Group();
  const anim = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion();

  for (const items of groups.values()){
    const { geomIdx, belt, kind } = items[0];
    const geometry = GEOMS[geomIdx]();
    const material = makeGroupMaterial(kind, belt, cols);
    const imesh = new THREE.InstancedMesh(geometry, material, items.length);
    imesh.frustumCulled = false;

    items.forEach((it, idx) => {
      q.setFromEuler(new THREE.Euler(it.rot.x, it.rot.y, it.rot.z));
      m.compose(new THREE.Vector3(it.px,it.py,it.pz), q, new THREE.Vector3(it.scale.x,it.scale.y,it.scale.z));
      imesh.setMatrixAt(idx, m);
      imesh.setColorAt(idx, it.color);

      const r0 = Math.hypot(it.px, it.py) || 1e-6;

      anim.push({
        imesh, index:idx, belt:it.belt,
        pos:new THREE.Vector3(it.px,it.py,it.pz),
        dirX: it.px / r0, dirY: it.py / r0,
        euler:new THREE.Euler(it.rot.x, it.rot.y, it.rot.z),
        spin:it.spin, pulse:it.pulse, ph:it.ph,
        baseScale:new THREE.Vector3(it.scale.x,it.scale.y,it.scale.z),
        mouthK:it.mouthK, mouthInvert:it.mouthInvert
      });
    });
    imesh.instanceMatrix.needsUpdate = true;
    if (imesh.instanceColor) imesh.instanceColor.needsUpdate = true;

    group.add(imesh);
  }

  const scaleV = new THREE.Vector3();
  const posV = new THREE.Vector3();

  return {
    object3D: group,

    update(state){
      const t = state.t;
      const mouthEnergy = state.mouthEnergy || 0;
      const spinMul = 1 + mouthEnergy*2;
      const touched = new Set();
      for (const a of anim){
        a.euler.x += a.spin.x*.01*spinMul;
        a.euler.y += a.spin.y*.01*spinMul;
        a.euler.z += a.spin.z*.01*spinMul;
        q.setFromEuler(a.euler);

        let sx = a.baseScale.x, sy = a.baseScale.y, sz = a.baseScale.z;
        if (a.mouthK){
          const mk = 1 + mouthEnergy * a.mouthK * (a.mouthInvert ? -1 : 1);
          sx *= mk; sy *= mk; sz *= mk;
        }
        if (a.pulse){
          const k = 1 + Math.sin(t*a.pulse + a.ph)*.18;
          sx *= k; sy *= k; sz *= k;
        }
        scaleV.set(sx, sy, sz);

        posV.copy(a.pos);
        if (a.belt === 'core' && mouthEnergy){
          posV.x += a.dirX * mouthEnergy * .15;
          posV.y += a.dirY * mouthEnergy * .15;
        }

        m.compose(posV, q, scaleV);
        a.imesh.setMatrixAt(a.index, m);
        touched.add(a.imesh);
      }
      touched.forEach(im => { im.instanceMatrix.needsUpdate = true; });
    },

    dispose(){
      group.traverse(o=>{ o.geometry?.dispose(); o.material?.dispose?.(); });
    }
  };
}
