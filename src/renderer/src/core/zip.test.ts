import { describe, expect, it } from 'vitest'
import { crc32, zipStore } from './zip'

describe('zipStore (FR-EXP-2 browser .zip)', () => {
  it('wraps a file as a valid single-entry STORED archive', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const buf = new Uint8Array(zipStore([{ name: 'model.stl', data: payload }]))
    const dv = new DataView(buf.buffer)

    // Local header signature and STORED method.
    expect(dv.getUint32(0, true)).toBe(0x04034b50)
    expect(dv.getUint16(8, true)).toBe(0) // method 0 = stored
    expect(dv.getUint32(14, true)).toBe(crc32(payload))
    expect(dv.getUint32(18, true)).toBe(payload.length) // compressed == uncompressed
    expect(dv.getUint32(22, true)).toBe(payload.length)

    // Name and raw (uncompressed) payload follow the 30-byte header.
    const name = new TextDecoder().decode(buf.subarray(30, 30 + 9))
    expect(name).toBe('model.stl')
    expect(buf.subarray(39, 39 + payload.length)).toEqual(payload)

    // End-of-central-directory signature present at the tail, one entry.
    const eocd = buf.length - 22
    expect(dv.getUint32(eocd, true)).toBe(0x06054b50)
    expect(dv.getUint16(eocd + 10, true)).toBe(1)
  })

  it('computes the known CRC-32 of an ASCII string', () => {
    // CRC-32("123456789") === 0xCBF43926 (standard test vector).
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })
})
