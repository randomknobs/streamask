import * as THREE from 'three';
import { FaceLandmarker } from
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.12/vision_bundle.mjs';
import { R } from '../rng.js';
import { toWorld } from '../tracking.js';

function buildTriangles(){
  const t = FaceLandmarker.FACE_LANDMARKS_TESSELATION;
  const idx = [];
  for (let i=0; i+2<t.length; i+=3) idx.push(t[i].start, t[i+1].start, t[i+2].start);
  return new Uint16Array(idx);
}

// меш «кожи» живёт всё время работы приложения — тесселяция и UV из живых
// лендмарков не пересоздаются между масками, реролл только перекрашивает
// материал (см. applyPalette). Так сохраняется поведение до рефакторинга.
export function create(ctx){
  const { scene } = ctx;

  const material = new THREE.ShaderMaterial({
    transparent:true, side:THREE.DoubleSide, depthWrite:false,
    uniforms:{ t:{value:0}, cA:{value:new THREE.Color()}, cB:{value:new THREE.Color()},
               cC:{value:new THREE.Color()}, freq:{value:12}, warp:{value:1},
               bands:{value:0}, spd:{value:.3}, op:{value:.9} },
    vertexShader:`varying vec2 vU; varying vec3 vP;
      void main(){ vU=uv; vP=position;
        gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader:`precision highp float;
      uniform float t,freq,warp,bands,spd,op; uniform vec3 cA,cB,cC;
      varying vec2 vU; varying vec3 vP;
      float h(vec2 p){return fract(sin(dot(p,vec2(41.3,289.1)))*43758.5453);}
      float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
        return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
      void main(){
        vec2 p=vU*freq;
        float w=n(p*.5+t*spd)*warp;
        float v=sin(p.x+p.y*.6+w*3.0+t*spd*2.0)*.5+.5;
        if(bands>.5) v=step(.5,v)*.85+v*.15;
        vec3 c=mix(cA,cB,v);
        c=mix(c,cC,smoothstep(.3,.9,n(p*.3-t*spd*.5)));
        gl_FragColor=vec4(c,op);
      }`
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(478*3),3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(478*2),2));
  geometry.setIndex(new THREE.BufferAttribute(buildTriangles(),1));

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  scene.add(mesh);

  const v = new THREE.Vector3();

  return {
    object3D: mesh,

    applyPalette(cols){
      material.uniforms.cA.value.copy(cols[0]);
      material.uniforms.cB.value.copy(cols[1] || cols[0]);
      material.uniforms.cC.value.copy(cols[2] || cols[0]);
      material.uniforms.freq.value = R(28,4);
      material.uniforms.warp.value = R(3,0);
      material.uniforms.bands.value = R()<.45 ? 1 : 0;
      material.uniforms.spd.value = R(.8,.05);
      material.uniforms.op.value = R(.95,.55);
    },

    updateGeometry(landmarks, aspect){
      const pos = geometry.attributes.position.array;
      const uv  = geometry.attributes.uv.array;
      const n = Math.min(landmarks.length, 478);
      for (let i=0;i<n;i++){
        toWorld(landmarks[i], aspect, v);
        pos[i*3]=v.x; pos[i*3+1]=v.y; pos[i*3+2]=v.z + .002;
        uv[i*2]=landmarks[i].x; uv[i*2+1]=1-landmarks[i].y;
      }
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.uv.needsUpdate = true;
      geometry.computeVertexNormals();
    },

    setTime(t){ material.uniforms.t.value = t; },

    dispose(){ geometry.dispose(); material.dispose(); scene.remove(mesh); }
  };
}
