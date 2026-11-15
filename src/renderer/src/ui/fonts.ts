import { pickFile } from '../web-io'
import { BUILTIN_FONTS } from '@core/types'

/**
 * Font choices for text overlays: the cross-platform built-in list plus any
 * fonts the user uploads. Uploaded fonts are registered with the browser via the
 * FontFace API so the canvas rasterizer (`ui/text-image.ts`) can draw them, and
 * their bytes are kept so a saved project can embed them and stay portable.
 */

export interface StoredFont {
  family: string
  data: Uint8Array
}

export class FontRegistry {
  private uploaded = new Map<string, Uint8Array>()

  /** Built-in families followed by uploaded ones (for the editor dropdown). */
  list(): string[] {
    return [...BUILTIN_FONTS, ...this.uploaded.keys()]
  }

  /**
   * Pick a font file, register it for canvas use, and return its family name
   * (or null if the picker was cancelled).
   */
  async upload(): Promise<string | null> {
    let picked: { name: string; buffer: ArrayBuffer }
    try {
      picked = await pickFile('.ttf,.otf,.woff,.woff2,font/*')
    } catch {
      return null // cancelled / nothing chosen
    }
    const bytes = new Uint8Array(picked.buffer)
    const family = this.uniqueFamily(baseName(picked.name))
    await this.addFace(family, bytes)
    this.uploaded.set(family, bytes)
    return family
  }

  /** Re-register uploaded fonts from a loaded project (await before rendering text). */
  async register(fonts: StoredFont[] | undefined): Promise<void> {
    if (!fonts) return
    for (const f of fonts) {
      if (this.uploaded.has(f.family)) continue
      this.uploaded.set(f.family, f.data)
      try {
        await this.addFace(f.family, f.data)
      } catch (err) {
        console.warn(`font "${f.family}" failed to load:`, err)
      }
    }
  }

  /** Uploaded fonts (family + bytes) for embedding in a saved project. */
  serialize(): StoredFont[] {
    return [...this.uploaded].map(([family, data]) => ({ family, data }))
  }

  private async addFace(family: string, bytes: Uint8Array): Promise<void> {
    const face = new FontFace(family, bytes as BufferSource)
    await face.load()
    document.fonts.add(face)
  }

  /** Avoid clashing with a built-in or an already-uploaded family. */
  private uniqueFamily(base: string): string {
    const taken = (name: string): boolean =>
      this.uploaded.has(name) || (BUILTIN_FONTS as readonly string[]).includes(name)
    let name = base || 'Custom Font'
    for (let n = 2; taken(name); n++) name = `${base || 'Custom Font'} ${n}`
    return name
  }
}

function baseName(file: string): string {
  return file.replace(/\.[^.]+$/, '').trim()
}
