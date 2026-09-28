/**
 * 赛后"马"称号：按单项之最在全场十人里发殊荣，一个人可以同时拿多项，
 * 名字按固定顺序拼接：上等（输出最高）→ 陀螺（承伤最多）→ K头（人头最多）
 * → 仁慈（助攻最多）→ 死（死亡最多），最后加"马"；例如输出最高又死得最多就是"上等死马"。
 * 一项都不沾的是"普通马"。并列最高时都算。
 */

export type HorseHonor = 'top' | 'tank' | 'kills' | 'assists' | 'deaths'

export type RatingStatBlock = {
  kills?: number | null
  deaths?: number | null
  assists?: number | null
  damageDealtToChampions?: number | null
  damageTaken?: number | null
}

export type RatingPlayerInput = {
  key: string
  team?: string
  stats?: RatingStatBlock | null
}

export type HorseRating = {
  key: string
  team: string
  /** 拿到的殊荣，按拼名顺序排列；空数组表示普通马。 */
  honors: HorseHonor[]
  /** 每个殊荣对应的全场最高数值。 */
  honorValues: Partial<Record<HorseHonor, number>>
  playerCount: number
}

export const HORSE_HONOR_ORDER: Array<{ honor: HorseHonor; stat: keyof RatingStatBlock }> = [
  { honor: 'top', stat: 'damageDealtToChampions' },
  { honor: 'tank', stat: 'damageTaken' },
  { honor: 'kills', stat: 'kills' },
  { honor: 'assists', stat: 'assists' },
  { honor: 'deaths', stat: 'deaths' },
]

function toNumber(value: unknown): number | null {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : null
}

export function hasRatingEvidence(stats: RatingStatBlock | null | undefined): boolean {
  return HORSE_HONOR_ORDER.some(({ stat }) => (toNumber(stats?.[stat]) ?? 0) > 0)
}

/**
 * 计算全场每个玩家的称号。少于两个有效玩家时返回空 Map。
 */
export function computeHorseRatings(players: RatingPlayerInput[]): Map<string, HorseRating> {
  const ratings = new Map<string, HorseRating>()
  const valid = players.filter((player) => player?.key && hasRatingEvidence(player.stats))
  if (valid.length < 2) {
    return ratings
  }

  valid.forEach((player) => {
    ratings.set(player.key, {
      key: player.key,
      team: String(player.team || ''),
      honors: [],
      honorValues: {},
      playerCount: valid.length,
    })
  })

  for (const { honor, stat } of HORSE_HONOR_ORDER) {
    let best = 0
    valid.forEach((player) => {
      best = Math.max(best, toNumber(player.stats?.[stat]) ?? 0)
    })
    if (best <= 0) {
      continue
    }

    valid.forEach((player) => {
      if ((toNumber(player.stats?.[stat]) ?? 0) !== best) {
        return
      }
      const rating = ratings.get(player.key)
      if (!rating) {
        return
      }
      rating.honors.push(honor)
      rating.honorValues[honor] = best
    })
  }

  return ratings
}
