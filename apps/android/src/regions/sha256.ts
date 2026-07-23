/**
 * Incremental SHA-256 in pure JS. Hermes ships no Web Crypto (see the crypto
 * polyfill note) and expo-crypto can only hash a whole string at once, which
 * would mean holding an entire multi-hundred-MB pack file in memory. Region
 * packs are verified by streaming the file through this hasher in chunks, so
 * memory stays flat regardless of pack size.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Rotate a 32-bit word right by `n` bits. */
function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

export interface Sha256 {
  update(bytes: Uint8Array): void;
  /** Finalise and return the lowercase-hex digest. Call at most once. */
  hex(): string;
}

export function createSha256(): Sha256 {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const block = new Uint8Array(64);
  let blockLen = 0;
  // Total message length in bytes, tracked as two 32-bit halves so the padded
  // 64-bit length is exact past 4 GiB without needing BigInt.
  let lenHi = 0;
  let lenLo = 0;

  function processBlock(): void {
    for (let i = 0; i < 16; i++) {
      const j = i * 4;
      w[i] = (block[j] << 24) | (block[j + 1] << 16) | (block[j + 2] << 8) | block[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
    h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0;
    h[7] = (h[7] + hh) | 0;
  }

  function addLen(n: number): void {
    lenLo += n;
    while (lenLo >= 0x100000000) {
      lenLo -= 0x100000000;
      lenHi += 1;
    }
  }

  return {
    update(bytes: Uint8Array): void {
      addLen(bytes.length);
      for (let i = 0; i < bytes.length; i++) {
        block[blockLen++] = bytes[i];
        if (blockLen === 64) {
          processBlock();
          blockLen = 0;
        }
      }
    },
    hex(): string {
      // Bit length of the whole message (bytes * 8).
      const bitsHi = ((lenHi << 3) | (lenLo >>> 29)) >>> 0;
      const bitsLo = (lenLo << 3) >>> 0;
      block[blockLen++] = 0x80;
      if (blockLen > 56) {
        while (blockLen < 64) block[blockLen++] = 0;
        processBlock();
        blockLen = 0;
      }
      while (blockLen < 56) block[blockLen++] = 0;
      block[56] = (bitsHi >>> 24) & 0xff;
      block[57] = (bitsHi >>> 16) & 0xff;
      block[58] = (bitsHi >>> 8) & 0xff;
      block[59] = bitsHi & 0xff;
      block[60] = (bitsLo >>> 24) & 0xff;
      block[61] = (bitsLo >>> 16) & 0xff;
      block[62] = (bitsLo >>> 8) & 0xff;
      block[63] = bitsLo & 0xff;
      processBlock();
      let out = '';
      for (let i = 0; i < 8; i++) out += h[i].toString(16).padStart(8, '0');
      return out;
    },
  };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) table[B64.charCodeAt(i)] = i;
  return table;
})();

/**
 * Decode standard base64 to bytes. The pack hasher feeds it chunks read via
 * expo-file-system's base64 encoding, so it must tolerate the `=` padding of a
 * final chunk (chunks are read on 3-byte boundaries, so only the last is padded).
 */
export function base64ToBytes(b64: string): Uint8Array {
  const len = b64.length;
  if (len === 0) return new Uint8Array(0);
  let pad = 0;
  if (b64[len - 1] === '=') pad++;
  if (b64[len - 2] === '=') pad++;
  const out = new Uint8Array((len >> 2) * 3 - pad);
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const c0 = B64_LOOKUP[b64.charCodeAt(i)];
    const c1 = B64_LOOKUP[b64.charCodeAt(i + 1)];
    const c2 = B64_LOOKUP[b64.charCodeAt(i + 2)];
    const c3 = B64_LOOKUP[b64.charCodeAt(i + 3)];
    const triple = (c0 << 18) | (c1 << 12) | ((c2 & 63) << 6) | (c3 & 63);
    if (o < out.length) out[o++] = (triple >> 16) & 0xff;
    if (o < out.length) out[o++] = (triple >> 8) & 0xff;
    if (o < out.length) out[o++] = triple & 0xff;
  }
  return out;
}
