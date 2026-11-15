import { trimToContent } from '@core/image-trace'
import { DEFAULT_CUT, type ImageSource, type Placement, type TextSpec, type Vec2 } from '@core/types'

/**
 * Render a text overlay to a raster `ImageSource` so it flows through the exact
 * same engrave/emboss pipeline as an imported image (SPEC §2.4/§2.7). The text
 * is drawn **black on an opaque white background** — the mask is luma-based and
 * ignores alpha, so a transparent background would read as "cut". An optional
 * stroke thickens thin glyph strokes (in mm) for printability.
 *
 * The placed size is derived from the rendered pixels (after trimming the empty
 * margin), so the editor's bounding box hugs the text and `fontSizeMm` is its
 * true height on the box. The caller must ensure the font family is loaded
 * (built-ins are system fonts; uploaded fonts register via `FontRegistry`).
 */
export function renderTextImage(spec: TextSpec, pxPerMm = 24): { image: ImageSource; sizeMm: Vec2 } {
  const fontPx = Math.max(1, spec.fontSizeMm * pxPerMm)
  const strokePx = Math.max(0, spec.thicknessMm * pxPerMm)
  const content = spec.content.length ? spec.content : ' '

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  const font = `${fontPx}px "${cssFontFamily(spec.fontFamily)}"`
  ctx.font = font
  ctx.textBaseline = 'alphabetic'

  const m = ctx.measureText(content)
  const ascent = m.actualBoundingBoxAscent || fontPx * 0.8
  const descent = m.actualBoundingBoxDescent || fontPx * 0.2
  const pad = Math.ceil(strokePx / 2) + 2
  const w = Math.max(1, Math.ceil(m.width + 2 * pad))
  const h = Math.max(1, Math.ceil(ascent + descent + 2 * pad))

  canvas.width = w
  canvas.height = h
  // measureText reset the context; re-apply before drawing.
  ctx.font = font
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, w, h)

  const x = pad
  const y = pad + ascent
  ctx.fillStyle = '#000'
  if (strokePx > 0) {
    ctx.lineJoin = 'round'
    ctx.lineWidth = strokePx
    ctx.strokeStyle = '#000'
    ctx.strokeText(content, x, y)
  }
  ctx.fillText(content, x, y)

  const { data } = ctx.getImageData(0, 0, w, h)
  const raw: ImageSource = { width: w, height: h, rgba: data }
  const image = trimToContent(raw, DEFAULT_CUT)
  return {
    image,
    sizeMm: [Math.max(0.5, image.width / pxPerMm), Math.max(0.5, image.height / pxPerMm)]
  }
}

/**
 * A centred text placement for a face (mirrors `createCenteredPlacement`): the
 * size comes from the rendered glyphs and the spec is kept for later editing.
 */
export function createTextPlacement(spec: TextSpec): Placement {
  const { image, sizeMm } = renderTextImage(spec)
  return {
    center: [0, 0],
    size: sizeMm,
    rotation: 0,
    image,
    cut: { ...DEFAULT_CUT },
    text: { ...spec }
  }
}

/** Guard the family name against breaking out of the CSS font string. */
function cssFontFamily(family: string): string {
  return family.replace(/["\\]/g, '')
}
