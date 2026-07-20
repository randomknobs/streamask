import * as THREE from 'three';
import { reseed, seedFrom } from './rng.js';
import { palette } from './palette.js';
import { loadLandmarker, createFaceTracker, createBlendshapeSmoother, createLandmarkSmoother } from './tracking.js';
import * as skinLayer from './layers/skin.js';
import * as shardsLayer from './layers/shards.js';
import * as mouthLayer from './layers/mouth.js';
import * as eyesLayer from './layers/eyes.js';
import * as browsLayer from './layers/brows.js';
import * as crownLayer from './layers/crown.js';
import { setupUI } from './ui.js';
import * as storage from './storage.js';
import { createRecorder, dataUrlToBlobSync, extensionForMime } from './record.js';

const $ = id => document.getElementById(id);
const video = $('cam'), canvas = $('gl'), statusEl = $('status'), errEl = $('err');

/* ────────────────────────── three setup ───────────────────────── */
// preserveDrawingBuffer:true — фаза 6 читает этот канвас из record.js на
// requestVideoFrameCallback, отдельном от основного цикла рендера коллбэке
// (нарочно, см. record.js: так композит идёт по кадрам камеры, а не по
// герцовке дисплея). Без preserveDrawingBuffer браузер вправе очистить
// буфер сразу после renderer.render() и до того, как rVFC успеет его
// прочитать — композит ловил бы случайные пустые кадры.
const renderer = new THREE.WebGLRenderer({canvas, alpha:true, antialias:true, preserveDrawingBuffer:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1,1,1,-1,-10,10);

scene.add(new THREE.AmbientLight(0xffffff,1.1));
const d1 = new THREE.DirectionalLight(0xffffff,1.4); d1.position.set(1,1,2); scene.add(d1);
const d2 = new THREE.DirectionalLight(0x88aaff,.7); d2.position.set(-1.5,-.5,1); scene.add(d2);

// анкер лица: локальные координаты, 1.0 = межзрачковое расстояние
const anchor = new THREE.Group();
anchor.matrixAutoUpdate = false;
scene.add(anchor);

const tracker = createFaceTracker();
const blend = createBlendshapeSmoother();
const lmSmoother = createLandmarkSmoother();
const recorder = createRecorder({ video, glCanvas: canvas });

/* ────────────────────────── генератор маски ───────────────────── */
let skin = null;
let shards = null;
let mouth = null;
let eyes = null;
let brows = null;
let crown = null;
let currentSeed = '';

function generate(seedStr){
  if(shards){ anchor.remove(shards.object3D); shards.dispose(); }
  if(eyes){ anchor.remove(eyes.object3D); eyes.dispose(); }
  if(brows){ anchor.remove(brows.object3D); brows.dispose(); }
  if(crown){ anchor.remove(crown.object3D); crown.dispose(); }

  currentSeed = seedStr || Math.random().toString(36).slice(2,9);
  const seedNum = seedFrom(currentSeed);
  reseed(seedNum);
  // сид больше не дублируется в панели — живёт в хеше урла и в строке fps
  // внизу (см. loop()).
  location.hash = currentSeed;

  const cols = palette();

  shards = shardsLayer.create({ scene, palette: cols, params: { density: shardDensityOverride ?? 1 } });
  anchor.add(shards.object3D);
  shards.object3D.visible = showShards;

  eyes = eyesLayer.create({ palette: cols, params: {}, seedNum });
  anchor.add(eyes.object3D);

  brows = browsLayer.create({ palette: cols, params: {} });
  anchor.add(brows.object3D);

  crown = crownLayer.create({ palette: cols, params: {} });
  anchor.add(crown.object3D);
  crown.object3D.visible = showCrown;

  skin.applyPalette(cols);
  mouth.applyPalette(cols);
}

// пересобрать ТОЛЬКО осколки на текущем сиде с новым density, не трогая
// остальные слои — безопасно, потому что shards.create() тратит одинаковое
// число случайных чисел независимо от density (см. shards.js), так что
// позиция в общем rnd после неё не меняется и crown/brows не поедут.
function regenerateShardsOnly(){
  if (!shards) return;
  reseed(seedFrom(currentSeed));
  const cols = palette();
  anchor.remove(shards.object3D);
  shards.dispose();
  shards = shardsLayer.create({ scene, palette: cols, params: { density: shardDensityOverride ?? 1 } });
  anchor.add(shards.object3D);
  shards.object3D.visible = showShards;
}

/* ────────────────────────── фаза 5: сохранение/рекол ────────────── */
// Собирает только РУЧНЫЕ оверрайды (не в сид) — всё остальное детерми-
// нированно восстанавливается из seed при generate(). Пустые (null,
// нетронутые) слайдеры в объект не попадают — сравни с skin.js/shards.js,
// где override===null означает "бери сгенерированное".
function getOverrideParams(){
  const p = {};
  if (skinExtensionOverride !== null) p.skinExtension = skinExtensionOverride;
  if (skinWidthOverride !== null) p.skinWidth = skinWidthOverride;
  if (shardDensityOverride !== null) p.density = shardDensityOverride;
  return p;
}

// Обратная операция — восстанавливает состояние оверрайдов ИЗ сохранённых
// параметров (ключей может не быть — тогда конкретный слайдер возвращается
// в null, "бери сгенерированное", а не остаётся от предыдущей маски).
function applyOverrideParams(p){
  skinExtensionOverride = p.skinExtension ?? null;
  skinWidthOverride = p.skinWidth ?? null;
  shardDensityOverride = p.density ?? null;
  if (skin){
    skin.setExtensionOverride(skinExtensionOverride);
    skin.setWidthExtensionOverride(skinWidthOverride);
  }
  // density применяется через generate() -> shards.create({params:{density}}),
  // отдельного вызова на существующий объект shards не требуется.

  // слайдеры визуально отражают то, что реально применилось; нетронутые в
  // сохранённой маске параметры не трогаем — их эффективное значение и так
  // не зависит от текущего положения бегунка (override===null).
  if (p.skinExtension != null) $('skinExtension').value = p.skinExtension;
  if (p.skinWidth != null) $('skinWidth').value = p.skinWidth;
  if (p.density != null) $('density').value = p.density;
}

function recall(entry){
  applyOverrideParams(entry.params || {});
  generate(entry.seed);
}

// вызывается из loop() СРАЗУ после renderer.render(), пока буфер WebGL
// точно валиден — canvas создан без preserveDrawingBuffer, так что
// toDataURL/drawImage из обработчика клика (вне цикла рендера) рискует
// поймать уже очищенный браузером буфер вместо текущего кадра.
let pendingSave = false;
function captureThumbnail(){
  const off = document.createElement('canvas');
  off.width = storage.STORAGE_THUMB_MAX_PX; off.height = storage.STORAGE_THUMB_MAX_PX;
  const octx = off.getContext('2d');
  const cw = canvas.width, ch = canvas.height;
  const side = Math.min(cw, ch) || 1;
  const sx = (cw-side)/2, sy = (ch-side)/2;
  octx.drawImage(canvas, sx, sy, side, side, 0, 0, off.width, off.height);
  return off.toDataURL('image/jpeg', 0.6);
}

function doSave(){
  const entry = { seed: currentSeed, name: currentSeed, ts: Date.now(),
                  thumb: captureThumbnail(), params: getOverrideParams() };
  const res = storage.add(entry);
  if (!res.ok){
    if (res.reason === 'limit') alert(`Reached the limit of ${res.limit} masks (currently ${res.current}). Delete something to save a new one.`);
    else if (res.reason === 'quota') alert('The browser refused to save (localStorage is full). Delete a few masks to free up space.');
    else alert('Could not save the mask.');
    return;
  }
  renderGallery();
}

function renderGallery(){
  const gal = $('gallery');
  gal.innerHTML = '';
  const items = storage.list();
  const countText = `${items.length}/${storage.STORAGE_LIMIT}`;
  $('galleryCount').textContent = countText;
  $('galleryModalCount').textContent = countText;
  for (const entry of items.slice().reverse()){ // новые сверху
    const el = document.createElement('div');
    el.className = 'thumb';
    el.title = entry.name;

    const img = document.createElement('img');
    img.src = entry.thumb;
    img.alt = entry.name;

    const nameEl = document.createElement('div');
    nameEl.className = 'thumb-name';
    nameEl.textContent = entry.name;

    const delBtn = document.createElement('button');
    delBtn.className = 'thumb-del';
    delBtn.textContent = '×';
    delBtn.title = 'delete';
    delBtn.onclick = e => { e.stopPropagation(); storage.remove(entry.ts); renderGallery(); };

    el.append(img, nameEl, delBtn);
    el.onclick = () => { recall(entry); closeCollection(); };
    el.ondblclick = () => {
      const newName = prompt('New mask name:', entry.name);
      if (newName){ storage.rename(entry.ts, newName); renderGallery(); }
    };
    gal.appendChild(el);
  }
}

function openCollection(){
  $('galleryModal').classList.remove('modal-hidden');
}
function closeCollection(){
  $('galleryModal').classList.add('modal-hidden');
}

/* ────────────────────── фаза 6/6b: запись и «поделиться» ───────── */
function formatTime(sec){
  const m = Math.floor(sec/60), s = Math.floor(sec%60);
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

let micStreamForRecording = null;

async function toggleRecording(){
  if (recorder.isRecording){
    recorder.stopRecording();
    return;
  }

  const wantMic = $('micToggle').checked;
  const transparent = $('transparentToggle').checked;
  micStreamForRecording = null;
  if (wantMic){
    try {
      micStreamForRecording = await navigator.mediaDevices.getUserMedia({ audio:true });
    } catch(e){
      console.error(e);
      alert('Could not access the microphone: ' + e.message + '. Recording without audio.');
    }
  }

  const started = recorder.startRecording({
    micStream: micStreamForRecording,
    transparent,
    onTick: sec => { $('recTimer').textContent = formatTime(sec); },
    onStop: (blob, mime) => {
      $('recStatus').style.display = 'none';
      $('record').classList.remove('on');
      $('record').textContent = '● record (V)';
      $('recFormatNote').style.display = 'none';
      if (micStreamForRecording){ micStreamForRecording.getTracks().forEach(t=>t.stop()); micStreamForRecording = null; }
      downloadBlob(blob, `streamask-${currentSeed}-${Date.now()}.${extensionForMime(mime)}`);
      updateShareButtonLabel();
    },
    onWarnLong: () => alert('Recording has passed 10 minutes - consider stopping soon, long recordings use a lot of memory.'),
  });

  if (!started){
    alert('Recording is not supported in this browser.');
    if (micStreamForRecording){ micStreamForRecording.getTracks().forEach(t=>t.stop()); micStreamForRecording = null; }
    return;
  }

  $('recStatus').style.display = 'flex';
  $('recTimer').textContent = '00:00';
  $('record').classList.add('on');
  $('record').textContent = '● stop (V)';
  if (recorder.usingMp4Fallback){
    $('recFormatNote').textContent = 'mp4 not supported here — recording webm instead';
    $('recFormatNote').style.display = 'block';
  }
  if (recorder.transparentFallbackActive){
    alert("This browser's encoder does not support a transparent background - recording on a green background instead.");
  }
}

// Держим готовый PNG-снимок ПОСЛЕДНЕГО кадра заранее (обновляется здесь, в
// фоне, throttled), а не готовим его в обработчике клика share — раньше
// doShare делал canvas.toDataURL + декодирование base64 ПОСЛЕ клика, и хотя
// сам по себе этот путь синхронный (без await), в реальных браузерах этого
// оказалось достаточно, чтобы потерять transient activation клика и словить
// NotAllowedError на navigator.share(). Теперь клик не делает вообще ничего,
// кроме чтения уже готового File и вызова share().
let latestSnapshotFile = null;
let lastSnapshotRefreshTs = 0;
const SNAPSHOT_REFRESH_MS = 1000;

function refreshLatestSnapshot(){
  const dataUrl = recorder.snapshotDataUrl({ transparent: $('transparentToggle').checked });
  const blob = dataUrlToBlobSync(dataUrl);
  latestSnapshotFile = new File([blob], `streamask-${currentSeed}.png`, { type:'image/png' });
}

// canShare — проверяем ИМЕННО через canShare({files}), не по user-agent
// (десктопный Chrome файлы не поддерживает вовсе, мобильные и Safari на
// macOS — да, и это не всегда совпадает с тем, что можно было бы угадать
// по UA).
function canShareFiles(mimeType){
  try { return !!navigator.canShare?.({ files:[new File([], 'probe', { type:mimeType })] }); }
  catch(e){ return false; }
}

function updateShareButtonLabel(){
  const mime = recorder.lastBlob ? (recorder.lastMime || 'video/webm') : 'image/png';
  $('share').textContent = canShareFiles(mime) ? 'share' : 'download';
}

// navigator.share() обязан вызываться синхронно из обработчика реального
// клика, без единого await до самого вызова — иначе браузер тихо отклоняет
// его как не идущий от жеста пользователя. file здесь уже готов заранее
// (см. refreshLatestSnapshot/onStop), само тело функции не делает ничего
// асинхронного до share().
function doShare(){
  const file = recorder.lastBlob
    ? new File([recorder.lastBlob], `streamask-${currentSeed}.${extensionForMime(recorder.lastMime)}`,
                { type: recorder.lastMime || 'video/webm' })
    : latestSnapshotFile;

  if (!file){
    alert('No frame ready yet - try again in a moment.');
    return;
  }

  const shareText = `seed: ${currentSeed}\nhttps://randomknobs.github.io/streamask/#${currentSeed}`;

  if (navigator.canShare?.({ files:[file] })){
    navigator.share({ files:[file], title:'streamask', text:shareText }).catch(e => {
      // отмену шаринга пользователем не показываем как ошибку
      if (e.name !== 'AbortError') console.error(e);
    });
  } else {
    downloadBlob(file, file.name);
  }
}

/* ────────────────────────── mediapipe ─────────────────────────── */
let landmarker = null;
async function initMP(){
  statusEl.textContent = 'loading model…';
  landmarker = await loadLandmarker();
  skin = skinLayer.create({ scene, palette: [], params: {} });
  // если пользователь уже трогал слайдер до того, как кожа успела
  // создаться (гейт разрешения камеры ещё не пройден) — применяем
  // запомненное значение сейчас; если не трогал, ничего не вызываем и
  // кожа берёт сгенерированное из сида (см. skin.js: override===null).
  if (skinExtensionOverride !== null) skin.setExtensionOverride(skinExtensionOverride);
  if (skinWidthOverride !== null) skin.setWidthExtensionOverride(skinWidthOverride);
  mouth = mouthLayer.create({ scene, palette: [], params: {} });
}

let currentStream = null;
async function initCam(deviceId){
  statusEl.textContent = 'camera…';
  if(currentStream) currentStream.getTracks().forEach(t => t.stop());
  const constraints = { audio:false, video:{ width:{ideal:1280}, height:{ideal:720} } };
  if(deviceId) constraints.video.deviceId = { exact: deviceId };
  else constraints.video.facingMode = 'user';
  currentStream = await navigator.mediaDevices.getUserMedia(constraints);
  video.srcObject = currentStream;
  await new Promise(r => video.onloadedmetadata = r);
  await video.play();
  resize();
}

async function listDevices(){
  const sel = $('devices');
  const devs = (await navigator.mediaDevices.enumerateDevices())
                 .filter(d => d.kind === 'videoinput');
  const active = currentStream?.getVideoTracks()[0]?.getSettings()?.deviceId;
  sel.innerHTML = '';
  devs.forEach((d,i) => {
    const o = document.createElement('option');
    o.value = d.deviceId; o.textContent = d.label || `camera ${i+1}`;
    if(d.deviceId === active) o.selected = true;
    sel.appendChild(o);
  });
  sel.onchange = async () => {
    try { await initCam(sel.value); } catch(e){ errEl.textContent = 'Error: ' + e.message; }
  };
}

let aspect = 16/9;
function resize(){
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  aspect = vw/vh;
  const maxW = innerWidth, maxH = innerHeight;
  let w = maxW, h = w/aspect;
  if(h > maxH){ h = maxH; w = h*aspect; }
  video.style.width = canvas.style.width = w+'px';
  video.style.height = canvas.style.height = h+'px';
  renderer.setSize(w,h,false);
  camera.left = -aspect; camera.right = aspect; camera.top = 1; camera.bottom = -1;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

/* ────────────────────────── состояние панели ──────────────────── */
let userScale = 1;
let showSkin = true, showShards = true, showCrown = true, showEyes = true, showBrows = true, showMouth = true;
// null = слайдер ещё не тронут, слой берёт сгенерированное из сида;
// как только пользователь двигает слайдер — абсолютное значение здесь,
// реролл (generate()) его не трогает и не перезаписывает.
let skinExtensionOverride = null, skinWidthOverride = null, shardDensityOverride = null;
// множитель на mouthEnergy (единственный потребитель — shards.update, см.
// loop()) — не оверрайд поверх сгенерированного и не часть сида, просто
// сила реакции на мимику, дефолт 1.
let mouthReactionMul = 1;

// заморозка — останавливает ТОЛЬКО генеративную анимацию (шум кожи/рта,
// спин/пульс осколков), не трекинг лица и не реакцию на мимику (блинки,
// брови) — те продолжают отражать твоё текущее состояние. freezeT держит
// t на момент заморозки; при снятии t0 сдвигается так, чтобы анимация
// продолжилась без скачка, а не прыгнула вперёд на время паузы.
let frozen = false, freezeT = 0;

/* ────────────────────────── loop ──────────────────────────────── */
let lastTs = -1, t0 = performance.now(), frames = 0, fps = 0, fpsT = performance.now();
let mouthEnergy = 0, jawOpen = 0;
function loop(){
  requestAnimationFrame(loop);
  if(!landmarker || video.readyState < 2) return;

  const now = performance.now();
  if(video.currentTime !== lastTs){
    lastTs = video.currentTime;
    const res = landmarker.detectForVideo(video, now);
    if(res.faceLandmarks && res.faceLandmarks.length){
      // сглаживаем лендмарки ОДИН раз здесь — все слои ниже (анкер, кожа,
      // рот, глаза, брови) читают этот же массив, лаг между слоями из-за
      // разных источников/степеней сглаживания физически невозможен. Сила
      // сглаживания больше не ручная — адаптивная, от скорости движения
      // лендмарков (см. tracking.js).
      const lms = lmSmoother.update(res.faceLandmarks[0]);
      tracker.updateAnchor(lms, aspect, anchor, userScale);
      // eyes.js пересчитывает позиции в anchor-local через matrixWorld этим
      // же кадром — без принудительного пересчёта тут читал бы матрицу
      // с прошлого кадра (three обновляет её лениво, внутри renderer.render).
      anchor.updateMatrixWorld(true);
      if(showSkin) skin.updateGeometry(lms, aspect);
      if(mouth) mouth.updateGeometry(lms, aspect);
      // anchor всегда виден, пока лицо трекается — каждый слой управляет
      // своей видимостью независимым тумблером.
      anchor.visible = true;
      if(skin) skin.object3D.visible = showSkin;
      if(mouth) mouth.object3D.visible = showMouth;
      if(shards) shards.object3D.visible = showShards;
      if(crown) crown.object3D.visible = showCrown;
      if(eyes) eyes.object3D.visible = showEyes;
      if(brows) brows.object3D.visible = showBrows;

      const bs = blend.update(res.faceBlendshapes?.[0]?.categories);
      jawOpen = bs.jawOpen || 0;
      mouthEnergy = jawOpen*.7 + (bs.mouthFunnel||0)*.2 + (bs.mouthPucker||0)*.1;
      if(eyes) eyes.updateGeometry(lms, aspect, anchor, bs.eyeBlinkRight||0, bs.eyeBlinkLeft||0, jawOpen);
      if(brows){
        brows.updateGeometry(lms, aspect, anchor);
        brows.update(bs.browDownLeft||0, bs.browDownRight||0);
      }
    } else {
      anchor.visible = false;
      if(skin) skin.object3D.visible = false;
      if(mouth) mouth.object3D.visible = false;
    }
  }

  if (!frozen){
    const t = (now - t0)/1000;
    skin.setTime(t);
    if(mouth) mouth.setFrame(t, jawOpen);
    if(shards) shards.update({ t, mouthEnergy: mouthEnergy * mouthReactionMul });
  }

  renderer.render(scene, camera);

  if (pendingSave){ pendingSave = false; doSave(); }

  // не во время записи: recorder уже сам гонит композит на rVFC, и
  // snapshotDataUrl() тут перезаписал бы transparentSupported, вычисленный
  // под ИДУЩУЮ запись (см. record.js) — сломал бы фолбэк на зелёный фон.
  if (!recorder.isRecording && now - lastSnapshotRefreshTs > SNAPSHOT_REFRESH_MS){
    lastSnapshotRefreshTs = now;
    refreshLatestSnapshot();
  }

  frames++;
  if(now - fpsT > 500){ fps = Math.round(frames*1000/(now-fpsT)); frames=0; fpsT=now;
    statusEl.textContent = `${fps} fps · seed ${currentSeed}`; }
}

/* ────────────────────────── ui ────────────────────────────────── */
setupUI({
  onReroll: () => generate(),
  onAutoTick: () => generate(),
  onToggleSkin: () => { showSkin = !showSkin; return showSkin; },
  onToggleShards: () => { showShards = !showShards; return showShards; },
  onToggleCrown: () => { showCrown = !showCrown; return showCrown; },
  onToggleEyes: () => { showEyes = !showEyes; return showEyes; },
  onToggleBrows: () => { showBrows = !showBrows; return showBrows; },
  onToggleMouth: () => { showMouth = !showMouth; return showMouth; },
  onToggleFreeze: () => {
    frozen = !frozen;
    if (frozen) freezeT = (performance.now()-t0)/1000;
    else t0 = performance.now() - freezeT*1000;
    return frozen;
  },
  onScale: v => userScale = v,
  onSkinExtension: v => { skinExtensionOverride = v; if(skin) skin.setExtensionOverride(v); },
  onSkinWidth: v => { skinWidthOverride = v; if(skin) skin.setWidthExtensionOverride(v); },
  onDensity: v => { shardDensityOverride = v; regenerateShardsOnly(); },
  onMouthReaction: v => { mouthReactionMul = v; },
  // visibility:hidden вместо display:none — видео остаётся в потоке разметки
  // (тот же размер занимает), не вызывает reflow #wrap/канваса при переключении.
  onChroma: on => { video.style.visibility = on ? 'hidden' : 'visible'; },
  onSave: () => { pendingSave = true; },
  onOpenCollection: () => openCollection(),
  onToggleRecord: () => toggleRecording(),
  onShare: () => doShare(),
});

$('galleryModalBackdrop').onclick = () => closeCollection();
$('galleryModalClose').onclick = () => closeCollection();
addEventListener('keydown', e => { if (e.key === 'Escape') closeCollection(); });

/* ────────────────────────── boot ──────────────────────────────── */
function camError(err){
  if(!window.isSecureContext) return 'Insecure context. Open via http://localhost or https - file:// will never get camera access.';
  switch(err.name){
    case 'NotAllowedError': return 'Access denied. Click the camera icon in the address bar → Allow, then click the button again.';
    case 'NotFoundError':   return 'No camera found.';
    case 'NotReadableError':return 'Camera is busy in another app (OBS, Zoom, Telegram?). Close it and try again.';
    case 'OverconstrainedError': return 'This device does not support the requested mode.';
    default: return err.name + ': ' + err.message;
  }
}

let started = false;
async function start(deviceId){
  if(started) return;
  const btn = $('allow');
  btn.disabled = true; btn.textContent = 'connecting…';
  $('gateerr').textContent = '';
  try {
    await initCam(deviceId);
    await listDevices();
    $('gate').classList.add('done');
    started = true;
    await initMP();
    generate(location.hash.slice(1) || undefined);
    renderGallery();
    updateShareButtonLabel();
    statusEl.textContent = 'ok';
    loop();
  } catch(err){
    console.error(err);
    $('gateerr').textContent = camError(err);
    btn.disabled = false; btn.textContent = 'Try again';
  }
}
$('allow').onclick = () => start();

// если разрешение уже выдано (OBS / повторный заход) — стартуем сами
(async () => {
  try {
    const p = await navigator.permissions.query({ name:'camera' });
    if(p.state === 'granted') start();
  } catch(e){ /* Firefox/Safari не умеют — ждём кнопку */ }
})();
