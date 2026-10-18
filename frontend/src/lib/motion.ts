import type { Transition, Variants } from 'motion/react'

/**
 * Framer Motion mirror of the CSS motion tokens in src/index.css.
 * Components import from here; no motion values hardcoded elsewhere.
 */

/** --ease-smooth-out: default for open/close, slides, swaps. */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const

/** --ease-bounce: entrances only (badge pop); never on a close. */
export const EASE_BOUNCE = [0.34, 1.36, 0.64, 1] as const

/** Seconds. close = quick (150ms): closing is always faster than opening. */
export const DUR = {
  stagger: 0.04,  // --duration-stagger: per-item offset in a cascade
  micro: 0.08,    // --duration-micro: intent delay, success check stroke delay
  quick: 0.15,    // --duration-quick: close, press, text swap
  iconSwap: 0.17, // icon and state swaps (160–180ms)
  open: 0.25,     // --duration-fast: sheet/modal/dropdown open, page slide
  medium: 0.35,   // --duration-medium: error shake, checkbox draw, chat bubble slide-in
  badge: 0.5,     // --duration-very-slow: badge appear
} as const

/** Looping indicators (seconds). */
export const LOOP = {
  dots: 1.2,       // thinking dots cycle (--matrix-cycle)
  dotStagger: 0.2, // offset between dots
  pulse: 2,        // halo pulse (--think-shimmer)
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

/** Error shake (transitions-dev 12): one decaying shake of the field, or of the whole group in error. */
export const SHAKE_X = [0, -6, 6, -4, 4, -2, 2, 0]
export const SHAKE_TRANSITION = { duration: DUR.medium, ease: EASE_OUT } as const satisfies Transition

/** Sliding tab/segment indicator (layoutId). */
export const SPRING_TABS = { type: 'spring', stiffness: 450, damping: 35 } as const satisfies Transition

/** whileHover / whileTap on motion buttons. */
export const SPRING_SNAPPY = { type: 'spring', stiffness: 450, damping: 28 } as const satisfies Transition

/** Markers gliding along a track (--spring-spread): soft, no overshoot you can read as a number. */
export const SPRING_GLIDE = { type: 'spring', stiffness: 180, damping: 22, mass: 0.8 } as const satisfies Transition

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

/** Notification badge: pops in with a soft overshoot, leaves quickly without one. */
export const badgePop: Variants = {
  initial: { scale: 0.6, opacity: 0 },
  animate: { scale: 1, opacity: 1, transition: { duration: DUR.badge, ease: EASE_BOUNCE } },
  exit: { scale: 0.6, opacity: 0, transition: close },
}

/** Accordion body: one reversible motion, same 250ms both ways (no open/close split). */
export const accordion: Variants = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1, transition: open },
  exit: { height: 0, opacity: 0, transition: open },
}

/** A new item entering a live list (e.g. a negotiation round). */
export const listItem: Variants = {
  initial: { opacity: 0, y: -DIST.base, filter: 'blur(2px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)', transition: open, transitionEnd: { filter: 'none' } },
}

/**
 * Chat bubble arriving from its own side, like a message: `custom` is { side, delay }, side -1
 * for the left column and 1 for the right. Set transform-origin on the bubble's tail corner.
 * Leaves without travel, so a fold or a typing indicator never flings content across the chat.
 */
export const chatBubble: Variants = {
  initial: ({ side }: { side: number }) => ({ opacity: 0, x: side * DIST.large, scale: SCALE.overlay, filter: 'blur(2px)' }),
  animate: ({ delay = 0 }: { delay?: number }) => ({
    opacity: 1,
    x: 0,
    scale: 1,
    filter: 'blur(0px)',
    transition: { duration: DUR.medium, ease: EASE_OUT, delay },
    transitionEnd: { filter: 'none' },
  }),
  exit: { opacity: 0, scale: SCALE.overlay, transition: close },
}

/** Success check (transitions-dev 10): fades, turns upright and rises with a bob; pair with checkStroke. */
export const successCheck: Variants = {
  initial: { opacity: 0, rotate: 80, y: DIST.large, filter: 'blur(8px)' },
  animate: {
    opacity: 1,
    rotate: 0,
    y: 0,
    filter: 'blur(0px)',
    transition: { duration: DUR.badge, ease: EASE_OUT, y: { duration: DUR.badge, ease: EASE_BOUNCE } },
    transitionEnd: { filter: 'none' },
  },
}

/** The check's path, drawn once the badge is on its way (80ms beat). */
export const checkStroke: Variants = {
  initial: { pathLength: 0 },
  animate: { pathLength: 1, transition: { duration: DUR.badge, ease: EASE_OUT, delay: DUR.micro } },
}

/** Two views taking turns in the same slot (chat ↔ detailed flow), with AnimatePresence mode="wait". */
export const viewSwap: Variants = {
  initial: { opacity: 0, y: DIST.base, filter: 'blur(2px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)', transition: open, transitionEnd: { filter: 'none' } },
  exit: { opacity: 0, filter: 'blur(2px)', transition: close },
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
 * View change inside a WalletPane; `custom` is the direction: 1 going deeper (the new view
 * comes from the right), -1 going back (it comes from the left). Ends with filter: none so
 * the page does not stay a containing block for absolutely positioned descendants.
 */
export const pageSlide: Variants = {
  initial: (direction: number) => ({ opacity: 0, x: direction * DIST.base, filter: 'blur(3px)' }),
  animate: { opacity: 1, x: 0, filter: 'blur(0px)', transition: open, transitionEnd: { filter: 'none' } },
  exit: (direction: number) => ({ opacity: 0, x: -direction * DIST.base, filter: 'blur(3px)', transition: close }),
}
