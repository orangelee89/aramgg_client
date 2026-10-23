// 腾讯官方攻略站（101.qq.com）海克斯大乱斗接口的返回格式都是「JSON 里套一层 JSON 字符串」，
// 字段再用 # _ | & 等分隔符拼接。这里只做纯解析，不发请求，便于单测覆盖格式变化。

export type TencentRarity = 'kSilver' | 'kGold' | 'kPrismatic'

export type TencentAugmentMeta = {
  id: string
  name: string
  rarity: TencentRarity | null
  iconUrl: string | null
  description: string | null
  tooltip: string | null
  isNew: boolean
  // 镜像把 name 换成了马服（zh_MY）译名，原国服名放在这里，只给 OCR 当别名。
  aliasNames: string[]
}

export type TencentAugmentStat = {
  id: string
  pickRate: number
  pickRank: number
  winRate: number
  winRank: number
}

export type TencentChampionStat = {
  championId: string
  rank: number
  winRate: number
  pickRate: number
}

export type TencentChampionAugment = {
  augmentId: string
  rank: number
  pickRate: number
  grade: string
}

const RARITIES = new Set<string>(['kSilver', 'kGold', 'kPrismatic'])

function toFinite(value: unknown): number | null {
  if (value == null || value === '') {
    return null
  }

  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function toPositiveInt(value: unknown): number | null {
  const number = toFinite(value)
  return number != null && Number.isInteger(number) && number > 0 ? number : null
}

function isRate(value: number | null): value is number {
  return value != null && value >= 0 && value <= 1
}

export function unwrapOdpPayload(payload: any): Record<string, any> | null {
  const fieldValues = payload?.data?._fieldValues
  if (!fieldValues || typeof fieldValues !== 'object') {
    return null
  }

  for (const value of Object.values(fieldValues)) {
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value)
        if (parsed && typeof parsed === 'object') {
          return parsed
        }
      } catch {
        continue
      }
    } else if (value && typeof value === 'object') {
      return value as Record<string, any>
    }
  }

  return null
}

export function parseKiwiAugments(payload: any): TencentAugmentMeta[] {
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.augments) ? payload.augments : []
  const result: TencentAugmentMeta[] = []

  for (const record of list) {
    const id = toPositiveInt(record?.augmentID ?? record?.id)
    const name = String(record?.name_cn ?? record?.name ?? '').trim()
    if (!id || !name) {
      continue
    }

    const mode = String(record?.mode ?? '')
    if (mode && !/\bKIWI\b/.test(mode)) {
      continue
    }

    if (Number(record?.isPBE) === 1) {
      continue
    }

    const rarity = String(record?.level ?? '')
    const iconUrl = String(record?.large_Icon ?? record?.small_Icon ?? '').trim()
    result.push({
      id: String(id),
      name,
      rarity: RARITIES.has(rarity) ? (rarity as TencentRarity) : null,
      iconUrl: /^https:\/\//i.test(iconUrl) ? iconUrl : null,
      description: typeof record?.desc === 'string' ? record.desc : null,
      tooltip: typeof record?.tooltip === 'string' ? record.tooltip : null,
      isNew: Number(record?.isNew) === 1,
      aliasNames: [String(record?.name_cn_tencent ?? '').trim()].filter((alias) => alias && alias !== name),
    })
  }

  return result
}

// augmentlist 每条：id_品质_选取率_选取排名_选取排名变化_胜率_胜率排名_胜率排名变化_热门英雄
export function parseAugmentRank(inner: Record<string, any> | null): TencentAugmentStat[] {
  const text = typeof inner?.augmentlist === 'string' ? inner.augmentlist : ''
  const result: TencentAugmentStat[] = []

  for (const chunk of text.split('#')) {
    const fields = chunk.split('_')
    const id = toPositiveInt(fields[0])
    const pickRate = toFinite(fields[2])
    const pickRank = toPositiveInt(fields[3])
    const winRate = toFinite(fields[5])
    const winRank = toPositiveInt(fields[6])
    if (!id || !isRate(pickRate) || !isRate(winRate) || !pickRank || !winRank) {
      continue
    }

    result.push({ id: String(id), pickRate, pickRank, winRate, winRank })
  }

  return result
}

