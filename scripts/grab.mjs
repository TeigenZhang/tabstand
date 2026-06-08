// ============================================================
// grab.mjs — CLI wrapper over grab-core: scrape a page into the
// library, then refresh the manifest.
//
// Usage:
//   npm run grab -- <url> --name <song> --category strumming
//   npm run grab -- <url> --name <song> --category fingerstyle --version <label>
//
// The scraping logic lives in scripts/lib/grab-core.mjs and is
// shared with the web import API. Proxy: set GRAB_PROXY if the
// source needs it (Chinese tab sites usually do NOT).
// ============================================================
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  CATEGORIES,
  IMAGE_EXT_RE,
  collectSheetImages,
  getDispatcher,
} from './lib/grab-core.mjs'

const LIBRARY_DIR = path.join(process.cwd(), 'library')

// ------------------------------------------------------------
// CLI parsing
// ------------------------------------------------------------
function parseArgs(argv) {
  const [url, ...rest] = argv
  const opts = { url, name: null, category: null, version: null }
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, '')
    if (key in opts) opts[key] = rest[i + 1]
  }
  if (!opts.url || !opts.name || !CATEGORIES.has(opts.category)) {
    console.error(
      '用法：npm run grab -- <url> --name <歌名> --category strumming|fingerstyle [--version <版本名>]'
    )
    process.exit(1)
  }
  return opts
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
const opts = parseArgs(process.argv.slice(2))
const dispatcher = await getDispatcher()

console.log(`抓取页面：${opts.url}`)
let images
try {
  ;({ images } = await collectSheetImages(opts.url, {
    name: opts.name,
    dispatcher,
    onProgress: (msg) => console.log(msg),
  }))
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

// First grab → main pages; later grabs → versions/<label>/
const songDir = path.join(LIBRARY_DIR, opts.category, opts.name)
const hasMainPages =
  fs.existsSync(songDir) &&
  fs.readdirSync(songDir).some((f) => IMAGE_EXT_RE.test(f))

const versionLabel =
  opts.version ?? (hasMainPages ? new URL(opts.url).hostname : null)
const targetDir = versionLabel
  ? path.join(songDir, 'versions', versionLabel)
  : songDir

fs.mkdirSync(targetDir, { recursive: true })
images.forEach((img, i) => {
  fs.writeFileSync(path.join(targetDir, `${i + 1}${img.ext}`), img.data)
})

console.log(`已入库：${path.relative(process.cwd(), targetDir)}（${images.length} 张）`)

// Refresh the manifest so the web app sees the new song immediately
// (process.execPath = this node's absolute path, robust under any PATH)
execFileSync(process.execPath, [path.join('scripts', 'scan.mjs')], { stdio: 'inherit' })
