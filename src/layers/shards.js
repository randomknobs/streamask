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

function makeMaterial(cols){
  const c = pick(cols);
  const kind = R();
  if(kind < .22) return new THREE.MeshBasicMaterial({color:c, wireframe:true});
  if(kind < .34) return new THREE.MeshBasicMaterial({color:c, transparent:true, opacity:R(.65,.25),
                                                     side:THREE.DoubleSide});
  return new THREE.MeshStandardMaterial({
    color:c, side:THREE.DoubleSide, flatShading:R()<.6,
    roughness:R(.95,.1), metalness:R(1,0),
    emissive:R()<.35 ? pick(cols) : 0x000000, emissiveIntensity:R(.8,.1)
  });
}

// объёмные элементы вокруг лица — пересоздаются целиком на каждый generate()
export function create(ctx){
  const { palette: cols } = ctx;

  const group = new THREE.Group();
  const anim = [];

  const style = pick(['shards','plates','rings','spikes','orbit','grid']);
  const symmetric = R() < .78;
  const n = RI(14,4);

  for(let i=0;i<n;i++){
    const geo = GEOMS[style==='rings' ? 4 : style==='spikes' ? 5 : RI(GEOMS.length)]();
    const mesh = new THREE.Mesh(geo, makeMaterial(cols));

    let px, py, pz;
    if(style==='orbit'){
      const a = R(Math.PI*2), rr = R(1.6,.7);
      px = Math.cos(a)*rr; py = Math.sin(a)*rr*.9; pz = R(.9,.1);
    } else if(style==='grid'){
      px = (RI(4)-1.5)*.5; py = (RI(5)-2)*.45; pz = R(.8,.3);
    } else {
      px = R(1.5,.05); py = R(1.2,-1.2); pz = R(1.0,.15);
    }
    if(!symmetric && R()<.5) px = -px;

    const s = R(.42,.05) * (style==='spikes' ? R(1.4,.5) : 1);
    mesh.position.set(px,py,pz);
    mesh.scale.set(s, s*R(1.6,.5), s*R(1.4,.4));
    mesh.rotation.set(R(6.28),R(6.28),R(6.28));

    const item = { mesh, spin:new THREE.Vector3(R(.9,-.9),R(.9,-.9),R(.9,-.9)).multiplyScalar(R()<.5?0:1),
                   pulse:R()<.35 ? R(3,.5) : 0, base:mesh.scale.clone(), ph:R(6.28) };
    group.add(mesh); anim.push(item);

    if(symmetric && Math.abs(px)>.08){
      const m2 = mesh.clone(); m2.position.x = -px; m2.rotation.y = -mesh.rotation.y;
      m2.rotation.z = -mesh.rotation.z; group.add(m2);
      anim.push({ mesh:m2, spin:item.spin.clone().multiply(new THREE.Vector3(1,-1,-1)),
                  pulse:item.pulse, base:m2.scale.clone(), ph:item.ph });
    }
  }

  return {
    object3D: group,

    update(state){
      const t = state.t;
      for(const a of anim){
        a.mesh.rotation.x += a.spin.x*.01;
        a.mesh.rotation.y += a.spin.y*.01;
        a.mesh.rotation.z += a.spin.z*.01;
        if(a.pulse){ const k = 1 + Math.sin(t*a.pulse + a.ph)*.18;
          a.mesh.scale.set(a.base.x*k, a.base.y*k, a.base.z*k); }
      }
    },

    dispose(){
      group.traverse(o=>{ o.geometry?.dispose(); o.material?.dispose?.(); });
    }
  };
}
