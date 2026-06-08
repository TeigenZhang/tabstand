import crypto from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { checkSameOrigin } from '@/lib/sameOrigin'
import {
  UPLOAD_LIMITS,
  listStaging,
  sweepStaging,
  validateUploadBuffer,
  writeStaging,
} from '@/lib/importServer'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST multipart (field "files") → stage uploaded images, return
// preview. Files keep upload order (the client orders them). The
// canonical type is sniffed from magic bytes, not the client's name.
export async function POST(req: NextRequest) {
  const crossOrigin = checkSameOrigin(req)
  if (crossOrigin) return crossOrigin
  try {
    const form = await req.formData()
    const files = form.getAll('files').filter((f): f is File => f instanceof File)
    if (files.length === 0) {
      return NextResponse.json({ error: '没有上传文件' }, { status: 400 })
    }
    if (files.length > UPLOAD_LIMITS.maxFiles) {
      return NextResponse.json(
        { error: `一次最多上传 ${UPLOAD_LIMITS.maxFiles} 张` },
        { status: 400 }
      )
    }

    const images: { data: Buffer; ext: string }[] = []
    let total = 0
    for (const file of files) {
      const data = Buffer.from(await file.arrayBuffer())
      total += data.length
      if (total > UPLOAD_LIMITS.maxTotalBytes) {
        return NextResponse.json({ error: '上传总大小超限' }, { status: 400 })
      }
      try {
        const ext = validateUploadBuffer(data) // magic-byte + pixel check
        images.push({ data, ext })
      } catch {
        // Skip non-images silently; report only if nothing survives
      }
    }
    if (images.length === 0) {
      return NextResponse.json(
        { error: '没有有效的图片（仅支持 png/jpg/gif/webp）' },
        { status: 400 }
      )
    }

    sweepStaging() // clear abandoned sessions before creating a new one
    const id = crypto.randomUUID()
    writeStaging(id, images)
    return NextResponse.json({ id, images: listStaging(id) })
  } catch (error) {
    const message = error instanceof Error ? error.message : '上传失败'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
