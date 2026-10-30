/**
 * Client-side PDF exporter for AlphaTab scores using AlphaTab's built-in
 * `html5` Canvas2D rendering engine (`alphaTab.rendering.ScoreRenderer`).
 *
 * Renders the loaded `Score` directly into `<canvas>` rows at a fixed A4 width
 * (avoiding any SVG-to-Image blob serialization or CSP `img-src` restrictions),
 * paginates rows onto high-DPI A4 pages without splitting any staff system
 * across page breaks, and encodes a multi-page PDF 1.4 document.
 */

import * as alphaTab from '@coderline/alphatab'

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(',')[1] ?? ''
  const bin = atob(base64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i)
  }
  return out
}

interface JpegPage {
  jpegBytes: Uint8Array
  pixelWidth: number
  pixelHeight: number
}

/**
 * Assemble a standard PDF-1.4 document from one or more JPEG page images.
 * Each page is sized to standard A4 (595.28 x 841.89 pt).
 */
function buildPdfFromJpegPages(pages: JpegPage[]): Blob {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  let offset = 0

  const pushBytes = (bytes: Uint8Array) => {
    chunks.push(bytes)
    offset += bytes.byteLength
  }
  const pushStr = (str: string) => {
    pushBytes(encoder.encode(str))
  }

  const pageWidthPt = 595.28
  const pageHeightPt = 841.89

  const totalObjects = 2 + pages.length * 3
  const offsets: number[] = new Array(totalObjects + 1).fill(0)

  pushStr('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n')

  // 1: Catalog
  offsets[1] = offset
  pushStr('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')

  // 2: Pages
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ')
  offsets[2] = offset
  pushStr(
    `2 0 obj\n<< /Type /Pages /Count ${pages.length} /Kids [ ${kids} ] >>\nendobj\n`,
  )

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]
    const pageObjId = 3 + i * 3
    const contentObjId = 4 + i * 3
    const imageObjId = 5 + i * 3
    const imgName = `/Im${i}`

    const contentStream = `q\n${pageWidthPt.toFixed(2)} 0 0 ${pageHeightPt.toFixed(2)} 0 0 cm\n${imgName} Do\nQ\n`
    const contentBytes = encoder.encode(contentStream)

    // Page object
    offsets[pageObjId] = offset
    pushStr(
      `${pageObjId} 0 obj\n` +
        `<< /Type /Page /Parent 2 0 R ` +
        `/MediaBox [ 0 0 ${pageWidthPt.toFixed(2)} ${pageHeightPt.toFixed(2)} ] ` +
        `/Resources << /XObject << ${imgName} ${imageObjId} 0 R >> >> ` +
        `/Contents ${contentObjId} 0 R >>\n` +
        `endobj\n`,
    )

    // Content stream object
    offsets[contentObjId] = offset
    pushStr(
      `${contentObjId} 0 obj\n<< /Length ${contentBytes.byteLength} >>\nstream\n`,
    )
    pushBytes(contentBytes)
    pushStr('\nendstream\nendobj\n')

    // Image XObject (DCTDecode JPEG)
    offsets[imageObjId] = offset
    pushStr(
      `${imageObjId} 0 obj\n` +
        `<< /Type /XObject /Subtype /Image ` +
        `/Width ${page.pixelWidth} /Height ${page.pixelHeight} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
        `/Filter /DCTDecode /Length ${page.jpegBytes.byteLength} >>\n` +
        `stream\n`,
    )
    pushBytes(page.jpegBytes)
    pushStr('\nendstream\nendobj\n')
  }

  const xrefOffset = offset
  pushStr(`xref\n0 ${totalObjects + 1}\n`)
  pushStr('0000000000 65535 f \n')
  for (let id = 1; id <= totalObjects; id++) {
    pushStr(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`)
  }
  pushStr(
    `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  )

  return new Blob(chunks as BlobPart[], { type: 'application/pdf' })
}

/**
 * Render `api.score` using AlphaTab's native `html5` Canvas engine and
 * download a multi-page A4 PDF.
 */
export async function exportAlphaTabScoreToPdf(
  api: alphaTab.AlphaTabApi,
  filename = 'drums-score.pdf',
): Promise<void> {
  const score = api.score
  if (!score) {
    throw new Error('Score is still loading — wait a moment and try again.')
  }

  const pdfSettings = new alphaTab.Settings()
  pdfSettings.core.engine = 'html5'
  pdfSettings.core.enableLazyLoading = false
  pdfSettings.core.useWorkers = false
  pdfSettings.display.layoutMode = alphaTab.LayoutMode.Page
  pdfSettings.display.scale = 0.95
  pdfSettings.display.stretchForce = 0.85
  pdfSettings.core.fontDirectory = api.settings.core.fontDirectory
  pdfSettings.core.smuflFontSources = api.settings.core.smuflFontSources
  const srcResources = api.settings.display.resources as unknown as {
    smuflFontFamilyName?: string
  }
  const dstResources = pdfSettings.display.resources as unknown as {
    smuflFontFamilyName?: string
  }
  dstResources.smuflFontFamilyName =
    srcResources.smuflFontFamilyName || 'alphaTab'

  const env = alphaTab.Environment as unknown as { highDpiFactor: number }
  const prevDpi = env.highDpiFactor
  env.highDpiFactor = 2

  const rowCanvases: HTMLCanvasElement[] = []
  let renderErr: Error | null = null

  const renderer = new alphaTab.rendering.ScoreRenderer(pdfSettings)
  renderer.width = 760
  renderer.partialRenderFinished.on((r) => {
    if (r.renderResult instanceof HTMLCanvasElement) {
      rowCanvases.push(r.renderResult)
    }
  })
  renderer.error.on((err) => {
    renderErr = err instanceof Error ? err : new Error(String(err))
  })

  try {
    renderer.renderScore(score, [0])
  } finally {
    env.highDpiFactor = prevDpi
    renderer.destroy()
  }

  if (renderErr) {
    throw renderErr
  }
  if (!rowCanvases.length) {
    throw new Error('No staff rows were produced for PDF export.')
  }

  // High-resolution A4 page canvas (2x 96-DPI A4: 1588 x 2246 px)
  const pageWidthPx = 1588
  const pageHeightPx = 2246
  const marginX = 64
  const marginY = 72
  const printableWidth = pageWidthPx - marginX * 2
  const maxPageY = pageHeightPx - marginY

  const createBlankPage = () => {
    const canvas = document.createElement('canvas')
    canvas.width = pageWidthPx
    canvas.height = pageHeightPx
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D context is unavailable')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, pageWidthPx, pageHeightPx)
    return { canvas, ctx }
  }

  const jpegPages: JpegPage[] = []
  let current = createBlankPage()
  let cursorY = marginY
  let hasContentOnCurrentPage = false

  for (const rowCanvas of rowCanvases) {
    if (rowCanvas.width <= 0 || rowCanvas.height <= 0) continue
    const scale = printableWidth / rowCanvas.width
    const drawWidth = printableWidth
    const drawHeight = Math.ceil(rowCanvas.height * scale)

    if (hasContentOnCurrentPage && cursorY + drawHeight > maxPageY) {
      jpegPages.push({
        jpegBytes: dataUrlToBytes(current.canvas.toDataURL('image/jpeg', 0.92)),
        pixelWidth: pageWidthPx,
        pixelHeight: pageHeightPx,
      })
      current = createBlankPage()
      cursorY = marginY
    }

    current.ctx.drawImage(rowCanvas, marginX, cursorY, drawWidth, drawHeight)
    cursorY += drawHeight + 8
    hasContentOnCurrentPage = true
  }

  if (hasContentOnCurrentPage) {
    jpegPages.push({
      jpegBytes: dataUrlToBytes(current.canvas.toDataURL('image/jpeg', 0.92)),
      pixelWidth: pageWidthPx,
      pixelHeight: pageHeightPx,
    })
  }

  const pdfBlob = buildPdfFromJpegPages(jpegPages)
  const downloadUrl = URL.createObjectURL(pdfBlob)
  try {
    const link = document.createElement('a')
    link.href = downloadUrl
    link.download = filename.endsWith('.pdf') ? filename : `${filename}.pdf`
    document.body.appendChild(link)
    link.click()
    link.remove()
  } finally {
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 2000)
  }
}
