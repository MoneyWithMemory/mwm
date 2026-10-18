// Screen recorder for Playwright pages, built on the Chrome DevTools screencast.
// Playwright's own recordVideo encodes VP8 at about 1 Mbit/s, which smears small UI text once the
// composition zooms in. Here every frame arrives as a JPEG at device resolution with its timestamp,
// and ffmpeg turns the frames into a constant 30 fps H.264 clip that keeps the real timing.
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

const FPS = 30

/**
 * Starts recording `page`. Returns `stop()`, which writes `<outFile>` and resolves to its duration
 * in seconds. `marks` holds named moments (seconds from the start) for the composition.
 */
export async function record(page, outFile, { width, height, quality = 92 } = {}) {
  const framesDir = `${outFile}.frames`
  rmSync(framesDir, { recursive: true, force: true })
  mkdirSync(framesDir, { recursive: true })

  const cdp = await page.context().newCDPSession(page)
  const frames = []
  const t0 = Date.now() / 1000
  const writes = []
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    // Ack first: Chrome holds the next frame until the previous one is acknowledged.
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
    const file = path.join(framesDir, `${String(frames.length).padStart(6, '0')}.jpg`)
    frames.push({ file, t: metadata.timestamp ?? Date.now() / 1000 })
    writes.push(writeFile(file, Buffer.from(data, 'base64')))
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality, maxWidth: width, maxHeight: height, everyNthFrame: 1 })
  // The screencast only sends a frame when something repaints: nudge one so the clip starts now.
  await page.evaluate(() => document.body.style.setProperty('--rec-nudge', String(Math.random())))

  const marks = {}
  const boxes = {}
  return {
    marks,
    /** Names the current moment, in seconds from the start of the clip. */
    mark(name) {
      marks[name] = Math.round((Date.now() / 1000 - t0) * 1000) / 1000
    },
    /** Stores where `locators` are on screen now (CSS pixels; several are merged into one box). */
    async box(name, ...locators) {
      const found = (await Promise.all(locators.map((l) => l.boundingBox({ timeout: 2000 }).catch(() => null)))).filter(Boolean)
      if (found.length === 0) throw new Error(`No box for ${name}`)
      const x = Math.min(...found.map((b) => b.x))
      const y = Math.min(...found.map((b) => b.y))
      const r = Math.max(...found.map((b) => b.x + b.width))
      const b = Math.max(...found.map((b) => b.y + b.height))
      boxes[name] = [x, y, r - x, b - y].map((v) => Math.round(v))
    },
    async stop() {
      const tEnd = Date.now() / 1000
      await cdp.send('Page.stopScreencast').catch(() => {})
      await cdp.detach().catch(() => {})
      await Promise.all(writes)
      if (frames.length === 0) throw new Error(`No frames recorded for ${outFile}`)

      // The first frame stands in from t0; each frame lasts until the next one arrives.
      const start = Math.min(t0, frames[0].t)
      const lines = ['ffconcat version 1.0']
      frames.forEach((f, i) => {
        const from = i === 0 ? start : f.t
        const to = i + 1 < frames.length ? frames[i + 1].t : tEnd
        lines.push(`file '${path.basename(f.file)}'`, `duration ${Math.max(to - from, 0.0005).toFixed(4)}`)
      })
      // The concat demuxer ignores the last entry's duration unless the file is listed again.
      lines.push(`file '${path.basename(frames.at(-1).file)}'`)
      const list = path.join(framesDir, 'frames.ffconcat')
      writeFileSync(list, lines.join('\n') + '\n')

      const ff = spawnSync(
        'ffmpeg',
        ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
          '-vf', `fps=${FPS},scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`,
          '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-movflags', '+faststart', outFile],
        { stdio: 'inherit' },
      )
      if (ff.status !== 0) throw new Error(`ffmpeg failed for ${outFile}`)
      rmSync(framesDir, { recursive: true, force: true })
      const seconds = tEnd - start
      console.log(`  ${path.basename(outFile)}: ${frames.length} frames, ${seconds.toFixed(1)} s (${(frames.length / seconds).toFixed(1)} fps)`)
      return { seconds, marks, boxes }
    },
  }
}
