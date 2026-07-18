import * as THREE from 'three';
import { reseed, seedFrom } from './rng.js';
import { palette } from './palette.js';
import { loadLandmarker, createFaceTracker, createBlendshapeSmoother } from './tracking.js';
import * as skinLayer from './layers/skin.js';
import * as shardsLayer from './layers/shards.js';
import { setupUI } from './ui.js';

const $ = id => document.getElementById(id);
const video = $('cam'), canvas = $('gl'), statusEl = $('status'), errEl = $('err');

/* ────────────────────────── three setup ───────────────────────── */
const renderer = new THREE.WebGLRenderer({canvas, alpha:true, antialias:true});
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

/* ────────────────────────── генератор маски ───────────────────── */
let skin = null;
let shards = null;
let currentSeed = '';

function generate(seedStr){
  if(shards){ anchor.remove(shards.object3D); shards.dispose(); }

  currentSeed = seedStr || Math.random().toString(36).slice(2,9);
  reseed(seedFrom(currentSeed));
  $('seed').textContent = currentSeed;
  location.hash = currentSeed;

  const cols = palette();

  shards = shardsLayer.create({ scene, palette: cols, params: {} });
  anchor.add(shards.object3D);

  skin.applyPalette(cols);
}

/* ────────────────────────── mediapipe ─────────────────────────── */
let landmarker = null;
async function initMP(){
  statusEl.textContent = 'загрузка модели…';
  landmarker = await loadLandmarker();
  skin = skinLayer.create({ scene, palette: [], params: {} });
  skin.setOpacityMultiplier(skinOpacity);
}

let currentStream = null;
async function initCam(deviceId){
  statusEl.textContent = 'камера…';
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
    o.value = d.deviceId; o.textContent = d.label || `камера ${i+1}`;
    if(d.deviceId === active) o.selected = true;
    sel.appendChild(o);
  });
  sel.onchange = async () => {
    try { await initCam(sel.value); } catch(e){ errEl.textContent = 'Ошибка: ' + e.message; }
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
let userScale = 1, smoothing = .6, showSkin = true, showShards = true, skinOpacity = 1;

/* ────────────────────────── loop ──────────────────────────────── */
let lastTs = -1, t0 = performance.now(), frames = 0, fps = 0, fpsT = performance.now();
let mouthEnergy = 0;
function loop(){
  requestAnimationFrame(loop);
  if(!landmarker || video.readyState < 2) return;

  const now = performance.now();
  if(video.currentTime !== lastTs){
    lastTs = video.currentTime;
    const res = landmarker.detectForVideo(video, now);
    if(res.faceLandmarks && res.faceLandmarks.length){
      const lms = res.faceLandmarks[0];
      tracker.updateAnchor(lms, aspect, anchor, smoothing, userScale);
      if(showSkin) skin.updateGeometry(lms, aspect);
      anchor.visible = showShards;
      if(skin) skin.object3D.visible = showSkin;

      const bs = blend.update(res.faceBlendshapes?.[0]?.categories);
      mouthEnergy = (bs.jawOpen||0)*.7 + (bs.mouthFunnel||0)*.2 + (bs.mouthPucker||0)*.1;
    } else {
      anchor.visible = false;
      if(skin) skin.object3D.visible = false;
    }
  }

  const t = (now - t0)/1000;
  skin.setTime(t);
  if(shards) shards.update({ t, mouthEnergy });

  renderer.render(scene, camera);

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
  onSmoothing: v => smoothing = v,
  onScale: v => userScale = v,
  onSkinOpacity: v => { skinOpacity = v; if(skin) skin.setOpacityMultiplier(v); },
  onChroma: on => { video.style.display = on ? 'none' : 'block'; },
});

/* ────────────────────────── boot ──────────────────────────────── */
function camError(err){
  if(!window.isSecureContext) return 'Небезопасный контекст. Открой через http://localhost или https, file:// камеру не отдаст.';
  switch(err.name){
    case 'NotAllowedError': return 'Доступ запрещён. Нажми на иконку камеры в адресной строке → Разрешить, и жми кнопку снова.';
    case 'NotFoundError':   return 'Камера не найдена.';
    case 'NotReadableError':return 'Камера занята другой программой (OBS, Zoom, Telegram?). Закрой и попробуй снова.';
    case 'OverconstrainedError': return 'Это устройство не поддерживает запрошенный режим.';
    default: return err.name + ': ' + err.message;
  }
}

let started = false;
async function start(deviceId){
  if(started) return;
  const btn = $('allow');
  btn.disabled = true; btn.textContent = 'подключаюсь…';
  $('gateerr').textContent = '';
  try {
    await initCam(deviceId);
    await listDevices();
    $('gate').classList.add('done');
    started = true;
    await initMP();
    generate(location.hash.slice(1) || undefined);
    statusEl.textContent = 'ok';
    loop();
  } catch(err){
    console.error(err);
    $('gateerr').textContent = camError(err);
    btn.disabled = false; btn.textContent = 'Попробовать снова';
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
