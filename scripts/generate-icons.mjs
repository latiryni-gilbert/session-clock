// Renders the SVG sources in scripts/icons into the PNG icons in public/.
// Needs Playwright with Chromium (not a project dependency):  node scripts/generate-icons.mjs
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// require() rather than import so a globally installed Playwright (found via NODE_PATH) works too.
const { chromium } = createRequire(import.meta.url)('playwright')

const here = new URL('./icons/', import.meta.url)
const pub = new URL('../public/', import.meta.url)

const targets = [
  { src: 'icon-any.svg', out: 'pwa-192x192.png', size: 192, transparent: true },
  { src: 'icon-any.svg', out: 'pwa-512x512.png', size: 512, transparent: true },
  { src: 'icon-maskable.svg', out: 'pwa-maskable-512x512.png', size: 512 },
  { src: 'icon-apple.svg', out: 'apple-touch-icon.png', size: 180 },
  { src: 'favicon.svg', out: 'favicon-32x32.png', size: 32, transparent: true },
]

const browser = await chromium.launch()
const page = await browser.newPage()
for (const { src, out, size, transparent } of targets) {
  const svg = readFileSync(new URL(src, here), 'utf8')
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  )
  writeFileSync(new URL(out, pub), await page.screenshot({ omitBackground: !!transparent }))
  console.log('wrote', out)
}
await browser.close()

// The scalable favicon is the SVG itself; favicon.ico wraps the 32px PNG for browsers that ignore SVG icons.
copyFileSync(new URL('favicon.svg', here), new URL('favicon.svg', pub))
const png = readFileSync(new URL('favicon-32x32.png', pub))
const header = Buffer.alloc(22)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(1, 4) // one image
header.writeUInt8(32, 6) // width
header.writeUInt8(32, 7) // height
header.writeUInt16LE(1, 10) // colour planes
header.writeUInt16LE(32, 12) // bits per pixel
header.writeUInt32LE(png.length, 14) // image size
header.writeUInt32LE(22, 18) // image offset
writeFileSync(new URL('favicon.ico', pub), Buffer.concat([header, png]))
console.log('wrote favicon.svg, favicon.ico')
