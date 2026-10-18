// A visible mouse pointer for headless captures (headless Chromium draws none), plus helpers that
// move it the way a person would: eased glides, a short settle, then the click.

/** Injected before any page script: an arrow that follows the mouse and a ring on each click. */
export const POINTER_SCRIPT = `
(() => {
  const install = () => {
    if (document.getElementById('__rec_pointer')) return
    const style = document.createElement('style')
    style.textContent = \`
      #__rec_pointer { position: fixed; left: 0; top: 0; width: 26px; height: 26px; z-index: 2147483647;
        pointer-events: none; transform: translate(-100px, -100px); transition: opacity 200ms; }
      #__rec_pointer svg { position: absolute; left: -3px; top: -2px; filter: drop-shadow(0 2px 4px rgb(0 0 0 / 0.55)); }
      .__rec_ring { position: fixed; z-index: 2147483646; pointer-events: none; width: 34px; height: 34px;
        margin: -17px 0 0 -17px; border-radius: 50%; border: 2px solid #b9a8f6; background: rgb(185 168 246 / 0.18);
        animation: __rec_ring 520ms cubic-bezier(0.22, 1, 0.36, 1) forwards; }
      @keyframes __rec_ring { from { transform: scale(0.35); opacity: 1 } to { transform: scale(1.5); opacity: 0 } }
    \`
    document.head.appendChild(style)
    const el = document.createElement('div')
    el.id = '__rec_pointer'
    el.innerHTML = '<svg width="26" height="26" viewBox="0 0 26 26"><path d="M4 2.5v18.2l4.7-4.4 3.1 7.2 3.3-1.4-3.1-7.1h6.5z" fill="#fff" stroke="#14102b" stroke-width="1.4" stroke-linejoin="round"/></svg>'
    document.body.appendChild(el)
    window.addEventListener('mousemove', (e) => { el.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)' }, true)
    window.addEventListener('mousedown', (e) => {
      const ring = document.createElement('div')
      ring.className = '__rec_ring'
      ring.style.left = e.clientX + 'px'
      ring.style.top = e.clientY + 'px'
      document.body.appendChild(ring)
      setTimeout(() => ring.remove(), 600)
    }, true)
    window.__recPointer = (visible) => { el.style.opacity = visible ? '1' : '0' }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install)
  else install()
})()
`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

/** Pointer helpers bound to one page. Coordinates are CSS pixels. */
export function pointer(page) {
  let pos = { x: 600, y: 500 }

  async function glide(x, y, ms = 650) {
    const from = { ...pos }
    const steps = Math.max(8, Math.round(ms / 16))
    for (let i = 1; i <= steps; i++) {
      const k = ease(i / steps)
      await page.mouse.move(from.x + (x - from.x) * k, from.y + (y - from.y) * k)
      await sleep(ms / steps)
    }
    pos = { x, y }
  }

  async function center(locator) {
    await locator.waitFor({ state: 'visible' })
    await locator.scrollIntoViewIfNeeded()
    const box = await locator.boundingBox()
    if (!box) throw new Error('No box for locator')
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }

  return {
    /** Parks the pointer at a point without animation (call before recording starts). */
    async park(x, y) {
      pos = { x, y }
      await page.mouse.move(x, y)
    },
    glide,
    async hover(locator, ms) {
      const c = await center(locator)
      await glide(c.x, c.y, ms)
    },
    async click(locator, { ms = 650, settle = 180, after = 250 } = {}) {
      const c = await center(locator)
      await glide(c.x, c.y, ms)
      await sleep(settle)
      await page.mouse.down()
      await sleep(70)
      await page.mouse.up()
      await sleep(after)
    },
    async show(visible) {
      await page.evaluate((v) => window.__recPointer?.(v), visible)
    },
  }
}

export { sleep }
