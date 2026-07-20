// Фаза 6 — запись видео, фаза 6b — снимок для «поделиться». Оба построены
// на одном композитном канвасе: <video> и WebGL-канвас (#gl) — два разных
// DOM-элемента, снять их вместе можно только перерисовав кадр за кадром в
// третий, отдельный canvas.

const OUT_W = 1280, OUT_H = 720;
const BITRATE = 8_000_000;
const CHUNK_INTERVAL_MS = 1000; // чанки по 1с — не копим всю запись одним Blob в памяти
const LONG_RECORDING_WARN_MS = 10 * 60 * 1000;

// mp4 сначала — многие приложения (в т.ч. на телефонах) не принимают webm
// для шаринга, а isTypeSupported честно скажет, поддерживает ли браузер
// конкретную комбинацию контейнер+кодек, гадать не нужно.
const VIDEO_MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm',
];

export function extensionForMime(mime){
  return mime && mime.startsWith('video/mp4') ? 'mp4' : 'webm';
}
// поддержка альфы у VP9 в MediaRecorder — не везде и на момент написания
// практически нигде в вебе; isTypeSupported сам скажет правду для
// конкретного браузера, кода на глаз не угадываем.
const ALPHA_MIME_CANDIDATES = [
  'video/webm;codecs=vp09.00.10.08.alpha1',
  'video/webm;codecs=vp9.0,opus',
];

// Явный список codecs= в mimeType — не подсказка, а ИСЧЕРПЫВАЮЩИЙ список
// того, что MediaRecorder имеет право писать: если в стриме есть аудиотрек,
// а codecs называет только видео-кодек, аудио молча выбрасывается, хотя
// формально запись идёт без единой ошибки. Эти два кандидата называют
// только видео — пропускаем их, когда в стриме реально есть звук.
const AUDIO_UNSAFE_VIDEO_ONLY = new Set(['video/mp4;codecs=avc1', 'video/webm;codecs=vp9']);

