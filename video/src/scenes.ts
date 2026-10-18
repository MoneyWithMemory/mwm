// The six demo scenes, in live-demo order. Times are clip seconds, mostly relative to the marks the
// capture script saved; camera rects come from the element boxes it saved (CSS pixels).
// Captions stay short and literal: this is a Bitcoin regtest demo recorded in the app's mock mode.
import { CLIPS, pad, union, type Clip, type Cue, type Layout, type Rect, type SceneDef, type Segment, type Shot } from './timeline'

interface Ctx {
  layout: Layout
  m: Record<string, number>
  b: Record<string, Rect>
  end: number
  full: Rect
}

/** Phone: a horizontal band of the screen (full width), so zooming only crops top and bottom. */
const band = (full: Rect, r: Rect, h: number): Rect => {
  const cy = r[1] + r[3] / 2
  const top = Math.min(Math.max(cy - h / 2, 0), full[3] - h)
  return [0, top, full[2], h]
}

/** A sheet's content column (max-w-md, centered in the sheet), with some air around it. */
const sheetColumn = (sheet: Rect, width = 620): Rect => [sheet[0] + sheet[2] / 2 - width / 2, sheet[1] - 12, width, sheet[3] + 24]

type Build = (c: Ctx) => { segments: Segment[]; cues: Cue[]; shots: Shot[] }

