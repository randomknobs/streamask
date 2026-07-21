// Общий приём затухания для слоёв на обычных материалах three.js (не
// ShaderMaterial с кастомным фрагментным шейдером — те гасят себя сами
// через собственный uniform, см. setOpacity в skin.js/mouth.js/crown.js).
// У каждого встреченного материала запоминаем его "родную" transparent/
// opacity/depthWrite при первом вызове (userData.baseX) — иначе halo-
// элементы shards, уже полупрозрачные в покое, потеряли бы это при
// умножении на v или получили бы чужую базовую прозрачность обратно после
// затухания. transparent/depthWrite временно переключаются в fade-режим,
// пока v<1, и возвращаются к исходным значениям, когда v снова 1.
export function fadeGroupMaterials(root, v){
  const fading = v < 1;
  root.traverse(o => {
    const mat = o.material;
    if (!mat) return;
    const materials = Array.isArray(mat) ? mat : [mat];
    for (const m of materials){
      if (m.userData.baseTransparent === undefined){
        m.userData.baseTransparent = m.transparent;
        m.userData.baseDepthWrite = m.depthWrite;
        m.userData.baseOpacity = m.opacity;
      }
      if (m.uniforms && m.uniforms.opacity){
        // кастомный ShaderMaterial со своим uniform opacity (crown.js cap) —
        // builtin material.opacity шейдер игнорирует, и материал сам всегда
        // стартует полностью непрозрачным, отдельной базы не нужно.
        m.uniforms.opacity.value = v;
      } else {
        m.opacity = m.userData.baseOpacity * v;
      }
      // WebGLRenderer игнорирует opacity целиком, если transparent!==true —
      // материал рисуется как полностью непрозрачный вне зависимости от
      // значения opacity/uniform opacity. Поэтому на время затухания
      // transparent включается БЕЗУСЛОВНО для абсолютно всех материалов —
      // в т.ч. wireframe MeshBasicMaterial у core/mid осколков и рёбер
      // короны, у которых в покое transparent:false — а не только для тех,
      // кто и так уже был полупрозрачным (halo-элементы).
      if (fading){
        m.transparent = true;
        m.depthWrite = false;
      } else {
        m.transparent = m.userData.baseTransparent;
        m.depthWrite = m.userData.baseDepthWrite;
      }
    }
  });
}
