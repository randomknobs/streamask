import * as THREE from 'three';
import { R, RI, pick } from '../rng.js';
import { GLSL_SOURCE, pickPattern, pickContrastingPair } from '../texture/patterns.js';

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

// Геометрическая проверка "внутри головы", НЕ по высоте. y=0 — точка
// крепления (лоб), но макушка физически ВЫШЕ этой линии — старая проверка
// "ниже y=0 → solid" пропускала wireframe/glass прямо над головой, где под
// ними всё ещё волосы. Правильный тест — пересечение bbox со сферой головы:
// центр чуть выше точки крепления (лоб не в центре черепа, а спереди-сверху),
// радиус — реальный радиус построенной шапочки, не независимая константа.
const HEAD_UP_OFFSET_FRAC = .3;

export function makeHeadSphere(capRadius){
  return new THREE.Sphere(new THREE.Vector3(0, capRadius*HEAD_UP_OFFSET_FRAC, 0), capRadius);
}

function meshIntersectsHead(mesh, headSphere){
  mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox.clone();
  mesh.updateMatrix();
  box.applyMatrix4(mesh.matrix);
  return box.intersectsSphere(headSphere); // касание тоже считается пересечением
}

function kindForMesh(mesh, headSphere){
  return meshIntersectsHead(mesh, headSphere) ? 'solid' : pickKind();
}

function finishMesh(mesh, cols, headSphere){
  mesh.material = makeMaterial(kindForMesh(mesh, headSphere), pick(cols));
  return mesh;
}

// Гарантирует, что у каждого меша есть пересечение (не просто касание) с
// ближайшим соседом — не менее minFrac от собственного габарита (диаметра
// bounding sphere). Иначе в щели между отдельными элементами силуэта видно,
// что под ними (волосы/фон). Работает по позиции (подтягивает элемент к
// соседу) — это единственный универсальный способ для всех 8 семейств;
// доворот угла как альтернатива не реализован обобщённо (см. итоговое
// сообщение) — он специфичен для формы элемента и не переносится
// автоматически между конусами/торами/трубами.
function ensureOverlap(meshes, minFrac = .15){
  if (meshes.length < 2) return;

  const spheres = meshes.map(m => {
    m.geometry.computeBoundingBox();
    const box = m.geometry.boundingBox.clone();
    m.updateMatrix();
    box.applyMatrix4(m.matrix);
    const sphere = new THREE.Sphere();
    box.getBoundingSphere(sphere);
    return sphere;
  });

  for (let i=0;i<meshes.length;i++){
    let bestJ = -1, bestDist = Infinity;
    for (let j=0;j<meshes.length;j++){
      if (j===i) continue;
      const d = spheres[i].center.distanceTo(spheres[j].center);
      if (d < bestDist){ bestDist = d; bestJ = j; }
    }
    if (bestJ === -1) continue;

    const rA = spheres[i].radius, rB = spheres[bestJ].radius;
    const required = minFrac * (rA*2);
    const overlap = rA + rB - bestDist;

    if (overlap < required){
      const shiftNeeded = required - overlap;
      const dir = new THREE.Vector3().subVectors(spheres[bestJ].center, spheres[i].center);
      if (dir.lengthSq() < 1e-8) dir.set(1,0,0);
      dir.normalize().multiplyScalar(shiftNeeded);
      meshes[i].position.add(dir);
      spheres[i].center.add(dir);
    }
  }
}

/* ────────────────────────── силуэтные семейства ───────────────────────── */
// Каждая функция строит основу в локальных координатах группы (y=0 — точка
// крепления, лоб). Симметрия обязательна — либо форма сама рационально-
// симметрична (dome/halo/rays/tiers), либо строится на одну сторону и
// зеркалится явно (horns).
// Материал каждого меша решается ПОСЛЕ позиционирования (finishMesh) — нужна
// финальная позиция, чтобы проверить пересечение со сферой головы (headSphere).
// Overlap-проверка (ensureOverlap) применяется только там, где несколько
// раздельных элементов физически МОГУТ повиснуть с зазором — не для
// одноблочных форм (dome/crest) и не для horns (два рога по разные стороны
// головы обязаны оставаться раздельными по замыслу, не сливаться).

