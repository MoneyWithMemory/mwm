// Remotion CLI settings (`npx remotion render`). See README.md for the full pipeline.
import { Config } from '@remotion/cli/config'

Config.setEntryPoint('src/index.ts')
Config.setVideoImageFormat('jpeg')
Config.setJpegQuality(95)
Config.setCodec('h264')
// UI text and thin lines: a low CRF keeps them crisp.
Config.setCrf(16)
Config.setPixelFormat('yuv420p')
// Use a local Chromium when Remotion cannot download its own (offline or proxied machines).
if (process.env.REMOTION_BROWSER) Config.setBrowserExecutable(process.env.REMOTION_BROWSER)
