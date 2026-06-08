'use client'

import { RefObject, useEffect, useState } from 'react'

// ============================================================
// Auto-scroll hook — rAF-driven constant-speed scrolling with
// per-song speed memory in localStorage.
// ============================================================

const DEFAULT_SPEED = 40 // px per second
export const MIN_SPEED = 10
export const MAX_SPEED = 200

const storageKey = (songKey: string) => `scroll-speed:${songKey}`

export function useAutoScroll(
  ref: RefObject<HTMLElement>,
  songKey: string
) {
  const [running, setRunning] = useState(false)
  const [speed, setSpeed] = useState(DEFAULT_SPEED)

  // Restore the speed last used for this song
  useEffect(() => {
    const saved = Number(localStorage.getItem(storageKey(songKey)))
    if (saved >= MIN_SPEED && saved <= MAX_SPEED) setSpeed(saved)
  }, [songKey])

  useEffect(() => {
    localStorage.setItem(storageKey(songKey), String(speed))
  }, [songKey, speed])

  // The scroll loop. `el.scrollTop` reads back as an integer, so
  // doing `scrollTop += small` loses sub-pixel increments — at low
  // speeds (~30 px/s ≈ 0.5px/frame) it rounds to 0 and never moves.
  // Keep a float accumulator and write it each frame instead.
  useEffect(() => {
    if (!running) return

    const el = ref.current
    if (!el) return

    let rafId: number
    let last = performance.now()
    let pos = el.scrollTop // float position, independent of readback

    const step = (now: number) => {
      pos += ((now - last) / 1000) * speed
      el.scrollTop = pos
      last = now
      // Stop automatically once the end is reached
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) {
        setRunning(false)
        return
      }
      rafId = requestAnimationFrame(step)
    }

    rafId = requestAnimationFrame(step)
    return () => cancelAnimationFrame(rafId)
  }, [running, speed, ref])

  const adjustSpeed = (delta: number) =>
    setSpeed((s) => Math.min(MAX_SPEED, Math.max(MIN_SPEED, s + delta)))

  return {
    running,
    speed,
    toggle: () => setRunning((r) => !r),
    stop: () => setRunning(false),
    setSpeed,
    adjustSpeed,
  }
}
