// Фаза 7 — реакция на звук. Этот модуль НИКОГДА сам не запрашивает
// getUserMedia: main.js передаёт сюда уже полученный через общий
// ensureMicStream() MediaStream (тот же, что использует запись, см.
// комментарий в main.js) — микрофон/системное аудио запрашивается один раз
// на всё приложение, а не отдельно под анализатор.

const FFT_SIZE = 2048;
const LOW_HZ = [20, 200];
const MID_HZ = [200, 2000];
const HIGH_HZ = [2000, Infinity];

// атака быстрая (полоса почти мгновенно реагирует на удар), релиз —
// медленный (плавно спадает, а не мерцает между кадрами) — раздельные
// коэффициенты лерпа, а не единая симметричная EMA.
const ATTACK = 0.6;
const RELEASE = 0.08;

// удар — резкий скачок энергии низов кадр-к-кадру выше порога, с коротким
// кулдауном, чтобы один продолжительный подъём (несколько кадров подряд)
// не сыпал десятками "ударов" вместо одного.
const BEAT_DERIVATIVE_THRESHOLD = 0.15;
const BEAT_COOLDOWN_MS = 150;

// Hz -> индекс бина FFT. Чувствительность (0..3, UI-слайдер) множится на
// сырое значение полосы ДО сглаживания — так покрывает оба заявленных
// случая: тихий встроенный микрофон (крутим вверх, до x3) и системный звук
// через виртуальное устройство типа BlackHole, где уровни куда выше обычного
// микрофонного (крутим вниз, вплоть до 0). Результат клампится в [0,1] —
// и для полосы индикатора уровня, и чтобы не разгонять визуальные эффекты
// ниже за пределы разумного только из-за громкого источника.
export function bandRange(sampleRate, binCount, [loHz, hiHz]){
  const hzPerBin = sampleRate / FFT_SIZE;
  const lo = Math.max(0, Math.floor(loHz / hzPerBin));
  const hiRaw = hiHz === Infinity ? binCount - 1 : Math.ceil(hiHz / hzPerBin);
  const hi = Math.min(binCount - 1, hiRaw);
  return [lo, Math.max(lo, hi)];
}

export function bandAverage(byteData, [lo, hi]){
  let sum = 0;
  for (let i = lo; i <= hi; i++) sum += byteData[i];
  return sum / ((hi - lo + 1) * 255);
}

export function smoothTowards(prev, target){
  const k = target > prev ? ATTACK : RELEASE;
  return prev + (target - prev) * k;
}

// Чистая версия одного шага анализа — без AudioContext/AnalyserNode, чтобы
// её можно было проверить в node без DOM/Web Audio API. main.js/createAudioAnalyzer
// вызывают именно её на каждый реальный кадр FFT-данных.
export function analyzeFrame({ byteData, sampleRate, sensitivity, prevLow, prevMid, prevHigh, lastBeatAt, now }){
  const binCount = byteData.length;
  const lowRange = bandRange(sampleRate, binCount, LOW_HZ);
  const midRange = bandRange(sampleRate, binCount, MID_HZ);
  const highRange = bandRange(sampleRate, binCount, HIGH_HZ);

  const rawLow = Math.min(1, bandAverage(byteData, lowRange) * sensitivity);
  const rawMid = Math.min(1, bandAverage(byteData, midRange) * sensitivity);
  const rawHigh = Math.min(1, bandAverage(byteData, highRange) * sensitivity);

  const low = smoothTowards(prevLow, rawLow);
  const mid = smoothTowards(prevMid, rawMid);
  const high = smoothTowards(prevHigh, rawHigh);

  let beat = false;
  let nextBeatAt = lastBeatAt;
  const d = low - prevLow;
  if (d > BEAT_DERIVATIVE_THRESHOLD && now - lastBeatAt > BEAT_COOLDOWN_MS){
    beat = true;
    nextBeatAt = now;
  }

  const level = (low + mid + high) / 3;
  return { low, mid, high, level, beat, lastBeatAt: nextBeatAt };
}

// AnalyserNode-обвязка вокруг analyzeFrame(). connect()/disconnect() —
// единственные методы, трогающие Web Audio API; всё остальное состояние
// (сглаженные полосы, таймер удара) живёт здесь и переживает переключение
// устройства (main.js вызывает connect() заново с новым stream, состояние
// полос не сбрасывается искусственно — просто продолжает адаптироваться).
export function createAudioAnalyzer(){
  let ctx = null, analyser = null, source = null, data = null;
  let low = 0, mid = 0, high = 0, lastBeatAt = -Infinity;

  function connect(stream){
    disconnect();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    ctx = new Ctx();
    analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0; // своё attack/release-сглаживание, встроенное отключаем
    data = new Uint8Array(analyser.frequencyBinCount);
    source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);
  }

  function disconnect(){
    source?.disconnect();
    if (ctx && ctx.state !== 'closed') ctx.close();
    ctx = null; analyser = null; source = null; data = null;
    low = mid = high = 0; lastBeatAt = -Infinity;
  }

  function update(sensitivity, now){
    if (!analyser) return { low:0, mid:0, high:0, level:0, beat:false };
    analyser.getByteFrequencyData(data);
    const res = analyzeFrame({
      byteData: data, sampleRate: ctx.sampleRate, sensitivity,
      prevLow: low, prevMid: mid, prevHigh: high, lastBeatAt, now,
    });
    low = res.low; mid = res.mid; high = res.high; lastBeatAt = res.lastBeatAt;
    return { low, mid, high, level: res.level, beat: res.beat };
  }

  return {
    get connected(){ return analyser !== null; },
    connect, disconnect, update,
  };
}
