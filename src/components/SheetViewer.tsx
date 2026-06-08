'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MAX_SPEED, MIN_SPEED, useAutoScroll } from '@/lib/useAutoScroll'
import { useWakeLock } from '@/lib/useWakeLock'

// ============================================================
// Sheet viewer — every page is scaled to FIT THE VIEWPORT HEIGHT
// so it shows top-to-bottom with no clipping, N pages side by
// side. Pages chunk into rows of N; each row is exactly one
// screen tall (flex-1 gives the scroll area a definite height,
// rows take h-full of it), so it resizes with the window / full
// screen automatically and a "page turn" scrolls one screen.
//
//   Columns: auto (fit as many as the width allows) / 1 / 2 / 3.
//   Phones force a single column.
//
// Keyboard doubles as Bluetooth pedal:
//   ↓ / → / PageDown → next screen   ↑ / ← / PageUp → previous
//   Space → toggle auto-scroll   + / - → speed
// ============================================================

const COLUMN_MODES = ['auto', '1', '2', '3'] as const
type ColumnMode = (typeof COLUMN_MODES)[number]
const MODE_LABELS: Record<ColumnMode, string> = {
  auto: '自适应',
  '1': '1',
  '2': '2',
  '3': '3',
}

// Anti-glare levels for night practice — white scans against a dark
// room are harsh; "soft" keeps daylight reading, "dim" is stage-side.
// Global preference (not per song): the room, not the song, decides.
const LIGHT_MODES = ['normal', 'soft', 'dim'] as const
type LightMode = (typeof LIGHT_MODES)[number]
const LIGHT_LABELS: Record<LightMode, string> = {
  normal: '亮',
  soft: '柔',
  dim: '暗',
}
const LIGHT_FILTERS: Record<LightMode, string> = {
  normal: 'none',
  soft: 'brightness(0.86) contrast(0.97) sepia(0.07)',
  dim: 'brightness(0.68) contrast(0.95) sepia(0.1)',
}

// Speed slider semantics — players think in tempo words, not px/s
function speedLabel(speed: number): string {
  if (speed <= 60) return '慢'
  if (speed <= 120) return '中'
  return '快'
}
const GAP = 8 // px, matches the grid gap
const ROW_PAD = 16 // px, the row's p-2 left+right padding
const DEFAULT_ASPECT = 0.72 // typical tab page (width / height)
const MAX_COLS = 3
const MIN_READABLE_W = 300 // a page narrower than this is too small to read

