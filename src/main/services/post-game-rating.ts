/**
 * 赛后"马"称号。在各自队伍内部评选，一个人可以同时拿多项，名字按固定顺序拼接，最后加"马"：
 *
 * - 领头（leader）：MVP 综合评分队内最高。输出、KDA、参团、承伤、团队治疗护盾、控制六项按队内最大值归一化后加权；
 *   对面有治疗/护盾型英雄时，出了重伤/破盾装备的人按乘法加成（每件 +6%，上限 +12%），
 *   乘法保证基础分低的人靠出装拿不到领头。
 * - 悍（top）：输出最高；陀螺（tank）：承伤最多；K头（kills）：人头最多；仁慈（assists）：助攻最多；
 *   血泵（heal）：总治疗量（含自己）最高；胶黏（control）：对敌方控制时长最长；板（deaths）：死亡最多。
 * - 一项都不沾的是"普通马"。并列最高时都算。
 */

export type HorseHonor = 'leader' | 'top' | 'tank' | 'kills' | 'assists' | 'heal' | 'control' | 'deaths'

export type RatingStatBlock = {
  kills?: number | null
  deaths?: number | null
  assists?: number | null
  damageDealtToChampions?: number | null
  damageTaken?: number | null
  damageSelfMitigated?: number | null
  timeCCingOthers?: number | null
  healsOnTeammates?: number | null
  shieldsOnTeammates?: number | null
  totalHeal?: number | null
}

export type RatingPlayerInput = {
  key: string
  team?: string
  championId?: number | null
  items?: Array<number | string> | null
  stats?: RatingStatBlock | null
}

export type HorseRating = {
  key: string
  team: string
  /** 拿到的殊荣，按拼名顺序排列；空数组表示普通马。 */
  honors: HorseHonor[]
  /** 每个殊荣对应的数值（领头为综合评分，其余为该项数值）。 */
  honorValues: Partial<Record<HorseHonor, number>>
  /** MVP 综合评分（0～10）。 */
  score: number
  /** 评分里包含的针对性出装加成（0 表示没有）。 */
  itemBonus: number
  /** 各维度归一化后的分项（0～1）。 */
  breakdown: Record<MvpMetric, number>
  playerCount: number
}

export type MvpMetric = 'damage' | 'kda' | 'killParticipation' | 'tank' | 'support' | 'control'

export const MVP_WEIGHTS: Record<MvpMetric, number> = {
  damage: 0.3,
  kda: 0.2,
  killParticipation: 0.1,
  tank: 0.15,
  support: 0.15,
  control: 0.1,
}

// 减伤按一半计入承伤：它反映坦克真正"扛"下来的伤害，但原始数值通常比承伤本身大得多。
const SELF_MITIGATED_WEIGHT = 0.5
/** 每件对症装备的乘法加成与上限。 */
export const COUNTER_ITEM_BONUS = 0.06
export const COUNTER_ITEM_BONUS_CAP = 0.12

/** 重伤装备：凡性的提醒、死刑宣告、莫雷洛秘典、湮灭宝珠、荆棘之甲、棘刺背心、炼金科技纯化器 */
export const ANTI_HEAL_ITEM_IDS = new Set([3033, 3123, 3165, 3916, 3075, 3076, 3011])
/** 破盾装备：巨蛇之牙 */
export const ANTI_SHIELD_ITEM_IDS = new Set([6695])

/** 治疗量大的英雄（对面有这些时重伤装备才算对症）。 */
export const HEALING_CHAMPION_IDS = new Set([
  16, // 索拉卡
  350, // 悠米
  266, // 亚托克斯
  8, // 弗拉基米尔
  50, // 斯维因
  36, // 蒙多医生
  517, // 塞拉斯
  267, // 娜美
  37, // 娑娜
  19, // 沃里克
  9, // 费德提克
  141, // 凯隐
  233, // 贝蕾亚
  420, // 俄洛伊
  57, // 茂凯
  154, // 扎克
  75, // 内瑟斯
  58, // 雷克顿
  2, // 奥拉夫
  48, // 特朗德尔
  902, // 米利欧
  147, // 萨勒芬妮
  10, // 凯尔
  86, // 盖伦
  240, // 克烈
  114, // 菲奥娜
  92, // 锐雯
  27, // 辛吉德
  33, // 拉莫斯
  106, // 沃利贝尔
])