// listcollect 每条：英雄id_排名_排名变化描述_胜率_选取率_搭档..._其他平均值
export function parseHeroRank(inner: Record<string, any> | null): TencentChampionStat[] {
  const text = typeof inner?.listcollect === 'string' ? inner.listcollect : ''
  const result: TencentChampionStat[] = []

  for (const chunk of text.split('#')) {
    const fields = chunk.split('_')
    const championId = toPositiveInt(fields[0])
    const rank = toPositiveInt(fields[1])
    const winRate = toFinite(fields[3])
    const pickRate = toFinite(fields[4])
    if (!championId || !rank || !isRate(winRate) || !isRate(pickRate)) {
      continue
    }

    result.push({ championId: String(championId), rank, winRate, pickRate })
  }

  return result
}

// augment_json_irank 形如 "255:排名|英雄id|海克斯id|品质|选取率|等级#...&kGold:..."，255 段是不分品质的总榜
export function parseChampionAugments(inner: Record<string, any> | null): TencentChampionAugment[] {
  const text = String(inner?.augment_json_irank || inner?.augment_json || '').trim()
  if (!text) {
    return []
  }

  const segments = text.split('&').filter(Boolean).map((segment) => {
    const index = segment.indexOf(':')
    return {
      key: index > -1 ? segment.slice(0, index).trim() : '255',
      body: index > -1 ? segment.slice(index + 1) : segment,
    }
  })
  const overall = segments.filter((segment) => segment.key === '255')
  const source = overall.length > 0 ? overall : segments

  const byId = new Map<string, TencentChampionAugment>()
  for (const segment of source) {
    for (const chunk of segment.body.split('#')) {
      const fields = chunk.split('|')
      const rank = toPositiveInt(fields[0])
      const augmentId = toPositiveInt(fields[2])
      const pickRate = toFinite(fields[4])
      if (!rank || !augmentId || !isRate(pickRate)) {
        continue
      }

      const id = String(augmentId)
      const existing = byId.get(id)
      if (existing && existing.pickRate >= pickRate) {
        continue
      }

      byId.set(id, {
        augmentId: id,
        rank,
        pickRate,
        grade: String(fields[5] || (rank <= 2 ? 'S' : rank <= 5 ? 'A' : 'B')).trim(),
      })
    }
  }

  const list = [...byId.values()]
  if (overall.length === 0) {
    list.sort((left, right) => right.pickRate - left.pickRate)
    list.forEach((entry, index) => {
      entry.rank = index + 1
    })
  }

  return list.sort((left, right) => left.rank - right.rank)
}

// 与腾讯攻略站一致：前 4% 为 T0、15% 为 T1、30% 为 T2、40% 为 T3，其余 T4；
// 客户端 tier 约定 1 最强，所以 T0..T4 映射为 1..5。
export function rankToTier(rank: number, total: number): number | null {
  if (!rank || rank <= 0 || !total || total <= 0) {
    return null
  }

  const t0 = Math.max(1, Math.round(total * 0.04))
  const t1 = Math.max(t0, Math.round(total * 0.15))
  const t2 = Math.max(t1, Math.round(total * 0.3))
  const t3 = Math.max(t2, Math.round(total * 0.4))
  if (rank <= t0) return 1
  if (rank <= t1) return 2
  if (rank <= t2) return 3
  if (rank <= t3) return 4
  return 5
}

export function gradeToTier(grade: string): number | null {
  switch (String(grade || '').trim().toUpperCase()) {
    case 'S':
      return 1
    case 'A':
      return 2
    case 'B':
      return 3
    case 'C':
      return 4
    case 'D':
      return 5
    default:
      return null
  }
}
