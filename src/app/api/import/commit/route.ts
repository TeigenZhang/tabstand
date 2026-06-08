import { NextRequest, NextResponse } from 'next/server'
import { checkSameOrigin } from '@/lib/sameOrigin'
import { CommitConflictError, cleanupStaging, commitStaging } from '@/lib/importServer'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST { id, category, name, version?, files?, mode? } → move staged
// images into the library and rescan. A 409 means the target already
// has pages — the client re-submits with mode:'append' or a version
// name after the user chooses. DELETE { id } → discard the staging.
export async function POST(req: NextRequest) {
  const crossOrigin = checkSameOrigin(req)
  if (crossOrigin) return crossOrigin
  try {
    const { id, category, name, version, artist, files, mode } = await req.json()
    if (!id) return NextResponse.json({ error: '缺少 id' }, { status: 400 })
    const result = commitStaging({ id, category, name, version, artist, files, mode })
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    if (error instanceof CommitConflictError) {
      return NextResponse.json(
        { conflict: true, existingPages: error.existingPages, error: error.message },
        { status: 409 }
      )
    }
    const message = error instanceof Error ? error.message : '入库失败'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export async function DELETE(req: NextRequest) {
  const crossOrigin = checkSameOrigin(req)
  if (crossOrigin) return crossOrigin
  try {
    const { id } = await req.json()
    if (id) cleanupStaging(id)
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: true })
  }
}
