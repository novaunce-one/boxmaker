import type { ManifoldToplevel } from 'manifold-3d'
import Module from 'manifold-3d'

/**
 * Lazy singleton init of the manifold-3d WASM kernel (docs/PLAN.md §7).
 *
 *   import Module from 'manifold-3d'
 *   const wasm = await Module(); wasm.setup()
 *   const { Manifold, Mesh, CrossSection } = wasm
 */

let wasm: ManifoldToplevel | null = null

export async function initManifold(): Promise<ManifoldToplevel> {
  if (wasm) return wasm
  const mod = await Module()
  mod.setup()
  wasm = mod
  return wasm
}

/** Access the initialized kernel; throws if `initManifold()` hasn't run. */
export function manifold(): ManifoldToplevel {
  if (!wasm) throw new Error('manifold not initialized — call initManifold() first.')
  return wasm
}
