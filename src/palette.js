import * as THREE from 'three';
import { R, RI, pick } from './rng.js';

function shuffle4(){
  const a = [0,1,2,3];
  for (let i=a.length-1;i>0;i--){
    const j = RI(i+1);
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

// Светлота — явные разведённые слоты по диапазону 0.25..0.8, не мелкий
// разброс вокруг общей базы (было l*R(1.15,.8) — все 4 цвета кучковались
// внутри ~0.25 суммарно, порог контраста для узоров/шапочки был физически
// недостижим, см. фаза 8b п.3). Джиттер внутри слота — небольшой (±40% от
// половины шага), чтобы соседние слоты почти никогда не пересекались, но
// маска от маски всё равно отличалась.
const L_LO = .25, L_HI = .8;
const L_STEP = (L_HI - L_LO) / 3;

export function palette(){
  const h = R(1), s = R(.95,.55);
  const scheme = pick(['analog','complement','triad','split','mono']);
  const offs = { analog:[0,.06,-.06,.12], complement:[0,.5,.04,.54],
                 triad:[0,.333,.666,.166], split:[0,.42,.58,.08], mono:[0,0,0,0] }[scheme];
  const order = shuffle4();

  return offs.map((o,i) => {
    const base = L_LO + order[i]*L_STEP;
    const jitter = R(L_STEP*.4, -L_STEP*.4);
    const l = Math.min(L_HI, Math.max(L_LO, base + jitter));
    const sat = scheme==='mono' ? Math.max(.5, s*(1-i*.15)) : s;
    return new THREE.Color().setHSL((h+o+1)%1, sat, l);
  });
}
