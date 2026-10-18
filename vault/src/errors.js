// An error the HTTP layer returns as-is: status plus the {code, message} body the backend also uses.
// `message` is shown to the user, so it is plain English for a non-technical reader.
export class VaultError extends Error {
  constructor (status, code, message) {
    super(message)
    this.name = 'VaultError'
    this.status = status
    this.code = code
  }
}

export const invalidRequest = (message) => new VaultError(400, 'invalid_request', message)
