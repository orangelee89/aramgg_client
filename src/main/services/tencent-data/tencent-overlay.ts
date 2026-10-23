import {
  gradeToTier,
  rankToTier,
  type TencentAugmentMeta,
  type TencentAugmentStat,
  type TencentChampionAugment,
  type TencentChampionStat,
  type TencentRarity,
} from './tencent-parsers.ts'

export type TencentGlobalSnapshot = {
  fetchedAt: string
  statDate: string
  augments: TencentAugmentMeta[]
  augmentStats: TencentAugmentStat[]
  championStats: TencentChampionStat[]
}

export type TencentChampionSnapshot = {
  fetchedAt: string
  championId: string
  augments: TencentChampionAugment[]
}

const RARITY_FIELDS: Record<TencentRarity, { rarity: number; rarityName: string; rarityDisplayName: string }> = {
  kSilver: { rarity: 0, rarityName: 'silver', rarityDisplayName: '白银' },
  kGold: { rarity: 1, rarityName: 'gold', rarityDisplayName: '黄金' },
  kPrismatic: { rarity: 2, rarityName: 'prismatic', rarityDisplayName: '棱彩' },
}

function cloneWithList(payload: any, list: any[]): any {
  if (Array.isArray(payload)) {
    return list
  }

  if (payload && typeof payload === 'object' && Array.isArray(payload.data)) {
    return { ...payload, data: list, total: list.length }
  }

  return { ...(payload || {}), data: list, total: list.length }
}

function getList(payload: any): any[] {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.data)) return payload.data
  return []
}

function tencentStatFields(snapshot: TencentGlobalSnapshot) {
  return {
    source: 'tencent',
    region: 'CN',
    date: snapshot.statDate || snapshot.fetchedAt.slice(0, 10),
  }
}

function buildAugmentFromMeta(meta: TencentAugmentMeta): any {
  const rarity = meta.rarity ? RARITY_FIELDS[meta.rarity] : null
  return {
    id: Number(meta.id),
    name: meta.name,
    rarity: rarity?.rarity ?? null,
    rarityName: rarity?.rarityName ?? null,
    rarityDisplayName: rarity?.rarityDisplayName ?? null,
    iconUrl: meta.iconUrl,
    key: null,
    enabled: true,
    description: meta.description,
    tooltip: meta.tooltip,
    statsAvailable: false,
    stats: null,
    stages: [],
    topChampions: [],
  }
}

export function overlayAugmentsPayload(payload: any, snapshot: TencentGlobalSnapshot | null): any {
  if (!snapshot) {
    return payload
  }

  const metaById = new Map(snapshot.augments.map((meta) => [meta.id, meta]))
  const statById = new Map(snapshot.augmentStats.map((stat) => [stat.id, stat]))
  const total = snapshot.augmentStats.length
  const seen = new Set<string>()
  const list: any[] = []

  const applyStats = (augment: any, id: string): any => {
    const stat = statById.get(id)
    if (!stat) {
      return augment
    }

    return {
      ...augment,
      statsAvailable: true,
      stats: {
        ...(augment.stats || {}),
        tier: rankToTier(stat.winRank, total),
        wins: null,
        games: null,
        winRate: stat.winRate,
        pickRate: stat.pickRate,
        rank: stat.winRank,
        total,
        ...tencentStatFields(snapshot),
      },
    }
  }

  for (const augment of getList(payload)) {
    const id = String(augment?.id ?? '')
    if (!id) {
      continue
    }

    seen.add(id)
    list.push(applyStats(augment, id))
  }

  for (const meta of metaById.values()) {
    if (seen.has(meta.id)) {
      continue
    }

    if (!statById.has(meta.id) && !meta.isNew) {
      continue
    }

    seen.add(meta.id)
    list.push(applyStats(buildAugmentFromMeta(meta), meta.id))
  }

  return cloneWithList(payload, list)
}

function championStats(champion: any, stat: TencentChampionStat, total: number, snapshot: TencentGlobalSnapshot): any {
  return {
    ...(champion?.stats || {}),
    tier: rankToTier(stat.rank, total),
    wins: null,
    games: null,
    winRate: stat.winRate,
    pickRate: stat.pickRate,
    rank: stat.rank,
    total,
    ...tencentStatFields(snapshot),
  }
}

export function overlayChampionsPayload(payload: any, snapshot: TencentGlobalSnapshot | null): any {
  if (!snapshot || snapshot.championStats.length === 0) {
    return payload
  }

  const statById = new Map(snapshot.championStats.map((stat) => [stat.championId, stat]))
  const total = snapshot.championStats.length
  const list = getList(payload).map((champion: any) => {
    const stat = statById.get(String(champion?.id ?? champion?.championId ?? ''))
    return stat ? { ...champion, stats: championStats(champion, stat, total, snapshot) } : champion
  })

  return cloneWithList(payload, list)
}

export function overlayChampionDetail(
  detail: any,
  snapshot: TencentGlobalSnapshot | null,
  championSnapshot: TencentChampionSnapshot | null
): any {
  if (!detail || typeof detail !== 'object' || (!snapshot && !championSnapshot)) {
    return detail
  }

  const result = { ...detail }
  const championId = String(detail.championId ?? detail.champion?.id ?? '')

  if (snapshot && detail.champion) {
    const stat = snapshot.championStats.find((entry) => entry.championId === championId)
    if (stat) {
      result.champion = {
        ...detail.champion,
        stats: championStats(detail.champion, stat, snapshot.championStats.length, snapshot),
      }
    }
  }

  const ranked = championSnapshot?.augments || []
  if (ranked.length > 0) {
    const existingById = new Map<string, any>(
      (Array.isArray(detail.augments) ? detail.augments : [])
        .filter((augment: any) => augment?.id != null)
        .map((augment: any) => [String(augment.id), augment])
    )
    const metaById = new Map((snapshot?.augments || []).map((meta) => [meta.id, meta]))
    const total = ranked.length
    const date = championSnapshot?.fetchedAt.slice(0, 10) || ''

    const augments = ranked.map((entry) => {
      const existing = existingById.get(entry.augmentId)
      const meta = metaById.get(entry.augmentId)
      const base = existing || (meta ? buildAugmentFromMeta(meta) : { id: Number(entry.augmentId) })
      const previous = existing?.stats || {}
      const keepWinRate = previous.winRateSource && previous.winRate != null

      return {
        ...base,
        stats: {
          ...previous,
          tier: gradeToTier(entry.grade) ?? rankToTier(entry.rank, total),
          wins: keepWinRate ? previous.wins ?? null : null,
          games: keepWinRate ? previous.games ?? null : null,
          winRate: keepWinRate ? previous.winRate : null,
          pickRate: entry.pickRate,
          rank: entry.rank,
          total,
          source: 'tencent',
          region: 'CN',
          date,
        },
      }
    })

    result.augments = augments
  }

  return result
}

