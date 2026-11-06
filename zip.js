'use strict';
/* Store-only ZIP writer (no compression): ROOT files do not shrink much anyway and this keeps the
 * page dependency-free. entries: [{ name: 'RAW/x.root', parts: [Uint8Array...] | Uint8Array | string }]
 * Returns an array of Uint8Array chunks suitable for new Blob(chunks). Files up to 4 GB (no zip64). */
const ZipStore = (() => {
  const CRC = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); CRC[n] = c; }
  function crc32(parts) { let c = -1; for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC[(c ^ p[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
  const enc = s => { const out = []; for (let i = 0; i < s.length; i++) { let c = s.codePointAt(i); if (c > 0xffff) i++; if (c < 0x80) out.push(c); else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63)); else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); } return Uint8Array.from(out); };
  function dosTime(d) { return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() }; }
  function le(fields) { const n = fields.reduce((a, [w]) => a + w, 0), b = new Uint8Array(n), dv = new DataView(b.buffer); let o = 0; for (const [w, v] of fields) { if (w === 2) dv.setUint16(o, v, true); else dv.setUint32(o, v >>> 0, true); o += w; } return b; }
  function build(entries, date) {
    const { time, date: dd } = dosTime(date || new Date()), out = [], central = [];
    let offset = 0;
    for (const e of entries) {
      const parts = typeof e.parts === 'string' ? [enc(e.parts)] : (e.parts instanceof Uint8Array ? [e.parts] : e.parts);
      const size = parts.reduce((a, p) => a + p.length, 0), crc = crc32(parts), name = enc(e.name);
      const local = le([[4, 0x04034b50], [2, 20], [2, 0x800], [2, 0], [2, time], [2, dd], [4, crc], [4, size], [4, size], [2, name.length], [2, 0]]);
      out.push(local, name, ...parts);
      central.push(le([[4, 0x02014b50], [2, 20], [2, 20], [2, 0x800], [2, 0], [2, time], [2, dd], [4, crc], [4, size], [4, size], [2, name.length], [2, 0], [2, 0], [2, 0], [2, 0], [4, 0], [4, offset]]), name);
      offset += local.length + name.length + size;
    }
    const cdSize = central.reduce((a, p) => a + p.length, 0);
    out.push(...central, le([[4, 0x06054b50], [2, 0], [2, 0], [2, entries.length], [2, entries.length], [4, cdSize], [4, offset], [2, 0]]));
    return out;
  }
  return { build, crc32 };
})();
if (typeof module !== 'undefined') module.exports = ZipStore;
