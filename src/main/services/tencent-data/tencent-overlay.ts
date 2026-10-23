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
  // 来自自建镜像时记录镜像版本号与镜像抓取时间；直连掌盟时为空。
  mirrorHash?: string
  sourceFetchedAt?: string
  statDate: string
  augments: TencentAugmentMeta[]
  augmentStats: TencentAugmentStat[]
  championStats: TencentChampionStat[]
  // 镜像下发的英雄 / 装备展示名（马服 zh_MY 译名）；直连掌盟时没有。
  localizedNames?: { champions: Record<string, string>; items: Record<string, string> }
  // 镜像同步时记录的正式服补丁号（如 16.21），只用于界面显示。
  gamePatch?: string
}

export type TencentChampionSnapshot = {
  fetchedAt: string
  mirrorHash?: string
  sourceFetchedAt?: string
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
    aliasNames: meta.aliasNames || [],
    description: meta.description,
    tooltip: meta.tooltip,
    statsAvailable: false,
    stats: null,
    stages: [],
    topChampions: [],
  }
}

// 展示名以镜像（马服译名）为准；被替换下来的旧名并入 aliasNames，OCR 仍能用它们匹配。
function withMetaName(augment: any, meta: TencentAugmentMeta | undefined): any {
  if (!meta || !augment) {
    return augment
  }

  const aliases = [...(meta.aliasNames || []), ...(Array.isArray(augment.aliasNames) ? augment.aliasNames : []), augment.name]
    .map((name) => String(name || '').trim())
    .filter((name, index, list) => name && name !== meta.name && list.indexOf(name) === index)
  return { ...augment, name: meta.name, aliasNames: aliases }
}

function localizedName(map: Record<string, string> | undefined, id: unknown): string | null {
  const name = map?.[String(id ?? '')]
  return typeof name === 'string' && name.trim() ? name.trim() : null
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
    list.push(applyStats(withMetaName(augment, metaById.get(id)), id))
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

function withChampionName(champion: any, snapshot: TencentGlobalSnapshot): any {
  const name = localizedName(snapshot.localizedNames?.champions, champion?.id ?? champion?.championId)
  return name ? { ...champion, name } : champion
}

export function overlayChampionsPayload(payload: any, snapshot: TencentGlobalSnapshot | null): any {
  if (!snapshot) {
    return payload
  }

  const statById = new Map(snapshot.championStats.map((stat) => [stat.championId, stat]))
  const total = snapshot.championStats.length
  const list = getList(payload).map((champion: any) => {
    const named = withChampionName(champion, snapshot)
    const stat = statById.get(String(champion?.id ?? champion?.championId ?? ''))
    return stat ? { ...named, stats: championStats(champion, stat, total, snapshot) } : named
  })

  return cloneWithList(payload, list)
}

export function overlayItemsPayload(payload: any, snapshot: TencentGlobalSnapshot | null): any {
  const names = snapshot?.localizedNames?.items
  if (!names || Object.keys(names).length === 0) {
    return payload
  }

  const list = getList(payload).map((item: any) => {
    const name = localizedName(names, item?.id)
    return name ? { ...item, name } : item
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
    const named = withChampionName(detail.champion, snapshot)
    const stat = snapshot.championStats.find((entry) => entry.championId === championId)
    result.champion = stat
      ? { ...named, stats: championStats(detail.champion, stat, snapshot.championStats.length, snapshot) }
      : named
  }

  const metaById = new Map((snapshot?.augments || []).map((meta) => [meta.id, meta]))
  if (Array.isArray(detail.augments) && metaById.size > 0) {
    result.augments = detail.augments.map((augment: any) => withMetaName(augment, metaById.get(String(augment?.id ?? ''))))
  }

  const ranked = championSnapshot?.augments || []
  if (ranked.length > 0) {
    const existingById = new Map<string, any>(
      (Array.isArray(result.augments) ? result.augments : [])
        .filter((augment: any) => augment?.id != null)
        .map((augment: any) => [String(augment.id), augment])
    )
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

    // 掌盟推荐列表里没有、但 aramgg 有单英雄胜率的海克斯也要保留，排在掌盟列表之后。
    const rankedIds = new Set(ranked.map((entry) => entry.augmentId))
    const leftovers = [...existingById.entries()]
      .filter(([id, augment]) => !rankedIds.has(id) && augment?.stats?.winRateSource && augment.stats.winRate != null)
    // 排序要求每条都有 rank，补回来的条目接在掌盟名次之后，total 统一为合并后的条数。
    const mergedTotal = augments.length + leftovers.length
    result.augments = [
      ...augments.map((augment) => ({ ...augment, stats: { ...augment.stats, total: mergedTotal } })),
      ...leftovers.map(([, augment], index) => ({
        ...augment,
        stats: { ...augment.stats, rank: augments.length + index + 1, total: mergedTotal },
      })),
    ]
  }

  return result
}

