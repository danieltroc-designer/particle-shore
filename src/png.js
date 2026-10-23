// Minimal PNG encoder (8-bit RGB/RGBA) using the browser's native deflate.
// Avoids canvas size limits and lets us embed settings in a tEXt chunk.

const SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// tEXt is Latin-1; escape anything else so JSON survives.
const ascii = (s) => new TextEncoder().encode(s.replace(/[^\x20-\x7e\n]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')));

// raw: scanlines already prefixed with a filter byte (0) per row.
export async function encodePNG(raw, width, height, channels, texts = {}) {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'));
  const z = new Uint8Array(await new Response(stream).arrayBuffer());
  const parts = [SIG, chunk('IHDR', ihdr)];
  for (const [k, v] of Object.entries(texts)) {
    const key = ascii(k), val = ascii(v);
    const data = new Uint8Array(key.length + 1 + val.length);
    data.set(key);
    data.set(val, key.length + 1);
    parts.push(chunk('tEXt', data));
  }
  parts.push(chunk('IDAT', z), chunk('IEND', new Uint8Array(0)));
  return new Blob(parts, { type: 'image/png' });
}

export function readPNGText(buffer, keyword) {
  const b = new Uint8Array(buffer);
  if (b.length < 8 || SIG.some((v, i) => b[i] !== v)) return null;
  const dv = new DataView(buffer);
  const dec = new TextDecoder('latin1');
  let p = 8;
  while (p + 8 <= b.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    if (type === 'tEXt') {
      const data = b.subarray(p + 8, p + 8 + len);
      const z = data.indexOf(0);
      if (z > 0 && dec.decode(data.subarray(0, z)) === keyword) return dec.decode(data.subarray(z + 1));
    }
    if (type === 'IEND') break;
    p += 12 + len;
  }
  return null;
}
