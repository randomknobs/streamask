const $ = id => document.getElementById(id);

// панель и хоткеи. Само состояние (showSkin, smoothing, ...) держит main.js —
// сюда приходят только колбэки.
export function setupUI({ onReroll, onAutoTick, onToggleSkin, onToggleShards, onToggleCrown,
                           onSmoothing, onScale, onSkinOpacity, onSkinExtension, onSkinWidth, onChroma }){
  let autoTimer = null;

  $('reroll').onclick = () => onReroll();
  $('auto').onclick = e => {
    if(autoTimer){ clearInterval(autoTimer); autoTimer=null; e.target.classList.remove('on'); }
    else { autoTimer = setInterval(()=>onAutoTick(), 8000); e.target.classList.add('on'); }
  };
  $('skin').onclick   = e => { const on = onToggleSkin();   e.target.classList.toggle('on', on); };
  $('shards').onclick = e => { const on = onToggleShards(); e.target.classList.toggle('on', on); };
  $('crown').onclick  = e => { const on = onToggleCrown();  e.target.classList.toggle('on', on); };
  $('skin').classList.add('on'); $('shards').classList.add('on'); $('crown').classList.add('on');
  $('smooth').oninput = e => onSmoothing(+e.target.value);
  $('scale').oninput  = e => onScale(+e.target.value);
  $('skinOpacity').oninput = e => onSkinOpacity(+e.target.value);
  $('skinExtension').oninput = e => onSkinExtension(+e.target.value);
  $('skinWidth').oninput = e => onSkinWidth(+e.target.value);
  $('chroma').onclick = e => {
    const on = document.body.style.background !== 'rgb(0, 255, 0)';
    document.body.style.background = on ? '#00ff00' : 'var(--bg)';
    onChroma(on);
    e.target.classList.toggle('on', on);
  };

  addEventListener('keydown', e => {
    if(e.key==='r'||e.key==='R'||e.key==='к'||e.key==='К') onReroll();
    if(e.key==='h'||e.key==='H'||e.key==='р'||e.key==='Р') $('ui').classList.toggle('hidden');
  });
}