/** 护盾量大的英雄（对面有这些时巨蛇之牙才算对症）。 */
export const SHIELDING_CHAMPION_IDS = new Set([
  117, // 璐璐
  43, // 卡尔玛
  40, // 迦娜
  25, // 莫甘娜
  412, // 锤石
  223, // 塔姆
  15, // 希维尔
  111, // 诺提勒斯
  61, // 奥莉安娜
  44, // 塔里克
  147, // 萨勒芬妮
  902, // 米利欧
  888, // 烈娜塔
  427, // 艾翁
  164, // 卡蜜尔
  54, // 墨菲特
  14, // 赛恩
  82, // 莫德凯撒
  526, // 芮尔
  131, // 黛安娜
  201, // 布隆
  350, // 悠米
  267, // 娜米
  84, // 阿卡丽
  53, // 布里茨
  145, // 卡莎
  777, // 永恩
  157, // 亚索
  245, // 艾克
])

const HONOR_STATS: Array<{ honor: Exclude<HorseHonor, 'leader'>; stat: keyof RatingStatBlock }> = [
  { honor: 'top', stat: 'damageDealtToChampions' },
  { honor: 'tank', stat: 'damageTaken' },
  { honor: 'kills', stat: 'kills' },
  { honor: 'assists', stat: 'assists' },
  { honor: 'heal', stat: 'totalHeal' },
  { honor: 'control', stat: 'timeCCingOthers' },
  { honor: 'deaths', stat: 'deaths' },
]

/** KDA：优先用 EOG 给的 kda 字段，没有就按 (K+A)/max(1,D) 算。 */
function readKda(stats: Partial<RatingStatBlock> | null | undefined): number {
  const given = toNumber(stats?.kda)
  if (given > 0) {
    return given
  }
  return (toNumber(stats?.kills) + toNumber(stats?.assists)) / Math.max(1, toNumber(stats?.deaths))
}

function toNumber(value: unknown): number {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : 0
}

function toItemIds(items: RatingPlayerInput['items']): number[] {
  return (items || [])
    .map((item) => Number(item))
    .filter((id) => Number.isInteger(id) && id > 0)
}

export function hasRatingEvidence(stats: RatingStatBlock | null | undefined): boolean {
  return toNumber(stats?.damageDealtToChampions) > 0 ||
    toNumber(stats?.damageTaken) > 0 ||
    toNumber(stats?.kills) > 0 ||
    toNumber(stats?.assists) > 0 ||
    toNumber(stats?.deaths) > 0
}

function readRawMetrics(stats: RatingStatBlock | null | undefined, teamKills: number): Record<MvpMetric, number> {
  const kills = toNumber(stats?.kills)
  const deaths = toNumber(stats?.deaths)
  const assists = toNumber(stats?.assists)
  return {
    damage: toNumber(stats?.damageDealtToChampions),
    kda: (kills + assists) / Math.max(1, deaths),
    killParticipation: teamKills > 0 ? (kills + assists) / teamKills : 0,
    tank: toNumber(stats?.damageTaken) + SELF_MITIGATED_WEIGHT * toNumber(stats?.damageSelfMitigated),
    support: toNumber(stats?.healsOnTeammates) + toNumber(stats?.shieldsOnTeammates),
    control: toNumber(stats?.timeCCingOthers),
  }
}

/**
 * 针对性出装加成：只有对面确实有治疗/护盾型英雄，且自己出了对应装备时才计入。
 */
