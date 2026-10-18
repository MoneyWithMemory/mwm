// Scene timing and camera math. Scenes are written in clip time (seconds into the recorded clip,
// usually relative to the marks the capture script saved); these helpers turn that into frames of
// the final video, where parts of a clip may play faster.
import desktopClips from '../public/captures/desktop/clips.json'
import mobileClips from '../public/captures/mobile/clips.json'

export const FPS = 30

export type Layout = 'desktop' | 'mobile'
export type Rect = [x: number, y: number, w: number, h: number]

export interface Clip {
  file: string
  seconds: number
  marks: Record<string, number>
  boxes: Record<string, Rect>
}

export interface ClipSet {
  width: number
  height: number
  dpr: number
  clips: Record<string, Clip>
}

export const CLIPS: Record<Layout, ClipSet> = {
  desktop: desktopClips as unknown as ClipSet,
  mobile: mobileClips as unknown as ClipSet,
}

/** A stretch of the clip, played at `rate` (1 = real time). */
export interface Segment {
  from: number
  to: number
  rate?: number
}

/** A caption that takes over at clip time `at`. */
export interface Cue {
  at: number
  title: string
  sub?: string
}

/** The camera frames `rect` (CSS pixels of the capture), moving there from clip time `at` for `dur` s. */
export interface Shot {
  at: number
  rect: Rect
  dur?: number
}

export interface SceneDef {
  id: string
  chapter: string
  clip: Clip
  segments: Segment[]
  cues: Cue[]
  shots: Shot[]
}

/** Length of the scene in frames, once its segments are played at their rates. */
export function sceneFrames(scene: SceneDef): number {
  return Math.round(scene.segments.reduce((sum, s) => sum + (s.to - s.from) / (s.rate ?? 1), 0) * FPS)
}

/** Clip time → scene frame. Times in a gap between segments land on the next segment's start. */
export function clipToFrame(scene: SceneDef, t: number): number {
  let elapsed = 0
  for (const s of scene.segments) {
    const rate = s.rate ?? 1
    if (t <= s.from) return elapsed * FPS
    if (t < s.to) return (elapsed + (t - s.from) / rate) * FPS
    elapsed += (s.to - s.from) / rate
  }
  return elapsed * FPS
}

/** Grows `r` by `pad` (CSS px) on every side, or by [x, y]. */
export function pad(r: Rect, p: number | [number, number]): Rect {
  const [px, py] = typeof p === 'number' ? [p, p] : p
  return [r[0] - px, r[1] - py, r[2] + 2 * px, r[3] + 2 * py]
}

/** The smallest rect holding all of `rects`. */
export function union(...rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r[0]))
  const y = Math.min(...rects.map((r) => r[1]))
  const right = Math.max(...rects.map((r) => r[0] + r[2]))
  const bottom = Math.max(...rects.map((r) => r[1] + r[3]))
  return [x, y, right - x, bottom - y]
}

/** Keeps `r` inside `bounds` (shrinking it if it is larger). */
export function clampRect(r: Rect, bounds: Rect): Rect {
  const w = Math.min(r[2], bounds[2])
  const h = Math.min(r[3], bounds[3])
  const x = Math.min(Math.max(r[0], bounds[0]), bounds[0] + bounds[2] - w)
  const y = Math.min(Math.max(r[1], bounds[1]), bounds[1] + bounds[3] - h)
  return [x, y, w, h]
}

const smooth = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

/** Blends two rects: centers move linearly, sizes geometrically (zooms feel even). */
function mix(a: Rect, b: Rect, k: number): Rect {
  const ca = [a[0] + a[2] / 2, a[1] + a[3] / 2]
  const cb = [b[0] + b[2] / 2, b[1] + b[3] / 2]
  const w = Math.exp(Math.log(a[2]) + (Math.log(b[2]) - Math.log(a[2])) * k)
  const h = Math.exp(Math.log(a[3]) + (Math.log(b[3]) - Math.log(a[3])) * k)
  const cx = ca[0] + (cb[0] - ca[0]) * k
  const cy = ca[1] + (cb[1] - ca[1]) * k
  return [cx - w / 2, cy - h / 2, w, h]
}

/** Where the camera looks at scene frame `frame`. */
export function cameraAt(scene: SceneDef, frame: number): Rect {
  const shots = scene.shots
  let rect = shots[0].rect
  for (let i = 1; i < shots.length; i++) {
    const start = clipToFrame(scene, shots[i].at)
    const len = (shots[i].dur ?? 0.9) * FPS
    if (frame <= start) break
    const k = Math.min(1, (frame - start) / len)
    rect = mix(rect, shots[i].rect, smooth(k))
  }
  return rect
}

export interface Fit {
  /** Content scale: screen pixels per CSS pixel of the capture. */
  scale: number
  /** The window on screen. */
  w: number
  h: number
  /** The part of the capture shown, after the zoom cap and clamping. */
  view: Rect
}

/**
 * Fits a camera rect into a window box of at most maxW × maxH. The window takes the rect's shape;
 * past `maxZoom` the view widens instead, so the capture is never enlarged beyond what it holds.
 */
export function fit(rect: Rect, maxW: number, maxH: number, maxZoom: number, content: Rect): Fit {
  let scale = Math.min(maxW / rect[2], maxH / rect[3])
  let view = rect
  if (scale > maxZoom) {
    // Same shape, more context around the same center.
    const grow = scale / maxZoom
    scale = maxZoom
    const w = rect[2] * grow
    const h = rect[3] * grow
    view = [rect[0] + rect[2] / 2 - w / 2, rect[1] + rect[3] / 2 - h / 2, w, h]
  }
  view = clampRect(view, content)
  return { scale, w: view[2] * scale, h: view[3] * scale, view }
}
