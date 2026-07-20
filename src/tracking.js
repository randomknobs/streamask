import * as THREE from 'three';
import { FaceLandmarker, FilesetResolver } from
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.12/vision_bundle.mjs';

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
export function createLandmarkSmoother(){
  let smoothed = null; // держим один и тот же массив {x,y,z}, мутируем на месте
  return {
    update(rawLms, smoothing){
      if (!smoothed){
        smoothed = rawLms.map(p => ({ x:p.x, y:p.y, z:p.z }));
        return smoothed;
      }
      const lerpK = Math.max(.04, 1 - smoothing);
      for (let i=0;i<rawLms.length;i++){
        const s = smoothed[i], r = rawLms[i];
        s.x += (r.x - s.x) * lerpK;
        s.y += (r.y - s.y) * lerpK;
        s.z += (r.z - s.z) * lerpK;
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

// экспоненциальное сглаживание блендшейпов по имени категории — иначе дрожит.
// Возвращает один и тот же объект каждый кадр (мутируется на месте).
export function createBlendshapeSmoother(){
  const smoothed = {};
  return {
    update(categories){
      if (categories){
        for (const cat of categories){
          const prev = smoothed[cat.categoryName] ?? cat.score;
          smoothed[cat.categoryName] = prev + (cat.score - prev) * .35;
        }
      }
      return smoothed;
    }
  };
}
