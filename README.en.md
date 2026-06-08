<div align="center">

<img src="public/icon-192.png" width="88" alt="tabstand" />

# tabstand

**A self-turning music stand for your tabs**

Self-hosted guitar-tab viewer & private library · pinyin search · multi-column view · Bluetooth-pedal page turns · one-click import

[简体中文](README.md) · **English**

![License](https://img.shields.io/badge/License-MIT-d97706)
![Next.js](https://img.shields.io/badge/Next.js-14-000000)
![React](https://img.shields.io/badge/React-18-149eca)
![Database](https://img.shields.io/badge/database-none-22c55e)
![PWA](https://img.shields.io/badge/PWA-ready-5a0fc8)

</div>

---

Turning pages while you play is annoying: paper charts need a free hand, phone tabs cramp onto a tiny screen and you keep scrolling. **tabstand** smooths that out — fit a whole song on one screen, auto-scroll at a steady pace, tap a Bluetooth pedal to turn the page. Your hands stay on the strings.

Instrument-neutral by design; today it implements guitar (strumming / fingerstyle). **The tool is open source and distributable, the library stays private**: tabs are copyrighted scans and never enter git (`library/` is gitignored). Clone it, then build your own library through the in-app **Import** panel.

<div align="center">
  <img src="docs/images/01-home.png" width="800" alt="Library home" />
</div>

## ✨ Features

- **🎼 Smooth viewing** — adaptive multi-column layout (auto / 1 / 2 / 3 columns, remembered per song); a short song fits on one screen, no page turns
- **🦶 Bluetooth pedal** — page-turn on `keydown`, works with pedals that act as a Bluetooth keyboard (`↑↓←→` / `PageUp/Down` / space)
- **🌀 Auto-scroll** — rAF smooth scrolling with remembered speed, Wake Lock keeps the screen on, installable as a standalone PWA
- **🔤 Pinyin search** — fuzzy-match Chinese titles by pinyin / initials; search by artist too
- **📥 One-click import** — three entry points (search by title / paste URL / upload images); for hard, paywalled, or JS-rendered tabs there's a manual fallback: open the source page → drag or Ctrl+V paste → reorder in preview → commit
- **✎ Library editing** — reorder pages, delete pages, split into versions, move back to the main tab, edit artist / title; deletes go to a recycle bin
- **🗂 Zero database** — `library/` is scanned into a `manifest.json`; change the library, refresh, done
- **📄 Offline PDF** — a Python script builds bookmarked PDFs (sorted by pinyin / alphabet, blank pages inserted for two-page spreads)

## 📸 Screenshots

<table>
  <tr>
    <td width="50%">
      <img src="docs/images/02-viewer.png" alt="Multi-column stand" /><br/>
      <sub><b>Multi-column stand</b> — the whole song laid out on one screen, switchable brightness, adjustable auto-scroll</sub>
    </td>
    <td width="50%">
      <img src="docs/images/05-mobile.png" alt="Mobile stand" /><br/>
      <sub><b>Turns into a stand</b> — single-column portrait on phone / tablet; add a Bluetooth pedal and it's an e-music-stand</sub>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="docs/images/03-import-search.png" alt="One-click import" /><br/>
      <sub><b>One-click import</b> — search aggregates several tab sites; what it can't grab, paste a URL or upload images</sub>
    </td>
    <td width="50%">
      <img src="docs/images/04-edit.png" alt="Library editing" /><br/>
      <sub><b>Library editing</b> — reorder / delete pages / split versions / edit artist; deletes go to a recycle bin</sub>
    </td>
  </tr>
</table>

## 🚀 Quick start

```bash
npm ci
npm run dev          # local dev, port 6060 (override with PORT env)
# open http://localhost:6060
```

Production:

```bash
npm run build && npm start
```

> From a phone or tablet on the same LAN / Tailscale, open `http://<your-ip>:6060` and use it as a stand.

When the library is empty, fill it from the **＋ Import** panel in the top-right. You can also grab tabs from the CLI:

```bash
npm run grab -- <url> --name <title> --category strumming|fingerstyle [--version <version-name>]
```

Chinese tab-site CDNs connect directly by default; set `GRAB_PROXY=http://127.0.0.1:7890` when you need a proxy (Node fetch via undici ProxyAgent).

## 📁 Directory layout

```
library/strumming/<title>/                   strumming tabs, images numbered 1.png 2.png… (gitignored)
library/fingerstyle/<title>/                 fingerstyle tabs, same shape
library/<category>/<title>/versions/<name>/  multiple versions of one song
library/<category>/<title>/meta.json         song-level metadata (artist, optional)
data/manifest.json                           scan-generated index (gitignored)
output/                                       generated PDFs (gitignored)
```

`library/` is entirely gitignored: the tool is public, the library is private.

## 🛠 Tech stack

Next.js 14 (App Router) + Tailwind CSS + React 18, zero database. `scripts/scan.mjs` scans `library/` into an index; pages read from disk on request (`force-dynamic`), so changes show up on refresh. The grab core `scripts/lib/grab-core.mjs` is shared between the CLI and the web import API.

## 📄 Offline PDF

```bash
uv run --with PyPDF2,reportlab,tqdm,pypinyin,Pillow scripts/get_pdf.py strumming
uv run --with PyPDF2,reportlab,tqdm,pypinyin,Pillow scripts/get_pdf.py fingerstyle
```

English titles sort alphabetically, Chinese titles by pinyin; each image is scaled and centered on a letter page, odd-page songs get a blank page (so two-page spreads align), and bookmarks are added per song. `versions/` subdirectories are excluded.

## 🔒 Trust boundary ⚠️

This service has **no login / auth** — the network *is* the trust boundary: **only reach it over LAN / Tailscale, never port-forward or reverse-proxy it to the public internet**. Anyone who can hit the port can view, import, and write to your library.

- All write APIs (`/api/library`, `/api/import/*`) pass a same-origin guard (cross-site requests get 403)
- The import endpoint has SSRF protection: `/api/import/url` refuses internal / loopback / link-local / cloud-metadata addresses, allowing only public http(s)
- Uploads are magic-byte validated and size-capped; staging has a TTL sweep

If you ever expose it publicly, put an auth layer in front first.

## 🚢 Deploy

On macOS you can run a boot-start local background service via launchd; materials in [`deploy/`](deploy/). On other platforms just `npm run build && npm start`.

## 📄 License

[MIT](LICENSE). Only the tool code is open source; library contents are your own and remain the property of their respective rights holders — **do not distribute copyrighted tabs**.
