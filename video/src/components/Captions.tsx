import { Easing, interpolate, useCurrentFrame } from 'remotion'
import { color, EASE_SMOOTH_OUT } from '../theme'
import { clipToFrame, type Layout, type SceneDef } from '../timeline'
import { GEOMETRY } from './geometry'

const IN = 12 // frames: the app's text reveal (~400 ms, 12 px, 3 px blur)
const OUT = 7
const ease = Easing.bezier(...EASE_SMOOTH_OUT)

/** Fades a text layer in (rising, unblurring) and out (lifting, blurring). */
function reveal(frame: number, start: number, end: number | null, delay = 0) {
  const t = frame - start - delay
  const k = ease(Math.min(1, Math.max(0, t / IN)))
  let opacity = k
  let y = (1 - k) * 14
  let blur = (1 - k) * 4
  if (end !== null && frame >= end) {
    const o = ease(Math.min(1, (frame - end) / OUT))
    opacity *= 1 - o
    y -= o * 8
    blur += o * 3
  }
  return { opacity, transform: `translateY(${y}px)`, filter: blur > 0.05 ? `blur(${blur}px)` : undefined }
}

/**
 * The scene's chapter and its captions, one cue at a time. Between scenes the old text leaves in
 * the first half of the overlap and the new text arrives in the second, so they never mix.
 */
export function Captions({ scene, index, layout, len, overlap }: { scene: SceneDef; index: number; layout: Layout; len: number; overlap: number }) {
  const frame = useCurrentFrame()
  const g = GEOMETRY[layout].captions
  const enter = Math.round(overlap / 2)
  const leave = len - overlap
  const starts = scene.cues.map((c, i) => (i === 0 ? enter : Math.round(clipToFrame(scene, c.at))))

  const layer: React.CSSProperties = { position: 'absolute', left: 0, right: 0, top: g.chapter * 2.7 }

  return (
    <div style={{ position: 'absolute', left: g.left, width: g.width, top: g.top }}>
      <div style={reveal(frame, enter, leave)}>
        <Chapter index={index} name={scene.chapter} size={g.chapter} />
      </div>
      {scene.cues.map((cue, i) => {
        const start = starts[i]
        const last = i + 1 === starts.length
        const next = last ? leave : starts[i + 1]
        if (frame < start || frame > next + OUT) return null
        const sameTitleAsPrev = i > 0 && scene.cues[i - 1].title === cue.title
        const sameTitleAsNext = i + 1 < scene.cues.length && scene.cues[i + 1].title === cue.title
        // A new cue waits for the old one to be mostly gone.
        const wait = i > 0 ? OUT - 2 : 0
        const titleStyle = sameTitleAsPrev ? reveal(frame, -IN, sameTitleAsNext ? null : next) : reveal(frame, start, sameTitleAsNext ? null : next, wait)
        const hideTitle = sameTitleAsNext && frame >= next
        return (
          <div key={i} style={layer}>
            <h1
              style={{
                margin: 0,
                fontSize: g.title,
                lineHeight: 1.08,
                fontWeight: 600,
                letterSpacing: '-0.022em',
                color: color.fg,
                textWrap: 'balance',
                ...titleStyle,
                ...(hideTitle ? { opacity: 0 } : null),
              }}
            >
              {cue.title}
            </h1>
            {cue.sub && (
              <p
                style={{
                  margin: `${g.sub * 0.7}px 0 0`,
                  fontSize: g.sub,
                  lineHeight: 1.38,
                  fontWeight: 400,
                  color: color.hint,
                  textWrap: 'pretty',
                  ...reveal(frame, start, next, wait + (sameTitleAsPrev ? 0 : 4)),
                }}
              >
                {cue.sub}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}

function Chapter({ index, name, size }: { index: number; name: string; size: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: size * 0.6 }}>
      <span
        style={{
          fontSize: size * 0.82,
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          color: color.accent,
          background: 'rgba(185,168,246,0.14)',
          boxShadow: 'inset 0 0 0 1px rgba(185,168,246,0.25)',
          borderRadius: 999,
          padding: `${size * 0.22}px ${size * 0.6}px`,
        }}
      >
        {String(index + 1).padStart(2, '0')}
      </span>
      <span style={{ fontSize: size, fontWeight: 500, color: color.hint, letterSpacing: '0.01em' }}>{name}</span>
    </div>
  )
}
