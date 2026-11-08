/**
 * Minimal STORED (uncompressed) ZIP writer (SPEC §2.9 FR-EXP-2). The hosted
 * artifact page only permits certain download extensions, so the browser build
 * wraps the exported `.stl` in a `.zip`. No compression keeps this dependency-
 * free and the round-trip lossless; a single-entry archive of a few-MB STL is
 * trivially small either way.
 */

export interface ZipEntry {
  name: string
  data: Uint8Array
}

/** Build a ZIP archive containing `files`, stored (not compressed). */
export function zipStore(files: ZipEntry[]): ArrayBuffer {
  const enc = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const f of files) {
    const name = enc.encode(f.name)
    const crc = crc32(f.data)
    const size = f.data.length

    // Local file header + name + data.
    const local = new Uint8Array(30 + name.length + size)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true) // local file header signature
    lv.setUint16(4, 20, true) // version needed
    lv.setUint16(6, 0, true) // flags
    lv.setUint16(8, 0, true) // method 0 = stored
    lv.setUint16(10, 0, true) // mod time
    lv.setUint16(12, 0x21, true) // mod date (1980-01-01)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, size, true) // compressed size
    lv.setUint32(22, size, true) // uncompressed size
    lv.setUint16(26, name.length, true)
    lv.setUint16(28, 0, true) // extra length
    local.set(name, 30)
    local.set(f.data, 30 + name.length)
    locals.push(local)

    // Central directory record.
    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true) // central dir signature
    cv.setUint16(4, 20, true) // version made by
    cv.setUint16(6, 20, true) // version needed
    cv.setUint16(8, 0, true) // flags
    cv.setUint16(10, 0, true) // method
    cv.setUint16(12, 0, true) // mod time
    cv.setUint16(14, 0x21, true) // mod date
    cv.setUint32(16, crc, true)
    cv.setUint32(20, size, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, name.length, true)
    cv.setUint16(30, 0, true) // extra length
    cv.setUint16(32, 0, true) // comment length
    cv.setUint16(34, 0, true) // disk number
    cv.setUint16(36, 0, true) // internal attrs
    cv.setUint32(38, 0, true) // external attrs
    cv.setUint32(42, offset, true) // local header offset
    central.set(name, 46)
    centrals.push(central)

    offset += local.length
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true) // end of central directory signature
  ev.setUint16(8, files.length, true) // entries on this disk
  ev.setUint16(10, files.length, true) // total entries
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true) // central dir offset
  ev.setUint16(20, 0, true) // comment length

  const total = offset + centralSize + eocd.length
  const out = new Uint8Array(total)
  let p = 0
  for (const l of locals) {
    out.set(l, p)
    p += l.length
  }
  for (const c of centrals) {
    out.set(c, p)
    p += c.length
  }
  out.set(eocd, p)
  return out.buffer
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/** Standard ISO-3309 CRC-32 (the checksum ZIP entries require). */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
