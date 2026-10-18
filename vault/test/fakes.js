// Test doubles: an in-memory stand-in for @utexo/wdk-wallet-rgb with the same account surface, so the real
// WDK policy engine and the HTTP layer run without regtest. Records every call that reaches the "wallet".
export const USDT_ID = 'rgb:Gu4Fx3l~-d_Ifrcd-WJ~mENC-5_jr0Hu-C9mu1bm-dTKTTsk'
export const PEPE_ID = 'rgb:PEPEpepe-PEPEpepe-PEPEpepe-PEPEpepe-PEPEpepe-PEPEpepe'
export const OTHER_ID = 'rgb:OTHERoth-OTHERoth-OTHERoth-OTHERoth-OTHERoth-OTHERoth'

// A real regtest invoice (from a test wallet) asking for 40 of USDT_ID: decodes offline with rgb-lib.
export const USDT_40_INVOICE = 'rgb:Gu4Fx3l~-d_Ifrcd-WJ~mENC-5_jr0Hu-C9mu1bm-dTKTTsk/RWhwUfTMpuP2Zfx1~j4nswCANGeJrYOqDcKelaMV4zU/fa/' +
  'bcrt:utxob:VTsde3_7-x_JrG1N-0aElbTJ-q9z4o7L-HkGZKbO-ToWYLnM-IKSno?assignment_name=assetOwner&endpoints=rpc://127.0.0.1:3000/json-rpc'

// A wallet's first invoice for an asset names no asset: this one asks for 100 of any asset.
export const ANY_100_INVOICE = 'rgb:~/~/BF/bcrt:utxob:h5XZgjAL-_5j8DmW-S0lutQ7-1K1rMgh-gd6yapO-uNGYjsn-1a2u7' +
  '?assignment_name=assetOwner&expiry=1792283694&endpoints=rpc://127.0.0.1:3000/json-rpc'

export const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

const balance = (spendable) => ({ settled: spendable, future: spendable, spendable })

export function makeFakeWallet ({ btcSats = 1_000_000 } = {}) {
  const calls = []
  const assets = [
    { assetId: USDT_ID, ticker: 'USDT', balance: balance(1_000_000) },
    { assetId: PEPE_ID, ticker: 'PEPE', balance: balance(5_000_000) },
    { assetId: OTHER_ID, ticker: 'OTHER', balance: balance(1000) }
  ]
  const record = (method, ...args) => calls.push({ method, args })

  class FakeAccount {
    get path () { return "m/86'/1'/0'" }
    get keyPair () { return { publicKey: new Uint8Array(33), privateKey: new Uint8Array(32) } }
    getAddress () { return 'bcrt1pfakevaultaddress' }
    async getBalance () { return BigInt(btcSats) }
    toReadOnlyAccount () { return { getAddress: () => 'bcrt1pfakevaultaddress' } }
    listAssets () { record('listAssets'); return { nia: assets.map((asset) => ({ ...asset, balance: { ...asset.balance } })) } }
    listUnspents () {
      record('listUnspents')
      return [{ utxo: { colorable: true, exists: true }, rgbAllocations: [], pendingBlinded: 0 }]
    }

    listTransfers () { record('listTransfers'); return [] }
    receiveAsset (options) {
      record('receiveAsset', options)
      return { invoice: 'rgb:~/~/BF/bcrt:utxob:fake', recipientId: 'bcrt:utxob:fake' }
    }

    refreshWallet () { record('refreshWallet') }
    async createUtxos (options) { record('createUtxos', options); return 5 }
    async transfer (options) { record('transfer', options); return { hash: 'f'.repeat(64), fee: 155n } }
    async sendTransaction (tx) { record('sendTransaction', tx); return { hash: 'b'.repeat(64), fee: 1n } }
    async sign (message) { record('sign', message); return 'signature' }
    async signPsbt (psbt) { record('signPsbt', psbt); return psbt }
    sendBegin (options) { record('sendBegin', options); return 'psbt' }
    sendEnd (options) { record('sendEnd', options); return { txid: 'e'.repeat(64) } }
    getRgbWallet () { record('getRgbWallet'); return {} }
    issueAssetNia (options) { record('issueAssetNia', options); return {} }
    dispose () { record('dispose') }
  }

  class FakeWalletManager {
    constructor (seed, config) {
      this.seed = seed
      this.config = config
      this.account = null
    }

    async getAccount () {
      this.account ??= new FakeAccount()
      return this.account
    }

    dispose () {
      this.account?.dispose()
      this.account = null
    }
  }

  return { FakeWalletManager, calls, assets, called: (method) => calls.filter((call) => call.method === method) }
}

export const silentLog = { info () {}, warn () {}, error () {} }
