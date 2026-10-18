import { Composition } from 'remotion'
import { Main, plan } from './Main'
import { GEOMETRY } from './components/geometry'
import { FPS } from './timeline'

export function Root() {
  return (
    <>
      <Composition
        id="MwM"
        component={Main}
        defaultProps={{ layout: 'desktop' as const }}
        width={GEOMETRY.desktop.width}
        height={GEOMETRY.desktop.height}
        fps={FPS}
        durationInFrames={plan('desktop').total}
      />
      <Composition
        id="MwMVertical"
        component={Main}
        defaultProps={{ layout: 'mobile' as const }}
        width={GEOMETRY.mobile.width}
        height={GEOMETRY.mobile.height}
        fps={FPS}
        durationInFrames={plan('mobile').total}
      />
    </>
  )
}
