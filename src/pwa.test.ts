import { describe, expect, it } from 'vitest'
import indexHtml from '../index.html?raw'
import apple from '../public/apple-touch-icon.png?inline'
import faviconIco from '../public/favicon.ico?inline'
import favicon32 from '../public/favicon-32x32.png?inline'
import faviconSvg from '../public/favicon.svg?raw'
import icon192 from '../public/pwa-192x192.png?inline'
import icon512 from '../public/pwa-512x512.png?inline'
import maskable from '../public/pwa-maskable-512x512.png?inline'

/** Decodes a base64 data URL to bytes. */
const bytes = (dataUrl: string) => Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), (c) => c.charCodeAt(0))

/** Width and height from a PNG's header, after checking it really is a PNG. */
function pngSize(dataUrl: string): [number, number] {
  const b = bytes(dataUrl)
  expect([...b.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]) // "PNG"
  const view = new DataView(b.buffer)
  return [view.getUint32(16), view.getUint32(20)]
}

describe('installable app files', () => {
  it('has icons of the sizes the manifest and iPhone need', () => {
    expect(pngSize(icon192)).toEqual([192, 192])
    expect(pngSize(icon512)).toEqual([512, 512])
    expect(pngSize(maskable)).toEqual([512, 512])
    expect(pngSize(apple)).toEqual([180, 180]) // iPhone Home Screen
    expect(pngSize(favicon32)).toEqual([32, 32])
  })

  it('has a valid favicon.ico and a scalable SVG favicon', () => {
    const ico = bytes(faviconIco)
    const view = new DataView(ico.buffer)
    expect([view.getUint16(0, true), view.getUint16(2, true), view.getUint16(4, true)]).toEqual([0, 1, 1]) // an icon file holding one image
    expect([view.getUint8(6), view.getUint8(7)]).toEqual([32, 32]) // 32x32
    expect(view.getUint32(14, true) + view.getUint32(18, true)).toBe(ico.length) // image size + offset reach exactly the end of the file
    expect(faviconSvg).toContain('<svg')
  })

  it('the page links the icons and sets the iPhone Home Screen tags', () => {
    expect(indexHtml).toContain('rel="icon" type="image/svg+xml" href="/favicon.svg"')
    expect(indexHtml).toContain('rel="icon" href="/favicon.ico"')
    expect(indexHtml).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"')
    expect(indexHtml).toContain('name="theme-color" content="#0a0a0a"')
    expect(indexHtml).toContain('name="apple-mobile-web-app-capable" content="yes"')
    expect(indexHtml).toContain('name="apple-mobile-web-app-status-bar-style" content="black"')
    expect(indexHtml).toContain('name="apple-mobile-web-app-title" content="Sessions"')
    expect(indexHtml).toContain('<title>Session Clock</title>')
  })
})
