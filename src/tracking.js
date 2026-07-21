import * as THREE from 'three';
import { FaceLandmarker, FilesetResolver } from
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.12/vision_bundle.mjs';

// ─── адаптивное сглаживание лендмарков (см. createLandmarkSmoother) ───────
// Коэффициент лерпа считается ОТДЕЛЬНО ДЛЯ КАЖДОГО лендмарка, от его
// собственного смещения за кадр — не задаётся вручную слайдером и не
// усредняется по всем точкам разом (усреднение по 478 точкам топило
// локальное быстрое движение вроде губ в общей массе почти неподвижного
// лица — среднее оставалось маленьким, и коэффициент падал к LERP_MIN
// вместе с губами). Пороги/кривая — константы здесь, эмпирические
// (лендмарки в нормализованном 0..1 видео-пространстве): MOTION_LOW/HIGH —
// границы смещения ОДНОЙ точки на кадр в этих единицах, LERP_MIN/MAX —
// соответствующие им коэффициенты. Почти неподвижная точка (дрожь трекера,
// не реальное движение) — сильное сглаживание (LERP_MIN); быстро движущаяся
// точка (резкий поворот головы, шевелящиеся губы) — коэффициент почти
// LERP_MAX, координата практически прыгает на новую позицию без визуального
// отставания. LERP_MAX=0.92 даёт ≥90% схождения к сырой позиции за один
// кадр при резком движении (см. verify в scratchpad).
const MOTION_LOW = 0.004;
const MOTION_HIGH = 0.05;
const LERP_MIN = 0.06;
const LERP_MAX = 0.92;

// ─── адаптивное сглаживание blendshapes (см. createBlendshapeSmoother) ────
// Та же схема, что у лендмарков выше, но по скорости изменения score
// отдельно на каждую категорию (blendshapes — скаляры 0..1, а не точки в
// видео-пространстве, отсюда свои пороги). Раньше EMA была фиксированной
// (.35) — при быстрой мимике (жевание) это давало заметное отставание и
// срезанную амплитуду ПОВЕРХ уже сглаженных лендмарков (двойное
// сглаживание). BLEND_MOTION_LOW/HIGH — границы |raw-smoothed| за кадр,
// BLEND_LERP_MIN/MAX — соответствующие коэффициенты; подобраны так, чтобы
// 5 Гц колебание с амплитудой 0.3 (жевание) сохраняло ≥70% амплитуды на
// выходе (см. verify в scratchpad).
const BLEND_MOTION_LOW = 0.01;
const BLEND_MOTION_HIGH = 0.08;
const BLEND_LERP_MIN = 0.15;
const BLEND_LERP_MAX = 0.95;

export async function loadLandmarker(){
  const fileset = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.12/wasm');
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions:{ modelAssetPath:
      'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
      delegate:'GPU' },
    runningMode:'VIDEO', numFaces:1, outputFaceBlendshapes:true
  });
}

// экранные координаты (зеркалим по X — селфи)
export function toWorld(lm, aspect, out){
  return out.set(-(lm.x-.5)*2*aspect, -(lm.y-.5)*2, -lm.z*2*aspect);
}

// Сглаживание сырых лендмарков ОДИН РАЗ, сразу после detectForVideo — до
// этого сглаживалась только матрица анкера (внутри updateAnchor), а кожа и
// рот брали сырые, несглаженные лендмарки напрямую. Из-за этого при
// повороте головы кожа обгоняла осколки/убор/глаза/брови — те сидят на
// сглаженном анкере, а кожа дёргалась вместе с сырым трекингом. Теперь ВСЕ
// слои читают один и тот же сглаженный массив — лагу между слоями взяться
// физически неоткуда.
//
// Сглаживаем в исходном нормализованном видео-пространстве (x/y/z из
// MediaPipe, до toWorld) — это ПРОСТРАНСТВО, в котором лендмарки приходят
// каждый кадр, и слои сами вызывают toWorld() над уже сглаженными точками
// точно так же, как раньше вызывали его над сырыми.
//
// Сила сглаживания — АДАПТИВНАЯ, не ручной слайдер, и СВОЯ У КАЖДОЙ ТОЧКИ:
// для каждого лендмарка отдельно считаем его смещение за кадр (сырое
// относительно уже сглаженного состояния — это и есть "куда сейчас нужно
// доехать") и коэффициент лерпа берём по кривой от этой величины (константы
// MOTION_LOW/HIGH, LERP_MIN/MAX — в начале файла). Базис анкера
// (updateAnchor) при этом всё равно получает согласованный результат — он
// строится из точек лба/глаз/подбородка, которые в норме двигаются вместе
// (голова — жёсткое тело), и каждая из них получает похожий коэффициент,
// потому что похожа её собственная скорость.
function smoothstep01(t){ return t*t*(3-2*t); }

