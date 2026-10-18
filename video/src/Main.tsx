import '@fontsource-variable/inter/wght.css'
import { useEffect, useState } from 'react'
import { AbsoluteFill, continueRender, delayRender, Easing, interpolate, Sequence, useCurrentFrame } from 'remotion'
import { AppWindow } from './components/AppWindow'
import { Backdrop, Intro, Outro, Rail } from './components/Cards'
import { Captions } from './components/Captions'
import { buildScenes } from './scenes'
import { color, EASE_SMOOTH_OUT, font } from './theme'
import { sceneFrames, type Layout, type SceneDef } from './timeline'

const INTRO = 126
const OUTRO = 168
const CROSS = 14 // frames two neighbours overlap

export interface Plan {
  scenes: { scene: SceneDef; start: number; len: number }[]
  outroStart: number
  total: number
}

/** Intro, the six scenes, the closing card; each one overlaps the next by CROSS frames. */
export function plan(layout: Layout): Plan {
  let t = INTRO - CROSS
  const scenes = buildScenes(layout).map((scene) => {
    const len = sceneFrames(scene)
    const placed = { scene, start: t, len }
    t += len - CROSS
    return placed
  })
  return { scenes, outroStart: t, total: t + OUTRO }
}

const ease = Easing.bezier(...EASE_SMOOTH_OUT)

/** Fades a part in over its first CROSS frames and out over its last ones. */
function Crossfade({ len, children, fadeOut = true }: { len: number; children: React.ReactNode; fadeOut?: boolean }) {
  const frame = useCurrentFrame()
  const fin = ease(interpolate(frame, [0, CROSS], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }))
  const fout = fadeOut ? interpolate(frame, [len - CROSS, len], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 1
  return <AbsoluteFill style={{ opacity: fin * fout, transform: `scale(${0.985 + 0.015 * fin})` }}>{children}</AbsoluteFill>
}

function useFonts() {
  const [handle] = useState(() => delayRender('Loading Inter'))
  useEffect(() => {
    Promise.all([400, 500, 600].map((w) => document.fonts.load(`${w} 40px "Inter Variable"`)))
      .then(() => document.fonts.ready)
      .finally(() => continueRender(handle))
  }, [handle])
}

export function Main({ layout }: { layout: Layout }) {
  useFonts()
  const frame = useCurrentFrame()
  const { scenes, outroStart } = plan(layout)
  const progress = scenes.map(({ start, len }) => (frame >= outroStart ? 0 : Math.min(1, Math.max(0, (frame - start) / len))))

  return (
    <AbsoluteFill style={{ backgroundColor: color.bg, fontFamily: font, color: color.fg }}>
      <Backdrop layout={layout} />
      <Sequence durationInFrames={INTRO} name="Intro">
        <IntroFade>
          <Intro layout={layout} />
        </IntroFade>
      </Sequence>
      {scenes.map(({ scene, start, len }, i) => (
        <Sequence key={scene.id} from={start} durationInFrames={len} name={scene.chapter}>
          <Crossfade len={len}>
            <AppWindow scene={scene} layout={layout} />
          </Crossfade>
          <Captions scene={scene} index={i} layout={layout} len={len} overlap={CROSS} />
        </Sequence>
      ))}
      <Rail layout={layout} progress={progress} labels={scenes.map((s) => s.scene.chapter)} />
      <Sequence from={outroStart} durationInFrames={OUTRO} name="Closing card">
        <Outro layout={layout} />
      </Sequence>
    </AbsoluteFill>
  )
}

function IntroFade({ children }: { children: React.ReactNode }) {
  const frame = useCurrentFrame()
  const opacity = interpolate(frame, [INTRO - CROSS, INTRO], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>
}