export function pickSupportedMime(candidates, { hasAudio = false } = {}){
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of candidates){
    if (hasAudio && AUDIO_UNSAFE_VIDEO_ONLY.has(m)) continue;
    if (MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return '';
}

// canvas.toBlob() асинхронный (коллбэк) — navigator.share() из 6b обязан
// вызываться синхронно из обработчика клика, без await перед собой (иначе
// часть браузеров тихо отклоняет вызов как не идущий от жеста пользователя).
// toDataURL() синхронный, а data: URL → Blob вручную через atob — тоже
// синхронно, без единого await на всём пути от клика до share().
export function dataUrlToBlobSync(dataUrl){
  const commaIdx = dataUrl.indexOf(',');
  const header = dataUrl.slice(0, commaIdx);
  const base64 = dataUrl.slice(commaIdx + 1);
  const mime = header.match(/:(.*?);/)[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i=0;i<binary.length;i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function createRecorder({ video, glCanvas }){
  const out = document.createElement('canvas');
  out.width = OUT_W; out.height = OUT_H;
  const ctx = out.getContext('2d', { alpha:true });

  let transparentMode = false;
  let transparentSupported = false; // выясняется при старте записи, см. startRecording

  function drawComposite(){
    ctx.clearRect(0, 0, out.width, out.height);
    if (!transparentMode){
      // зеркалим видео по X — тот же селфи-режим, что и у #cam в разметке
      // (там это чистый CSS transform, здесь рисуем руками).
      ctx.save();
      ctx.setTransform(-1, 0, 0, 1, out.width, 0);
      ctx.drawImage(video, 0, 0, out.width, out.height);
      ctx.restore();
    } else if (!transparentSupported){
      // альфа недоступна в этом браузере — честный зелёный фон вместо
      // тихой потери прозрачности (см. startRecording/onTransparentFallback).
      ctx.fillStyle = '#00ff00';
      ctx.fillRect(0, 0, out.width, out.height);
    }
    // если transparentMode && transparentSupported — под маской остаётся
    // чистый alpha=0 фон, video в композит не идёт вовсе.
    ctx.drawImage(glCanvas, 0, 0, out.width, out.height);
  }

  // Композит перерисовывается по кадрам видео (requestVideoFrameCallback),
  // а не по кадрам экрана (requestAnimationFrame) — так частота отрисовки
  // совпадает с реальным фреймрейтом камеры (обычно ~30) и не растёт вместе
  // с герцовкой дисплея (60/120/144), что и было бы риском просадки fps,
  // от которого явно предостерегает спека. Там, где rVFC нет (старые
  // Firefox/Safari), падаем на rAF как честный фолбэк.
  let compositing = false;
  let vfcHandle = null, rafHandle = null;

  function tick(){
    drawComposite();
    if (!compositing) return;
    if (video.requestVideoFrameCallback){
      vfcHandle = video.requestVideoFrameCallback(tick);
    } else {
      rafHandle = requestAnimationFrame(tick);
    }
  }
  function startCompositing(){
    if (compositing) return;
    compositing = true;
    tick();
  }
  function stopCompositing(){
    compositing = false;
    if (vfcHandle && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(vfcHandle);
    if (rafHandle) cancelAnimationFrame(rafHandle);
    vfcHandle = null; rafHandle = null;
  }

  let mediaRecorder = null;
  let chunks = [];
  let recordStartTs = 0;
  let warnedLong = false;
  let lastBlob = null, lastMime = '';
  let tickTimer = null;
  let capturedStream = null; // трек с out.captureStream() — глушим явно в onstop

  // mic: MediaStream с аудиодорожкой (или null) — main.js сам делает
  // getUserMedia({audio:true}) под тумблером и передаёт готовый stream сюда;
  // record.js не занимается разрешениями на микрофон.
  function startRecording({ micStream = null, transparent = false, onTick, onStop, onWarnLong } = {}){
    if (mediaRecorder) return false;
    if (typeof MediaRecorder === 'undefined') return false;

    transparentMode = transparent;
    transparentSupported = transparent && !!pickSupportedMime(ALPHA_MIME_CANDIDATES);

    startCompositing();

    // трек держим в замыкании и глушим явно в onstop — captureStream()
    // заводит новый MediaStreamTrack на канвасе при каждом старте записи,
    // никто не остановит его сам по себе просто потому что MediaRecorder
    // закончил работу.
    capturedStream = out.captureStream(30);
    const tracks = [...capturedStream.getVideoTracks()];
    if (micStream) tracks.push(...micStream.getAudioTracks());
    const finalStream = new MediaStream(tracks);
    const hasAudio = finalStream.getAudioTracks().length > 0;

    const mimeType = transparentMode && transparentSupported
      ? pickSupportedMime(ALPHA_MIME_CANDIDATES, { hasAudio })
      : pickSupportedMime(VIDEO_MIME_CANDIDATES, { hasAudio });

    mediaRecorder = new MediaRecorder(finalStream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: BITRATE
    });
    lastMime = mediaRecorder.mimeType || mimeType || 'video/webm';
    // видно в консоли при каждом старте записи — какой mimeType реально
    // выбрался и какие треки (с kind) ушли в MediaRecorder, чтобы вопрос
    // "куда делось аудио" был проверяем без гадания.
    console.log('[record] mimeType:', lastMime, 'tracks:',
      finalStream.getTracks().map(t => `${t.kind}(${t.label || t.id})`));
    chunks = [];
    recordStartTs = performance.now();
    warnedLong = false;

    mediaRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    mediaRecorder.onstop = () => {
      stopCompositing();
      capturedStream?.getTracks().forEach(t => t.stop());
      capturedStream = null;
      lastBlob = new Blob(chunks, { type: lastMime });
      chunks = [];
      clearInterval(tickTimer); tickTimer = null;
      onStop?.(lastBlob, lastMime);
    };
    mediaRecorder.start(CHUNK_INTERVAL_MS);

    tickTimer = setInterval(() => {
      const elapsed = (performance.now() - recordStartTs) / 1000;
      onTick?.(elapsed);
      if (!warnedLong && elapsed*1000 >= LONG_RECORDING_WARN_MS){
        warnedLong = true;
        onWarnLong?.(elapsed);
      }
    }, 500);

    return true;
  }

  function stopRecording(){
    if (!mediaRecorder) return;
    mediaRecorder.stop();
    mediaRecorder = null;
  }

  // разовый композит для скриншота — НЕ запускает постоянный цикл, синхронно
  // рисует один кадр и синхронно (toDataURL, не toBlob) отдаёт PNG, чтобы
  // цепочка клика до navigator.share() в 6b нигде не проходила через await.
  // transparent тут читается ЗАНОВО (не оставшееся состояние от последней
  // записи) — PNG прозрачность поддерживает всегда, в отличие от
  // видео-кодека, отдельного фолбэка на зелёный фон здесь не нужно.
  function snapshotDataUrl({ transparent = false } = {}){
    transparentMode = transparent;
    transparentSupported = true;
    drawComposite();
    return out.toDataURL('image/png');
  }

  return {
    get isRecording(){ return mediaRecorder !== null; },
    get transparentFallbackActive(){ return transparentMode && !transparentSupported; },
    // true, когда реально идущая/только что законченная запись НЕ mp4 —
    // т.е. mp4 не нашёлся в isTypeSupported и сработал фолбэк на webm.
    get usingMp4Fallback(){ return !!lastMime && !lastMime.startsWith('video/mp4'); },
    get lastBlob(){ return lastBlob; },
    get lastMime(){ return lastMime; },
    get outCanvas(){ return out; },
    startRecording,
    stopRecording,
    snapshotDataUrl,
  };
}