// низкий/высокий порог величины движения -> коэффициент лерпа min/max по
// smoothstep-кривой между ними. Общая форма для лендмарков и blendshapes,
// каждый вызывающий код передаёт свои константы.
function adaptiveLerp(value, low, high, min, max){
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return min + (max - min) * smoothstep01(t);
}

function adaptiveLerpK(displacement){
  return adaptiveLerp(displacement, MOTION_LOW, MOTION_HIGH, LERP_MIN, LERP_MAX);
}

export function createLandmarkSmoother(){
  let smoothed = null; // держим один и тот же массив {x,y,z}, мутируем на месте
  return {
    update(rawLms){
      if (!smoothed){
        smoothed = rawLms.map(p => ({ x:p.x, y:p.y, z:p.z }));
        return smoothed;
      }
      for (let i=0;i<rawLms.length;i++){
        const s = smoothed[i], r = rawLms[i];
        const dx = r.x-s.x, dy = r.y-s.y, dz = r.z-s.z;
        const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
        const lerpK = adaptiveLerpK(dist);
        s.x += dx * lerpK;
        s.y += dy * lerpK;
        s.z += dz * lerpK;
      }
      return smoothed;
    }
  };
}

// базис лица (позиция+ориентация+масштаб анкера). Лендмарки на входе уже
// сглажены (см. createLandmarkSmoother выше) — второе сглаживание поверх
// не нужно и не делается: базис пересчитывается заново из уже сглаженных
// точек каждый кадр, без собственного EMA/slerp.
export function createFaceTracker(){
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();
  const foreV = new THREE.Vector3(), noseV = new THREE.Vector3();
  const ax = new THREE.Vector3(), ay = new THREE.Vector3(), az = new THREE.Vector3();
  const M = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const scaleVec = new THREE.Vector3();

  return {
    updateAnchor(lms, aspect, anchor, userScale){
      const eyeR = toWorld(lms[33], aspect, tmpA);   // внешний угол одного глаза
      const eyeL = toWorld(lms[263], aspect, tmpB);
      const chin = toWorld(lms[152], aspect, tmpC);
      const fore = toWorld(lms[10], aspect, foreV);
      const nose = toWorld(lms[1], aspect, noseV);

      ax.copy(eyeL).sub(eyeR);
      const ipd = ax.length() || .2;
      ax.normalize();
      ay.copy(fore).sub(chin).normalize();
      az.crossVectors(ax, ay).normalize();
      ay.crossVectors(az, ax).normalize();

      M.makeBasis(ax, ay, az);
      quat.setFromRotationMatrix(M);

      const s = ipd * userScale;
      scaleVec.set(s, s, s);
      anchor.matrix.compose(nose, quat, scaleVec);
      anchor.matrixWorldNeedsUpdate = true;
    }
  };
}

// адаптивное сглаживание блендшейпов по имени категории — иначе дрожит.
// Коэффициент считается отдельно на каждую категорию от скорости её
// изменения между кадрами (сырое значение относительно уже сглаженного —
// как и для лендмарков), а не фиксированной EMA: медленная мимика
// сглаживается как раньше, быстрая (жевание) проходит почти без лага.
// Возвращает один и тот же объект каждый кадр (мутируется на месте).
export function createBlendshapeSmoother(){
  const smoothed = {};
  return {
    update(categories){
      if (categories){
        for (const cat of categories){
          const prev = smoothed[cat.categoryName] ?? cat.score;
          const k = adaptiveLerp(Math.abs(cat.score - prev),
            BLEND_MOTION_LOW, BLEND_MOTION_HIGH, BLEND_LERP_MIN, BLEND_LERP_MAX);
          smoothed[cat.categoryName] = prev + (cat.score - prev) * k;
        }
      }
      return smoothed;
    }
  };
}
