// ============================================================
// shuffle-bag.mjs — pseudo-random no-repeat picker (网易云-style).
//
// True random re-hands you a song you just saw. A shuffle bag deals its
// songs in a RANDOM order without replacement: every song appears once
// before any repeat, then the bag reshuffles into a NEW random order (so it
// never degrades into a fixed rotation).
//
// One bag PER pool (role × mood), kept separate. 所有 = 弹唱 ∪ 指弹 overlap
// in content, but each is its own bag, so exhausting 弹唱 can never make its
// songs reappear early inside 所有 (no cross-pool leak / premature repeat).
// A shared set couldn't do both — clearing it leaks across overlapping pools,
// while never clearing it forces a fixed cycle.
//
// `drawFromBag` is pure except for recording the pick in the bag it's given,
// so it's unit-testable without React/DOM. Callers hold a Map<poolKey, Set>.
// ============================================================

/**
 * Draw the next item from `pool`, using `bag` (this pool's already-shown keys)
 * for no-repeat. Reshuffles (clears the bag) once the pool is exhausted, and
 * never repeats `prevKey` back-to-back while there's an alternative.
 *
 * @template T
 * @param {Set<string>} bag    keys shown this cycle FOR THIS POOL (mutated)
 * @param {T[]} pool           candidate items (already scoped to mood+role)
 * @param {string|null} prevKey key on screen now, to avoid back-to-back repeats
 * @param {(item: T) => string} keyOf stable key for an item
 * @param {() => number} [rng] random source in [0,1) (injectable for tests)
 * @returns {T|null} the drawn item, or null if the pool is empty
 */
export function drawFromBag(bag, pool, prevKey, keyOf, rng = Math.random) {
  if (pool.length === 0) return null
  // With ≥2 songs we can always avoid a back-to-back repeat — including on a
  // mood/role switch, where prevKey came from a DIFFERENT pool's bag and may
  // still be the lone unshown song here.
  const avoidPrev = prevKey != null && pool.length > 1

  const unshown = pool.filter((item) => !bag.has(keyOf(item)))
  let choices = avoidPrev ? unshown.filter((item) => keyOf(item) !== prevKey) : unshown

  if (choices.length === 0) {
    // Pool exhausted, or the only song left unshown is prev itself → reshuffle
    // into a fresh random cycle, still refusing to hand back prev.
    bag.clear()
    choices = avoidPrev ? pool.filter((item) => keyOf(item) !== prevKey) : pool.slice()
  }

  const pick = choices[Math.floor(rng() * choices.length)]
  bag.add(keyOf(pick))
  return pick
}

/**
 * Collision-proof key for a pool (role × mood). JSON of a fixed-shape tuple, so
 * no owner/mood string can ever forge another pool's key (a '|' delimiter
 * could). null owner/mood (全部 / 所有) serialize distinctly.
 */
export function poolKey(owner, mood) {
  return JSON.stringify([owner ?? null, mood ?? null])
}
