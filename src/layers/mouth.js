import * as THREE from 'three';
import { R, pick } from '../rng.js';
import { toWorld } from '../tracking.js';

// Внутренний контур губ, порядок из спеки. Не доверяем ему как есть —
// направление обхода проверяется вычислением на первом реальном кадре
// (см. updateGeometry) и при необходимости разворачивается.
const RING_RAW = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324,
                   308, 415, 310, 311, 312, 13, 82, 81, 80, 191];

function signedArea2D(pts){
  let sum = 0;
  for (let i=0;i<pts.length;i++){
    const a = pts[i], b = pts[(i+1)%pts.length];
    sum += a.x*b.y - b.x*a.y;
  }
  return sum/2;
}

// объёмные объекты (skin, shards) рисуются раньше и при высокой генерируемой
// непрозрачности кожи (см. skin.js) переходят в opaque+depthWrite:true —
// без depthTest:false шум рта был бы депт-занулен этой плоскостью и не
// виден вообще на части масок. Эффект должен работать всегда, не зависеть
// от того, куда упал слайдер непрозрачности кожи.
export function create(ctx){
  const { scene } = ctx;

  const material = new THREE.ShaderMaterial({
    transparent:true, depthWrite:false, depthTest:false, side:THREE.DoubleSide,
    uniforms:{ t:{value:0}, intensity:{value:0},
               tint:{value:new THREE.Color(1,1,1)}, rollSpeed:{value:.6} },
    vertexShader:`varying vec2 vUv;
      void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader:`precision highp float;
      uniform float t, intensity, rollSpeed; uniform vec3 tint;
      varying vec2 vUv;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(41.3,289.1)))*43758.5453); }
      void main(){
        float n = hash(vec2(floor(vUv.x*220.), floor(vUv.y*160.) + floor(t*24.)));
        float scan = 0.85 + 0.15*sin(vUv.y*400. + t*6.);
        float roll = smoothstep(0.0, 0.08, fract(vUv.y - t*rollSpeed));
        vec3 c = vec3(n)*scan*mix(0.6,1.0,roll);
        c = mix(c, c*tint, 0.5);
        gl_FragColor = vec4(c, intensity);
      }`
  });

  const N = RING_RAW.length;
  const centroidIdx = N;
  const positions = new Float32Array((N+1)*3);
  const uvs = new Float32Array((N+1)*2);
  const indices = new Uint16Array(N*3);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions,3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs,2));
  geometry.setIndex(new THREE.BufferAttribute(indices,1));

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  scene.add(mesh);

  let ring = RING_RAW;
  let windingChecked = false;

  function buildFan(){
    const idx = geometry.index.array;
    for (let i=0;i<N;i++){
      idx[i*3] = centroidIdx;
      idx[i*3+1] = i;
      idx[i*3+2] = (i+1) % N;
    }
    geometry.index.needsUpdate = true;
  }

  return {
    object3D: mesh,

    applyPalette(cols){
      material.uniforms.tint.value.copy(pick(cols));
      material.uniforms.rollSpeed.value = R(1.2,.3);
    },

    updateGeometry(landmarks, aspect){
      const pts = ring.map(li => toWorld(landmarks[li], aspect, new THREE.Vector3()));

      if (!windingChecked){
        if (signedArea2D(pts) < 0){ ring = [...ring].reverse(); pts.reverse(); }
        buildFan();
        windingChecked = true;
      }

      const pos = geometry.attributes.position.array;
      const uv = geometry.attributes.uv.array;

      let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
      for (const p of pts){
        if (p.x<minX) minX=p.x; if (p.x>maxX) maxX=p.x;
        if (p.y<minY) minY=p.y; if (p.y>maxY) maxY=p.y;
      }
      const spanX = (maxX-minX) || 1, spanY = (maxY-minY) || 1;

      let cx=0, cy=0, cz=0;
      for (let i=0;i<N;i++){
        const p = pts[i];
        pos[i*3]=p.x; pos[i*3+1]=p.y; pos[i*3+2]=p.z-.004;
        uv[i*2]=(p.x-minX)/spanX; uv[i*2+1]=(p.y-minY)/spanY;
        cx+=p.x; cy+=p.y; cz+=p.z;
      }
      cx/=N; cy/=N; cz/=N;
      pos[centroidIdx*3]=cx; pos[centroidIdx*3+1]=cy; pos[centroidIdx*3+2]=cz-.004;
      uv[centroidIdx*2]=.5; uv[centroidIdx*2+1]=.5;

      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.uv.needsUpdate = true;
    },

    setFrame(t, jawOpen){
      material.uniforms.t.value = t;
      material.uniforms.intensity.value = jawOpen;
    },

    dispose(){ geometry.dispose(); material.dispose(); scene.remove(mesh); }
  };
}
