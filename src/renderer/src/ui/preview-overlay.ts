import * as THREE from 'three'
import { toBinaryMask, type BinaryMask } from '@core/image-trace'
import type { ProjectState, Vec3 } from '@core/types'

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

const v3 = (v: Vec3): THREE.Vector3 => new THREE.Vector3(v[0], v[1], v[2])

/** Build a THREE group of overlay decals for the whole project (browser only). */
export function buildOverlayGroup(state: ProjectState): THREE.Group {
  const group = new THREE.Group()
  group.name = 'overlay'
  for (const fw of state.faces) {
    const { origin, u, v, normal } = fw.face
    for (const pl of fw.placements) {
      const mask = toBinaryMask(pl.image, pl.cut)
      const tex = new THREE.CanvasTexture(rgbaToCanvas(maskToRgba(mask)))
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

function rgbaToCanvas(img: Rgba): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')!
  const imageData = ctx.createImageData(img.width, img.height)
  imageData.data.set(img.data)
  ctx.putImageData(imageData, 0, 0)
  return canvas
}
