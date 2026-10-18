# MwM motion video

A 16:9 demo video (1080p) and a 9:16 cut of Money with Memory, recorded from the frontend's built-in
mock. That mock needs no backend, no AI model and no Vault service. Everything shown runs on Bitcoin
**regtest** with demo data.

| Output | Size | Composition |
|---|---|---|
| `out/mwm-promo-1080p.mp4` | 1920×1080, 14 s teaser | `MwMPromo` |
| `out/mwm-motion-1080p.mp4` | 1920×1080, 30 fps | `MwM` |
| `out/mwm-motion-vertical.mp4` | 1080×1920, 30 fps | `MwMVertical` |

The **teaser** (`src/Promo.tsx`) shows the phone in 3D playing the app, with one line per feature: "Know who you trade with.", "Local AI negotiates.", "RGB settles.", "You stay in control.". It ends on the name, the line and a call to action.

## Scenes (long version)

1. **Shop.** Wallet B's PEPE offer (*PEPE Desk*). Sybil is *Low reliability*, and its (?) explains why.
2. **Negotiation.** Wallet A buys 50% from Wallet B. In split view, the two agents negotiate in a chat. *Details* then shows that each side sees only its own agent's private reasoning.
3. **Approve and settle.** Both wallets approve. The 7-step RGB atomic swap runs (one `rgb_lib` call per step) and a transaction id appears.
4. **Vault.** USDT moves from the Wallet into the Vault. A Send to an outside invoice is then refused by the Tether WDK policy.
5. **Ask your AI and Contacts.** *Analyze my account* answers with a *Move to Vault* button. Contacts show your own reliability score.
6. **Closing card.** "Local AI negotiates. RGB settles. You stay in control." RGB · QVAC (local AI) · Tether WDK.

## Pipeline

```
frontend (mock mode) ──Playwright──▶ public/captures/<layout>/*.mp4 + clips.json
Higgsfield (Z Image)  ─────────────▶ public/higgsfield/*.jpg   (backdrops, intro stills)
                                          │
                                   Remotion (src/) ──▶ out/*.mp4
```

- **`capture/`**: Playwright drives the app at 1440×900 (desktop) and 390×844 (phone). `recorder.mjs` records the Chrome DevTools screencast at 1.5× and 2× device pixels and encodes constant 30 fps H.264, keeping real timing. That is sharper than Playwright's own `recordVideo`, which is VP8 at about 1 Mbit/s. `pointer.mjs` draws the mouse pointer, which headless Chromium does not show. Each scene saves named moments (*marks*) and the on-screen boxes of the elements it shows to `clips.json`.
- **`src/`**: the Remotion composition. `scenes.ts` sets each scene's speed-ups, captions and camera moves relative to those marks and boxes, so a new capture stays in sync without editing timings. `timeline.ts` holds the timing and camera math. The colors and the Inter font come from `frontend/src/index.css`.
- **`public/higgsfield/`**: four stills generated with Higgsfield (model `z_image`, about 0.6 credits in total). They are the aurora backdrops (16:9, 9:16) and the "two agents" intro image. The prompts are below.

Setup steps run while nothing records. Wallet A names Sybil's contact, as in the live demo. Then it creates its Vault with Tether WDK in the browser. The recovery phrase is generated at run time and read back only to pass the confirm step. It is never recorded or stored. The Vault password is a throwaway string for the in-browser mock. The "outside invoice" is a made-up regtest placeholder.

## Run it

Node 22 or newer. The frontend's lockfile needs npm 11, so with Node 22 (npm 10) use `npx npm@11 ci`.

```bash
# 1. The app, in mock mode (the default)
cd frontend && npx npm@11 ci && npm run dev            # http://localhost:5173

# 2. Captures (about 4 minutes each; the app must be running)
cd video && npm ci
npm run capture -- desktop
npm run capture -- mobile

# 3. Preview and render
npm run studio
npm run render:promo
npm run render
npm run render:vertical
```

If Remotion cannot download its headless Chrome (offline or behind a proxy), point it to a local one with `REMOTION_BROWSER=/path/to/chrome-headless-shell npm run render`.

On a 4-core machine, a 2× desktop screencast drops to about 20 fps, which is why desktop records at 1.5×. Recording is real time, so keep the machine otherwise idle while it runs.

## Higgsfield prompts

- `backdrop-16x9.jpg` and `backdrop-9x16.jpg`: *Minimal abstract background for a premium fintech product video. Near-black deep blue-black base color #08080f. A soft lavender #b9a8f6 aurora glow…, a faint cool blue #6fc8f4 haze…, very subtle film grain. A sparse constellation of tiny glowing nodes linked by hairline lavender lines, like a peer-to-peer network, only near the edges… No text, no letters, no logos, no coins, no people.*
- `agents-16x9.jpg` and `agents-9x16.jpg`: *Cinematic abstract image: two small luminous glass orbs…, one glowing soft lavender #b9a8f6…, one glowing pale blue #a9bdf5…. Between them a thin delicate thread of light…, like two minds reaching an agreement. Each orb sits inside a faint translucent protective sphere. Deep blue-black background #08080f… No text, no letters, no logos, no coins, no people, no hands.*

## Licenses

Remotion is free for individuals and companies of up to three people ([license](https://www.remotion.dev/license)). Inter is under the SIL Open Font License.
