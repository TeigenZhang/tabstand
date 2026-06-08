import fs from 'node:fs/promises'
import path from 'node:path'
import { NextRequest, NextResponse } from 'next/server'

// ============================================================
// Tab image server — library/ lives outside public/ (private,
// gitignored content), so images are read on demand here with
// path-traversal and extension-whitelist checks
// ============================================================

const LIBRARY_DIR = path.join(process.cwd(), 'library')

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.jfif': 'image/jpeg',
  '.webp': 'image/webp',
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { path: string[] } }
) {
  const relativePath = params.path.join('/')
  const filePath = path.normalize(path.join(LIBRARY_DIR, relativePath))

  // Prevent path traversal: resolved path must stay inside library/
  if (!filePath.startsWith(LIBRARY_DIR + path.sep)) {
    return NextResponse.json({ error: 'invalid path' }, { status: 400 })
  }

  const mimeType = MIME_TYPES[path.extname(filePath).toLowerCase()]
  if (!mimeType) {
    return NextResponse.json({ error: 'unsupported type' }, { status: 400 })
  }

  try {
    const data = await fs.readFile(filePath)
    return new NextResponse(data, {
      headers: {
        'Content-Type': mimeType,
        'Cache-Control': 'public, max-age=3600',
      },
    })
  } catch {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
}
