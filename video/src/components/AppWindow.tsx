import { AbsoluteFill, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from 'remotion'
import { color } from '../theme'
import { cameraAt, CLIPS, clipToFrame, fit, FPS, type Layout, type Rect, type SceneDef } from '../timeline'
import { GEOMETRY } from './geometry'

/** One scene's recording, cropped and zoomed by its camera, in a floating window. */
export function AppWindow({ scene, layout }: { scene: SceneDef; layout: Layout }) {
  const frame = useCurrentFrame()
  const set = CLIPS[layout]
  const g = GEOMETRY[layout].window
  const content: Rect = [0, 0, set.width, set.height]
  const { scale, w, h, view } = fit(cameraAt(scene, frame), g.maxW, g.maxH, g.maxZoom, content)

  return (
    <AbsoluteFill>
      {/* A soft lavender glow behind the window. */}
      <div
        style={{
          position: 'absolute',
          left: g.cx - w / 2 - 60,
          top: g.cy - h / 2 - 60,
          width: w + 120,
          height: h + 120,
          borderRadius: g.radius + 60,
          background: 'radial-gradient(closest-side, rgba(185,168,246,0.22), rgba(185,168,246,0) 100%)',
          filter: 'blur(30px)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: g.cx - w / 2,
          top: g.cy - h / 2,
          width: w,
          height: h,
          overflow: 'hidden',
          borderRadius: g.radius,
          backgroundColor: color.bg,
          boxShadow: `0 0 0 1px ${color.separator}, 0 40px 90px -30px rgba(0,0,0,0.85), 0 0 50px -12px rgba(185,168,246,0.35)`,
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: set.width,
            height: set.height,
            transformOrigin: '0 0',
            transform: `translate(${-view[0] * scale}px, ${-view[1] * scale}px) scale(${scale})`,
          }}
        >
          {scene.segments.map((s, i) => {
            const from = Math.round(clipToFrame(scene, s.from))
            const to = Math.round(clipToFrame(scene, s.to))
            return (
              <Sequence key={i} from={from} durationInFrames={Math.max(1, to - from)} layout="none">
                <OffthreadVideo
                  src={staticFile(scene.clip.file)}
                  trimBefore={Math.round(s.from * FPS)}
                  playbackRate={s.rate ?? 1}
                  muted
                  style={{ position: 'absolute', left: 0, top: 0, width: set.width, height: set.height }}
                />
              </Sequence>
            )
          })}
        </div>
      </div>
    </AbsoluteFill>
  )
}
