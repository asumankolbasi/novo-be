'use strict';
/* Minimal ROOT file writer: one TTree with flat branches (and optionally a TArrayS object branch),
 * uncompressed, laid out byte-for-byte like ROOT 6.40 writes it (TTree v20, TBranch v13,
 * TBranchElement v10, TLeafS/I/L/F/D v1, TBasket v3, 32000-byte baskets, ROOT's own fill rule).
 * The StreamerInfo record is the one ROOT itself wrote for exactly these classes, embedded below.
 * Verified against files written by ROOT (byte-identical except time stamps and UUIDs) and read
 * back with ROOT and uproot. No DOM, no dependencies: runs in a browser, a worker or jsc.
 *
 *   const parts = RootWriter.write({
 *     fileName: 'DataR_CH0@NOVO_1_run.root',              // stored in the TFile record
 *     tree: { name: 'Data_R', title: 'CoMPASS RAW events' },
 *     branches: [
 *       { name: 'Channel',     kind: 'u16', data: Uint16Array },
 *       { name: 'Timestamp',   kind: 'u64', data: BigUint64Array },
 *       { name: 'Flags',       kind: 'u32', data: Uint32Array },
 *       { name: 'Samples',     kind: 'TArrayS', data: Int16Array, len: 1012 },   // n*len samples
 *     ],
 *   });                                                      // -> array of Uint8Array chunks
 *   new Blob(parts, { type: 'application/octet-stream' })
 */