const SCENES: { id: string; chapter: string; clip: string; build: Build }[] = [
  {
    id: 'shop',
    chapter: 'Shop',
    clip: '01-shop',
    build: ({ layout, m, b, end, full }) => ({
      segments: [
        { from: m.shop - 1.3, to: m.offer - 0.3, rate: 1.1 },
        { from: m.offer - 0.3, to: m.offer + 2.5, rate: 1.3 },
      ],
      cues: [
        { at: 0, title: "Wallet B's PEPE offer", sub: 'Listed in the Shop as PEPE Desk.' },
        { at: m.sybil - 0.4, title: 'Sybil: Low reliability', sub: 'The (?) explains it. The score comes from settled swaps.' },
        { at: m.offer - 0.2, title: 'Wallet A buys from Wallet B', sub: 'PEPE Desk: High Authenticity, 86%.' },
      ],
      shots:
        layout === 'desktop'
          ? [
              { at: 0, rect: full },
              { at: m.shop + 0.1, rect: pad(union(b.offer, b.sybil), [40, 60]) },
              { at: m.sybil - 0.3, rect: pad(b.sybil, [50, 40]) },
              { at: m.offer - 0.4, rect: pad(b.offer, [50, 40]) },
              { at: m.offer + 1.8, rect: full, dur: 0.7 },
            ]
          : [
              { at: 0, rect: full },
              { at: m.sybil - 0.3, rect: band(full, b.sybil, 470) },
              { at: m.offer - 0.3, rect: band(full, b.offer, 520) },
              { at: m.offer + 1.5, rect: full, dur: 0.8 },
            ],
    }),
  },
  {
    id: 'negotiate',
    chapter: 'Negotiation',
    clip: '02-negotiate',
    build: ({ layout, m, b, end, full }) => {
      const desktop = layout === 'desktop'
      const cues: Cue[] = [
        desktop
          ? { at: 0, title: 'Wallet A buys 50%', sub: 'Split view: Wallet A on the left, Wallet B on the right.' }
          : { at: 0, title: 'Wallet A buys 50%', sub: "Half of Wallet B's lot." },
        { at: m.start, title: 'Two local AI agents negotiate', sub: 'Offers go back and forth in a chat.' },
        { at: m.deal, title: 'Deal reached', sub: 'Both agents accept the same price.' },
        {
          at: m.detailsA,
          title: 'Limits stay private on each device',
          sub: desktop ? "Wallet A sees only its own agent's reasoning." : "Only this device sees its agent's reasoning.",
        },
      ]
      if (desktop) cues.push({ at: m.detailsB, title: 'Limits stay private on each device', sub: 'And Wallet B sees only its own.' })
      return {
        segments: [
          { from: m.half - 1.5, to: m.deal, rate: 1.3 },
          { from: m.deal, to: m.detailsA - 0.2, rate: 1.5 },
          { from: m.detailsA - 0.2, to: end - 0.3, rate: 1.2 },
        ],
        cues,
        shots: desktop
          ? [
              { at: 0, rect: pad(b.panes, 10) },
              { at: m.half - 1.3, rect: pad(b.amount, [30, 70]), dur: 0.8 },
              { at: m.half + 0.7, rect: pad(b.panes, 10) },
              { at: m.private + 0.1, rect: pad(b.privateA, [40, 150]) },
              { at: m.deal - 0.4, rect: pad(b.panes, 10) },
              { at: m.detailsA + 0.2, rect: pad(b.roundA, [36, 40]) },
              { at: m.detailsB - 1.2, rect: pad(b.panes, 10) },
              { at: m.detailsB + 0.3, rect: pad(union(b.roundA, b.roundB), [30, 40]) },
            ]
          : [
              { at: 0, rect: band(full, b.amount, 560) },
              { at: m.half + 0.8, rect: full },
              { at: m.private + 0.1, rect: band(full, b.privateA, 560) },
              { at: m.deal - 0.4, rect: full },
              { at: m.detailsA + 0.2, rect: band(full, b.roundA, 560) },
            ],
      }
    },
  },
  {
    id: 'settle',
    chapter: 'Approve and settle',
    clip: '03-settle',
    build: ({ layout, m, b, end, full }) => ({
      segments: [
        { from: m.approveA - 2.3, to: m.approveB + 0.8, rate: 1.5 },
        { from: m.approveB + 0.8, to: m.settled + 0.2, rate: 1.25 },
        { from: m.settled + 0.2, to: Math.min(end - 0.3, m.txid + 1.7) },
      ],
      cues: [
        {
          at: 0,
          title: 'Both parties approve',
          sub: layout === 'desktop' ? 'Each wallet signs the same terms.' : 'Wallet B signs the same terms on this device too.',
        },
        { at: m.approveB + 0.6, title: '7-step RGB atomic swap', sub: 'Each step is an rgb-lib call, on Bitcoin regtest.' },
        { at: m.settled, title: 'Trade complete', sub: 'A transaction id appears.' },
      ],
      shots:
        layout === 'desktop'
          ? [
              { at: 0, rect: pad(b.panes, 10) },
              { at: m.approveB + 0.8, rect: [b.done[0] - 16, b.steps[1] - 40, b.done[2] + 32, b.steps[3] + 70] },
              { at: m.settled + 0.5, rect: pad(b.done, [40, 30]) },
            ]
          : [
              { at: 0, rect: full },
              { at: m.approveB + 0.8, rect: band(full, b.steps, 560) },
              { at: m.settled + 0.5, rect: band(full, b.done, 520) },
            ],
    }),
  },
  {
    id: 'vault',
    chapter: 'Vault',
    clip: '04-vault',
    build: ({ layout, m, b, end, full }) => {
      const desktop = layout === 'desktop'
      // Balance, actions and assets: the left column of the Vault (the sheets start where it does).
      const top: Rect = desktop ? [b.moveSheet[0], 80, 820, 470] : band(full, [0, 0, 390, 560], 600)
      return {
        segments: [
          { from: m.vault - 1.2, to: m.moved + 1.2, rate: 1.5 },
          { from: m.moved + 1.2, to: m.inVault + 0.2, rate: 2 },
          { from: m.inVault + 0.2, to: m.refused - 0.3, rate: 1.4 },
          { from: m.refused - 0.3, to: end - 0.6 },
        ],
        cues: [
          { at: 0, title: 'Wallet → Vault', sub: "Your agents can't see or spend the Vault." },
          { at: m.move - 0.4, title: 'Move USDT into the Vault', sub: 'Self-custody with Tether WDK.' },
          { at: m.send - 0.3, title: 'Send to an outside invoice', sub: 'An RGB invoice the Vault never asked for.' },
          { at: m.refused, title: 'The Tether WDK policy refuses it', sub: 'Nothing left the Vault.' },
        ],
        shots: desktop
          ? [
              { at: 0, rect: full },
              { at: m.vault + 0.1, rect: top },
              { at: m.move + 0.1, rect: sheetColumn(b.moveSheet) },
              { at: m.moved, rect: sheetColumn(b.movedSheet) },
              // Done closes the sheet about 2.4 s after "moved".
              { at: m.moved + 2.3, rect: top, dur: 0.7 },
              { at: m.send + 0.1, rect: sheetColumn(b.sendSheet) },
              { at: m.refused, rect: sheetColumn(b.refusedSheet) },
            ]
          : [
              { at: 0, rect: full },
              { at: m.move + 0.1, rect: band(full, b.moveSheet, 600) },
              { at: m.moved, rect: band(full, b.movedSheet, 600) },
              { at: m.moved + 2.3, rect: full, dur: 0.7 },
              { at: m.send + 0.1, rect: band(full, b.sendSheet, 600) },
              { at: m.refused, rect: band(full, b.refusedSheet, 600) },
            ],
      }
    },
  },
  {
    id: 'ai',
    chapter: 'Ask your AI',
    clip: '05-ai',
    build: ({ layout, m, b, end, full }) => ({
      segments: [{ from: m.open - 1.3, to: end - 0.6, rate: 1.25 }],
      cues: [
        { at: 0, title: 'Ask your AI', sub: 'On this device.' },
        { at: m.analyze - 0.3, title: 'Analyze my account', sub: 'The answer has a Move to Vault button.' },
      ],
      shots:
        layout === 'desktop'
          ? [
              { at: 0, rect: full },
              { at: m.open + 0.1, rect: pad(b.aiPanel, [60, 20]) },
              // The question and the answer, at the top of the panel.
              { at: m.answer - 0.7, rect: [b.aiPanel[0] - 14, b.aiPanel[1] + 8, b.aiPanel[2] + 28, 330] },
            ]
          : [
              { at: 0, rect: full },
              { at: m.answer - 0.7, rect: band(full, [0, b.aiPanel[1], full[2], 330], 540) },
            ],
    }),
  },
  {
    id: 'contacts',
    chapter: 'Contacts',
    clip: '06-contacts',
    build: ({ layout, m, b, end, full }) => ({
      segments: [{ from: m.contacts - 1.2, to: Math.min(end - 0.3, m.sybil + 1.7), rate: 1.3 }],
      cues: [
        { at: 0, title: 'Contacts', sub: 'Each one with a reliability score.' },
        { at: m.score - 0.4, title: 'Your own reliability score', sub: 'As counterparties see it.' },
      ],
      shots:
        layout === 'desktop'
          ? [
              { at: 0, rect: full },
              { at: m.contacts + 0.1, rect: [b.profile[0] - 40, b.profile[1] - 110, 700, 330] },
              { at: m.sybil - 0.5, rect: [b.sybilRow[0] - 20, b.sybilRow[1] - 110, 640, 300] },
            ]
          : [
              { at: 0, rect: full },
              { at: m.contacts + 0.1, rect: band(full, b.profile, 520) },
            ],
    }),
  },
]

export function buildScenes(layout: Layout): SceneDef[] {
  const set = CLIPS[layout]
  const full: Rect = [0, 0, set.width, set.height]
  // A scene may frame a box another clip saved (the split-view panes stay put); its own come first.
  const allBoxes = Object.assign({}, ...Object.values(set.clips).map((c) => c.boxes)) as Record<string, Rect>
  return SCENES.map(({ id, chapter, clip: name, build }) => {
    const clip: Clip = set.clips[name]
    const { segments, cues, shots } = build({ layout, m: clip.marks, b: { ...allBoxes, ...clip.boxes }, end: clip.seconds, full })
    return {
      id,
      chapter,
      clip,
      segments,
      // Cue 0 starts with the scene, whatever the first segment's start.
      cues: cues.map((c, i) => (i === 0 ? { ...c, at: segments[0].from } : c)),
      shots: shots.map((s, i) => (i === 0 ? { ...s, at: segments[0].from } : s)),
    }
  })
}
