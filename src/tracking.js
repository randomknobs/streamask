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

// базис лица (позиция+ориентация+масштаб анкера) со сглаживанием
export function createFaceTracker(){
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();
  const foreV = new THREE.Vector3(), noseV = new THREE.Vector3();
  const ax = new THREE.Vector3(), ay = new THREE.Vector3(), az = new THREE.Vector3();
  const M = new THREE.Matrix4();
  const curPos = new THREE.Vector3(), curQuat = new THREE.Quaternion();
  const tgtPos = new THREE.Vector3(), tgtQuat = new THREE.Quaternion();
  let curScale = .2, has = false;

  return {
    updateAnchor(lms, aspect, anchor, smoothing, userScale){
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
      tgtQuat.setFromRotationMatrix(M);
      tgtPos.copy(nose);

      const lerpK = has ? Math.max(.04, 1 - smoothing) : 1;
      curPos.lerp(tgtPos, lerpK);
      curQuat.slerp(tgtQuat, lerpK);
      curScale += (ipd - curScale) * lerpK;
      has = true;

      const s = curScale * userScale;
      anchor.matrix.compose(curPos, curQuat, new THREE.Vector3(s,s,s));
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
