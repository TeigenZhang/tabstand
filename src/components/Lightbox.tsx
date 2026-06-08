'use client'

import { useEffect } from 'react'

// ============================================================
// Lightbox — full-screen viewer for staged/search/library images.
// Tab pages are tall, so the image scrolls vertically. Esc to
// close, ← / → to move between pages.
// ============================================================

export default function Lightbox({
  urls,
  index,
  onClose,
  onNav,
}: {
  urls: string[]
  index: number
  onClose: () => void
  onNav: (d: number) => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') onNav(-1)
      else if (e.key === 'ArrowRight') onNav(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onNav])

  const multi = urls.length > 1

  return (
    <div data-overlay className="fixed inset-0 z-[60] flex flex-col bg-black/90 backdrop-blur-sm" onClick={onClose}>
      <div className="flex shrink-0 items-center justify-between px-4 py-3 text-sm text-stone-300">
        <span>{multi ? `${index + 1} / ${urls.length}` : '预览'}</span>
        <button onClick={onClose} aria-label="关闭" className="rounded-md px-2 py-1 hover:bg-white/10">
          ✕ 关闭
        </button>
      </div>
      <div className="flex flex-1 items-center gap-2 overflow-hidden px-2 pb-4">
        {multi && (
          <button
            onClick={(e) => { e.stopPropagation(); onNav(-1) }}
            aria-label="上一张"
            className="shrink-0 rounded-full bg-white/10 p-2 text-2xl text-white hover:bg-white/20"
          >
            ‹
          </button>
        )}
        <div className="h-full flex-1 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={urls[index]} alt="" className="mx-auto max-w-full rounded bg-white" />
        </div>
        {multi && (
          <button
            onClick={(e) => { e.stopPropagation(); onNav(1) }}
            aria-label="下一张"
            className="shrink-0 rounded-full bg-white/10 p-2 text-2xl text-white hover:bg-white/20"
          >
            ›
          </button>
        )}
      </div>
    </div>
  )
}
