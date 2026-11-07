import type { TriangleMesh } from './types'

/**
 * Binary STL I/O. ASCII STL is detected and rejected (the template is binary);
 * add an ASCII path here if a supplied model turns out to be ASCII.
 *
 * Binary STL layout:
 *   80-byte header
 *   uint32   triangle count
 *   per triangle (50 bytes): 3×float32 normal, 3×(3×float32) verts, uint16 attr
 */

const HEADER_BYTES = 80
const COUNT_BYTES = 4
const TRI_BYTES = 50

/** True if the buffer looks like an ASCII STL ("solid " + text, not binary). */
function isAscii(buffer: ArrayBufferLike): boolean {
  const view = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 5))
  const header = String.fromCharCode(...view)
  if (header !== 'solid') return false
  // A binary STL can also start with "solid"; confirm via the size formula.
  if (buffer.byteLength < HEADER_BYTES + COUNT_BYTES) return true
  const dv = new DataView(buffer)
  const count = dv.getUint32(HEADER_BYTES, true)
  const expected = HEADER_BYTES + COUNT_BYTES + count * TRI_BYTES
  return expected !== buffer.byteLength
}

export function parseBinaryStl(buffer: ArrayBufferLike): TriangleMesh {
  if (isAscii(buffer)) {
    throw new Error('ASCII STL not supported yet — supply a binary STL.')
  }
  const dv = new DataView(buffer)
  const triangleCount = dv.getUint32(HEADER_BYTES, true)
  const expected = HEADER_BYTES + COUNT_BYTES + triangleCount * TRI_BYTES
  if (buffer.byteLength < expected) {
    throw new Error(`Truncated STL: expected ${expected} bytes, got ${buffer.byteLength}.`)
  }

  const positions = new Float32Array(triangleCount * 9)
  const normals = new Float32Array(triangleCount * 3)

  let offset = HEADER_BYTES + COUNT_BYTES
  for (let t = 0; t < triangleCount; t++) {
    normals[t * 3 + 0] = dv.getFloat32(offset, true)
    normals[t * 3 + 1] = dv.getFloat32(offset + 4, true)
    normals[t * 3 + 2] = dv.getFloat32(offset + 8, true)
    offset += 12
    for (let v = 0; v < 3; v++) {
      const base = t * 9 + v * 3
      positions[base + 0] = dv.getFloat32(offset, true)
      positions[base + 1] = dv.getFloat32(offset + 4, true)
      positions[base + 2] = dv.getFloat32(offset + 8, true)
      offset += 12
    }
    offset += 2 // attribute byte count
  }

  return { positions, normals, triangleCount }
}

/** Serialize a triangle soup back to a binary STL. Recomputes face normals. */
export function writeBinaryStl(mesh: TriangleMesh): ArrayBuffer {
  const { positions, triangleCount } = mesh
  const buffer = new ArrayBuffer(HEADER_BYTES + COUNT_BYTES + triangleCount * TRI_BYTES)
  const dv = new DataView(buffer)
  dv.setUint32(HEADER_BYTES, triangleCount, true)

  let offset = HEADER_BYTES + COUNT_BYTES
  for (let t = 0; t < triangleCount; t++) {
    const b = t * 9
    const n = faceNormal(positions, b)
    dv.setFloat32(offset, n[0], true)
    dv.setFloat32(offset + 4, n[1], true)
    dv.setFloat32(offset + 8, n[2], true)
    offset += 12
    for (let i = 0; i < 9; i++) {
      dv.setFloat32(offset, positions[b + i], true)
      offset += 4
    }
    offset += 2
  }
  return buffer
}

function faceNormal(p: Float32Array, b: number): [number, number, number] {
  const ax = p[b + 3] - p[b],
    ay = p[b + 4] - p[b + 1],
    az = p[b + 5] - p[b + 2]
  const bx = p[b + 6] - p[b],
    by = p[b + 7] - p[b + 1],
    bz = p[b + 8] - p[b + 2]
  const nx = ay * bz - az * by
  const ny = az * bx - ax * bz
  const nz = ax * by - ay * bx
  const len = Math.hypot(nx, ny, nz) || 1
  return [nx / len, ny / len, nz / len]
}