function addDome(radius, cols, group, headSphere){
  const thetaLen = Math.PI*.55;
  const faceted = R()<.5;
  const wSeg = faceted ? RI(10,6) : RI(28,16);
  const hSeg = faceted ? RI(6,4) : RI(16,8);
  const geo = new THREE.SphereGeometry(radius, wSeg, hSeg, 0, Math.PI*2, 0, thetaLen);
  const rimY = radius*Math.cos(thetaLen); // может быть отрицательным — купол чуть ниже экватора сферы
  geo.translate(0, -rimY, 0);
  const mesh = new THREE.Mesh(geo);
  finishMesh(mesh, cols, headSphere);
  if ('flatShading' in mesh.material) mesh.material.flatShading = faceted;
  group.add(mesh);
}

function addCrest(radius, cols, group, headSphere){
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
  group.add(finishMesh(new THREE.Mesh(geo), cols, headSphere));
}

function addHalo(radius, cols, group, headSphere){
  const n = RI(3,1);
  const meshes = [];
  for (let i=0;i<n;i++){
    const r = radius*R(1.1,.75);
    const tube = radius*R(.09,.03);
    const geo = new THREE.TorusGeometry(r, tube, 10, 28);
    const mesh = new THREE.Mesh(geo);
    mesh.rotation.x = Math.PI/2 + R(.6,-.6);
    mesh.rotation.z = R(.6,-.6);
    mesh.position.y = radius*R(.9,.5) + i*radius*.15;
    meshes.push(mesh);
  }
  ensureOverlap(meshes);
  for (const m of meshes){ finishMesh(m, cols, headSphere); group.add(m); }
}

function addRays(radius, cols, group, headSphere){
  const n = RI(25,8);
  const meshes = [];
  for (let i=0;i<n;i++){
    const a = (i/n)*Math.PI*2;
    const len = radius*R(1.1,.4);
    const geo = new THREE.ConeGeometry(radius*R(.12,.04), len, 6);
    const mesh = new THREE.Mesh(geo);
    const outwardTilt = R(.9,.3);
    mesh.rotation.order = 'YXZ';
    mesh.rotation.y = -a;
    mesh.rotation.x = outwardTilt;
    mesh.position.set(Math.cos(a)*radius*.6, radius*.5, Math.sin(a)*radius*.6);
    meshes.push(mesh);
  }
  ensureOverlap(meshes);
  for (const m of meshes){ finishMesh(m, cols, headSphere); group.add(m); }
}

function addTiers(radius, cols, group, headSphere){
  const n = RI(5,2);
  const meshes = [];
  let y = 0;
  for (let i=0;i<n;i++){
    const rTop = Math.max(.06, radius*(1-(i+1)/n)*.85);
    const rBot = Math.max(.1, radius*(1-i/n)*.85);
    const h = radius*R(.5,.25);
    const geo = new THREE.CylinderGeometry(rTop, rBot, h, RI(10,6));
    const mesh = new THREE.Mesh(geo);
    mesh.position.y = y + h/2;
    meshes.push(mesh);
    y += h;
  }
  // ярусы и так стоят строго друг на друге (низ следующего = верх предыдущего)
  // — касание, не пересечение. ensureOverlap подтянет их внахлёст.
  ensureOverlap(meshes);
  for (const m of meshes){ finishMesh(m, cols, headSphere); group.add(m); }
}

function addHorns(radius, cols, group, headSphere){
  const outward = R()<.5;
  const pts = [
    new THREE.Vector3(radius*.5, radius*.2, 0),
    new THREE.Vector3(radius*.7, radius*.5, radius*.1),
    new THREE.Vector3(outward?radius*1.1:radius*.6, outward?radius*.6:radius*1.2, radius*.15),
  ];
  const curve = new THREE.CatmullRomCurve3(pts);
  const geo = new THREE.TubeGeometry(curve, 24, radius*R(.12,.06), 8, false);
  const right = new THREE.Mesh(geo);
  finishMesh(right, cols, headSphere);
  group.add(right);
  const left = right.clone();
  left.scale.x = -1;
  group.add(left);
}

function addWrap(radius, cols, group, headSphere){
  const n = RI(4,2);
  const meshes = [];
  for (let i=0;i<n;i++){
    const r = radius*R(1.05,.85);
    const tube = radius*R(.05,.02);
    const geo = new THREE.TorusGeometry(r, tube, 8, 32);
    const mesh = new THREE.Mesh(geo);
    mesh.rotation.x = Math.PI/2 + R(.5,-.5);
    mesh.rotation.y = R(3.14,0);
    mesh.position.y = radius*R(.6,.15);
    meshes.push(mesh);
  }
  ensureOverlap(meshes);
  for (const m of meshes){ finishMesh(m, cols, headSphere); group.add(m); }
}

