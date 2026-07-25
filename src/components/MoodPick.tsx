'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Song } from '@/lib/manifest'
import { coverUrl, pageCount } from '@/lib/songMedia'
import { useOwner } from '@/lib/ownerContext'
import { drawFromBag, poolKey } from '../../scripts/lib/shuffle-bag.mjs'

// ============================================================
// 随便弹 — mood picker. The library is too long to browse when
// you just want to *play something*; this turns "74 choices"
// (decision fatigue) into "one low-stakes suggestion you can
// accept or re-roll" (a slot-machine, not a forced random).
//
// Role-scoped: it draws only from the currently-selected 角色 (or 全部),
// so the suggestion matches whose library you're browsing.
//
// Pseudo-random, not true random (the 网易云 shuffle-bag): true random
// re-hands you a song you just saw. Instead we remember every song shown
// this session and never repeat one until the whole pool is exhausted,
// then start a fresh cycle. Feels fresh, covers the library.
// ============================================================

const enc = (s: string) => encodeURIComponent(s)
const songKey = (s: Song) => `${s.category}/${s.name}`

// Session no-repeat memory: one shuffle bag per pool (role × mood), each a Set
// of songKeys shown this cycle. Persisted so navigating into a sheet and back
// doesn't re-suggest what you already saw. Stored as { poolKey: [songKey, …] }.
const BAGS_STORAGE_KEY = 'tabstand:mood-shown'

type Bags = Map<string, Set<string>>

function loadBags(): Bags {
  try {
    const raw = localStorage.getItem(BAGS_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    // Only accept the current object shape; older formats (arrays) just reset.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map()
    const bags: Bags = new Map()
    for (const [k, arr] of Object.entries(parsed)) {
      if (Array.isArray(arr)) bags.set(k, new Set(arr.filter((x) => typeof x === 'string')))
    }
    return bags
  } catch {
    return new Map()
  }
}

function saveBags(bags: Bags): void {
  try {
    const obj: Record<string, string[]> = {}
    bags.forEach((set, k) => {
      obj[k] = Array.from(set)
    })
    localStorage.setItem(BAGS_STORAGE_KEY, JSON.stringify(obj))
  } catch {
    // Private mode / quota — no-repeat degrades to per-render only
  }
}

interface Props {
  songs: Song[]
  categories: { key: string; label: string }[]
}

export default function MoodPick({ songs, categories }: Props) {
  const router = useRouter()
  const { owner, owners } = useOwner()
  const [open, setOpen] = useState(false)
  // null = 所有; default to the first category (弹唱) — that's what
  // people reach for most, and it's a saner default than the whole library
  const [mood, setMood] = useState<string | null>(categories[0]?.key ?? null)
  const [current, setCurrent] = useState<Song | null>(null)
  // One shuffle bag per pool (role × mood). Survives modal open/close; seeded
  // from storage on first open so it also survives navigation.
  const bagsRef = useRef<Bags>(new Map())
  const seededRef = useRef(false)

  // Draw one song scoped to the current role + mood from THAT pool's own
  // shuffle bag: random each cycle, no repeat until the pool is exhausted, and
  // independent of other (possibly overlapping) pools. Unit-tested in
  // scripts/lib/shuffle-bag.test.mjs.
  const roll = (forMood: string | null, prev: Song | null) => {
    const scoped = songs.filter(
      (s) => (!owner || s.owner === owner) && (forMood ? s.category === forMood : true)
    )
    const key = poolKey(owner, forMood)
    const bags = bagsRef.current
    let bag = bags.get(key)
    if (!bag) {
      bag = new Set<string>()
      bags.set(key, bag)
    }
    const next = drawFromBag(bag, scoped, prev ? songKey(prev) : null, songKey) as Song | null
    if (next) saveBags(bags)
    setCurrent(next)
  }

  const openPicker = () => {
    if (!seededRef.current) {
      // Merge stored history in once so a reload/return doesn't repeat
      loadBags().forEach((set, k) => bagsRef.current.set(k, set))
      seededRef.current = true
    }
    setOpen(true)
    roll(mood, null)
  }

  const close = () => setOpen(false)

  const pickMood = (key: string | null) => {
    setMood(key)
    roll(key, current) // re-roll within the new mood immediately
  }

  const reroll = () => roll(mood, current)

  // Commit the pick and open the sheet (already recorded in shown by roll)
  const play = () => {
    if (!current) return
    setOpen(false)
    router.push(`/song/${current.category}/${enc(current.name)}`)
  }

  if (songs.length === 0) return null

  const ownerLabel = owner && owners.length > 1 ? owner : null

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
          <h2 className="text-lg font-semibold">
            🎸 今天弹这首？
            {ownerLabel && (
              <span className="ml-2 align-middle text-xs font-medium text-amber-400/90">
                {ownerLabel}
              </span>
            )}
          </h2>
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
