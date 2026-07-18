import * as THREE from 'three';
import { R, pick } from './rng.js';

export function palette(){
  const h = R(1), s = R(.95,.55), l = R(.68,.42);
  const scheme = pick(['analog','complement','triad','split','mono']);
  const offs = { analog:[0,.06,-.06,.12], complement:[0,.5,.04,.54],
                 triad:[0,.333,.666,.166], split:[0,.42,.58,.08], mono:[0,0,0,0] }[scheme];
  return offs.map((o,i)=> new THREE.Color().setHSL((h+o+1)%1,
      scheme==='mono'? s*(1-i*.15) : s, scheme==='mono'? l*(1+i*.12) : l*R(1.15,.8)));
}