function addPlume(radius, cols, group, headSphere){
  const n = RI(9,4);
  const meshes = [];
  for (let i=0;i<n;i++){
    const spread = n>1 ? (i/(n-1)-.5)*1.2 : 0;
    const len = radius*R(1.6,.7);
    const geo = new THREE.ConeGeometry(radius*R(.07,.03), len, 5);
    const mesh = new THREE.Mesh(geo);
    mesh.rotation.order = 'YXZ';
    mesh.rotation.y = spread*.6;
    mesh.rotation.x = -.6 + spread*.3;
    mesh.position.set(Math.sin(spread)*radius*.3, radius*.4, -radius*.5);
    meshes.push(mesh);
  }
  ensureOverlap(meshes);
  for (const m of meshes){ finishMesh(m, cols, headSphere); group.add(m); }
}

const FAMILIES = { dome:addDome, crest:addCrest, halo:addHalo, rays:addRays,
                    tiers:addTiers, horns:addHorns, wrap:addWrap, plume:addPlume };

/* ────────────────────────── шапочка (фаза 8b) ──────────────────────────
   Обязательная база под ВСЕ семейства — плотно облегающая голову форма,
   семейство ставится поверх неё. Без неё горны/гало/плюм/гребень/лучи не
   держат силуэт и волосы остаются открыты по бокам. Форма шапочки — своё,
   независимое от силуэтного семейства, семейство из сида.
   Всегда непрозрачная (текстура двухцветная, но alpha=1 всегда) — она
   должна реально перекрывать, а не просвечивать. */
const CAP_FAMILIES = ['dome','low','deep','cone','box','bulb','flat','segments'];
// low/flat физически перекрывают меньше всего — там бахрома обязательна
// (см. create(), fringeChance), а не просто желательна.
export const CAP_SPARSE = new Set(['low','flat']);
// на гранёных/раздельных формах мелкий паттерн превращается в кашу —
// см. "Соответствие" в спеке.
const CAP_LARGE_SCALE_ONLY = new Set(['box','segments']);

function capSphereCap(radius, thetaLen, drop){
  const geo = new THREE.SphereGeometry(radius, 24, 16, 0, Math.PI*2, 0, thetaLen);
  const rimY = radius*Math.cos(thetaLen);
  geo.translate(0, -rimY-drop, 0);
  return geo;
}

function buildCapDome(radius){ return capSphereCap(radius, Math.PI*.62, .5); }
function buildCapLow(radius){ return capSphereCap(radius, Math.PI*.42, .1); }
function buildCapDeep(radius){ return capSphereCap(radius, Math.PI*.72, 1.0); }

function buildCapCone(radius, height){
  const DROP = .5;
  const geo = new THREE.CylinderGeometry(radius*.12, radius, height, 20);
  geo.translate(0, height/2-DROP, 0); // широкое основание (низ) на y=-DROP
  return geo;
}

// низкополигональная сфера — сама угловатость сегментов и есть "грань"
function buildCapBox(radius){
  const facets = RI(9,5); // 5-8, как в спеке
  const thetaLen = Math.PI*.58;
  const geo = new THREE.SphereGeometry(radius, facets, Math.max(3,Math.round(facets*.6)), 0, Math.PI*2, 0, thetaLen);
  const rimY = radius*Math.cos(thetaLen);
  geo.translate(0, -rimY-.5, 0);
  return geo;
}

// луковица — LatheGeometry по явному профилю (шире середины, чем у рима)
function buildCapBulb(radius, height){
  const DROP = .5;
  const pts = [
    new THREE.Vector2(radius*.55, -DROP),
    new THREE.Vector2(radius*.95, -DROP+height*.18),
    new THREE.Vector2(radius*1.05, -DROP+height*.42),
    new THREE.Vector2(radius*.7, -DROP+height*.75),
    new THREE.Vector2(Math.max(.02,radius*.05), -DROP+height),
  ];
  return new THREE.LatheGeometry(pts, 24);
}

// плоский диск с коротким бортиком — "height" здесь намеренно почти не
// используется (иначе противоречит "плоский"), бортик всегда низкий.
function buildCapFlat(radius){
  const DROP = .08;
  const rimHeight = radius*.14;
  const geo = new THREE.CylinderGeometry(radius, radius*.96, rimHeight, 24);
  geo.translate(0, rimHeight/2-DROP, 0);
  return geo;
}

