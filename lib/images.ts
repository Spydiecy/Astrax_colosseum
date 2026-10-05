// Image rules shared by the uploader (browser) and /api/upload (server).
// Only formats that wallets and explorers reliably display as NFT artwork.
// SVG is left out on purpose: it can carry scripts and many wallets don't render it.

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024 // 10 MB

export const IMAGE_TYPES = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/gif": ["gif"],
  "image/webp": ["webp"],
} as const

export type ImageMime = keyof typeof IMAGE_TYPES

/** Value for <input type="file" accept>. */
export const IMAGE_ACCEPT = ".png,.jpg,.jpeg,.gif,.webp,image/png,image/jpeg,image/gif,image/webp"

export const IMAGE_FORMATS_LABEL = "PNG, JPG, GIF or WebP"

const extOf = (name: string) => name.split(".").pop()?.toLowerCase() || ""

/** MIME type for a file name's extension, if it's an allowed image. */
export function mimeFromName(name: string): ImageMime | null {
  const ext = extOf(name)
  for (const [mime, exts] of Object.entries(IMAGE_TYPES)) {
    if ((exts as readonly string[]).includes(ext)) return mime as ImageMime
  }
  return null
}

/** Quick checks on name, type and size. Returns an error message, or null if OK. */
export function checkImageFile(file: { name: string; type: string; size: number }): string | null {
  const byName = mimeFromName(file.name)
  if (!byName || (file.type && !(file.type in IMAGE_TYPES))) {
    return `"${file.name}" isn't a supported image. Use ${IMAGE_FORMATS_LABEL}.`
  }
  if (file.size === 0) return `"${file.name}" is empty.`
  if (file.size > MAX_IMAGE_BYTES) return `"${file.name}" is larger than 10 MB.`
  return null
}

/** Detect the real image type from the file's first bytes (ignores the name). */
export function sniffImageType(b: Uint8Array): ImageMime | null {
  const at = (i: number, ...bytes: number[]) => bytes.every((v, k) => b[i + k] === v)
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png"
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return "image/jpeg"
  if (b.length >= 6 && (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) return "image/gif"
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp"
  return null
}
