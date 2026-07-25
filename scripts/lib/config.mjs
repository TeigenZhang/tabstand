// ============================================================
// config.mjs — optional local install config (data/config.json)
//
// The tool is shareable, the install is personal. Anything that is
// *your* name rather than *the tool's* behaviour lives here, stays
// gitignored, and has a neutral built-in default so a fresh clone
// works with no config file at all.
//
// See data/config.example.json for the shape.
// ============================================================
import fs from 'node:fs'
import path from 'node:path'

// 角色 (owner) fallback for songs whose meta.json carries no owner —
// i.e. every song imported before the roles feature existed. Neutral
// on purpose: a single-owner library never shows the role UI, so this
// name only surfaces once you actually add a second 角色.
export const FALLBACK_OWNER = '我'

const CONFIG_FILE = path.join(process.cwd(), 'data', 'config.json')

const readConfigFile = () => {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {} // absent (the common case) or malformed → all defaults
  }
}

// Resolve the default 角色 from a raw config object. Pure, so the
// precedence rule is testable without touching the filesystem.
export const resolveDefaultOwner = (config) =>
  typeof config?.defaultOwner === 'string' && config.defaultOwner.trim()
    ? config.defaultOwner.trim()
    : FALLBACK_OWNER

export const defaultOwner = () => resolveDefaultOwner(readConfigFile())