const RootWriter = (() => {
  const BASKET_SIZE = 32000;
  const KEY_VERSION = 4;
  const ROOT_VERSION = 64004;      // format version stamped in the header (ROOT 6.40/04)
  const IOFEATURES = [0x40, 0x00, 0x00, 0x07, 0x00, 0x00, 0x1a, 0xa1, 0x2f, 0x10, 0x00];
  const KINDS = {
    u16: { leaf: 'TLeafS', code: 's', size: 2, unsigned: true, put: (dv, o, v) => dv.setUint16(o, v) },
    i16: { leaf: 'TLeafS', code: 'S', size: 2, unsigned: false, put: (dv, o, v) => dv.setInt16(o, v) },
    u32: { leaf: 'TLeafI', code: 'i', size: 4, unsigned: true, put: (dv, o, v) => dv.setUint32(o, v) },
    i32: { leaf: 'TLeafI', code: 'I', size: 4, unsigned: false, put: (dv, o, v) => dv.setInt32(o, v) },
    u64: { leaf: 'TLeafL', code: 'l', size: 8, unsigned: true, put: (dv, o, v) => dv.setBigUint64(o, BigInt(v)) },
    i64: { leaf: 'TLeafL', code: 'L', size: 8, unsigned: false, put: (dv, o, v) => dv.setBigInt64(o, BigInt(v)) },
    f32: { leaf: 'TLeafF', code: 'F', size: 4, unsigned: false, put: (dv, o, v) => dv.setFloat32(o, v) },
    f64: { leaf: 'TLeafD', code: 'D', size: 8, unsigned: false, put: (dv, o, v) => dv.setFloat64(o, v) },
    TArrayS: { leaf: 'TLeafElement', object: true },
  };
  const TARRAYS_CHECKSUM = 56398612;      // ROOT's checksum of the TArrayS class layout

  // ---------------------------------------------------------------- big-endian growable buffer
  class W {
    constructor(cap = 1 << 16) { this.buf = new ArrayBuffer(cap); this.dv = new DataView(this.buf); this.a = new Uint8Array(this.buf); this.pos = 0; }
    ensure(n) { if (this.pos + n <= this.buf.byteLength) return; let c = this.buf.byteLength * 2; while (c < this.pos + n) c *= 2; const nb = new ArrayBuffer(c); new Uint8Array(nb).set(this.a.subarray(0, this.pos)); this.buf = nb; this.dv = new DataView(nb); this.a = new Uint8Array(nb); }
    u8(v) { this.ensure(1); this.dv.setUint8(this.pos, v); this.pos += 1; }
    i16(v) { this.ensure(2); this.dv.setInt16(this.pos, v); this.pos += 2; }
    u16(v) { this.ensure(2); this.dv.setUint16(this.pos, v); this.pos += 2; }
    i32(v) { this.ensure(4); this.dv.setInt32(this.pos, v); this.pos += 4; }
    u32(v) { this.ensure(4); this.dv.setUint32(this.pos, v); this.pos += 4; }
    i64(v) { this.ensure(8); this.dv.setBigInt64(this.pos, BigInt(v)); this.pos += 8; }
    f32(v) { this.ensure(4); this.dv.setFloat32(this.pos, v); this.pos += 4; }
    f64(v) { this.ensure(8); this.dv.setFloat64(this.pos, v); this.pos += 8; }
    raw(bytes) { this.ensure(bytes.length); this.a.set(bytes, this.pos); this.pos += bytes.length; }
    zeros(n) { this.ensure(n); this.a.fill(0, this.pos, this.pos + n); this.pos += n; }
    str(s) { const b = utf8(s); if (b.length < 255) this.u8(b.length); else { this.u8(255); this.i32(b.length); } this.raw(b); }   // TString
    cstr(s) { this.raw(utf8(s)); this.u8(0); }                                                                                      // NUL-terminated
    patchI32(pos, v) { this.dv.setInt32(pos, v); }
    bytes() { return this.a.slice(0, this.pos); }
  }
  function utf8(s) { const out = []; for (let i = 0; i < s.length; i++) { let c = s.codePointAt(i); if (c > 0xffff) i++; if (c < 0x80) out.push(c); else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63)); else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); } return Uint8Array.from(out); }
  const tstrLen = s => { const n = utf8(s).length; return n < 255 ? 1 + n : 5 + n; };
  const begin = w => { const p = w.pos; w.i32(0); return p; };                       // byte-count placeholder
  const end = (w, p) => w.patchI32(p, ((w.pos - p - 4) | 0x40000000) >>> 0);        // kByteCountMask
  function datimeNow(d) { d = d || new Date(); return (((d.getFullYear() - 1995) << 26) | ((d.getMonth() + 1) << 22) | (d.getDate() << 17) | (d.getHours() << 12) | (d.getMinutes() << 6) | d.getSeconds()) >>> 0; }
  function uuid16() { const u = new Uint8Array(16); if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(u); else for (let i = 0; i < 16; i++) u[i] = Math.floor(Math.random() * 256); u[6] = (u[6] & 0x0f) | 0x10; u[8] = (u[8] & 0x3f) | 0x80; return u; }

  // ---------------------------------------------------------------- ROOT core objects
  function tobject(w, bits) { w.i16(1); w.i32(0); w.u32(bits); }
  function tnamed(w, name, title, bits) { const p = begin(w); w.i16(1); tobject(w, bits); w.str(name); w.str(title); end(w, p); }
  function tattline(w) { const p = begin(w); w.i16(2); w.i16(602); w.i16(1); w.i16(1); end(w, p); }
  function tattfill(w) { const p = begin(w); w.i16(2); w.i16(0); w.i16(1001); end(w, p); }
  function tattmarker(w) { const p = begin(w); w.i16(3); w.i16(1); w.i16(1); w.f32(1); end(w, p); }
  function tobjarrayHead(w, n, bits) { const p = begin(w); w.i16(3); tobject(w, bits); w.str(''); w.i32(n); w.i32(0); return p; }
  function iofeatures(w) { w.raw(Uint8Array.from(IOFEATURES)); }
  // TKey header; `big` selects the 8-byte seek layout (version + 1000), as ROOT uses for every basket
  function keyLen(cls, name, title, big) { return 18 + (big ? 16 : 8) + tstrLen(cls) + tstrLen(name) + tstrLen(title); }
  function keyHeader(w, k) {
    const klen = keyLen(k.cls, k.name, k.title, k.big) + (k.extra || 0);     // extra: TBasket's own header, counted in fKeylen
    w.i32(klen + k.objlen); w.i16(KEY_VERSION + (k.big ? 1000 : 0)); w.i32(k.objlen); w.u32(k.datime); w.i16(klen); w.i16(k.cycle);
    if (k.big) { w.i64(k.seekKey); w.i64(k.seekPdir); } else { w.i32(k.seekKey); w.i32(k.seekPdir); }
    w.str(k.cls); w.str(k.name); w.str(k.title);
    return klen;
  }

  // ---------------------------------------------------------------- baskets (ROOT's own fill rule)
  // A basket is flushed after entry k when keylen + bytes(k entries) + 2*4*k*(variable ? 1 : 0) + bytes(next entry) >= 32000.
  function planBaskets(branch, n, klen) {
    const out = [];
    if (!branch.kind.object) {
      const size = branch.kind.size, per = Math.max(1, Math.ceil((BASKET_SIZE - klen) / size) - 1);
      for (let s = 0; s < n; s += per) out.push({ start: s, stop: Math.min(n, s + per) });
    } else {
      let start = 0, bytes = 0, k = 0;
      for (let i = 0; i < n; i++) {
        const nb = 4 + 2 * branch.lenAt(i); bytes += nb; k++;
        if (klen + bytes + 8 * k + nb >= BASKET_SIZE && i + 1 < n) { out.push({ start, stop: i + 1 }); start = i + 1; bytes = 0; k = 0; }
      }
      if (n === 0 || start < n) out.push({ start, stop: n });
    }
    if (!out.length) out.push({ start: 0, stop: 0 });
    return out;
  }
  function basketRecord(branch, treeName, seek, b, datime, nevBufSize, cycle) {
    const w = new W(BASKET_SIZE + 256), n = b.stop - b.start, kind = branch.kind;
    const klen = keyLen('TBasket', branch.name, treeName, true) + 19;
    let dataLen, objlen;
    if (!kind.object) { dataLen = n * kind.size; objlen = dataLen; }
    else { dataLen = 0; for (let i = b.start; i < b.stop; i++) dataLen += 4 + 2 * branch.lenAt(i); objlen = dataLen + 4 + 4 * (n + 1); }
    keyHeader(w, { cls: 'TBasket', name: branch.name, title: treeName, objlen, datime, cycle, seekKey: seek, seekPdir: 100, big: true, extra: 19 });   // cycle = basket number, as ROOT does
    w.i16(3); w.i32(BASKET_SIZE); w.i32(kind.object ? nevBufSize : kind.size); w.i32(n); w.i32(klen + dataLen); w.u8(0);
    if (!kind.object) { w.ensure(dataLen); const dv = w.dv, d = branch.data; let o = w.pos; for (let i = b.start; i < b.stop; i++, o += kind.size) kind.put(dv, o, d[i]); w.pos = o; }
    else {
      const offs = new Int32Array(n + 1); let o = 0;
      for (let i = b.start; i < b.stop; i++) { const len = branch.lenAt(i), base = branch.offAt(i); offs[i - b.start] = klen + o; w.i32(len); w.ensure(2 * len); const dv = w.dv; for (let k = 0; k < len; k++) dv.setInt16(w.pos + 2 * k, branch.data[base + k]); w.pos += 2 * len; o += 4 + 2 * len; }
      w.i32(n + 1); for (let i = 0; i <= n; i++) w.i32(offs[i]);          // entry offsets; the last one is left 0 like ROOT
    }
    return { bytes: w.bytes(), nbytes: klen + objlen };
  }

  // ---------------------------------------------------------------- TTree record
  function leafBody(w, br, lenType, unsigned) { const p = begin(w); w.i16(2); tnamed(w, br.name, br.name, 0); w.i32(1); w.i32(lenType); w.i32(0); w.u8(0); w.u8(unsigned ? 1 : 0); w.i32(0); end(w, p); }
  function writeLeaf(w, br) {
    const k = br.kind, p = begin(w); w.i16(1);
    if (k.object) { leafBody(w, br, 0, false); w.i32(-1); w.i32(-1); }
    else { leafBody(w, br, k.size, k.unsigned); if (k.size === 2) { w.i16(0); w.i16(0); } else if (k.leaf === 'TLeafI') { w.i32(0); w.i32(0); } else if (k.leaf === 'TLeafL') { w.i64(0); w.i64(0); } else if (k.leaf === 'TLeafF') { w.f32(0); w.f32(0); } else { w.f64(0); w.f64(0); } }
    end(w, p);
  }
  function writeObject(w, ctx, cls, body) {        // envelope: byte count + class tag (new or back-reference) + object
    const p = begin(w);
    if (ctx.classes.has(cls)) w.u32((0x80000000 | (ctx.classes.get(cls) + 2)) >>> 0); else { ctx.classes.set(cls, w.pos); w.u32(0xffffffff); w.cstr(cls); }
    body(); end(w, p); return p;
  }
  function writeBranchBase(w, ctx, br, nEntries, treeInfo) {
    const p = begin(w); w.i16(13);
    tnamed(w, br.name, br.kind.object ? br.name : `${br.name}/${br.kind.code}`, br.kind.object ? 0x120000 : 0x400000);
    tattfill(w);
    const nb = br.baskets.length, maxB = Math.max(10, nb + 1);
    w.i32(0); w.i32(BASKET_SIZE); w.i32(br.entryOffsetLen); w.i32(nb); w.i64(nEntries); iofeatures(w); w.i32(0); w.i32(maxB); w.i32(0);
    w.i64(nEntries); w.i64(0); w.i64(br.totBytes); w.i64(br.totBytes);
    let q = tobjarrayHead(w, 0, 0); end(w, q);                                   // fBranches (none)
    q = tobjarrayHead(w, 1, 0); br.leafRef = writeObject(w, ctx, br.kind.leaf, () => writeLeaf(w, br)); end(w, q);   // fLeaves
    q = tobjarrayHead(w, nb + 1, 0); for (let i = 0; i <= nb; i++) w.i32(0); end(w, q);                             // fBaskets: slots already on disk
    w.u8(1); for (let i = 0; i < maxB; i++) w.i32(i < nb ? br.baskets[i].nbytes : 0);
    w.u8(1); for (let i = 0; i < maxB; i++) w.i64(i < nb ? br.baskets[i].start : i === nb ? nEntries : 0);
    w.u8(1); for (let i = 0; i < maxB; i++) w.i64(i < nb ? br.baskets[i].seek : 0);
    w.str('');
    end(w, p);
  }
  function writeBranch(w, ctx, br, nEntries) {
    if (!br.kind.object) return writeObject(w, ctx, 'TBranch', () => writeBranchBase(w, ctx, br, nEntries));
    return writeObject(w, ctx, 'TBranchElement', () => {
      const p = begin(w); w.i16(10);
      writeBranchBase(w, ctx, br, nEntries);
      w.str('TArrayS'); w.str(''); w.str(''); w.u32(TARRAYS_CHECKSUM); w.i16(1); w.i32(-1); w.i32(-1); w.i32(-1); w.i32(0); w.i32(0); w.i32(0);
      end(w, p);
    });
  }
  function treeRecord(tree, branches, nEntries, seek, datime) {
    const w = new W(1 << 16), ctx = { classes: new Map() };
    const klen = keyLen('TTree', tree.name, tree.title, false);
    const hdrPos = w.pos; keyHeader(w, { cls: 'TTree', name: tree.name, title: tree.title, objlen: 0, datime, cycle: 1, seekKey: seek, seekPdir: 100, big: false });
    const obj = begin(w); w.i16(20);
    tnamed(w, tree.name, tree.title, 0x8); tattline(w); tattfill(w); tattmarker(w);
    const tot = branches.reduce((a, b) => a + b.totBytes, 0);
    w.i64(nEntries); w.i64(tot); w.i64(tot); w.i64(0); w.i64(0); w.f64(1); w.i32(0); w.i32(25); w.i32(0); w.i32(1000); w.i32(0);
    w.i64(1000000000000); w.i64(1000000000000); w.i64(0); w.i64(-300000000); w.i64(-30000000); w.i64(1000000);
    w.u8(0); w.u8(0); iofeatures(w);
    let q = tobjarrayHead(w, branches.length, 0x4000); for (const br of branches) writeBranch(w, ctx, br, nEntries); end(w, q);
    q = tobjarrayHead(w, branches.length, 0); for (const br of branches) w.i32(br.leafRef + 2); end(w, q);
    w.zeros(28);                                   // fAliases, fIndexValues, fIndex, fTreeIndex, fFriends, fUserInfo, fBranchRef: all empty
    end(w, obj);
    const objlen = w.pos - klen;
    w.patchI32(hdrPos, klen + objlen); w.patchI32(hdrPos + 6, objlen);
    return { bytes: w.bytes(), keyHeader: w.a.slice(0, klen), nbytes: klen + objlen };
  }

  // ---------------------------------------------------------------- whole file
  function write(spec) {
    const fileName = spec.fileName || 'out.root', title = spec.title || '', tree = { name: 'Data_R', title: '', ...(spec.tree || {}) };
    const datime = datimeNow(spec.date), uuid = spec.uuid || uuid16();
    const branches = spec.branches.map(b => {
      const kind = KINDS[b.kind]; if (!kind) throw new Error('unknown branch kind: ' + b.kind);
      const br = { name: b.name, kind, data: b.data, baskets: [], totBytes: 0, entryOffsetLen: 0, leafRef: 0 };
      if (kind.object) {
        if (b.lens) { const offs = new Int32Array(b.lens.length + 1); for (let i = 0; i < b.lens.length; i++) offs[i + 1] = offs[i] + b.lens[i]; br.lenAt = i => b.lens[i]; br.offAt = i => offs[i]; br.n = b.lens.length; }
        else { const len = b.len | 0; br.lenAt = () => len; br.offAt = i => i * len; br.n = len ? Math.floor(b.data.length / len) : 0; }
      } else br.n = b.data.length;
      return br;
    });
    const nEntries = branches.length ? branches[0].n : 0;
    for (const br of branches) if (br.n !== nEntries) throw new Error(`branch ${br.name}: ${br.n} entries, expected ${nEntries}`);
    const parts = [];
    let pos = 100;
    // TFile key + TDirectory (fixed size; patched at the end with the keys-list position)
    const dirW = new W(256);
    const fklen = keyLen('TFile', fileName, title, false), nbytesName = fklen + tstrLen(fileName) + tstrLen(title), dirObjlen = tstrLen(fileName) + tstrLen(title) + 60;
    keyHeader(dirW, { cls: 'TFile', name: fileName, title, objlen: dirObjlen, datime, cycle: 1, seekKey: 100, seekPdir: 0, big: false });
    dirW.str(fileName); dirW.str(title); dirW.i16(5); dirW.u32(datime); dirW.u32(datime);
    const pKeys = dirW.pos; dirW.i32(0); dirW.i32(nbytesName); dirW.i32(100); dirW.i32(0); const pSeekKeys = dirW.pos; dirW.i32(0);
    dirW.i16(1); dirW.raw(uuid); dirW.zeros(12);
    parts.push(null); pos += dirW.pos;
    // baskets in ROOT's order: by the entry that filled them, then by branch
    const plan = [];
    branches.forEach((br, bi) => {
      const klen = keyLen('TBasket', br.name, tree.name, true) + 19;
      let nevBufSize = 1000;
      planBaskets(br, nEntries, klen).forEach((b, k) => {
        if (br.kind.object) { const n = b.stop - b.start; while (n + 1 > nevBufSize || n >= nevBufSize) nevBufSize *= 2; }   // ROOT doubles the offset table when it fills up
        plan.push({ br, bi, k, b, order: b.stop >= nEntries ? nEntries : b.stop - 1, nevBufSize });
      });
      if (br.kind.object) br._nevFinal = nevBufSize;
    });
    plan.sort((x, y) => (x.order - y.order) || (x.bi - y.bi));
    for (const p of plan) {
      const rec = basketRecord(p.br, tree.name, pos, p.b, datime, p.nevBufSize, p.k);
      p.br.baskets[p.k] = { start: p.b.start, stop: p.b.stop, seek: pos, nbytes: rec.nbytes };
      p.br.totBytes += rec.nbytes; parts.push(rec.bytes); pos += rec.nbytes;
    }
    for (const br of branches) if (br.kind.object) { const lastN = br.baskets.length ? br.baskets[br.baskets.length - 1].stop - br.baskets[br.baskets.length - 1].start : 0; br.entryOffsetLen = Math.min(4 * lastN, br._nevFinal) || 1000; }
    // TTree
    const seekTree = pos, tr = treeRecord(tree, branches, nEntries, pos, datime);
    parts.push(tr.bytes); pos += tr.nbytes;
    // StreamerInfo (ROOT's own record for these classes)
    const streamers = spec.streamers || STREAMERS, seekInfo = pos, sw = new W(streamers.length + 128);
    keyHeader(sw, { cls: 'TList', name: 'StreamerInfo', title: 'Doubly linked list', objlen: streamers.length, datime, cycle: 1, seekKey: pos, seekPdir: 100, big: false });
    sw.raw(streamers); const nbytesInfo = sw.pos; parts.push(sw.bytes()); pos += nbytesInfo;
    // KeysList
    const seekKeys = pos, kw = new W(512);
    keyHeader(kw, { cls: 'TFile', name: fileName, title, objlen: 4 + tr.keyHeader.length, datime, cycle: 1, seekKey: pos, seekPdir: 100, big: false });
    kw.i32(1); kw.raw(tr.keyHeader); const nbytesKeys = kw.pos; parts.push(kw.bytes()); pos += nbytesKeys;
    // FreeSegments
    const seekFree = pos, nbytesFree = fklen + 10, fEND = seekFree + nbytesFree, fw = new W(256);
    keyHeader(fw, { cls: 'TFile', name: fileName, title, objlen: 10, datime, cycle: 1, seekKey: pos, seekPdir: 100, big: false });
    fw.i16(1); fw.i32(fEND); fw.i32(2000000000); parts.push(fw.bytes()); pos += fw.pos;
    if (fEND !== pos) throw new Error('internal inconsistency: fEND');
    if (fEND >= 2000000000) throw new Error('file would exceed the 2 GB limit of this writer; narrow the time window');
    dirW.patchI32(pKeys, nbytesKeys); dirW.patchI32(pSeekKeys, seekKeys); parts[0] = dirW.bytes();
    // header
    const hw = new W(100);
    hw.raw(utf8('root')); hw.i32(ROOT_VERSION); hw.i32(100); hw.i32(fEND); hw.i32(seekFree); hw.i32(nbytesFree); hw.i32(1); hw.i32(nbytesName); hw.u8(4); hw.i32(0); hw.i32(seekInfo); hw.i32(nbytesInfo);
    hw.i16(1); hw.raw(uuid); hw.zeros(100 - hw.pos);
    parts.unshift(hw.bytes());
    return parts;
  }
  const size = parts => parts.reduce((a, p) => a + p.length, 0);
  function concat(parts) { const out = new Uint8Array(size(parts)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }

  // ROOT 6.40.04 StreamerInfo list for TTree, TBranch, TBranchElement, TLeaf/TLeafS/I/L/Element, TArrayS and their bases
  const STREAMERS = b64decode('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AAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADaW50QAAAooAAESBAAACaAAJAAACUAARAAABfAAEAAQAAAAAAAAAACGZQYXJlbnRzSWFycmF5IG9mIFBhcmVudCBvYmplY3RzICAoZWcgVFRyZWUgYnJhbmNoKSBob2xkaW5nIHRoZSByZWZlcmVuY2VkIG9iamVjdHMAAABAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKVE9iakFycmF5KkAAAHGAABEgQAAAaQACQAAAYwAEQAAAMAABAAEAAAAAAAAAAAZmT3duZXIcT2JqZWN0IG93bmluZyB0aGlzIFRSZWZUYWJsZQAAAEAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAhUT2JqZWN0KkAAAJ7/////VFN0cmVhbWVyU1RMAEAAAIkAA0AAAHsABEAAAEIAAQABAAAAAAAAAAANZlByb2Nlc3NHVUlEcydVVUlEcyBvZiBUUHJvY2Vzc0lEcyB1c2VkIGluIGZQYXJlbnRJRHMAAAH0AAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOdmVjdG9yPHN0cmluZz4AAAABAAAAPQBAAAG4gAAAW0AAAbAACkAAABcAAQABAAAAAAABAAAJVE9iakFycmF5AKmeZVIAAAADQAABh4AAAJhAAAF/AAMAAQAAAAAAAAAAAAAAAAMAAAAAQAAAeIAAAMNAAABwAANAAABmAARAAAA3AAEAAQAAAAAAAAAADlRTZXFDb2xsZWN0aW9uG1NlcXVlbmNlYWJsZSBjb2xsZWN0aW9uIEFCQwAAAAAAAAAAAAAAAAAAAAAAAAAA/Gw7xgAAAAAAAAAAAAAAAARCQVNFAAAAAEAAAG2AAAIlQAAAZQACQAAAXwAEQAAAMQABAAEAAAAAAAAAAAtmTG93ZXJCb3VuZBhMb3dlciBib3VuZCBvZiB0aGUgYXJyYXkAAAADAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADaW50QAAAeYAAAiVAAABxAAJAAABrAARAAAA9AAEAAQAAAAAAAAAABWZMYXN0Kkxhc3QgZWxlbWVudCBpbiBhcnJheSBjb250YWluaW5nIGFuIG9iamVjdAAAAAMAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANpbnQAQAABgv////9UTGlzdABAAAF0AAUAAQAAAAAAAEAAC2xpc3RPZlJ1bGVzAAAAAkAAALb/////VE9ialN0cmluZwBAAACjAAEAAQAAAAAAAAAAlnR5cGU9cmVhZCBzb3VyY2VDbGFzcz0iVFRyZWUiIHRhcmdldENsYXNzPSJUVHJlZSIgdmVyc2lvbj0iWy0xNl0iIHNvdXJjZT0iIiB0YXJnZXQ9ImZEZWZhdWx0RW50cnlPZmZzZXRMZW4iIGNvZGU9InsgZkRlZmF1bHRFbnRyeU9mZnNldExlbiA9IDEwMDA7IH0iIABAAACYgABDW0AAAJAAAQABAAAAAAAAAACDdHlwZT1yZWFkIHNvdXJjZUNsYXNzPSJUVHJlZSIgdGFyZ2V0Q2xhc3M9IlRUcmVlIiB2ZXJzaW9uPSJbLTE4XSIgc291cmNlPSIiIHRhcmdldD0iZk5DbHVzdGVyUmFuZ2UiIGNvZGU9InsgZk5DbHVzdGVyUmFuZ2UgPSAwOyB9IiAAAA==');
  function b64decode(s) {
    const T = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', lut = new Int16Array(256).fill(-1); for (let i = 0; i < 64; i++) lut[T.charCodeAt(i)] = i;
    let pad = 0; while (s.length && s[s.length - 1] === '=') { pad++; s = s.slice(0, -1); }
    const out = new Uint8Array(Math.floor(s.length * 3 / 4)); let o = 0, acc = 0, bits = 0;
    for (let i = 0; i < s.length; i++) { const v = lut[s.charCodeAt(i)]; if (v < 0) continue; acc = (acc << 6) | v; bits += 6; if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; } }
    return out.subarray(0, o);
  }
  return { write, concat, size, datime: datimeNow, b64decode };
})();
if (typeof module !== 'undefined') module.exports = RootWriter;
