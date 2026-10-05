import { NextResponse } from "next/server"
import { uploadFileToIPFS, isPinataConfigured } from "@/lib/pinata"
import { rateLimited } from "@/lib/db"
import { checkImageFile, sniffImageType, IMAGE_TYPES, IMAGE_FORMATS_LABEL } from "@/lib/images"

export const runtime = "nodejs"

// Per-IP rate limit so the endpoint can't be used to drain the Pinata quota.
// Stored in the database, so it holds across server instances.
const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 20

// Uploads one image to public IPFS via Pinata. The JWT never leaves the server.
// Images only (PNG, JPG, GIF, WebP): checked by name, declared type AND the
// file's actual bytes, so a renamed PDF or script is rejected.
export async function POST(req: Request) {
  if (!isPinataConfigured()) {
    return NextResponse.json({ error: "Image uploads aren't configured on this server." }, { status: 503 })
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local"
  if (await rateLimited(`upload:${ip}`, WINDOW_MS, MAX_PER_WINDOW)) {
    return NextResponse.json({ error: "Too many uploads. Try again in a minute." }, { status: 429 })
  }

  let file: FormDataEntryValue | null
  try {
    file = (await req.formData()).get("file")
  } catch {
    return NextResponse.json({ error: "Expected multipart form data with a `file` field." }, { status: 400 })
  }
  if (!(file instanceof File)) return NextResponse.json({ error: "No file provided." }, { status: 400 })

  const invalid = checkImageFile(file)
  if (invalid) return NextResponse.json({ error: invalid }, { status: invalid.includes("10 MB") ? 413 : 415 })

  const bytes = new Uint8Array(await file.arrayBuffer())
  const realType = sniffImageType(bytes)
  if (!realType) {
    return NextResponse.json({ error: `"${file.name}" isn't a valid image. Use ${IMAGE_FORMATS_LABEL}.` }, { status: 415 })
  }

  // Store under a clean name whose extension matches the real content.
  const base = file.name.replace(/\.[^.]*$/, "").replace(/[^\w.-]+/g, "_").slice(0, 60) || "image"
  const clean = new File([bytes], `${base}.${IMAGE_TYPES[realType][0]}`, { type: realType })

  try {
    const { cid, ipfsUrl, size } = await uploadFileToIPFS(clean)
    return NextResponse.json({ cid, ipfsUrl, size, name: file.name, contentType: realType })
  } catch (e: any) {
    console.error("[upload]", e?.message)
    return NextResponse.json({ error: "Couldn't upload to IPFS. Try again." }, { status: 502 })
  }
}