function chunk<T>(arr: T[], size: number): T[][] {
  if (size < 1) return [arr]
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// Ideal columns for an even, no-orphan layout:
//   1–3 pages → that many (3 → 3 across)
//   divisible by 3 → 3 (6 → 3+3)
//   divisible by 2 → 2 (4 → 2+2, not 3+1)
//   otherwise (5, 7… primes) → 2 (5 → 2+2+1)
function idealColumns(n: number): number {
  if (n <= MAX_COLS) return Math.max(1, n)
  if (n % 3 === 0) return 3
  if (n % 2 === 0) return 2
  return 2
}

// Auto columns — the balanced ideal above, stepped down only when a
// page scaled to fit its grid cell would get too small to read (narrow
// windows). Pages fit the cell (top-to-bottom complete); they don't
// need to fill the full height.
function pickAutoColumns(w: number, h: number, pageCount: number, aspect: number): number {
  const ideal = idealColumns(pageCount || 1)
  if (!w || !h) return ideal
  for (let cols = ideal; cols >= 1; cols--) {
    const cellW = (w - ROW_PAD - GAP * (cols - 1)) / cols
    const pageW = Math.min(cellW, h * aspect) // page fits the cell (contain)
    if (pageW >= MIN_READABLE_W || cols === 1) return cols
  }
  return 1
}

interface Props {
  title: string
  imageUrls: string[]
  /** Back link — leftmost slot in the top bar */
  leading?: React.ReactNode
  /** Version switcher tabs — rendered after the title */
  tabs?: React.ReactNode
  /** Edit button etc. — rightmost tool cluster */
  actions?: React.ReactNode
}

export default function SheetViewer({
  title,
  imageUrls,
  leading,
  tabs,
  actions,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const autoScroll = useAutoScroll(scrollRef, title)
  useWakeLock()

  const [columns, setColumns] = useState<ColumnMode>('auto')
  const [isNarrow, setIsNarrow] = useState(false)
  const [showControls, setShowControls] = useState(false)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [aspect, setAspect] = useState(DEFAULT_ASPECT)
  const aspectMeasured = useRef(false)
  const [light, setLight] = useState<LightMode>('normal')
  const [screen, setScreen] = useState(1)

  // Remembered column choice per song
  useEffect(() => {
    const saved = localStorage.getItem(`columns:${title}`)
    if (saved && COLUMN_MODES.includes(saved as ColumnMode)) {
      setColumns(saved as ColumnMode)
    }
  }, [title])

  const pickColumns = (mode: ColumnMode) => {
    setColumns(mode)
    localStorage.setItem(`columns:${title}`, mode)
  }

  // Anti-glare preference — global, survives across songs
  useEffect(() => {
    const saved = localStorage.getItem('sheet-light')
    if (saved && LIGHT_MODES.includes(saved as LightMode)) {
      setLight(saved as LightMode)
    }
  }, [])

  const cycleLight = () => {
    const next =
      LIGHT_MODES[(LIGHT_MODES.indexOf(light) + 1) % LIGHT_MODES.length]
    setLight(next)
    localStorage.setItem('sheet-light', next)
  }

  // Reading position — current screen number for the top-bar counter.
  // rAF-throttled: scroll fires far faster than we need to paint.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let rafId = 0
    const update = () => {
      rafId = 0
      setScreen(
        Math.min(
          Math.round(el.scrollTop / Math.max(el.clientHeight, 1)) + 1,
          Math.max(Math.round(el.scrollHeight / Math.max(el.clientHeight, 1)), 1)
        )
      )
    }
    const onScroll = () => {
      if (!rafId) rafId = requestAnimationFrame(update)
    }
    update()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [imageUrls.length])

  // Phones → always 1 column
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    const update = () => setIsNarrow(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  // Track the scroll area's size so auto mode can recompute columns
  // on window resize / full-screen
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() =>
      setSize({ w: el.clientWidth, h: el.clientHeight })
    )
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // First page measures the real aspect ratio (better auto columns)
  const onImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    if (aspectMeasured.current) return
    const im = e.currentTarget
    if (im.naturalWidth && im.naturalHeight) {
      setAspect(im.naturalWidth / im.naturalHeight)
      aspectMeasured.current = true
    }
  }

  const autoCols = useMemo(
    () => pickAutoColumns(size.w, size.h, imageUrls.length, aspect),
    [size, aspect, imageUrls.length]
  )

  const cols = isNarrow
    ? 1
    : Math.min(
        columns === 'auto' ? autoCols : Number(columns),
        imageUrls.length || 1
      )

  const rows = useMemo(() => chunk(imageUrls, cols), [imageUrls, cols])

  // Page turn = exactly one screen (one row)
  const turnPage = useCallback((direction: 1 | -1) => {
    autoScroll.stop()
    const el = scrollRef.current
    if (!el) return
    el.scrollBy({ top: direction * el.clientHeight, behavior: 'smooth' })
  }, [autoScroll])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
      // An overlay (edit modal / lightbox) is up — don't turn pages
      // or toggle auto-scroll underneath it
      if (document.querySelector('[data-overlay]')) return
      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowRight':
        case 'PageDown':
          e.preventDefault()
          turnPage(1)
          break
        case 'ArrowUp':
        case 'ArrowLeft':
        case 'PageUp':
          e.preventDefault()
          turnPage(-1)
          break
        case ' ':
          e.preventDefault()
          if (!autoScroll.running) setShowControls(true)
          autoScroll.toggle()
          break
        case '+':
        case '=':
          autoScroll.adjustSpeed(10)
          break
        case '-':
          autoScroll.adjustSpeed(-10)
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [turnPage, autoScroll])

  let pageNo = 0

  return (
    <div data-sheet-viewer className="flex h-dvh flex-col bg-stone-950">
      {/* Top bar — identity left (back · title · version), tools right */}
      <header className="relative flex items-center gap-2 border-b border-stone-800/80 bg-stone-950/95 px-3 py-2 backdrop-blur">
        {leading}

        <h1 className="font-display min-w-0 shrink truncate text-sm font-medium tracking-wide text-stone-200">
          {title}
        </h1>

        {tabs}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* Screen counter — "where am I" recovery while playing */}
          {rows.length > 1 && (
            <span className="font-tuner text-xs text-stone-500">
              <span className="text-amber-400/90">{Math.min(screen, rows.length)}</span>
              /{rows.length}屏
            </span>
          )}

          {/* Anti-glare cycle: 亮 → 柔 → 暗 */}
          <button
            onClick={cycleLight}
            title={`亮度：${LIGHT_LABELS[light]}（点击切换）`}
            aria-label="切换谱面亮度"
            className={`flex h-7 w-7 items-center justify-center rounded-md text-xs font-medium transition-colors ${
              light === 'normal'
                ? 'bg-stone-900 text-stone-400 hover:bg-stone-800 hover:text-stone-100'
                : 'bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-500/40'
            }`}
          >
            {LIGHT_LABELS[light]}
          </button>

          {/* Column switch (hidden on phones — always 1 col there) */}
          <div className="hidden items-center gap-1 rounded-lg bg-stone-900 p-1 md:flex">
            <span className="px-1.5 text-xs text-stone-500">列</span>
            {COLUMN_MODES.map((mode) => (
              <button
                key={mode}
                onClick={() => pickColumns(mode)}
                className={`min-w-7 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                  columns === mode
                    ? 'bg-amber-500 text-stone-950'
                    : 'text-stone-400 hover:bg-stone-800 hover:text-stone-100'
                }`}
              >
                {MODE_LABELS[mode]}
              </button>
            ))}
          </div>

          {actions}
        </div>
      </header>

      {/* Scrollable sheet area — each row is one screen tall */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {rows.map((row, r) => (
          <div
            key={r}
            className="grid h-full gap-2 p-2"
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
          >
            {row.map((url) => {
              const n = ++pageNo
              return (
                <div key={url} className="flex min-h-0 items-center justify-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={url}
                    alt={`${title} 第 ${n} 页`}
                    loading={n <= 4 ? 'eager' : 'lazy'}
                    onLoad={onImgLoad}
                    className="max-h-full max-w-full rounded-[3px] bg-white object-contain shadow-md shadow-black/40"
                    style={{ filter: LIGHT_FILTERS[light] }}
                  />
                </div>
              )
            })}
          </div>
        ))}
      </div>

      {/* Floating auto-scroll control (collapsed by default) */}
      <div className="pointer-events-none absolute right-5 flex flex-col items-end gap-3 bottom-[max(1.25rem,env(safe-area-inset-bottom))]">
        {showControls && (
          <div className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-stone-700 bg-stone-900/95 px-4 py-2.5 shadow-xl shadow-black/50 backdrop-blur">
            <button
              onClick={autoScroll.toggle}
              aria-label={autoScroll.running ? '暂停' : '播放'}
              className={`flex h-9 w-9 items-center justify-center rounded-full text-base transition-colors ${
                autoScroll.running
                  ? 'bg-amber-500 text-stone-950'
                  : 'bg-stone-800 text-stone-100 hover:bg-stone-700'
              }`}
            >
              {autoScroll.running ? '❚❚' : '▶'}
            </button>
            <input
              type="range"
              min={MIN_SPEED}
              max={MAX_SPEED}
              step={5}
              value={autoScroll.speed}
              onChange={(e) => autoScroll.setSpeed(Number(e.target.value))}
              aria-label="滚动速度"
              className="w-28 accent-amber-500"
            />
            <span className="w-14 text-right text-xs text-stone-400">
              {speedLabel(autoScroll.speed)}
              <span className="font-tuner ml-1 text-stone-500">
                {autoScroll.speed}
              </span>
            </span>
          </div>
        )}

        {/* Toggle button — always visible */}
        <button
          onClick={() => setShowControls((s) => !s)}
          aria-label="自动滚动"
          className={`pointer-events-auto flex h-12 w-12 items-center justify-center rounded-full border shadow-xl shadow-black/50 transition-colors ${
            autoScroll.running
              ? 'animate-glow-pulse border-amber-400 bg-amber-500 text-stone-950'
              : 'border-stone-700 bg-stone-900/95 text-stone-200 hover:bg-stone-800'
          }`}
          title="自动滚动"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
            <path strokeLinecap="round" strokeLinejoin="round" d="m6 4 6 6 6-6" opacity={0.5} />
          </svg>
        </button>
      </div>
    </div>
  )
}
