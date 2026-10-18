// Design tokens mirrored from frontend/src/index.css (dark premium, lavender accent).
export const color = {
  bg: '#08080f',
  surface: '#14141f',
  surfaceMuted: '#1d1d2b',
  surfaceRaised: '#2a2a3d',
  fg: '#f4f4f8',
  hint: '#9a9aad',
  separator: 'rgba(255, 255, 255, 0.08)',
  accent: '#b9a8f6',
  accentPressed: '#a08cf0',
  accentCool: '#6fc8f4',
  onAccent: '#14102b',
  success: '#5fd39a',
  danger: '#f0707a',
  warning: '#e8b04a',
  chartFrom: '#a9bdf5',
  chartTo: '#f2cbd6',
}

// The app's own stack: SF Pro on Apple devices, Inter (bundled) elsewhere. Renders use Inter.
export const font = '"Inter Variable", Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif'

// --ease-smooth-out and --ease-exponential from index.css, as bezier control points.
export const EASE_SMOOTH_OUT = [0.22, 1, 0.36, 1] as const
export const EASE_EXPONENTIAL = [0.16, 1, 0.3, 1] as const
export const EASE_IN_OUT = [0.65, 0, 0.35, 1] as const
