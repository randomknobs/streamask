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

// белый базовый цвет — реальный цвет каждого инстанса задаёт instanceColor,
// иначе умножение material.color × instanceColor даёт грязные тона
function makeGroupMaterial(belt, cols){
  if (belt === 'halo'){
    return new THREE.MeshStandardMaterial({
      color:0xffffff, transparent:true, opacity:R(.5,.18), side:THREE.DoubleSide,
      roughness:R(.95,.3), metalness:R(.6,0), flatShading:R()<.6,
      emissive:R()<.3 ? pick(cols) : 0x000000, emissiveIntensity:R(.6,.1)
    });
  }
  const kind = R();
  if(kind < .22) return new THREE.MeshBasicMaterial({color:0xffffff, wireframe:true});
  if(kind < .34) return new THREE.MeshBasicMaterial({color:0xffffff, transparent:true, opacity:R(.65,.25),
                                                     side:THREE.DoubleSide});
  return new THREE.MeshStandardMaterial({
    color:0xffffff, side:THREE.DoubleSide, flatShading:R()<.6,
    roughness:R(.95,.1), metalness:R(1,0),
    emissive:R()<.35 ? pick(cols) : 0x000000, emissiveIntensity:R(.8,.1)
  });
}

function beltOf(px, py){
  const r = Math.hypot(px, py);
  if (r < .5) return 'core';
  if (r < 1.0) return 'mid';
  return 'halo';
}

const SIZE_RANGE = { core:[.20,.06], mid:[.40,.16], halo:[.75,.35] };

// 3-6 «гнёзд» на лице — вокруг них кучкуется 70% элементов (гауссов разброс),
// остальные 30% сыплются равномерно по общей области. Style влияет на форму
// расстановки гнёзд, но не на итоговый пул позиций.
function makeNests(count, style){
  const nests = [];
  for (let i=0;i<count;i++){
    if (style === 'orbit'){
      const a = R(Math.PI*2), rr = R(.9,.4);
      nests.push({ x:Math.cos(a)*rr, y:Math.sin(a)*rr*.9 });
    } else if (style === 'grid'){
      nests.push({ x:(RI(4)-1.5)*.4, y:(RI(5)-2)*.35 });
    } else {
      nests.push({ x:R(1.1,.05)*(R()<.5?-1:1), y:R(.9,-.9) });
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
// InstancedMesh на каждую (geometry × пояс плотности) комбинацию.
export function create(ctx){
  const { palette: cols } = ctx;

  const style = pick(['shards','plates','rings','spikes','orbit','grid']);
  const symmetric = R() < .78;
  const asymmetryBias = R(.3, 0);
  const n = RI(60, 22);

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
    const color = pick(cols);
    const key = geomIdx + '|' + belt;

    slots.push({ key, geomIdx, belt, px, py, pz, rot, spin, pulse, ph, scale, color });

    if (symmetric && Math.abs(px) > .08 && R() >= asymmetryBias){
      slots.push({
        key, geomIdx, belt, px:-px, py, pz,
        rot:{ x:rot.x, y:-rot.y, z:-rot.z },
        spin: spin.clone().multiply(new THREE.Vector3(1,-1,-1)),
        pulse, ph, scale:{ ...scale }, color
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
    const { geomIdx, belt } = items[0];
    const geometry = GEOMS[geomIdx]();
    const material = makeGroupMaterial(belt, cols);
    const imesh = new THREE.InstancedMesh(geometry, material, items.length);
    imesh.frustumCulled = false;

    items.forEach((it, idx) => {
      q.setFromEuler(new THREE.Euler(it.rot.x, it.rot.y, it.rot.z));
      m.compose(new THREE.Vector3(it.px,it.py,it.pz), q, new THREE.Vector3(it.scale.x,it.scale.y,it.scale.z));
      imesh.setMatrixAt(idx, m);
      imesh.setColorAt(idx, it.color);

      anim.push({
        imesh, index:idx,
        pos:new THREE.Vector3(it.px,it.py,it.pz),
        euler:new THREE.Euler(it.rot.x, it.rot.y, it.rot.z),
        spin:it.spin, pulse:it.pulse, ph:it.ph,
        baseScale:new THREE.Vector3(it.scale.x,it.scale.y,it.scale.z)
      });
    });
    imesh.instanceMatrix.needsUpdate = true;
    if (imesh.instanceColor) imesh.instanceColor.needsUpdate = true;

    group.add(imesh);
  }

  const scaleV = new THREE.Vector3();

  return {
    object3D: group,

    update(state){
      const t = state.t;
      const touched = new Set();
      for (const a of anim){
        a.euler.x += a.spin.x*.01;
        a.euler.y += a.spin.y*.01;
        a.euler.z += a.spin.z*.01;
        q.setFromEuler(a.euler);
        if (a.pulse){
          const k = 1 + Math.sin(t*a.pulse + a.ph)*.18;
          scaleV.set(a.baseScale.x*k, a.baseScale.y*k, a.baseScale.z*k);
        } else {
          scaleV.copy(a.baseScale);
        }
        m.compose(a.pos, q, scaleV);
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
