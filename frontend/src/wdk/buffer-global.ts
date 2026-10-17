// bip39 (inside Tether WDK) calls Buffer.from to generate a seed; browsers have no
// Buffer, so this must be imported before WDK.
import { Buffer } from 'buffer'

if (!('Buffer' in globalThis)) Object.assign(globalThis, { Buffer })