// возвращает МАССИВ геометрий (не одна) — доли с зазорами, не единая форма
function buildCapSegmentsGeoms(radius, height){
  const n = RI(9,4); // 4-8
  const gapFraction = .12;
  const thetaLen = Math.PI*.58;
  const rimY = radius*Math.cos(thetaLen);
  const segAngle = (Math.PI*2/n)*(1-gapFraction);
  const geoms = [];
  for (let i=0;i<n;i++){
    const phiStart = (i/n)*Math.PI*2;
    const geo = new THREE.SphereGeometry(radius, 6, 10, phiStart, segAngle, 0, thetaLen);
    geo.translate(0, -rimY-.5, 0);
    geoms.push(geo);
  }
  return geoms;
}

function addCapShape(shape, radius, height, material, group){
  if (shape === 'segments'){
    for (const geo of buildCapSegmentsGeoms(radius, height)) group.add(new THREE.Mesh(geo, material));
    return;
  }
  const geo = {
    dome: () => buildCapDome(radius),
    low: () => buildCapLow(radius),
    deep: () => buildCapDeep(radius),
    cone: () => buildCapCone(radius, height),
    box: () => buildCapBox(radius),
    bulb: () => buildCapBulb(radius, height),
    flat: () => buildCapFlat(radius),
  }[shape]();
  group.add(new THREE.Mesh(geo, material));
}

