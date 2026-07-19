import * as THREE from 'three';
import { R, RI, pick } from '../rng.js';
import { toWorld } from '../tracking.js';

// Верхняя точка кольца глаза (см. eyes.js: RING_RIGHT/RING_LEFT) — от неё
// считается посадка брови, а не от константы. Так брови не наезжают на
// сборку глаза даже когда та крупная (сборки глаз масштабируются по ширине
// кольца, фиксированный Y-офсет от этого не защищал).
const EYE_TOP_RIGHT = 159;
const EYE_TOP_LEFT = 386;
const GAP = .18;

const INNER_X = .18;
const OUTER_X = .75;
const BROW_SPAN = OUTER_X - INNER_X;
const BROW_Z = .06;

// 5 контрольных точек, t=0 у переносицы (внутр. конец) .. t=1 у виска (внешн.).
// y — вертикальное смещение относительно точки посадки (см. updateGeometry).
const CURVE_PROFILES = {
  angry:     { y:[-.15,-.05, .03, .08, .10], thickness:.045 },
  sad:       { y:[ .13, .06, .00,-.04,-.07], thickness:.020 },
  surprised: { y:[ .02, .12, .16, .12, .02], thickness:.032 },
  manic:     { y:[ .06,-.07, .11,-.05, .16], thickness:.045 },
  dead:      { y:[ .00, .00, .00, .00, .00], thickness:.014 },
  arch:      { y:[ .02, .15, .19, .15, .02], thickness:.018 },
  droop:     { y:[ .00, .00,-.05,-.14,-.22], thickness:.030 },
  wave:      { y: Array.from({length:7}, (_,i) => Math.sin((i/6)*4*Math.PI)*.12), thickness:.026 },
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

/* ────────────────────────── кривые (CatmullRom + Tube) ─────────────────
   (0,0,0) — внутренний (у переносицы) конец, дальше вдоль local X к
   внешнему. isLeft определяет знак local X, чтобы rotation.z потом крутил
   обе брови в согласованном направлении без scale-трюков (см. update). */
function browLocalPoints(profile, isLeft){
  const dir = isLeft ? 1 : -1;
  return profile.y.map((y,i) => {
    const t = i/(profile.y.length-1);
    return new THREE.Vector3(dir*BROW_SPAN*t, y, 0);
  });
}

function makeCurveBrow(preset, isLeft, color){
  const pts = browLocalPoints(CURVE_PROFILES[preset], isLeft);
  const curve = new THREE.CatmullRomCurve3(pts);
  const geo = new THREE.TubeGeometry(curve, 32, CURVE_PROFILES[preset].thickness, 8, false);
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
}

/* ────────────────────────── особые пресеты ──────────────────────────────
   Каждый билдер строит ОДНУ сторону в той же локальной раскладке, что и
   кривые: x=0 у переносицы, x=dir*BROW_SPAN у виска. Возвращают Group —
   единообразно с однослойными кривыми (у Group те же position/rotation). */

function buildSlab(isLeft, color){
  const dir = isLeft?1:-1;
  const geo = new THREE.BoxGeometry(BROW_SPAN, .06, .05);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
  mesh.position.x = dir*BROW_SPAN/2;
  const g = new THREE.Group(); g.add(mesh); return g;
}

// толстый у переносицы (x=0), сходит на нет к виску — конус, база у
// переносицы, остриё (радиус 0) у виска.
function buildTaper(isLeft, color){
  const dir = isLeft?1:-1;
  const geo = new THREE.ConeGeometry(.07, BROW_SPAN, 10);
  geo.rotateZ(-Math.PI/2); // конус вдоль +Y по умолчанию → вдоль +X
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
  mesh.position.x = dir*BROW_SPAN/2;
  if (!isLeft) mesh.scale.x = -1; // на правой стороне разворачиваем, база всё равно у x=0
  const g = new THREE.Group(); g.add(mesh); return g;
}

function buildComb(isLeft, color, n){
  const dir = isLeft?1:-1;
  const g = new THREE.Group();
  for (let i=0;i<n;i++){
    const t = i/(n-1);
    const geo = new THREE.BoxGeometry(.025, .16, .025);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
    mesh.position.x = dir*BROW_SPAN*t;
    g.add(mesh);
  }
  return g;
}

function buildSplit(isLeft, color){
  const dir = isLeft?1:-1;
  const g = new THREE.Group();
  const gap = .08;
  const halfLen = (BROW_SPAN-gap)/2;
  for (let half=0; half<2; half++){
    const startX = half===0 ? 0 : halfLen+gap;
    const cx = startX + halfLen/2;
    const geo = new THREE.CylinderGeometry(.022,.022,halfLen,8);
    geo.rotateZ(Math.PI/2);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
    mesh.position.x = dir*cx;
    g.add(mesh);
  }
  return g;
}

// треугольные зубцы — намеренно отдельные конусы (не одна кривая), иначе
// CatmullRom сглаживает углы и пила превращается в волну.
function buildSpike(isLeft, color, n){
  const dir = isLeft?1:-1;
  const g = new THREE.Group();
  for (let i=0;i<n;i++){
    const t = (i+.5)/n;
    const geo = new THREE.ConeGeometry(.05, .16, 3);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
    mesh.position.set(dir*BROW_SPAN*t, .05, 0);
    g.add(mesh);
  }
  const baseGeo = new THREE.CylinderGeometry(.012,.012,BROW_SPAN,8);
  baseGeo.rotateZ(Math.PI/2);
  const base = new THREE.Mesh(baseGeo, new THREE.MeshBasicMaterial({ color }));
  base.position.x = dir*BROW_SPAN/2;
  g.add(base);
  return g;
}

function buildDots(isLeft, color, n){
  const dir = isLeft?1:-1;
  const g = new THREE.Group();
  for (let i=0;i<n;i++){
    const t = n>1 ? i/(n-1) : .5;
    const geo = new THREE.SphereGeometry(.035, 8, 6);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
    mesh.position.x = dir*BROW_SPAN*t;
    g.add(mesh);
  }
  return g;
}

// горизонталь + вертикаль вниз у внешнего (височного) края
function buildBracket(isLeft, color){
  const dir = isLeft?1:-1;
  const g = new THREE.Group();
  const horizGeo = new THREE.CylinderGeometry(.022,.022,BROW_SPAN,8);
  horizGeo.rotateZ(Math.PI/2);
  const horiz = new THREE.Mesh(horizGeo, new THREE.MeshBasicMaterial({ color }));
  horiz.position.x = dir*BROW_SPAN/2;
  g.add(horiz);

  const vertLen = .14;
  const vertGeo = new THREE.CylinderGeometry(.022,.022,vertLen,8);
  const vert = new THREE.Mesh(vertGeo, new THREE.MeshBasicMaterial({ color }));
  vert.position.set(dir*BROW_SPAN, -vertLen/2, 0);
  g.add(vert);
  return g;
}

const SPECIAL_BUILDERS = { slab:buildSlab, taper:buildTaper, comb:buildComb, split:buildSplit,
                            spike:buildSpike, dots:buildDots, bracket:buildBracket };
// [max,min] для RI() — только у билдеров со случайным числом элементов
const SPECIAL_COUNT_RANGE = { comb:[9,6], spike:[6,4], dots:[7,4] };
const CURVE_PRESETS = Object.keys(CURVE_PROFILES);

export const PRESETS = [...CURVE_PRESETS, 'unibrow', ...Object.keys(SPECIAL_BUILDERS)];

// объёмные брови-«характер» — не трекают форму реальных бровей (пресет
// фиксирован из сида), но точка посадки — от живого верхнего края кольца
// глаза (см. updateGeometry), иначе на крупных сборках глаз брови наезжают.
// Пересоздаются целиком на каждый generate(), как shards/eyes.
// Обе стороны ВСЕГДА зеркальны — асимметричных пресетов нет.
export function create(ctx){
  const { palette: cols } = ctx;

  const preset = pick(PRESETS);
  const color = contrastToSkin(cols);
  const group = new THREE.Group();

  let rightMesh, leftMesh, isUnibrow = false;

  if (preset === 'unibrow'){
    isUnibrow = true;
    const pts = [
      new THREE.Vector3(-OUTER_X, 0, BROW_Z),
      new THREE.Vector3(-INNER_X, .02, BROW_Z),
      new THREE.Vector3(0, -.015, BROW_Z),
      new THREE.Vector3(INNER_X, .02, BROW_Z),
      new THREE.Vector3(OUTER_X, 0, BROW_Z),
    ];
    const curve = new THREE.CatmullRomCurve3(pts);
    const geo = new THREE.TubeGeometry(curve, 48, .07, 8, false);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
    group.add(mesh);
    rightMesh = leftMesh = mesh; // единая форма — обе "стороны" это один объект
  } else if (preset in SPECIAL_BUILDERS){
    // count-параметр (число зубцов/точек/штрихов) решается ОДИН раз и
    // передаётся в обе стороны — иначе RI() внутри билдера читает общий
    // поток дважды подряд и правая/левая брови получают разное количество
    // элементов, что ломает симметрию не хуже skeptical.
    const countRange = SPECIAL_COUNT_RANGE[preset];
    const n = countRange ? RI(countRange[0], countRange[1]) : undefined;
    rightMesh = SPECIAL_BUILDERS[preset](false, color, n);
    leftMesh  = SPECIAL_BUILDERS[preset](true, color, n);
    rightMesh.position.x = -INNER_X; rightMesh.position.z = BROW_Z;
    leftMesh.position.x = INNER_X; leftMesh.position.z = BROW_Z;
    group.add(rightMesh, leftMesh);
  } else {
    rightMesh = makeCurveBrow(preset, false, color);
    leftMesh  = makeCurveBrow(preset, true, color);
    rightMesh.position.set(-INNER_X, 0, BROW_Z);
    leftMesh.position.set(INNER_X, 0, BROW_Z);
    group.add(rightMesh, leftMesh);
  }

  const _inv = new THREE.Matrix4();
  const _wp = new THREE.Vector3();

  return {
    object3D: group,
    presetName: preset,

    // точка посадки — верхний край кольца своего глаза (в anchor-local,
    // через инверсию anchor.matrixWorld — та же техника, что в eyes.js)
    // плюс фиксированный зазор GAP. Форма пресета не меняется, меняется
    // только высота посадки.
    updateGeometry(landmarks, aspect, anchor){
      _inv.copy(anchor.matrixWorld).invert();
      toWorld(landmarks[EYE_TOP_RIGHT], aspect, _wp);
      const rightY = _wp.applyMatrix4(_inv).y;
      toWorld(landmarks[EYE_TOP_LEFT], aspect, _wp);
      const leftY = _wp.applyMatrix4(_inv).y;

      if (isUnibrow){
        rightMesh.position.y = (rightY+leftY)/2 + GAP;
      } else {
        rightMesh.position.y = rightY + GAP;
        leftMesh.position.y = leftY + GAP;
      }
    },

    // browDownLeft/Right — лёгкая модуляция наклона, не подмена пресета.
    // Симметрично: берём среднее от обеих сторон, а не каждую отдельно —
    // иначе получаем скрытую асимметрию, а её быть не должно (см. п.2).
    update(browDownLeft, browDownRight){
      const maxTilt = THREE.MathUtils.degToRad(8);
      const avg = ((browDownLeft||0) + (browDownRight||0)) / 2;
      rightMesh.rotation.z = avg * maxTilt;
      if (!isUnibrow) leftMesh.rotation.z = -avg * maxTilt;
    },

    dispose(){
      group.traverse(o=>{ o.geometry?.dispose(); o.material?.dispose?.(); });
    }
  };
}
