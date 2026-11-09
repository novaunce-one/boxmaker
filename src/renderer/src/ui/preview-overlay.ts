import * as THREE from 'three'
import { previewContours, type BinaryMask, type Contour } from '@core/image-trace'
import type { ProjectState, Vec2, Vec3 } from '@core/types'

/**
 * View 1 — the fast "overlay" preview (SPEC §2 FR-VIEW): the thresholded image
 * is drawn onto the picked face as a dark, semi-transparent decal that reads as
 * an engraving, without changing the geometry. Rebuilt from `ProjectState` on
 * every edit / undo / redo.
 */

export interface Rgba {
  width: number
  height: number
  /** RGBA, length width*height*4. */
  data: Uint8ClampedArray
}

/** Pure, DOM-free: binary mask → RGBA buffer (cut pixels opaque-dark). Testable. */
export function maskToRgba(
  mask: BinaryMask,
  color: readonly [number, number, number] = [15, 15, 15],
  cutAlpha = 210
): Rgba {
  const data = new Uint8ClampedArray(mask.width * mask.height * 4)
  for (let i = 0; i < mask.bits.length; i++) {
    const o = i * 4
    data[o] = color[0]
    data[o + 1] = color[1]
    data[o + 2] = color[2]
    data[o + 3] = mask.bits[i] ? cutAlpha : 0
  }
  return { width: mask.width, height: mask.height, data }
}

/** Raised (embossed) art reads as a light tint, etched art as a dark one. */
const RAISED_COLOR: readonly [number, number, number] = [255, 205, 90]

const v3 = (v: Vec3): THREE.Vector3 => new THREE.Vector3(v[0], v[1], v[2])

/** Build a THREE group of overlay decals for the whole project (browser only). */
export function buildOverlayGroup(state: ProjectState): THREE.Group {
  const group = new THREE.Group()
  group.name = 'overlay'
  for (const fw of state.faces) {
    const { origin, u, v, normal } = fw.face
    for (const pl of fw.placements) {
      // Drawn from the smoothed outline that will actually be cut / raised.
      const tex = new THREE.CanvasTexture(
        contoursToCanvas(
          previewContours(pl),
          pl.size,
          pl.cut.mode === 'emboss' ? RAISED_COLOR : [15, 15, 15],
          pl.cut.mode === 'emboss' ? 200 : 210
        )
      )
      tex.colorSpace = THREE.SRGBColorSpace
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(pl.size[0], pl.size[1]),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
      )
      // Orient the plane: local X→u, Y→v, Z→normal; then in-plane rotation.
      mesh.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(v3(u), v3(v), v3(normal))
      )
      mesh.rotateZ(pl.rotation)
      // Position at the placement center in face coords, lifted ε off the wall.
      const eps = 0.05
      mesh.position
        .copy(v3(origin))
        .addScaledVector(v3(u), pl.center[0])
        .addScaledVector(v3(v), pl.center[1])
        .addScaledVector(v3(normal), eps)
      group.add(mesh)
    }
  }
  return group
}

/**
 * Fill traced outlines (normalized [0,1], y up) into a canvas sized to the
 * placement's aspect, using the even-odd rule so holes stay open. The same rings
 * feed the real cut, so the preview shows the exact smoothed outline.
 */
export function contoursToCanvas(
  rings: readonly Contour[],
  sizeMm: Vec2,
  color: readonly [number, number, number] = [15, 15, 15],
  alpha = 210,
  longEdgePx = 512
): HTMLCanvasElement {
  const aspect = sizeMm[0] / sizeMm[1]
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(aspect >= 1 ? longEdgePx : longEdgePx * aspect))
  canvas.height = Math.max(1, Math.round(aspect >= 1 ? longEdgePx / aspect : longEdgePx))
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha / 255})`
  ctx.beginPath()
  for (const ring of rings) {
    ring.forEach(([x, y], i) => {
      const px = x * canvas.width
      const py = (1 - y) * canvas.height
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    })
    ctx.closePath()
  }
  ctx.fill('evenodd')
  return canvas
}
