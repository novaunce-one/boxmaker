import type { ImageSource } from '@core/types'

/**
 * Canvas-backed pixel codec for project files: `ImageSource` (raw RGBA) <->
 * PNG data URL. Lossless for the pixels the cut pipeline reads, and far smaller
 * than raw RGBA. Lives outside `core/` because it needs the DOM canvas.
 */

export async function encodeImagePng(image: ImageSource): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const ctx = canvas.getContext('2d')!
  const data = ctx.createImageData(image.width, image.height)
  data.data.set(image.rgba)
  ctx.putImageData(data, 0, 0)
  return canvas.toDataURL('image/png')
}

export async function decodeImagePng(dataUrl: string): Promise<ImageSource> {
  // An <img> (img-src allows data:) rather than fetch(): connect-src is 'self'.
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(img, 0, 0)
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return { width: canvas.width, height: canvas.height, rgba: data }
}
