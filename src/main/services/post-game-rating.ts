/**
 * 赛后"马力"评分：把承伤、输出、控制时长、对队友的治疗+护盾四项分别按本局最大值归一化后加权，
 * 每队马力最高的是"上等马"，最低的是"下等马"，其余"中等马"。
 *
 * 归一化到本局最大值而不是直接比原始数值，是为了让坦克（承伤高）、辅助（治疗护盾高）
 * 和输出位（伤害高）在各自擅长的维度都能拿到满分，不会被单一维度的绝对值压过。
 */

export type HorseTier = 'top' | 'mid' | 'bottom'

export type RatingStatBlock = {
  damageDealtToChampions?: number | null
  damageTaken?: number | null
  damageSelfMitigated?: number | null
  timeCCingOthers?: number | null
  healsOnTeammates?: number | null
  shieldsOnTeammates?: number | null
}

export type RatingPlayerInput = {
  key: string
  team?: string
  stats?: RatingStatBlock | null
}

export type HorseRating = {
  key: string
  team: string
  score: number
  rank: number
  teamSize: number
  tier: HorseTier
  breakdown: {
    damage: number
    tank: number
    control: number
    support: number
  }
}

export const HORSE_RATING_WEIGHTS = {
  damage: 0.35,
  tank: 0.25,
  control: 0.2,
  support: 0.2,
} as const

// 减伤按一半计入承伤：它反映坦克真正"扛"下来的伤害，但原始数值通常比承伤本身大得多。
const SELF_MITIGATED_WEIGHT = 0.5

function toNumber(value: unknown): number {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : 0
}

function readMetrics(stats: RatingStatBlock | null | undefined) {
  return {
    damage: toNumber(stats?.damageDealtToChampions),
    tank: toNumber(stats?.damageTaken) + SELF_MITIGATED_WEIGHT * toNumber(stats?.damageSelfMitigated),
    control: toNumber(stats?.timeCCingOthers),
    support: toNumber(stats?.healsOnTeammates) + toNumber(stats?.shieldsOnTeammates),
  }
}

export function hasRatingEvidence(stats: RatingStatBlock | null | undefined): boolean {
  const metrics = readMetrics(stats)
  return metrics.damage > 0 || metrics.tank > 0
}

/**
 * 计算一局里所有玩家的马力。少于两个有效玩家时返回空 Map。
 * 名次和上下马都在各自队伍内部决定；没有队伍信息的玩家归到同一组。
 */
export function computeHorseRatings(players: RatingPlayerInput[]): Map<string, HorseRating> {
  const ratings = new Map<string, HorseRating>()
  const valid = players.filter((player) => player?.key && hasRatingEvidence(player.stats))
  if (valid.length < 2) {
    return ratings
  }

  const metricList = valid.map((player) => readMetrics(player.stats))
  const max = {
    damage: Math.max(...metricList.map((metrics) => metrics.damage)),
    tank: Math.max(...metricList.map((metrics) => metrics.tank)),
    control: Math.max(...metricList.map((metrics) => metrics.control)),
    support: Math.max(...metricList.map((metrics) => metrics.support)),
  }
  const normalize = (value: number, ceiling: number) => (ceiling > 0 ? value / ceiling : 0)

  const scored = valid.map((player, index) => {
    const metrics = metricList[index]
    const breakdown = {
      damage: normalize(metrics.damage, max.damage),
      tank: normalize(metrics.tank, max.tank),
      control: normalize(metrics.control, max.control),
      support: normalize(metrics.support, max.support),
    }
    const score =
      HORSE_RATING_WEIGHTS.damage * breakdown.damage +
      HORSE_RATING_WEIGHTS.tank * breakdown.tank +
      HORSE_RATING_WEIGHTS.control * breakdown.control +
      HORSE_RATING_WEIGHTS.support * breakdown.support

    return {
      key: player.key,
      team: String(player.team || ''),
      score: Number((score * 10).toFixed(2)),
      breakdown,
    }
  })

  const byTeam = new Map<string, typeof scored>()
  scored.forEach((entry) => {
    const bucket = byTeam.get(entry.team) || []
    bucket.push(entry)
    byTeam.set(entry.team, bucket)
  })

  byTeam.forEach((bucket) => {
    const ordered = [...bucket].sort((left, right) => right.score - left.score || left.key.localeCompare(right.key))
    ordered.forEach((entry, index) => {
      let tier: HorseTier = 'mid'
      if (ordered.length >= 2 && index === 0) {
        tier = 'top'
      } else if (ordered.length >= 2 && index === ordered.length - 1) {
        tier = 'bottom'
      }

      ratings.set(entry.key, {
        key: entry.key,
        team: entry.team,
        score: entry.score,
        rank: index + 1,
        teamSize: ordered.length,
        tier,
        breakdown: entry.breakdown,
      })
    })
  })

  return ratings
}
