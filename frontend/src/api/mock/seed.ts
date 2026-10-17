import type {
  ActivityItem,
  AgentProfile,
  AssetId,
  AssetRef,
  HistoryPoint,
  TrustAudit,
  WalletId,
  WalletSummary,
} from '../types'

/** Demo economy (proposed by the backend, pending final confirmation). Change here only. */
export const ECONOMY = {
  lotAmount: 1_000_000, // PEPE units offered by Wallet B
  askUsd: 150, // public asking price
  reserveUsd: 110, // seller's secret floor
  ceilingUsd: 135, // buyer's secret ceiling
  targetUsd: 120, // buyer's target
  networkFeeSat: 2_000,
  satsPerUsd: 1_000, // fixed simulated rate: BTC = $100k
} as const

export const ASSETS = {
  btc: { asset_id: 'btc', ticker: 'BTC', schema: 'BTC', precision: 8 },
  // precision 0 like the backend's regtest issuance: payment_amount == agreed_price_usd
  usdt: { asset_id: 'rgb:Cfkujjki-8sTiGTJG-BTF2fAXN-tFdj8Cts-Mop7hkME-sN4Ztyww', ticker: 'USDT', schema: 'NIA', precision: 0 },
  pepe: { asset_id: 'rgb:NEiuTRxB-hW8rMMvx-TxQ3AXAx-w3X5oSzg-QHPi6h9p-VEPnPatt', ticker: 'PEPE', schema: 'NIA', precision: 0 },
} as const satisfies Record<string, AssetRef>

export const ASSET_LIST: AssetRef[] = [ASSETS.btc, ASSETS.usdt, ASSETS.pepe]

export const ADDRESSES = {
  a: 'bcrt1q7mvxknxj3qj7m74saylyasug8fuv3fffecejxy',
  b: 'bcrt1qlnpzv8e53eerx8g7jl27zzfk5jw4q6nk8fdzuf',
  sybil: 'bcrt1qmh5hngad7rxlryeysgh2axxrfwswratthzcx4c',
  /** External address with no validated history (cold start). */
  newcomer: 'bcrt1q88zjdd99fcucelza8delz78jt89j4kscdp5cva',
  faucet: 'bcrt1qj4rm9lxm99jlcufp0qf594tzgd80fd08hye6dx',
  /** Sybil's ring partner. */
  ringPeer: 'bcrt1q9xukdg3atm67fzlajzpxgrrpttsvl70ympjawc',
  exchange: 'bcrt1qexchan9e7desk834k92jjd82kdls83hdjsk82',
  otc: 'bcrt1qotc8partn9er382kdls93ksjdl92kdls83h992',
  merchant: 'bcrt1qpaym3nt8gatew4y82ksdl93ksjd82kdls8288',
  miningPool: 'bcrt1qmin1ngp00l8strat2kdls82kdls83kdls8277',
} as const

const TRUST: Record<string, TrustAudit> = {
  [ADDRESSES.a]: {
    trusted: true,
    sybil_ring_detected: false,
    reliability_pct: 88,
    trust_tier: 'High Authenticity',
    assessment_summary: 'Organic activity with independent counterparties over the past month.',
  },
  [ADDRESSES.b]: {
    trusted: true,
    sybil_ring_detected: false,
    reliability_pct: 92,
    trust_tier: 'High Authenticity',
    assessment_summary: 'Settled swaps with many unrelated counterparties and no circular flows.',
  },
  [ADDRESSES.sybil]: {
    trusted: false,
    sybil_ring_detected: true,
    reliability_pct: 14,
    trust_tier: 'Ring Anomaly Detected',
    assessment_summary: 'Volume stays inside a closed cluster of related wallets trading with each other.',
  },
  [ADDRESSES.ringPeer]: {
    trusted: false,
    sybil_ring_detected: true,
    reliability_pct: 9,
    trust_tier: 'Ring Anomaly Detected',
    assessment_summary: 'Part of the same closed cluster; its history is mostly bursts with a few related wallets.',
  },
}

const UNVERIFIED: TrustAudit = {
  trusted: false,
  sybil_ring_detected: false,
  reliability_pct: null,
  trust_tier: 'Unverified',
  assessment_summary: 'Not enough validated volume yet to assess this address.',
}

