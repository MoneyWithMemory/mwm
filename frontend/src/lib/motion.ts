import type { Transition, Variants } from 'motion/react'

/**
 * Framer Motion mirror of the CSS motion tokens in src/index.css.
 * Components import from here; no motion values hardcoded elsewhere.
 */

/** --ease-smooth-out: default for open/close, slides, swaps. */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const

/** Seconds. close = quick (150ms): closing is always faster than opening. */
export const DUR = {
  quick: 0.15,    // --duration-quick: close, press, text swap
  iconSwap: 0.17, // icon and state swaps (CLAUDE.md 160–180ms)
  open: 0.25,     // --duration-fast: sheet/modal/dropdown open, page slide
} as const

export const SCALE = {
  overlay: 0.96,  // --scale-large: modal and sheet open/close
  dropdown: 0.97, // --scale-medium: dropdown open
  dropdownClose: 0.99, // --scale-tiny
  hover: 1.015,   // --scale-hover
  press: 0.97,    // --scale-press
  pressIcon: 0.9, // --scale-press-icon
} as const

export const DIST = {
  micro: 4,  // --distance-micro: text swap
  base: 8,   // --distance-base: page slide
  large: 30, // --distance-large: sheet entry
} as const

/** Sliding tab/segment indicator (layoutId). */
export const SPRING_TABS = { type: 'spring', stiffness: 450, damping: 35 } as const satisfies Transition

/** whileHover / whileTap on motion buttons. */
export const SPRING_SNAPPY = { type: 'spring', stiffness: 450, damping: 28 } as const satisfies Transition

/** Pass to <MotionConfig> at the app root so Framer Motion honours prefers-reduced-motion. */
export const MOTION_CONFIG = { reducedMotion: 'user' } as const

const open: Transition = { duration: DUR.open, ease: EASE_OUT }
const close: Transition = { duration: DUR.quick, ease: EASE_OUT }

/** Icon swap: use with <AnimatePresence mode="wait" initial={false}>. */
export const iconSwap: Variants = {
  initial: { scale: 0.6, rotate: -20, opacity: 0, filter: 'blur(2px)' },
  animate: { scale: 1, rotate: 0, opacity: 1, filter: 'blur(0px)', transition: { duration: DUR.iconSwap, ease: EASE_OUT } },
  exit: { scale: 0.6, rotate: 20, opacity: 0, filter: 'blur(2px)', transition: { duration: DUR.iconSwap, ease: EASE_OUT } },
}

/** Text/label swap (Save → Saved), with AnimatePresence mode="wait". */
export const textSwap: Variants = {
  initial: { y: DIST.micro, opacity: 0, filter: 'blur(2px)' },
  animate: { y: 0, opacity: 1, filter: 'blur(0px)', transition: { duration: DUR.quick, ease: 'easeInOut' } },
  exit: { y: -DIST.micro, opacity: 0, filter: 'blur(2px)', transition: { duration: DUR.quick, ease: 'easeInOut' } },
}

/** Bottom sheet, transform-origin bottom center: opens in 250ms, closes in 150ms. */
export const sheet: Variants = {
  initial: { opacity: 0, y: DIST.large, scale: SCALE.overlay },
  animate: { opacity: 1, y: 0, scale: 1, transition: open },
  exit: { opacity: 0, y: DIST.large, scale: SCALE.overlay, transition: close },
}

/** Centered modal, scales from the center. */
export const modal: Variants = {
  initial: { opacity: 0, scale: SCALE.overlay },
  animate: { opacity: 1, scale: 1, transition: open },
  exit: { opacity: 0, scale: SCALE.overlay, transition: close },
}

/** Dropdown/popover: set transform-origin to the trigger's anchor. */
export const dropdown: Variants = {
  initial: { opacity: 0, scale: SCALE.dropdown },
  animate: { opacity: 1, scale: 1, transition: open },
  exit: { opacity: 0, scale: SCALE.dropdownClose, transition: close },
}

/** Backdrop behind sheets and modals. */
export const backdrop: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: open },
  exit: { opacity: 0, transition: close },
}

/** Crossfade, e.g. switching wallet in the single layout. */
export const fade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: open },
  exit: { opacity: 0, transition: close },
}

/**
 * View change inside a WalletPane. Ends with filter: none so the page does not
 * stay a containing block for absolutely positioned descendants.
 */
export const pageSlide: Variants = {
  initial: { opacity: 0, x: DIST.base, filter: 'blur(3px)' },
  animate: { opacity: 1, x: 0, filter: 'blur(0px)', transition: open, transitionEnd: { filter: 'none' } },
  exit: { opacity: 0, x: -DIST.base, filter: 'blur(3px)', transition: close },
}
