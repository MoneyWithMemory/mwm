import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion'
import { color, EASE_EXPONENTIAL, EASE_SMOOTH_OUT } from '../theme'
import type { Layout } from '../timeline'
import { GEOMETRY } from './geometry'

const smoothOut = Easing.bezier(...EASE_SMOOTH_OUT)
const exponential = Easing.bezier(...EASE_EXPONENTIAL)

/** Rises in from 18 px below with a little blur, starting at `delay` frames. */
function rise(frame: number, delay: number, duration = 18) {
  const k = exponential(Math.min(1, Math.max(0, (frame - delay) / duration)))
  return { opacity: k, transform: `translateY(${(1 - k) * 18}px)`, filter: k < 0.98 ? `blur(${(1 - k) * 4}px)` : undefined }
}

/** The Higgsfield backdrop under everything, drifting very slowly. */
export function Backdrop({ layout }: { layout: Layout }) {
  const frame = useCurrentFrame()
  const { durationInFrames } = useVideoConfig()
  const k = frame / durationInFrames
  return (
    <AbsoluteFill style={{ backgroundColor: color.bg }}>
      <Img
        src={staticFile(`higgsfield/backdrop-${layout === 'desktop' ? '16x9' : '9x16'}.jpg`)}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          transform: `scale(${1.06 + 0.06 * k}) translate(${-12 * k}px, ${-8 * k}px)`,
          opacity: 0.85,
        }}
      />
      {/* Keeps captions and the window readable over the aurora. */}
      <AbsoluteFill
        style={{
          background:
            layout === 'desktop'
              ? 'linear-gradient(90deg, rgba(8,8,15,0.86) 0%, rgba(8,8,15,0.55) 38%, rgba(8,8,15,0.35) 100%)'
              : 'linear-gradient(180deg, rgba(8,8,15,0.88) 0%, rgba(8,8,15,0.5) 30%, rgba(8,8,15,0.4) 100%)',
        }}
      />
    </AbsoluteFill>
  )
}

/** One bar per chapter: the current one fills as its scene plays. Plus the honest footnote. */
export function Rail({ layout, progress, labels }: { layout: Layout; progress: number[]; labels: string[] }) {
  const g = GEOMETRY[layout].rail
  const size = layout === 'desktop' ? 17 : 22
  const visible = progress.some((p) => p > 0)
  return (
    <div style={{ position: 'absolute', left: g.left, bottom: g.bottom, opacity: visible ? 1 : 0 }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: size }} aria-label={labels.join(', ')}>
        {progress.map((p, i) => (
          <span key={i} style={{ width: layout === 'desktop' ? 44 : 64, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.12)', overflow: 'hidden' }}>
            <span style={{ display: 'block', height: '100%', width: `${Math.round(p * 1000) / 10}%`, background: color.accent, borderRadius: 2 }} />
          </span>
        ))}
      </div>
      <div style={{ fontSize: size, color: color.hint, opacity: 0.8 }}>Bitcoin regtest · recorded in the app's mock mode</div>
    </div>
  )
}