export function trustFor(address: string): TrustAudit {
  return TRUST[address] ?? UNVERIFIED
}

/** Value in USD of a balance map; assets without a price count as 0. */
export function totalUsd(balances: Record<AssetId, number>, pepePriceUsd: number | null): number {
  const btc = (balances[ASSETS.btc.asset_id] ?? 0) / ECONOMY.satsPerUsd
  const usdt = (balances[ASSETS.usdt.asset_id] ?? 0) / 10 ** ASSETS.usdt.precision
  const pepe = pepePriceUsd === null ? 0 : ((balances[ASSETS.pepe.asset_id] ?? 0) / 10 ** ASSETS.pepe.precision) * pepePriceUsd
  return Math.round((btc + usdt + pepe) * 100) / 100
}

export interface MockWallet {
  summary: WalletSummary
  balances: Record<AssetId, number>
  avg_cost_basis: Record<AssetId, number | null>
  history_points: HistoryPoint[]
  activity: ActivityItem[]
  local_aliases: Record<string, string>
  agent_profile: AgentProfile
}

const DAY = 86_400

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

type SeedEvent = {
  day: number
  kind: ActivityItem['kind']
  direction?: ActivityItem['direction']
  asset: AssetRef
  amount: number
  counterparty?: string | null
  from?: string | null
  status?: ActivityItem['status']
}

function buildActivity(events: SeedEvent[], now: number): ActivityItem[] {
  return events
    .map((e, i) => {
      const direction = e.direction ?? 'in'
      const status = e.status ?? 'confirmed'
      const counterparty = e.counterparty ?? e.from ?? null
      return {
        id: `seed-${i}-${randomHex(4)}`,
        t: now - e.day * DAY,
        kind: e.kind,
        direction,
        asset: e.asset,
        amount: e.amount,
        counterparty_address: counterparty,
        txid: randomHex(32),
        session_id: null,
        status,
      }
    })
    .sort((x, y) => y.t - x.t)
}

/** One point per day for the last 35 days (5 weekly buckets), replaying the activity. */
function buildHistory(activity: ActivityItem[], now: number): HistoryPoint[] {
  const points: HistoryPoint[] = []
  for (let day = 34; day >= 0; day--) {
    const t = now - day * DAY
    const balances: Record<AssetId, number> = {}
    for (const item of activity) {
      if (item.t > t) continue
      const sign = item.direction === 'in' ? 1 : -1
      balances[item.asset.asset_id] = (balances[item.asset.asset_id] ?? 0) + sign * item.amount
    }
    points.push({ t, balances, total_usd: totalUsd(balances, null) })
  }
  return points
}

function balancesOf(activity: ActivityItem[]): Record<AssetId, number> {
  const balances: Record<AssetId, number> = {}
  for (const item of activity) {
    const sign = item.direction === 'in' ? 1 : -1
    balances[item.asset.asset_id] = (balances[item.asset.asset_id] ?? 0) + sign * item.amount
  }
  return balances
}

const usdt = (value: number) => value * 10 ** ASSETS.usdt.precision

const BUYER_DEFAULTS = {
  buyer_max_ceiling_usd: ECONOMY.ceilingUsd,
  buyer_target_usd: ECONOMY.targetUsd,
  buyer_ai_prompt: '',
}

const DESK_OFF = {
  seller_active: false,
  offered_asset_id: null,
  offered_amount: 0,
  asking_price_usd: 0,
  secret_min_reserve_usd: 0,
  seller_ai_prompt: '',
}

function wallet(
  id: WalletId,
  label: string,
  address: string,
  events: SeedEvent[],
  profile: AgentProfile,
  aliases: Record<string, string>,
  now: number,
): MockWallet {
  const activity = buildActivity(events, now)
  return {
    summary: { wallet_id: id, label, address },
    balances: balancesOf(activity),
    avg_cost_basis: { [ASSETS.usdt.asset_id]: 1 },
    history_points: buildHistory(activity, now),
    activity,
    local_aliases: aliases,
    agent_profile: profile,
  }
}

export function createEmptyWallet(id: WalletId, label: string, address: string, now: number): MockWallet {
  return wallet(id, label, address, [], { ...DESK_OFF, ...BUYER_DEFAULTS }, {}, now)
}