// Кастомный ShaderMaterial — не через makeMaterial(), потому что паттерн
// это не однотонная заливка. Цвета НЕ конвертируются в linear (в отличие
// от instanceColor у бахромы/осколков) — это сырой ShaderMaterial мимо
// автоматического colorspace-пайплайна three.js, тот же случай, что и
// шейдер кожи в skin.js (см. фаза 1, п.7 — там разбор именно этой разницы).
function makeCapMaterial(patternInfo, bg, fg){
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: {
      bgColor: { value: bg.clone() },
      fgColor: { value: fg.clone() },
      patternId: { value: patternInfo.id },
      patternParams: { value: new THREE.Vector4(...patternInfo.params) },
    },
    vertexShader: `varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `precision highp float;
      uniform vec3 bgColor, fgColor; uniform int patternId; uniform vec4 patternParams;
      varying vec2 vUv;
      ${GLSL_SOURCE}
      void main(){
        float m = patternById(patternId, vUv, patternParams);
        gl_FragColor = vec4(mix(bgColor, fgColor, m), 1.0);
      }`,
    extensions: { derivatives: true }
  });
}

// возвращает { shape, group: THREE.Group с формой+текстурой }, плюс метаданные
// (patternInfo, contrastRetried) — нужны наружу для проверки в create().
function buildCap(cols){
  const shape = pick(CAP_FAMILIES);
  const radius = R(1.5,.95);
  const height = radius * R(1.6,.7);

  const rngLike = { R, RI, pick };
  const patternInfo = pickPattern(rngLike, { largeScaleOnly: CAP_LARGE_SCALE_ONLY.has(shape) });
  // palette.js теперь разводит светлоту явными слотами по 0.25..0.8
  // (было l*R(1.15,.8) — кучковало все цвета, отсюда и временное снижение
  // порога до 0.15). С разведённой светлотой 0.25 достижим — см. node-проверку.
  const { bg, fg, tries } = pickContrastingPair(rngLike, cols, .25);
  const material = makeCapMaterial(patternInfo, bg, fg);

  const capGroup = new THREE.Group();
  capGroup.rotation.x = THREE.MathUtils.degToRad(R(15,0) * (R()<.5?-1:1));
  addCapShape(shape, radius, height, material, capGroup);

  return { shape, radius, group: capGroup, patternName: patternInfo.name, contrastRetried: tries > 1, bg, fg };
}

/* ────────────────────────── бахрома ────────────────────────────────────
   ~60% масок по умолчанию, но 100% для семейств с маленькой площадью
   (horns/halo/plume) — сами по себе они силуэт не держат, без бахромы
   волосы остаются открыты по бокам. Инстансим — до 80 элементов на маску,
   иначе просядет fps. Она в зоне волос по определению (свисает вдоль
   висков) — всегда solid, никогда glass/wire, см. п.2 разбора зазоров. */
function addFringe(radius, cols, group, chance){
  if (R() >= chance) return;

  const perSide = RI(41,10);
  const total = perSide*2;
  const geo = new THREE.ConeGeometry(radius*.025, 1, 5);
  const mat = makeMaterial('solid', 0xffffff);
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
   намеренно асимметричные (см. asymRate). Позиция всегда y>0 (радиус*0.2..1.1)
   по построению, но зональность решаем через finishMesh, а не полагаемся
   на это — так же, как и остальные семейства. */
const DECOR_GEOMS = [
  ()=> new THREE.SphereGeometry(1, RI(12,6), RI(8,5)),
  ()=> new THREE.RingGeometry(.5, 1, RI(16,8)),
  ()=> new THREE.IcosahedronGeometry(1, RI(2)),
  ()=> new THREE.OctahedronGeometry(1, 0),
  ()=> new THREE.CircleGeometry(1, RI(8,5)),
];

function addDecor(radius, cols, group, headSphere){
  const count = RI(13,0);
  const asymRate = .2;
  for (let i=0;i<count;i++){
    const geo = pick(DECOR_GEOMS)();
    const s = radius*R(.14,.05);
    const mesh = new THREE.Mesh(geo);
    const a = R(Math.PI*2), r = radius*R(1.0,.6), y = radius*R(1.1,.2);
    mesh.scale.setScalar(s);
    mesh.position.set(Math.cos(a)*r, y, Math.sin(a)*r);
    mesh.rotation.set(R(6.28),R(6.28),R(6.28));
    mesh.userData.crownPart = 'decor'; // для отладки/проверки — decor не входит в overlap-гарантию силуэта

    const willMirror = R() >= asymRate && Math.abs(mesh.position.x) > 1e-3;
    let mirror = null;
    if (willMirror){
      mirror = mesh.clone();
      mirror.position.x *= -1;
      // случайный 3D-поворот (см. выше) делает bbox несимметричным — зеркало
      // по одной лишь позиции НЕ является честным геометрическим отражением
      // (в отличие от horns, где зеркалит scale.x саму геометрию). Проверку
      // прохождения оригиналом нельзя переносить на копию без пересчёта —
      // нашёл на 1000 сидов ровно этот случай: оригинал снаружи сферы,
      // зеркало от сдвига чуть задело её. Поэтому проверяем ОБЕ позиции.
    }
    const kind = (meshIntersectsHead(mesh, headSphere) || (mirror && meshIntersectsHead(mirror, headSphere)))
      ? 'solid' : pickKind();
    const material = makeMaterial(kind, pick(cols));
    mesh.material = material;
    group.add(mesh);

    if (mirror){
      mirror.material = material;
      group.add(mirror);
    }
  }
}

// головной убор — жёстко крепится к анкеру, фиксированная поза из сида,
// на blendshapes не реагирует (вся жизнь — от движения головы через анкер).
// Полностью пересоздаётся на каждый generate(), как shards/eyes/brows.
const SPARSE_FAMILIES = new Set(['horns','halo','plume']);

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

  const cap = buildCap(crownCols);
  group.add(cap.group);

  // сфера головы для проверки "что реально снаружи, а что нет" — центр чуть
  // выше точки крепления (лоб не в центре черепа), радиус — РЕАЛЬНЫЙ радиус
  // построенной шапочки, не независимая константа. См. kindForMesh/finishMesh.
  const headSphere = makeHeadSphere(cap.radius);

  // цвета шапочки (фон+узор) — не те же, что у семейства, иначе сольются в
  // одно пятно. Гарантия строгая: обе задействованные точки палитры
  // исключаются из пула семейства целиком, а не просто "авось не совпадёт".
  const familyCols = crownCols.filter(c => c !== cap.bg && c !== cap.fg);

  FAMILIES[familyName](radius, familyCols, group, headSphere);

  // low/flat физически прикрывают меньше всего — бахрома там обязательна,
  // а не просто вероятна, как у "пустых" силуэтных семейств.
  const fringeChance = (SPARSE_FAMILIES.has(familyName) || CAP_SPARSE.has(cap.shape)) ? 1.0 : .6;
  addFringe(radius, crownCols, group, fringeChance);
  addDecor(radius, crownCols, group, headSphere);

  return {
    object3D: group,
    familyName,
    capShape: cap.shape,
    capRadius: cap.radius,
    capPattern: cap.patternName,
    capContrastRetried: cap.contrastRetried,
    dispose(){ group.traverse(o=>{ o.geometry?.dispose(); o.material?.dispose?.(); }); }
  };
}
