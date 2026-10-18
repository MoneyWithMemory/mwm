import { AbsoluteFill, Easing, Img, interpolate, OffthreadVideo, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion'
import { useFonts } from './Main'
import { color, EASE_EXPONENTIAL, font } from './theme'
import { CLIPS, FPS } from './timeline'

// A short app teaser: the phone in 3D playing the real app, one line per feature, then the
// name, the line and a call to action. Same recordings as the long video (mock mode, regtest).

const mobile = CLIPS.mobile
const m = (clip: string) => mobile.clips[clip].marks

interface Shot {
  clip: string
  from: number
  seconds: number
  rate?: number
  title: string
  sub: string
}

const SHOTS: Shot[] = [
  { clip: '01-shop', from: m('01-shop').sybil - 0.5, seconds: 2.3, title: 'Know who you trade with.', sub: 'Reliability comes from settled swaps.' },
  { clip: '02-negotiate', from: m('02-negotiate').private - 0.3, seconds: 2.6, rate: 1.3, title: 'Local AI negotiates.', sub: 'Your limits never leave your device.' },
  { clip: '03-settle', from: m('03-settle').approveB + 0.8, seconds: 2.6, rate: 2.4, title: 'RGB settles.', sub: 'A 7-step atomic swap on Bitcoin.' },
  { clip: '04-vault', from: m('04-vault').refused - 0.5, seconds: 2.2, title: 'You stay in control.', sub: "A Tether WDK Vault your agents can't spend." },
]

const LEAD = 12 // frames before the first shot
const starts = SHOTS.reduce<number[]>((acc, s, i) => [...acc, i === 0 ? LEAD : acc[i - 1] + Math.round(SHOTS[i - 1].seconds * FPS)], [])
const END_CARD = starts[starts.length - 1] + Math.round(SHOTS[SHOTS.length - 1].seconds * FPS)
export const PROMO_FRAMES = END_CARD + 4 * FPS

const expo = Easing.bezier(...EASE_EXPONENTIAL)
const rise = (frame: number, at: number, d = 16) => {
  const k = expo(Math.min(1, Math.max(0, (frame - at) / d)))
  return { opacity: k, transform: `translateY(${(1 - k) * 22}px)`, filter: k < 0.98 ? `blur(${(1 - k) * 5}px)` : undefined }
}

export function Promo() {
  useFonts()
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const enter = spring({ frame, fps, config: { damping: 18, mass: 0.9 } })
  const end = spring({ frame: frame - END_CARD, fps, config: { damping: 20 } })

  // The phone floats in, turns slowly, then steps left for the end card.
  const rotY = interpolate(enter, [0, 1], [38, 16]) - 6 * Math.sin(frame / 70) - 4 * end
  const rotX = interpolate(enter, [0, 1], [18, 6]) + 2 * Math.sin(frame / 55)
  const x = interpolate(enter, [0, 1], [-260, 0]) - 40 * end
  const y = interpolate(enter, [0, 1], [380, 0]) + 8 * Math.sin(frame / 40)

  return (
    <AbsoluteFill style={{ backgroundColor: color.bg, fontFamily: font, color: color.fg, overflow: 'hidden' }}>
      <Img src={staticFile('higgsfield/backdrop-16x9.jpg')} style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: 0.55, transform: `scale(${1.08 + frame / 6000})` }} />
      <AbsoluteFill style={{ background: 'radial-gradient(45% 60% at 30% 52%, rgba(185,168,246,0.20), rgba(8,8,15,0) 70%), linear-gradient(90deg, rgba(8,8,15,0.2), rgba(8,8,15,0.75))' }} />

      {/* Phone */}
      <div style={{ position: 'absolute', left: 320, top: 50, width: 440, height: 980, perspective: 1800 }}>
        <div
          style={{
            width: '100%',
            height: '100%',
            transform: `translate(${x}px, ${y}px) rotateY(${rotY}deg) rotateX(${rotX}deg) rotateZ(-3deg)`,
            transformStyle: 'preserve-3d',
          }}
        >
          <Phone frame={frame} />
        </div>
      </div>

      {/* Feature lines, one per shot */}
      {SHOTS.map((s, i) => {
        const at = starts[i] + 4
        const until = i + 1 < SHOTS.length ? starts[i + 1] : END_CARD
        if (frame < at || frame > until + 8) return null
        const out = interpolate(frame, [until, until + 8], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
        return (
          <div key={s.title} style={{ position: 'absolute', left: 980, top: 400, width: 820, opacity: out }}>
            <div style={{ fontSize: 26, fontWeight: 500, color: color.accent, marginBottom: 18, ...rise(frame, at) }}>{String(i + 1).padStart(2, '0')} / 04</div>
            <h1 style={{ margin: 0, fontSize: 84, lineHeight: 1.04, fontWeight: 600, letterSpacing: '-0.03em', ...rise(frame, at + 3) }}>{s.title}</h1>
            <p style={{ margin: '22px 0 0', fontSize: 34, lineHeight: 1.35, color: color.hint, ...rise(frame, at + 8) }}>{s.sub}</p>
          </div>
        )
      })}

      {/* End card */}
      {frame >= END_CARD && <EndCard frame={frame - END_CARD} />}
    </AbsoluteFill>
  )
}

