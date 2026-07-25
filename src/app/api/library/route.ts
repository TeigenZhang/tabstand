import { NextRequest, NextResponse } from 'next/server'
import { checkSameOrigin } from '@/lib/sameOrigin'
import {
  MoveConflictError,
  applyPageEdit,
  deleteSong,
  deleteVersion,
  demoteMain,
  movePages,
  promoteVersion,
  rescan,
  renameSong,
  renameVersion,
  reorderVersions,
  setArtist,
  setOwner,
} from '@/lib/libraryEdit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST { op, ... } → one edit operation on a song already in the
// library. Field validation (path safety, whitelisting against the
// real directory contents) happens inside libraryEdit.
export async function POST(req: NextRequest) {
  const crossOrigin = checkSameOrigin(req)
  if (crossOrigin) return crossOrigin
  try {
    const body = await req.json()
    switch (body.op) {
      case 'pages':
        return NextResponse.json({ ok: true, ...applyPageEdit(body) })
      case 'move':
        return NextResponse.json({ ok: true, ...movePages(body) })
      case 'renameSong':
        return NextResponse.json({ ok: true, ...renameSong(body) })
      case 'setArtist':
        return NextResponse.json({ ok: true, ...setArtist(body) })
      case 'setOwner':
        return NextResponse.json({ ok: true, ...setOwner(body) })
      case 'rescan':
        return NextResponse.json({ ...rescan() })
      case 'renameVersion':
        return NextResponse.json({ ok: true, ...renameVersion(body) })
      case 'reorderVersions':
        return NextResponse.json({ ok: true, ...reorderVersions(body) })
      case 'promoteVersion':
        return NextResponse.json({ ok: true, ...promoteVersion(body) })
      case 'demoteMain':
        return NextResponse.json({ ok: true, ...demoteMain(body) })
      case 'deleteSong':
        deleteSong(body)
        return NextResponse.json({ ok: true })
      case 'deleteVersion':
        return NextResponse.json({ ok: true, ...deleteVersion(body) })
      default:
        return NextResponse.json({ error: `未知操作：${body.op}` }, { status: 400 })
    }
  } catch (error) {
    // Non-empty move target → the client confirms, then retries with
    // merge: true (same pattern as the import commit 409)
    if (error instanceof MoveConflictError) {
      return NextResponse.json(
        { conflict: true, existingPages: error.existingPages, error: error.message },
        { status: 409 }
      )
    }
    const message = error instanceof Error ? error.message : '操作失败'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
