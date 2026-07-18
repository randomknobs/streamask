import * as THREE from 'three';
import { R, RI, pick } from '../rng.js';

export const PRESETS = ['angry','sad','surprised','skeptical','manic','dead','unibrow'];

// Позиция над глазами — приближённая, брови намеренно НЕ привязаны к живым
// лендмаркам (см. спеку), это фиксированный face-local офсет от анкера
// (начало координат анкера — кончик носа). Значения оценочные по типичным
// пропорциям лица в единицах IPD=1; при необходимости можно подвинуть.
const BROW_Y = .55;
const INNER_X = .18;
const OUTER_X = .75;
const BROW_SPAN = OUTER_X - INNER_X;
const BROW_Z = .06;

// 5 контрольных точек, t=0 у переносицы (внутр. конец) .. t=1 у виска (внешн.).
// y — вертикальное смещение относительно BROW_Y, в единицах IPD.
const PROFILES = {
  angry:          { y:[-.15,-.05, .03, .08, .10], thickness:.045 },
  sad:            { y:[ .13, .06, .00,-.04,-.07], thickness:.020 },
  surprised:      { y:[ .02, .12, .16, .12, .02], thickness:.032 },
  manic:          { y:[ .06,-.07, .11,-.05, .16], thickness:.045 },
  dead:           { y:[ .00, .00, .00, .00, .00], thickness:.014 },
  skepticalUp:    { y:[ .04, .10, .14, .10, .05], thickness:.032 },
  skepticalDown:  { y:[-.02,-.07,-.11,-.14,-.16], thickness:.032 },
};

function contrastToSkin(cols){
  const hsl = {h:0,s:0,l:0};
  cols[0].getHSL(hsl);
  const skinL = hsl.l;
  let best = cols[0], bestDiff = -1;
  for (const c of cols){
    c.getHSL(hsl);
    const diff = Math.abs(hsl.l - skinL);
    if (diff > bestDiff){ bestDiff = diff; best = c; }
  }
  return best;
}

// точки одной брови в ЕЁ СОБСТВЕННОМ локальном пространстве: (0,0,0) —
// внутренний (у переносицы) конец, дальше вдоль local X к внешнему.
// isLeft определяет знак local X, чтобы rotation.z потом крутил обе брови
// в согласованном направлении (см. update ниже) без scale-трюков.
function browLocalPoints(profile, isLeft){
  const dir = isLeft ? 1 : -1;
  return profile.y.map((y,i) => {
    const t = i/(profile.y.length-1);
    return new THREE.Vector3(dir*BROW_SPAN*t, y, 0);
  });
}

function makeBrowMesh(profile, isLeft, color){
  const pts = browLocalPoints(profile, isLeft);
  const curve = new THREE.CatmullRomCurve3(pts);
  const geo = new THREE.TubeGeometry(curve, 32, profile.thickness, 8, false);
  const mat = new THREE.MeshBasicMaterial({ color });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(isLeft ? INNER_X : -INNER_X, BROW_Y, BROW_Z);
  return mesh;
}

// объёмные брови-«характер» — не трекают реальные брови, фиксированная поза
// над глазами в anchor-local координатах. Пересоздаются целиком на каждый
// generate(), как shards/eyes.
export function create(ctx){
  const { palette: cols } = ctx;

  const preset = pick(PRESETS);
  const color = contrastToSkin(cols);
  const group = new THREE.Group();

  let rightMesh, leftMesh, isUnibrow = false;

  if (preset === 'unibrow'){
    isUnibrow = true;
    const profile = PROFILES.dead; // база — горизонталь, толщину переопределяем
    const pts = [
      new THREE.Vector3(-OUTER_X, BROW_Y, BROW_Z),
      new THREE.Vector3(-INNER_X, BROW_Y+.02, BROW_Z),
      new THREE.Vector3(0, BROW_Y-.015, BROW_Z),
      new THREE.Vector3(INNER_X, BROW_Y+.02, BROW_Z),
      new THREE.Vector3(OUTER_X, BROW_Y, BROW_Z),
    ];
    const curve = new THREE.CatmullRomCurve3(pts);
    const geo = new THREE.TubeGeometry(curve, 48, .07, 8, false);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
    group.add(mesh);
    rightMesh = leftMesh = mesh; // единая форма, реагирует на обе стороны усреднённо
  } else if (preset === 'skeptical'){
    // асимметрия — обязательное свойство пресета, не побочный эффект
    // зеркалирования. Какая сторона вверх/вниз — тоже из сида.
    const rightUp = R() < .5;
    rightMesh = makeBrowMesh(rightUp ? PROFILES.skepticalUp : PROFILES.skepticalDown, false, color);
    leftMesh  = makeBrowMesh(rightUp ? PROFILES.skepticalDown : PROFILES.skepticalUp, true, color);
    group.add(rightMesh, leftMesh);
  } else {
    const profile = PROFILES[preset];
    rightMesh = makeBrowMesh(profile, false, color);
    leftMesh  = makeBrowMesh(profile, true, color);
    group.add(rightMesh, leftMesh);
  }

  return {
    object3D: group,
    presetName: preset,

    // browDownLeft/Right — лёгкая модуляция наклона, не подмена пресета.
    // Знак противоположен для left/right: локальные точки идут в
    // противоположные стороны (см. browLocalPoints), поэтому одинаковый
    // по модулю, но разный по знаку rotation.z даёт СИММЕТРИЧНОЕ движение
    // внешнего конца вниз на обеих бровях.
    update(browDownLeft, browDownRight){
      const maxTilt = THREE.MathUtils.degToRad(8);
      if (isUnibrow){
        const avg = ((browDownLeft||0) + (browDownRight||0)) / 2;
        rightMesh.rotation.z = avg * maxTilt;
      } else {
        rightMesh.rotation.z = (browDownRight||0) * maxTilt;
        leftMesh.rotation.z = -(browDownLeft||0) * maxTilt;
      }
    },

    dispose(){
      group.traverse(o=>{ o.geometry?.dispose(); o.material?.dispose?.(); });
    }
  };
}