/** Fresh demo state: Wallet A (buyer), Wallet B (PEPE seller desk), Sybil (ring member). */
export function createSeedWallets(now: number): MockWallet[] {
  return [
    wallet(
      'wallet_a',
      'Wallet A',
      ADDRESSES.a,
      [
        // Week 5 (days 34–28)
        { day: 34, kind: 'receive', direction: 'in', asset: ASSETS.btc, amount: 1_000_000, counterparty: ADDRESSES.faucet },
        { day: 34, kind: 'receive', direction: 'in', asset: ASSETS.usdt, amount: usdt(500), counterparty: ADDRESSES.faucet },
        { day: 33, kind: 'receive', direction: 'in', asset: ASSETS.usdt, amount: usdt(400), counterparty: ADDRESSES.exchange },
        { day: 32, kind: 'receive', direction: 'in', asset: ASSETS.usdt, amount: usdt(300), counterparty: ADDRESSES.otc },
        { day: 30, kind: 'swap', direction: 'out', asset: ASSETS.usdt, amount: usdt(150), counterparty: ADDRESSES.merchant },
        { day: 29, kind: 'receive', direction: 'in', asset: ASSETS.btc, amount: 300_000, counterparty: ADDRESSES.miningPool },
        { day: 28, kind: 'swap', direction: 'out', asset: ASSETS.btc, amount: 50_000, counterparty: ADDRESSES.exchange },

        // Week 4 (days 27–21)
        { day: 27, kind: 'receive', direction: 'in', asset: ASSETS.usdt, amount: usdt(350), counterparty: ADDRESSES.exchange },
        { day: 26, kind: 'swap', direction: 'out', asset: ASSETS.usdt, amount: usdt(200), counterparty: ADDRESSES.merchant },
        { day: 24, kind: 'receive', direction: 'in', asset: ASSETS.usdt, amount: usdt(250), counterparty: ADDRESSES.otc },
        { day: 23, kind: 'swap', direction: 'out', asset: ASSETS.usdt, amount: usdt(100), counterparty: ADDRESSES.newcomer },
        { day: 22, kind: 'receive', direction: 'in', asset: ASSETS.btc, amount: 200_000, counterparty: ADDRESSES.faucet },
        { day: 21, kind: 'swap', direction: 'out', asset: ASSETS.btc, amount: 30_000, counterparty: ADDRESSES.exchange },

        // Week 3 (days 20–14)
        { day: 19, kind: 'receive', direction: 'in', asset: ASSETS.usdt, amount: usdt(400), counterparty: ADDRESSES.exchange },
        { day: 18, kind: 'swap', direction: 'out', asset: ASSETS.usdt, amount: usdt(180), counterparty: ADDRESSES.merchant },
        { day: 16, kind: 'receive', direction: 'in', asset: ASSETS.usdt, amount: usdt(300), counterparty: ADDRESSES.faucet },
        { day: 15, kind: 'swap', direction: 'out', asset: ASSETS.usdt, amount: usdt(120), counterparty: ADDRESSES.otc },
        { day: 14, kind: 'receive', direction: 'in', asset: ASSETS.btc, amount: 150_000, counterparty: ADDRESSES.miningPool },

        // Week 2 (days 13–7)
        { day: 12, kind: 'receive', direction: 'in', asset: ASSETS.usdt, amount: usdt(350), counterparty: ADDRESSES.newcomer },
        { day: 11, kind: 'swap', direction: 'out', asset: ASSETS.usdt, amount: usdt(200), counterparty: ADDRESSES.merchant },
        { day: 9, kind: 'receive', direction: 'in', asset: ASSETS.usdt, amount: usdt(280), counterparty: ADDRESSES.exchange },
        { day: 8, kind: 'swap', direction: 'out', asset: ASSETS.btc, amount: 40_000, counterparty: ADDRESSES.exchange },
        { day: 7, kind: 'receive', direction: 'in', asset: ASSETS.usdt, amount: usdt(200), counterparty: ADDRESSES.otc },

        // Week 1 (days 6–0)
        { day: 5, kind: 'swap', direction: 'out', asset: ASSETS.usdt, amount: usdt(150), counterparty: ADDRESSES.merchant },
        { day: 4, kind: 'receive', direction: 'in', asset: ASSETS.btc, amount: 100_000, counterparty: ADDRESSES.faucet },
        { day: 3, kind: 'receive', direction: 'in', asset: ASSETS.usdt, amount: usdt(250), counterparty: ADDRESSES.exchange },
        { day: 2, kind: 'swap', direction: 'out', asset: ASSETS.usdt, amount: usdt(100), counterparty: ADDRESSES.newcomer },
        { day: 1, kind: 'receive', direction: 'in', asset: ASSETS.usdt, amount: usdt(150), counterparty: ADDRESSES.otc, status: 'pending' },
        { day: 0, kind: 'swap', direction: 'out', asset: ASSETS.usdt, amount: usdt(50), counterparty: ADDRESSES.merchant, status: 'pending' },
        { day: 0, kind: 'receive', direction: 'in', asset: ASSETS.btc, amount: 50_000, counterparty: ADDRESSES.faucet, status: 'pending' },
      ],
      { ...DESK_OFF, ...BUYER_DEFAULTS },
      {
        [ADDRESSES.b]: 'PEPE Desk',
        [ADDRESSES.faucet]: 'Regtest faucet',
        [ADDRESSES.exchange]: 'Exchange desk',
        [ADDRESSES.otc]: 'OTC partner',
        [ADDRESSES.merchant]: 'RGB Merchant',
        [ADDRESSES.miningPool]: 'Mining Pool',
      },
      now,
    ),
    wallet(
      'wallet_b',
      'Wallet B',
      ADDRESSES.b,
      [
        // Week 5 (days 34–28)
        { day: 34, kind: 'receive', direction: 'in', asset: ASSETS.btc, amount: 1_000_000, counterparty: ADDRESSES.faucet },
        { day: 34, kind: 'issue', direction: 'in', asset: ASSETS.pepe, amount: 5_000_000, counterparty: null },
        { day: 33, kind: 'receive', direction: 'in', asset: ASSETS.usdt, amount: usdt(100), counterparty: ADDRESSES.exchange },
        { day: 31, kind: 'swap', direction: 'out', asset: ASSETS.pepe, amount: 400_000, counterparty: ADDRESSES.otc },
        { day: 31, kind: 'swap', direction: 'in', asset: ASSETS.usdt, amount: usdt(50), counterparty: ADDRESSES.otc },
        { day: 28, kind: 'receive', direction: 'in', asset: ASSETS.btc, amount: 300_000, counterparty: ADDRESSES.miningPool },

        // Week 4 (days 27–21)
        { day: 26, kind: 'swap', direction: 'out', asset: ASSETS.pepe, amount: 350_000, counterparty: ADDRESSES.exchange },
        { day: 26, kind: 'swap', direction: 'in', asset: ASSETS.usdt, amount: usdt(45), counterparty: ADDRESSES.exchange },
        { day: 22, kind: 'swap', direction: 'out', asset: ASSETS.btc, amount: 30_000, counterparty: ADDRESSES.exchange },

        // Week 3 (days 20–14)
        { day: 20, kind: 'swap', direction: 'out', asset: ASSETS.pepe, amount: 300_000, counterparty: ADDRESSES.merchant },
        { day: 20, kind: 'swap', direction: 'in', asset: ASSETS.usdt, amount: usdt(40), counterparty: ADDRESSES.merchant },
        { day: 16, kind: 'receive', direction: 'in', asset: ASSETS.btc, amount: 200_000, counterparty: ADDRESSES.faucet },
        { day: 14, kind: 'swap', direction: 'out', asset: ASSETS.pepe, amount: 250_000, counterparty: ADDRESSES.otc },
        { day: 14, kind: 'swap', direction: 'in', asset: ASSETS.usdt, amount: usdt(30), counterparty: ADDRESSES.otc },

        // Week 2 (days 13–7)
        { day: 10, kind: 'swap', direction: 'out', asset: ASSETS.btc, amount: 25_000, counterparty: ADDRESSES.exchange },
        { day: 7, kind: 'swap', direction: 'out', asset: ASSETS.pepe, amount: 200_000, counterparty: ADDRESSES.exchange },
        { day: 7, kind: 'swap', direction: 'in', asset: ASSETS.usdt, amount: usdt(25), counterparty: ADDRESSES.exchange },

        // Week 1 (days 6–0)
        { day: 3, kind: 'receive', direction: 'in', asset: ASSETS.btc, amount: 100_000, counterparty: ADDRESSES.miningPool },
        { day: 1, kind: 'swap', direction: 'out', asset: ASSETS.pepe, amount: 100_000, counterparty: ADDRESSES.otc, status: 'pending' },
        { day: 1, kind: 'swap', direction: 'in', asset: ASSETS.usdt, amount: usdt(15), counterparty: ADDRESSES.otc, status: 'pending' },
      ],
      {
        seller_active: true,
        offered_asset_id: ASSETS.pepe.asset_id,
        offered_amount: ECONOMY.lotAmount,
        asking_price_usd: ECONOMY.askUsd,
        secret_min_reserve_usd: ECONOMY.reserveUsd,
        seller_ai_prompt: '',
        ...BUYER_DEFAULTS,
      },
      {
        [ADDRESSES.a]: 'Regular buyer',
        [ADDRESSES.faucet]: 'Regtest faucet',
        [ADDRESSES.exchange]: 'Exchange desk',
        [ADDRESSES.otc]: 'OTC partner',
        [ADDRESSES.merchant]: 'RGB Merchant',
        [ADDRESSES.miningPool]: 'Mining Pool',
      },
      now,
    ),
    wallet(
      'wallet_sybil',
      'Sybil',
      ADDRESSES.sybil,
      [
        { day: 30, kind: 'receive', direction: 'in', asset: ASSETS.btc, amount: 300_000, counterparty: ADDRESSES.faucet },
        { day: 28, kind: 'receive', direction: 'in', asset: ASSETS.usdt, amount: usdt(400), counterparty: ADDRESSES.ringPeer },
        { day: 27, kind: 'receive', direction: 'in', asset: ASSETS.pepe, amount: 600_000, counterparty: ADDRESSES.ringPeer },
        { day: 20, kind: 'swap', direction: 'out', asset: ASSETS.usdt, amount: usdt(150), counterparty: ADDRESSES.ringPeer },
        { day: 14, kind: 'swap', direction: 'out', asset: ASSETS.pepe, amount: 100_000, counterparty: ADDRESSES.ringPeer },
        { day: 7, kind: 'receive', direction: 'in', asset: ASSETS.usdt, amount: usdt(100), counterparty: ADDRESSES.ringPeer },
        { day: 1, kind: 'swap', direction: 'out', asset: ASSETS.usdt, amount: usdt(50), counterparty: ADDRESSES.ringPeer, status: 'pending' },
      ],
      {
        seller_active: true,
        offered_asset_id: ASSETS.pepe.asset_id,
        offered_amount: 500_000,
        asking_price_usd: 90,
        secret_min_reserve_usd: 60,
        seller_ai_prompt: 'Undercut every desk to attract buyers.',
        ...BUYER_DEFAULTS,
      },
      { [ADDRESSES.ringPeer]: 'Fast liquidity desk' },
      now,
    ),
  ]
}

/** Addresses shown in every wallet's contacts besides the other wallets. */
export const EXTERNAL_CONTACTS = [ADDRESSES.newcomer]

/** A public request in the Shop. The target is public; the buyer's maximum budget never is. */
export interface MockWant {
  id: string
  ownerAddress: string
  asset: AssetRef
  amount: number
  targetUsd: number
  note: string | null
  createdAt: number
  closed: boolean
}

/** Open requests that exist before anyone does anything: one external, one from Wallet A. */
export function createSeedWants(now: number): MockWant[] {
  return [
    {
      id: 'want_seed_1',
      ownerAddress: ADDRESSES.newcomer,
      asset: ASSETS.pepe,
      amount: 250_000,
      targetUsd: 55,
      note: 'Looking for a clean lot. Can pay in USDT today.',
      createdAt: now - 5 * 3600,
      closed: false,
    },
    {
      id: 'want_seed_2',
      ownerAddress: ADDRESSES.a,
      asset: ASSETS.pepe,
      amount: 500_000,
      targetUsd: 70,
      note: 'A smaller lot is fine too.',
      createdAt: now - 26 * 3600,
      closed: false,
    },
  ]
}
