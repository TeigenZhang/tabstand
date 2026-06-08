'use client'

import { useEffect } from 'react'

// ============================================================
// Screen Wake Lock — keeps the display on while reading sheets.
// Supported in Safari 16.4+; works in standalone PWAs since
// iPadOS 18.4. Re-acquires on tab visibility change since the
// lock is released when the page is backgrounded.
// ============================================================

export function useWakeLock() {
  useEffect(() => {
    if (!('wakeLock' in navigator)) return

    let lock: WakeLockSentinel | null = null
    let disposed = false

    const acquire = async () => {
      try {
        lock = await navigator.wakeLock.request('screen')
      } catch {
        // Denied (e.g. low battery mode) — non-fatal, just skip
      }
    }

    const onVisibilityChange = () => {
      if (!disposed && document.visibilityState === 'visible') acquire()
    }

    acquire()
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', onVisibilityChange)
      lock?.release().catch(() => {})
    }
  }, [])
}
