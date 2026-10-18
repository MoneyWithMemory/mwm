import type { Layout } from '../timeline'

/** Where things sit in each format: the floating app window, the captions and the chapter rail. */
export const GEOMETRY = {
  desktop: {
    width: 1920,
    height: 1080,
    // The capture is 1440×900 CSS px recorded at 1.5x: 2.2x on screen keeps text sharp enough.
    window: { cx: 1262, cy: 540, maxW: 1180, maxH: 900, maxZoom: 2.2, radius: 22 },
    captions: { left: 112, top: 330, width: 470, title: 54, sub: 26, chapter: 22 },
    rail: { left: 112, bottom: 64 },
  },
  mobile: {
    width: 1080,
    height: 1920,
    // The capture is 390×844 CSS px recorded at 2x; full width in the window is 2.4x.
    window: { cx: 540, cy: 1158, maxW: 940, maxH: 1340, maxZoom: 2.45, radius: 40 },
    captions: { left: 80, top: 132, width: 920, title: 64, sub: 31, chapter: 26 },
    rail: { left: 80, bottom: 52 },
  },
} satisfies Record<Layout, unknown>