/** Opening: the two agents, then the name and what it does. */
export function Intro({ layout }: { layout: Layout }) {
  const frame = useCurrentFrame()
  const { durationInFrames } = useVideoConfig()
  const desktop = layout === 'desktop'
  const k = frame / durationInFrames
  return (
    <AbsoluteFill style={{ backgroundColor: color.bg }}>
      <Img
        src={staticFile(`higgsfield/agents-${desktop ? '16x9' : '9x16'}.jpg`)}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          transform: `scale(${1.1 - 0.07 * smoothOut(k)})`,
          opacity: interpolate(frame, [0, 20], [0, 1], { extrapolateRight: 'clamp' }),
        }}
      />
      <AbsoluteFill style={{ background: 'linear-gradient(180deg, rgba(8,8,15,0) 40%, rgba(8,8,15,0.92) 82%)' }} />
      <AbsoluteFill
        style={{
          justifyContent: 'flex-end',
          alignItems: 'center',
          textAlign: 'center',
          padding: desktop ? '0 240px 120px' : '0 80px 230px',
        }}
      >
        <Img src={staticFile('brand/mwm-mark-white.svg')} style={{ width: desktop ? 104 : 132, marginBottom: desktop ? 26 : 34, ...rise(frame, 10) }} />
        <h1 style={{ margin: 0, fontSize: desktop ? 96 : 104, lineHeight: 1.04, fontWeight: 600, letterSpacing: '-0.03em', color: color.fg, ...rise(frame, 16) }}>
          Money with Memory
        </h1>
        <p style={{ margin: `${desktop ? 22 : 30}px 0 0`, fontSize: desktop ? 32 : 38, lineHeight: 1.35, color: color.hint, textWrap: 'balance', ...rise(frame, 26) }}>
          Local AI agents negotiate peer-to-peer swaps of RGB assets on Bitcoin.
        </p>
        <Pill style={{ marginTop: desktop ? 30 : 40, ...rise(frame, 36) }} size={desktop ? 20 : 26}>
          Bitcoin regtest demo
        </Pill>
      </AbsoluteFill>
    </AbsoluteFill>
  )
}

const MARKS = ['RGB', 'QVAC (local AI)', 'Tether WDK']

/** Closing card: the name, the line, the three building blocks. */
export function Outro({ layout }: { layout: Layout }) {
  const frame = useCurrentFrame()
  const { durationInFrames } = useVideoConfig()
  const desktop = layout === 'desktop'
  const lines = ['Local AI negotiates.', 'RGB settles.', 'You stay in control.']
  const fadeOut = interpolate(frame, [durationInFrames - 18, durationInFrames], [1, 0], { extrapolateLeft: 'clamp' })
  return (
    <AbsoluteFill style={{ opacity: fadeOut }}>
      <AbsoluteFill style={{ background: 'radial-gradient(60% 55% at 50% 50%, rgba(8,8,15,0.55), rgba(8,8,15,0.88))' }} />
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', textAlign: 'center', padding: desktop ? '0 200px' : '0 70px' }}>
        <Img src={staticFile('brand/mwm-mark-white.svg')} style={{ width: desktop ? 96 : 128, marginBottom: desktop ? 28 : 36, ...rise(frame, 4) }} />
        <h1 style={{ margin: 0, fontSize: desktop ? 104 : 108, lineHeight: 1.02, fontWeight: 600, letterSpacing: '-0.03em', color: color.fg, ...rise(frame, 8) }}>
          Money with Memory
        </h1>
        <div
          style={{
            marginTop: desktop ? 30 : 40,
            display: 'flex',
            flexDirection: desktop ? 'row' : 'column',
            gap: desktop ? '0.32em' : '0.12em',
            fontSize: desktop ? 40 : 50,
            lineHeight: 1.25,
            fontWeight: 500,
            color: color.fg,
          }}
        >
          {lines.map((line, i) => (
            <span key={line} style={{ ...rise(frame, 22 + i * 12), color: i === 2 ? color.accent : color.fg }}>
              {line}
            </span>
          ))}
        </div>
        <div style={{ marginTop: desktop ? 54 : 70, display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: desktop ? 14 : 16, ...rise(frame, 64) }}>
          {MARKS.map((mark) => (
            <Pill key={mark} size={desktop ? 22 : 28}>
              {mark}
            </Pill>
          ))}
        </div>
        <p style={{ margin: `${desktop ? 30 : 40}px 0 0`, fontSize: desktop ? 20 : 26, color: color.hint, ...rise(frame, 72) }}>Bitcoin regtest demo</p>
      </AbsoluteFill>
    </AbsoluteFill>
  )
}

function Pill({ children, size, style }: { children: React.ReactNode; size: number; style?: React.CSSProperties }) {
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: size,
        fontWeight: 500,
        color: color.fg,
        background: 'rgba(29,29,43,0.72)',
        boxShadow: `inset 0 0 0 1px ${color.separator}`,
        borderRadius: 999,
        padding: `${size * 0.42}px ${size * 0.9}px`,
        ...style,
      }}
    >
      {children}
    </span>
  )
}
