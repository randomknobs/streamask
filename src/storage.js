// Фаза 5 — сохранение и рекол. localStorage, ключ streamask:v1.
//
// Хранятся ТОЛЬКО параметры генерации, не геометрия: сид (из него рекол
// заново строит всю маску через generate()), имя, timestamp, превью
// 160×160 jpeg и текущие значения слайдеров-оверрайдов (density/skinOpacity/
// skinExtension/skinWidth) — только те, что пользователь реально трогал
// (см. main.js: null-до-касания). Всё остальное детерминированно
// восстанавливается из сида при рекole — это и есть основа фазы 5.
//
// Лимит и квота — явное предупреждение вызывающему коду, а не молчаливая
// потеря: add()/importJson() ничего не записывают и возвращают {ok:false},
// если результат не влезает (по счётчику записей или по факту квоты
// localStorage), а не обрезают/перезаписывают половину коллекции тихо.

const STORAGE_KEY = 'streamask:v1';
const LIMIT = 40;
const THUMB_MAX_PX = 160;

function loadRaw(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { version:1, saved:[] };
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.saved)) return { version:1, saved:[] };
    return { version:1, saved:data.saved };
  } catch(e){
    return { version:1, saved:[] };
  }
}

function writeRaw(data){
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return { ok:true };
  } catch(e){
    // QuotaExceededError и его аналоги в разных браузерах — коллекция НЕ
    // тронута (мы либо не успели, либо setItem целиком откатывает запись),
    // так что явно говорим об этом наружу вместо тихого исчезновения.
    return { ok:false, reason:'quota' };
  }
}

export function list(){
  return loadRaw().saved;
}

// entry: { seed, name, ts, thumb, params }
export function add(entry){
  const data = loadRaw();
  if (data.saved.length >= LIMIT){
    return { ok:false, reason:'limit', limit:LIMIT, current:data.saved.length };
  }
  data.saved.push(entry);
  const res = writeRaw(data);
  if (!res.ok) return res;
  return { ok:true };
}

export function remove(ts){
  const data = loadRaw();
  data.saved = data.saved.filter(e => e.ts !== ts);
  return writeRaw(data);
}

export function rename(ts, name){
  const data = loadRaw();
  const e = data.saved.find(e => e.ts === ts);
  if (!e) return { ok:false, reason:'notfound' };
  e.name = name;
  return writeRaw(data);
}

export function exportJson(){
  return JSON.stringify(loadRaw(), null, 2);
}

// Мёрдж всей коллекции — all-or-nothing: если итог превысит лимит, ничего
// не пишем и не обрезаем молча, возвращаем числа для явного предупреждения
// вызывающей стороне ("удали часть или экспортируй лишнее перед импортом").
export function importJson(text){
  let parsed;
  try { parsed = JSON.parse(text); } catch(e){ return { ok:false, reason:'parse' }; }
  if (!parsed || !Array.isArray(parsed.saved)) return { ok:false, reason:'shape' };

  const data = loadRaw();
  const existingTs = new Set(data.saved.map(e => e.ts));
  const incoming = parsed.saved.filter(e => e && typeof e.seed === 'string' && !existingTs.has(e.ts));
  const total = data.saved.length + incoming.length;
  if (total > LIMIT){
    return { ok:false, reason:'limit', limit:LIMIT, current:data.saved.length, incoming:incoming.length };
  }
  data.saved.push(...incoming);
  const res = writeRaw(data);
  if (!res.ok) return res;
  return { ok:true, added:incoming.length };
}

export const STORAGE_LIMIT = LIMIT;
export const STORAGE_THUMB_MAX_PX = THUMB_MAX_PX;
export const STORAGE_KEY_NAME = STORAGE_KEY;