function Phone({ frame }: { frame: number }) {
  const W = 440
  const H = 980
  const bezel = 16
  const screenW = W - bezel * 2
  const scale = screenW / mobile.width
  return (
    <div
      style={{
        position: 'relative',
        width: W,
        height: H,
        borderRadius: 72,
        background: 'linear-gradient(145deg, #3a3a4d 0%, #15151f 45%, #2b2b3b 100%)',
        boxShadow: '0 0 0 2px #4a4a5e, 0 60px 120px -30px rgba(0,0,0,0.9), 0 0 90px -20px rgba(185,168,246,0.45)',
      }}
    >
      <div style={{ position: 'absolute', left: bezel, top: bezel, width: screenW, height: H - bezel * 2, borderRadius: 58, overflow: 'hidden', background: color.bg }}>
        {/* The app sits below the dynamic island, as under a status bar. */}
        <div style={{ position: 'absolute', left: 0, top: H - bezel * 2 - mobile.height * scale, width: mobile.width, height: mobile.height, transform: `scale(${scale})`, transformOrigin: '0 0' }}>
          {SHOTS.map((s, i) => {
            const from = i === 0 ? 0 : starts[i]
            const len = (i + 1 < SHOTS.length ? starts[i + 1] : PROMO_FRAMES) - from
            return (
              <Sequence key={s.clip} from={from} durationInFrames={len} layout="none">
                <OffthreadVideo
                  src={staticFile(mobile.clips[s.clip].file)}
                  trimBefore={Math.round(s.from * FPS)}
                  playbackRate={s.rate ?? 1}
                  muted
                  style={{ position: 'absolute', width: mobile.width, height: mobile.height }}
                />
              </Sequence>
            )
          })}
        </div>
        {/* A quick flash between shots */}
        {starts.slice(1).map((st) => (
          <div key={st} style={{ position: 'absolute', inset: 0, background: color.bg, opacity: interpolate(frame, [st - 3, st, st + 5], [0, 0.85, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) }} />
        ))}
        {/* Glass reflection */}
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(115deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0) 35%)' }} />
      </div>
      {/* Dynamic island */}
      <div style={{ position: 'absolute', left: W / 2 - 58, top: bezel + 14, width: 116, height: 32, borderRadius: 16, background: '#000' }} />
    </div>
  )
}

function EndCard({ frame }: { frame: number }) {
  // The pointer glides onto the button and clicks it.
  const glide = expo(Math.min(1, Math.max(0, (frame - 40) / 26)))
  const press = interpolate(frame, [70, 74, 80], [1, 0.95, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const ring = interpolate(frame, [72, 90], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const px = interpolate(glide, [0, 1], [1780, 1520])
  const py = interpolate(glide, [0, 1], [1020, 812])
  return (
    <>
      <div style={{ position: 'absolute', left: 980, top: 300, width: 860 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 30, ...rise(frame, 2, 20) }}>
          <div style={{ width: 150, height: 150, borderRadius: 38, background: 'linear-gradient(145deg, #c9bbff, #8f78ec)', display: 'grid', placeItems: 'center', boxShadow: '0 20px 60px -15px rgba(185,168,246,0.6)' }}>
            <Img src={staticFile('brand/mwm-mark-white.svg')} style={{ width: 104 }} />
          </div>
          <div style={{ fontSize: 92, lineHeight: 0.98, fontWeight: 600, letterSpacing: '-0.035em' }}>
            Money with
            <br />
            Memory
          </div>
        </div>
        <p style={{ margin: '40px 0 0', fontSize: 38, lineHeight: 1.3, color: 'rgba(244,244,248,0.88)', ...rise(frame, 12) }}>
          Local AI negotiates. RGB settles.
          <br />
          <span style={{ color: color.accent }}>You stay in control.</span>
        </p>
        <div style={{ marginTop: 50, display: 'flex', alignItems: 'center', gap: 28, ...rise(frame, 22) }}>
          <div
            style={{
              position: 'relative',
              fontSize: 34,
              fontWeight: 600,
              color: color.onAccent,
              background: color.accent,
              borderRadius: 999,
              padding: '24px 48px',
              transform: `scale(${press})`,
              boxShadow: '0 16px 50px -12px rgba(185,168,246,0.7)',
            }}
          >
            Watch the demo →
            <div style={{ position: 'absolute', inset: -6, borderRadius: 999, border: `3px solid ${color.accent}`, opacity: (1 - ring) * (ring > 0 ? 1 : 0), transform: `scale(${1 + ring * 0.12})` }} />
          </div>
          <span style={{ fontSize: 22, color: color.hint, lineHeight: 1.4 }}>
            RGB · QVAC (local AI) · Tether WDK
            <br />
            Bitcoin regtest demo
          </span>
        </div>
      </div>
      <svg width="40" height="40" viewBox="0 0 26 26" style={{ position: 'absolute', left: px, top: py, opacity: glide, filter: 'drop-shadow(0 3px 6px rgba(0,0,0,0.6))' }}>
        <path d="M4 2.5v18.2l4.7-4.4 3.1 7.2 3.3-1.4-3.1-7.1h6.5z" fill="#fff" stroke="#14102b" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    </>
  )
}
