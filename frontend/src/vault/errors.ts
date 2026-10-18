import { ApiError, ERROR_CODES } from '@/api/client'
import { FOREIGN_INVOICE_MESSAGE } from '@/vault/policy'
import { MIN_PASSWORD_LENGTH, VAULT_ERROR_CODES as CODES } from '@/vault/types'

const UNREACHABLE = "The Vault isn't reachable right now. Try again in a moment."

/** Said when the server sends a code without a message. */
const FALLBACK: Record<string, string> = {
  [CODES.exists]: 'This wallet already has a Vault.',
  [CODES.invalidMnemonic]: 'Tether WDK did not accept this recovery phrase.',
  [CODES.missing]: 'You have no Vault yet. Create it first.',
  [CODES.locked]: 'The Vault is locked. Unlock it and try again.',
  [CODES.insufficientFunds]: 'Not enough balance for this move.',
  [CODES.invalidInvoice]: 'That is not an RGB invoice.',
  [CODES.policyDenied]: FOREIGN_INVOICE_MESSAGE,
}

/**
 * What the UI says when a Vault call or a move fails, in words a non-technical user understands.
 * The backend and the Vault already write their messages for people (a policy refusal reads
 * "Vault policy: …"), so their sentence is shown as is; the UI only words what has no sentence
 * (a network failure, a proxy with nothing behind it) or belongs to one field (the password).
 */
export function vaultErrorText(error: ApiError): string {
  switch (error.code) {
    case CODES.wrongPassword:
      return 'Wrong password.'
    case CODES.weakPassword:
      return `Use at least ${MIN_PASSWORD_LENGTH} characters.`
    case CODES.unavailable:
    case ERROR_CODES.network:
      return UNREACHABLE
    case ERROR_CODES.timeout:
      return 'Bitcoin regtest is slow right now. Check your balances in a minute.'
  }
  // No {code, message} body: the proxy answered, because the Vault service is not running,
  // or because it serves the Vault only to this computer (vite.config.ts).
  if (error.code.startsWith('http_5')) return UNREACHABLE
  if (error.code === 'http_404') return 'Your Vault opens only on the computer that holds it.'
  return error.message || FALLBACK[error.code] || 'Something went wrong. Try again.'
}

/** The same sentence from the code alone: for create, where nothing the server says about the phrase may surface. */
export function vaultCodeText(error: ApiError): string {
  return vaultErrorText(new ApiError(error.code, '', error.status))
}

export function isPolicyDenied(error: ApiError | null): boolean {
  return error?.code === CODES.policyDenied
}

/** The Vault cannot tell which asset an invoice wants (its wallet never held one): the user picks it. */
export function asksForAsset(error: ApiError | null): boolean {
  return (error?.code === CODES.invalidInvoice || error?.code === 'invalid_request') && /which asset/i.test(error.message)
}
