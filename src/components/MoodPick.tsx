'use client'

import { useCallback, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Song } from '@/lib/manifest'
import { coverUrl, pageCount } from '@/lib/songMedia'

// ============================================================
// 随便弹 — mood picker. The library is too long to browse when
// you just want to *play something*; this turns "74 choices"
// (decision fatigue) into "one low-stakes suggestion you can
// accept or re-roll" (a slot-machine, not a forced random).
//
// Mood is not inferred — we have no genre/difficulty/history
// signal to infer it from. Instead one coarse dial (弹唱/指弹,
// the only library axis that genuinely maps to mood) lets the
// player state intent in a tap; we random *within* that.
//
// Anti-repeat: recent picks live in localStorage so each spin
// feels fresh and we never hand back the song you just saw.
// ============================================================

const enc = (s: string) => encodeURIComponent(s)
const songKey = (s: Song) => `${s.category}/${s.name}`

const RECENT_STORAGE_KEY = 'tabstand:recent-picks'
const RECENT_MAX = 8

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((k) => typeof k === 'string') : []
  } catch {
    return []
  }
}

function saveRecent(keys: string[]): void {
  try {
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(keys.slice(0, RECENT_MAX)))
  } catch {
    // Private mode / quota — anti-repeat just degrades to pure random
  }
}

// Pick one song at random from `pool`, avoiding `avoid` keys when
// that still leaves something to choose, and never repeating the
// currently-shown song unless the pool has nothing else.
function rollFrom(pool: Song[], avoid: Set<string>, current: Song | null): Song | null {
  if (pool.length === 0) return null
  let pick = pool.filter((s) => !avoid.has(songKey(s)))
  if (pick.length === 0) pick = pool // everything's been seen — reset
  if (pick.length > 1 && current) {
    const fresh = pick.filter((s) => songKey(s) !== songKey(current))
    if (fresh.length > 0) pick = fresh
  }
  return pick[Math.floor(Math.random() * pick.length)]
}

interface Props {
  songs: Song[]
  categories: { key: string; label: string }[]
}

export default function MoodPick({ songs, categories }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  // null = 所有; default to the first category (弹唱) — that's what
  // people reach for most, and it's a saner default than the whole library
  const [mood, setMood] = useState<string | null>(categories[0]?.key ?? null)
  const [current, setCurrent] = useState<Song | null>(null)
  // Recent picks are read lazily on open so other tabs/sessions stay in sync
  const [recent, setRecent] = useState<string[]>([])

  const pool = useMemo(
    () => (mood ? songs.filter((s) => s.category === mood) : songs),
    [songs, mood]
  )

  const roll = useCallback(
    (forMood: string | null, prev: Song | null, recentKeys: string[]) => {
      const scoped = forMood ? songs.filter((s) => s.category === forMood) : songs
      const next = rollFrom(scoped, new Set(recentKeys), prev)
      setCurrent(next)
    },
    [songs]
  )

  const openPicker = () => {
    const recentKeys = loadRecent()
    setRecent(recentKeys)
    setOpen(true)
    roll(mood, null, recentKeys)
  }

  const close = () => setOpen(false)

  const pickMood = (key: string | null) => {
    setMood(key)
    roll(key, current, recent) // re-roll within the new mood immediately
  }

  const reroll = () => roll(mood, current, recent)

  // Commit the pick: remember it, then open the sheet
  const play = () => {
    if (!current) return
    const next = [songKey(current), ...recent.filter((k) => k !== songKey(current))]
    saveRecent(next)
    setOpen(false)
    router.push(`/song/${current.category}/${enc(current.name)}`)
  }

  if (songs.length === 0) return null

  if (!open) {
    return (
      <button
        onClick={openPicker}
        className="flex items-center gap-1.5 rounded-full border border-stone-700 bg-stone-900/70 px-4 py-2 text-sm font-semibold text-stone-200 transition-colors hover:border-amber-500/50 hover:text-amber-300"
      >
        <span className="text-base leading-none">🎲</span> 随机来一首
      </button>
    )
  }

  const cover = current ? coverUrl(current) : null
  const moods: { key: string | null; label: string }[] = [
    ...categories.map((c) => ({ key: c.key, label: c.label })),
    { key: null, label: '所有' },
  ]

  return (
    <div className="modal-overlay" onClick={close}>
      <div
        className="modal-card max-w-sm"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="随便弹一首"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">🎸 今天弹这首？</h2>
          <button
            onClick={close}
            className="text-stone-400 transition-colors hover:text-stone-100"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        {/* Mood dial — the only axis the library can honestly express */}
        {moods.length > 1 && (
          <div className="mb-4 inline-flex gap-1 rounded-full bg-stone-900/80 p-1 ring-1 ring-stone-800">
            {moods.map((m) => {
              const active = mood === m.key
              return (
                <button
                  key={m.key ?? '随便'}
                  onClick={() => pickMood(m.key)}
                  className={`rounded-full px-3.5 py-1 text-sm font-medium transition-all duration-200 ${
                    active
                      ? 'bg-amber-500 text-stone-950 shadow-md shadow-amber-900/40'
                      : 'text-stone-400 hover:text-stone-100'
                  }`}
                >
                  {m.label}
                </button>
              )
            })}
          </div>
        )}

        {/* Candidate card — remounts on every roll for a soft pop-in */}
        {current ? (
          <div key={songKey(current)} className="animate-fade-up">
            <div className="relative mx-auto aspect-[3/4] w-44 overflow-hidden rounded-xl border border-stone-800 bg-[#f0ead9]">
              {cover ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={cover}
                  alt={current.title}
                  className="h-full w-full bg-white object-cover object-top"
                />
              ) : (
                <div className="flex h-full items-center justify-center text-3xl text-stone-400">
                  🎼
                </div>
              )}
              <span className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-stone-950/15" />
            </div>
            <div className="mt-3 text-center">
              <p className="truncate text-base font-semibold text-stone-100">
                {current.title}
              </p>
              <p className="mt-0.5 truncate text-sm text-stone-500">
                {current.artist && <span>{current.artist} · </span>}
                {current.categoryLabel} · {pageCount(current)}页
              </p>
            </div>
          </div>
        ) : (
          <p className="py-12 text-center text-sm text-stone-500">这个心情下还没有谱～</p>
        )}

        {/* Re-roll keeps control with the player; 开始弹 commits */}
        <div className="mt-5 flex gap-2">
          <button
            onClick={reroll}
            disabled={!current}
            className="flex-1 rounded-xl border border-stone-700 py-2.5 text-sm font-medium text-stone-200 transition-colors hover:border-stone-500 hover:bg-stone-800/60 disabled:opacity-40"
          >
            换一首
          </button>
          <button
            onClick={play}
            disabled={!current}
            className="flex-1 rounded-xl bg-amber-500 py-2.5 text-sm font-semibold text-stone-950 shadow-lg shadow-amber-900/30 transition-colors hover:bg-amber-400 disabled:opacity-40"
          >
            开始弹
          </button>
        </div>
      </div>
    </div>
  )
}
