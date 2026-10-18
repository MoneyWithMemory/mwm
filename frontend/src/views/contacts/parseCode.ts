const REGTEST_ADDRESS = /^bcrt1[0-9a-z]{20,90}$/i

/**
 * Pulls a regtest address out of what the user pasted or a QR code decoded: a bare address
 * or a payment URI such as "bitcoin:bcrt1q...?label=x". Returns null if there is none.
 */
export function parseContactCode(raw: string): string | null {
  const text = raw.trim()
  const withoutScheme = text.replace(/^[a-z][a-z0-9+.-]*:/i, '')
  const address = withoutScheme.split(/[?#\s]/)[0].replace(/^\/+/, '')
  return REGTEST_ADDRESS.test(address) ? address : null
}
