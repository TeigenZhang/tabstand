'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

// ============================================================
// 角色（owner）筛选的共享状态。SongList 与 MoodPick 都从这里读当前角色，
// 于是「随便弹」跟着角色走，列表筛选与推荐口径一致。
//
// 主角色：默认落在 owners[0]（scan 把默认角色排在最前）——打开即只看
// 主角色的谱，而非全部。用户切换后写入 localStorage，导航返回时恢复，所以
// 「跟随上次角色」与「默认主角色」是同一套机制：没存过 → 主角色；存过 →
// 上次的选择。
// ============================================================

const STORAGE_KEY = 'tabstand:owner'
const ALL = '__all__' // sentinel for 全部（owner === null）

interface OwnerContextValue {
  owner: string | null // null = 全部
  setOwner: (owner: string | null) => void
  owners: string[]
  primary: string | null // 主角色（默认视图）
}

const OwnerContext = createContext<OwnerContextValue | null>(null)

export function OwnerProvider({
  owners,
  children,
}: {
  owners: string[]
  children: ReactNode
}) {
  const primary = owners[0] ?? null

  // Initial value = primary role, deterministic so SSR and first client render
  // match (no hydration mismatch). The stored choice is applied after mount.
  const [owner, setOwnerState] = useState<string | null>(primary)

  useEffect(() => {
    let stored: string | null = null
    try {
      stored = localStorage.getItem(STORAGE_KEY)
    } catch {
      stored = null
    }
    if (stored === ALL) setOwnerState(null)
    else if (stored && owners.includes(stored)) setOwnerState(stored)
    // no stored (or a role that no longer exists) → keep the primary default
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setOwner = (next: string | null) => {
    setOwnerState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next === null ? ALL : next)
    } catch {
      // private mode / quota — selection just won't persist across reloads
    }
  }

  return (
    <OwnerContext.Provider value={{ owner, setOwner, owners, primary }}>
      {children}
    </OwnerContext.Provider>
  )
}

// Defensive fallback keeps a stray out-of-provider render from crashing —
// degrades to 全部 with no roles.
export function useOwner(): OwnerContextValue {
  return (
    useContext(OwnerContext) ?? {
      owner: null,
      setOwner: () => {},
      owners: [],
      primary: null,
    }
  )
}
