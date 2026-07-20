const $ = id => document.getElementById(id);

// панель и хоткеи. Само состояние (showSkin, ...) держит main.js —
// сюда приходят только колбэки.
export function setupUI({ onReroll, onAutoTick, onToggleSkin, onToggleShards, onToggleCrown,
                           onToggleEyes, onToggleBrows, onToggleMouth, onToggleFreeze,
                           onScale, onSkinExtension, onSkinWidth,
                           onDensity, onMouthReaction, onChroma, onSave, onOpenCollection }){
  let autoTimer = null;

  $('reroll').onclick = () => onReroll();
  $('auto').onclick = e => {
    if(autoTimer){ clearInterval(autoTimer); autoTimer=null; e.target.classList.remove('on'); }
    else { autoTimer = setInterval(()=>onAutoTick(), 8000); e.target.classList.add('on'); }
  };
  $('skin').onclick   = e => { const on = onToggleSkin();   e.target.classList.toggle('on', on); };
  $('shards').onclick = e => { const on = onToggleShards(); e.target.classList.toggle('on', on); };
  $('crown').onclick  = e => { const on = onToggleCrown();  e.target.classList.toggle('on', on); };
  $('eyes').onclick   = e => { const on = onToggleEyes();   e.target.classList.toggle('on', on); };
  $('brows').onclick  = e => { const on = onToggleBrows();  e.target.classList.toggle('on', on); };
  $('mouth').onclick  = e => { const on = onToggleMouth();  e.target.classList.toggle('on', on); };
  ['skin','shards','crown','eyes','brows','mouth'].forEach(id => $(id).classList.add('on'));
  $('freeze').onclick = e => { const on = onToggleFreeze(); e.target.classList.toggle('on', on); };
  $('scale').oninput  = e => onScale(+e.target.value);
  $('skinExtension').oninput = e => onSkinExtension(+e.target.value);
  $('skinWidth').oninput = e => onSkinWidth(+e.target.value);
  $('density').oninput = e => onDensity(+e.target.value);
  $('mouthReaction').oninput = e => onMouthReaction(+e.target.value);
  $('chroma').onclick = e => {
    const on = document.body.style.background !== 'rgb(0, 255, 0)';
    document.body.style.background = on ? '#00ff00' : 'var(--bg)';
    onChroma(on);
    e.target.classList.toggle('on', on);
  };

  $('save').onclick = () => onSave();
  $('collectionBtn').onclick = () => onOpenCollection();

  addEventListener('keydown', e => {
    if(e.key==='r'||e.key==='R'||e.key==='к'||e.key==='К') onReroll();
    if(e.key==='h'||e.key==='H'||e.key==='р'||e.key==='Р'){
      $('ui').classList.toggle('hidden');
      // курсор прячется вместе с панелью — иначе стрелка мыши болтается
      // посреди чистого кадра, который H должен был расчистить целиком.
      document.body.classList.toggle('hide-cursor');
    }
  });
}
