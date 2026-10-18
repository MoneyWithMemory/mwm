// Runs tasks one at a time, in call order. One per Vault, so RGB operations on a wallet never overlap.
export class Mutex {
  #tail = Promise.resolve()

  run (task) {
    const result = this.#tail.then(task)
    this.#tail = result.catch(() => {})
    return result
  }
}
