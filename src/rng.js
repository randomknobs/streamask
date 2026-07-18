// mulberry32 + детерминированные хелперы. Один общий поток случайности —
// generate() пересевает через reseed() в начале, дальше все слои читают
// из этого же rnd в фиксированном порядке.

export function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function seedFrom(str){
  let h = 2166136261;
  for (const ch of str) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

let rnd = mulberry32(1);

export function reseed(seedNum){ rnd = mulberry32(seedNum); }

export function R(a = 1, b = 0){ return b + rnd() * (a - b); }
export function RI(a, b = 0){ return Math.floor(R(a, b)); }
export function pick(arr){ return arr[RI(arr.length)]; }
