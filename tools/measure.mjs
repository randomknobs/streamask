#!/usr/bin/env node
// Автономный замер плотности масок без браузера: сколько из N сгенерированных
// масок по абсолютной суммарной проекционной площади осколков попадают под
// порог "пустой". Порог зафиксирован константой (см. ниже) из baseline-прогона
// на коде до тюнинга плотности/размера/палитры (2026-07, коммит 2467438) —
// НЕ пересчитывается из медианы текущего прогона, иначе сравнение "было/стало"
// всегда самореферентно.
//
// Запуск: node tools/measure.mjs
// Никаких CLI-флагов и node_modules не нужно — three.js скачивается во
// временный файл и подключается через программно зарегистрированный loader.

import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const EMPTY_AREA_THRESHOLD = 2.189;
const N = 300;

const THREE_CDN = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
const dir = await mkdtemp(join(tmpdir(), 'streamask-three-'));
const threePath = join(dir, 'three.module.js');
await writeFile(threePath, await (await fetch(THREE_CDN)).text());
const threeURL = pathToFileURL(threePath).href;

const loaderSrc = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'three') return { url: ${JSON.stringify(threeURL)}, shortCircuit: true };
  return nextResolve(specifier, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(loaderSrc), import.meta.url);

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const { reseed, seedFrom } = await import(pathToFileURL(join(srcDir, 'rng.js')).href);
const { palette } = await import(pathToFileURL(join(srcDir, 'palette.js')).href);
const { create } = await import(pathToFileURL(join(srcDir, 'layers', 'shards.js')).href);
const THREE = await import('three');

const mat = new THREE.Matrix4(), pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();

function totalProjectedArea(seed){
  reseed(seedFrom(seed));
  const cols = palette();
  const layer = create({ palette: cols, params: {} });
  let area = 0, count = 0;
  layer.object3D.children.forEach(imesh => {
    for (let i=0;i<imesh.count;i++){
      imesh.getMatrixAt(i, mat);
      mat.decompose(pos, q, sc);
      // приближённая проекционная площадь: footprint по XY (scale.x*scale.y),
      // без учёта поворота и точной формы геометрии — годится для
      // относительного сравнения "было/стало" на одинаковой метрике.
      area += Math.abs(sc.x * sc.y);
      count++;
    }
  });
  return { area, count };
}

const areas = [], counts = [];
for (let i=0;i<N;i++){
  const r = totalProjectedArea('empty-check-'+i);
  areas.push(r.area);
  counts.push(r.count);
}

const sorted = [...areas].sort((a,b)=>a-b);
const median = sorted.length % 2
  ? sorted[(sorted.length-1)/2]
  : (sorted[sorted.length/2-1] + sorted[sorted.length/2]) / 2;
const emptyCount = areas.filter(a => a < EMPTY_AREA_THRESHOLD).length;

console.log('N seeds:', N);
console.log('instance count: min', Math.min(...counts), 'max', Math.max(...counts),
  'avg', (counts.reduce((a,b)=>a+b,0)/N).toFixed(1));
console.log('total projected area: min', Math.min(...areas).toFixed(3), 'max', Math.max(...areas).toFixed(3),
  'median', median.toFixed(3), '(median is informational only, not used as the threshold)');
console.log('fixed empty threshold:', EMPTY_AREA_THRESHOLD);
console.log('"empty" masks:', emptyCount, '/', N, '=', (100*emptyCount/N).toFixed(1)+'%');