export function computeCounterItemBonus(
  items: RatingPlayerInput['items'],
  enemyChampionIds: Array<number | null | undefined>
): number {
  const itemIds = toItemIds(items)
  const enemies = enemyChampionIds.filter((id): id is number => Number.isInteger(id) && (id as number) > 0)
  const enemyHeals = enemies.some((id) => HEALING_CHAMPION_IDS.has(id))
  const enemyShields = enemies.some((id) => SHIELDING_CHAMPION_IDS.has(id))

  let bonus = 0
  if (enemyHeals && itemIds.some((id) => ANTI_HEAL_ITEM_IDS.has(id))) {
    bonus += COUNTER_ITEM_BONUS
  }
  if (enemyShields && itemIds.some((id) => ANTI_SHIELD_ITEM_IDS.has(id))) {
    bonus += COUNTER_ITEM_BONUS
  }
  return Math.min(COUNTER_ITEM_BONUS_CAP, bonus)
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

  const teams = new Map<string, RatingPlayerInput[]>()
  valid.forEach((player) => {
    const team = String(player.team || '')
    const bucket = teams.get(team) || []
    bucket.push(player)
    teams.set(team, bucket)
  })

  teams.forEach((members, team) => {
    const enemyChampionIds = valid
      .filter((player) => String(player.team || '') !== team)
      .map((player) => player.championId ?? null)
    const teamKills = members.reduce((total, player) => total + toNumber(player.stats?.kills), 0)
    const rawMetrics = members.map((player) => readRawMetrics(player.stats, teamKills))
    const metricKeys = Object.keys(MVP_WEIGHTS) as MvpMetric[]
    const maxByMetric = Object.fromEntries(
      metricKeys.map((metric) => [metric, Math.max(0, ...rawMetrics.map((metrics) => metrics[metric]))])
    ) as Record<MvpMetric, number>
    // 全队都是 0 的维度不参与，权重按比例摊给其余维度。
    const activeWeightTotal = metricKeys.reduce(
      (total, metric) => total + (maxByMetric[metric] > 0 ? MVP_WEIGHTS[metric] : 0),
      0
    )

    const scored = members.map((player, index) => {
      const breakdown = Object.fromEntries(
        metricKeys.map((metric) => [
          metric,
          maxByMetric[metric] > 0 ? rawMetrics[index][metric] / maxByMetric[metric] : 0,
        ])
      ) as Record<MvpMetric, number>
      const base = activeWeightTotal > 0
        ? metricKeys.reduce((total, metric) => total + MVP_WEIGHTS[metric] * breakdown[metric], 0) / activeWeightTotal
        : 0
      const itemBonus = computeCounterItemBonus(player.items, enemyChampionIds)
      const score = Number((base * (1 + itemBonus) * 10).toFixed(2))
      return { player, breakdown, itemBonus, score }
    })

    scored.forEach(({ player, breakdown, itemBonus, score }) => {
      ratings.set(player.key, {
        key: player.key,
        team,
        honors: [],
        honorValues: {},
        score,
        itemBonus,
        breakdown,
        playerCount: valid.length,
      })
    })

    const bestScore = Math.max(...scored.map((entry) => entry.score))
    if (bestScore > 0) {
      scored.forEach(({ player, score }) => {
        if (score === bestScore) {
          const rating = ratings.get(player.key)!
          rating.honors.push('leader')
          rating.honorValues.leader = score
        }
      })
    }

    for (const { honor, stat } of HONOR_STATS) {
      const best = Math.max(0, ...members.map((player) => toNumber(player.stats?.[stat])))
      if (best <= 0) {
        continue
      }
      let winners = members.filter((player) => toNumber(player.stats?.[stat]) === best)
      // 外马（死亡最多）：死亡数并列时，只给 KDA 更低的那个
      if (honor === 'deaths' && winners.length > 1) {
        const lowestKda = Math.min(...winners.map((player) => readKda(player.stats)))
        winners = winners.filter((player) => readKda(player.stats) === lowestKda)
      }
      winners.forEach((player) => {
        const rating = ratings.get(player.key)!
        rating.honors.push(honor)
        rating.honorValues[honor] = best
      })
    }
  })

  return ratings
}
