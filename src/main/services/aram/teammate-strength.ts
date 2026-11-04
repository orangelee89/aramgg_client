/**
 * 队友综合评分（牛马检测器）。
 *
 * 算法移植自 WJZ-P/sona 的 src/lib/player-strength-score.ts（AGPL-3.0），
 * 仅保留单人评分部分，输入改为 SGP SUMMARY 的原始 game.json。
 * 展示分范围 3.0 - 16.0，与 Sona / WeGame 风格一致。
 */

type AnyRecord = Record<string, any>

export type StrengthRole = 'TOP' | 'JUNGLE' | 'MIDDLE' | 'BOTTOM' | 'UTILITY' | 'ARAM' | 'SPECIAL' | 'UNKNOWN'

export type StrengthGrade =
  | 'legendary'
  | 'carry'
  | 'strong'
  | 'reliable'
  | 'balanced'
  | 'unstable'
  | 'risky'
  | 'critical'

export interface StrengthBreakdown {
  combat: number
  win: number
  damage: number
  economy: number
  objectives: number
  vision: number
  durability: number
  farming: number
}

export interface GameStrengthScore {
  gameId: number
  championId: number
  win: boolean
  score: number
  kills: number
  deaths: number
  assists: number
  kda: number
}

export interface PlayerStrengthScore {
  score: number
  rawScore: number
  confidence: number
  validGames: number
  grade: StrengthGrade
  lowConfidence: boolean
  breakdown: StrengthBreakdown
  games: GameStrengthScore[]
}

type BreakdownKey = keyof StrengthBreakdown
type ScoreWeights = Record<BreakdownKey, number>

const INTERNAL_NEUTRAL_SCORE = 50
const DISPLAY_MIN_SCORE = 3.0
const DISPLAY_MAX_SCORE = 16.0
const DISPLAY_CONTRAST = 1.22
const DISPLAY_NEUTRAL_SCORE = toDisplayScore(INTERNAL_NEUTRAL_SCORE)

const OPTIONS = {
  recencyHalfLife: 18,
  minConfidenceGames: 3,
  fullConfidenceGames: 16,
  trimOutliers: true,
  skipEarlySurrender: true,
  skipAfkTeammate: true,
}

const BASE_WEIGHTS: ScoreWeights = {
  combat: 0.26,
  win: 0.12,
  damage: 0.18,
  economy: 0.11,
  objectives: 0.1,
  vision: 0.08,
  durability: 0.09,
  farming: 0.06,
}

export function calculatePlayerStrengthScore(games: AnyRecord[], puuid: string): PlayerStrengthScore | null {
  const scored = games
    .map((game) => calculateGameScore(game, puuid))
    .filter((entry): entry is { summary: GameStrengthScore; breakdown: StrengthBreakdown } => entry !== null)

  if (scored.length === 0) {
    return null
  }

  const rawSamples = scored.map((entry) => entry.summary.score)
  const samples = OPTIONS.trimOutliers ? winsorizeScores(rawSamples) : rawSamples
  const weights = scored.map((_, index) => Math.pow(0.5, index / Math.max(OPTIONS.recencyHalfLife, 1)))
  const rawScore = weightedAverage(samples, weights)
  const consistencyScore = samples.length <= 1
    ? INTERNAL_NEUTRAL_SCORE
    : clamp(100 - standardDeviation(samples) * 14, 0, 100)
  const trendScore = samples.length < 8
    ? INTERNAL_NEUTRAL_SCORE
    : clamp(INTERNAL_NEUTRAL_SCORE + (average(samples.slice(0, 5)) - average(samples.slice(5))) * 6.5, 0, 100)
  const confidenceRange = Math.max(OPTIONS.fullConfidenceGames - OPTIONS.minConfidenceGames, 1)
  const confidence = 0.35 + clamp((scored.length - OPTIONS.minConfidenceGames) / confidenceRange, 0, 1) * 0.65

  const consistencyAdjustment = clamp((consistencyScore - 50) * 0.012, -0.6, 0.6)
  const trendAdjustment = clamp((trendScore - 50) * 0.01, -0.5, 0.5)
  const confidenceScale = 0.57 + confidence * 0.43
  const score = clamp(
    DISPLAY_NEUTRAL_SCORE + (rawScore - DISPLAY_NEUTRAL_SCORE) * confidenceScale + consistencyAdjustment + trendAdjustment,
    DISPLAY_MIN_SCORE,
    DISPLAY_MAX_SCORE,
  )

  const breakdown = (Object.keys(BASE_WEIGHTS) as BreakdownKey[]).reduce((result, key) => {
    result[key] = weightedAverage(scored.map((entry) => entry.breakdown[key]), weights)
    return result
  }, {} as StrengthBreakdown)

  return {
    score,
    rawScore,
    confidence,
    validGames: scored.length,
    grade: getStrengthGrade(score),
    lowConfidence: confidence < 0.55,
    breakdown,
    games: scored.map((entry) => entry.summary),
  }
}

export function getStrengthGrade(score: number): StrengthGrade {
  if (score >= 15.0) return 'legendary'
  if (score >= 13.5) return 'carry'
  if (score >= 12.0) return 'strong'
  if (score >= 10.8) return 'reliable'
  if (score >= 9.5) return 'balanced'
  if (score >= 8.0) return 'unstable'
  if (score >= 6.3) return 'risky'
  return 'critical'
}

/** 早退局、有挂机队友的局数据不完整，不参与统计。 */
export function shouldSkipGameForPlayer(game: AnyRecord, puuid: string): boolean {
  const participant = findParticipant(game, puuid)
  return !participant || shouldSkipGame(game, participant)
}

function findParticipant(game: AnyRecord, puuid: string): AnyRecord | null {
  const participants = Array.isArray(game?.participants) ? game.participants : []
  return participants.find((item: AnyRecord) => item?.puuid === puuid) || null
}

function shouldSkipGame(game: AnyRecord, participant: AnyRecord): boolean {
  if (OPTIONS.skipEarlySurrender && (participant.gameEndedInEarlySurrender || participant.teamEarlySurrendered)) {
    return true
  }
  if (!OPTIONS.skipAfkTeammate) return false
  if (challengeFlag(participant, 'hadAfkTeammate')) return true
  return (game.participants as AnyRecord[]).some((item) =>
    item.teamId === participant.teamId && item.puuid !== participant.puuid && challengeFlag(item, 'hadAfkTeammate'))
}

function calculateGameScore(
  game: AnyRecord,
  puuid: string,
): { summary: GameStrengthScore; breakdown: StrengthBreakdown } | null {
  const participant = findParticipant(game, puuid)
  if (!participant || shouldSkipGame(game, participant)) {
    return null
  }

  const team = (game.participants as AnyRecord[]).filter((item) => item.teamId === participant.teamId)
  if (team.length === 0) return null

  const role = inferRole(game, participant)
  const minutes = Math.max((num(participant.timePlayed) || num(game.gameDuration) || 1) / 60, 1)
  const teamKills = sum(team, (item) => item.kills)
  const teamDamage = sum(team, (item) => item.totalDamageDealtToChampions)
  const teamGold = sum(team, (item) => item.goldEarned)
  const teamObjectiveDamage = sum(team, (item) => item.damageDealtToObjectives)
  const teamDamageTaken = sum(team, (item) => item.totalDamageTaken)

  const kills = num(participant.kills)
  const deaths = num(participant.deaths)
  const assists = num(participant.assists)
  const kda = challenge(participant, 'kda') || (kills + assists) / Math.max(deaths, 1)
  const killParticipation = clamp(challenge(participant, 'killParticipation') || safeDivide(kills + assists, teamKills), 0, 1)
  const damageShare = clamp(
    challenge(participant, 'teamDamagePercentage') || safeDivide(num(participant.totalDamageDealtToChampions), teamDamage),
    0,
    1,
  )
  const goldShare = clamp(safeDivide(num(participant.goldEarned), teamGold), 0, 1)
  const damageTakenShare = clamp(
    challenge(participant, 'damageTakenOnTeamPercentage') || safeDivide(num(participant.totalDamageTaken), teamDamageTaken),
    0,
    1,
  )
  const csPerMinute = safeDivide(num(participant.totalMinionsKilled) + num(participant.neutralMinionsKilled), minutes)
  const visionPerMinute = challenge(participant, 'visionScorePerMinute') || safeDivide(num(participant.visionScore), minutes)

  const breakdown: StrengthBreakdown = {
    combat: combatScore(kda, killParticipation, deaths, minutes),
    win: participant.win ? 100 : 18,
    damage: damageScore(role, participant, minutes, damageShare),
    economy: economyScore(role, participant, minutes, damageShare, goldShare),
    objectives: objectiveScore(role, participant, minutes, teamObjectiveDamage),
    vision: visionScore(role, participant, minutes, visionPerMinute),
    durability: durabilityScore(role, participant, minutes, damageTakenShare),
    farming: farmingScore(role, csPerMinute),
  }

  const weighted = clamp(
    (Object.keys(BASE_WEIGHTS) as BreakdownKey[]).reduce((total, key) => total + breakdown[key] * BASE_WEIGHTS[key], 0),
    0,
    100,
  )

  return {
    breakdown,
    summary: {
      gameId: num(game.gameId),
      championId: num(participant.championId),
      win: Boolean(participant.win),
      score: toDisplayScore(weighted),
      kills,
      deaths,
      assists,
      kda,
    },
  }
}

function inferRole(game: AnyRecord, participant: AnyRecord): StrengthRole {
  const mode = String(game.gameMode || '')
  if (mode === 'ARAM') return 'ARAM'
  if (mode === 'CHERRY' || mode === 'STRAWBERRY') return 'SPECIAL'
  const position = String(participant.teamPosition || participant.individualPosition || participant.lane || '').toUpperCase()
  if (position === 'TOP') return 'TOP'
  if (position === 'JUNGLE') return 'JUNGLE'
  if (position === 'MIDDLE' || position === 'MID') return 'MIDDLE'
  if (position === 'BOTTOM' || position === 'BOT') return 'BOTTOM'
  if (position === 'UTILITY' || position === 'SUPPORT') return 'UTILITY'
  return 'UNKNOWN'
}

function roleTarget<T>(role: StrengthRole, targets: Record<StrengthRole, T>): T {
  return targets[role] ?? targets.UNKNOWN
}

function combatScore(kda: number, killParticipation: number, deaths: number, minutes: number): number {
  const kdaScore = scoreRange(Math.log1p(kda), Math.log1p(1.1), Math.log1p(6.2))
  const participationScore = scoreRange(killParticipation, 0.32, 0.72)
  const deathSafetyScore = 1 - scoreRange(safeDivide(deaths, minutes), 0.18, 0.72)
  return toPercent(kdaScore * 0.38 + participationScore * 0.42 + deathSafetyScore * 0.2)
}

function damageScore(role: StrengthRole, participant: AnyRecord, minutes: number, damageShare: number): number {
  const excellentShare = role === 'UTILITY' ? 0.2 : role === 'ARAM' ? 0.26 : 0.29
  const shareScore = scoreRange(damageShare, role === 'UTILITY' ? 0.06 : 0.1, excellentShare)
  const damagePerMinute = challenge(participant, 'damagePerMinute') || safeDivide(num(participant.totalDamageDealtToChampions), minutes)
  const target = roleTarget(role, { TOP: 650, JUNGLE: 560, MIDDLE: 730, BOTTOM: 760, UTILITY: 360, ARAM: 950, SPECIAL: 720, UNKNOWN: 620 })
  return toPercent(shareScore * 0.68 + scoreRange(damagePerMinute, target * 0.42, target) * 0.32)
}

function economyScore(role: StrengthRole, participant: AnyRecord, minutes: number, damageShare: number, goldShare: number): number {
  const goldPerMinute = challenge(participant, 'goldPerMinute') || safeDivide(num(participant.goldEarned), minutes)
  const target = roleTarget(role, { TOP: 420, JUNGLE: 390, MIDDLE: 430, BOTTOM: 455, UTILITY: 285, ARAM: 470, SPECIAL: 430, UNKNOWN: 395 })
  const gpmScore = scoreRange(goldPerMinute, target * 0.58, target)
  const efficiency = goldShare > 0 ? damageShare / goldShare : 0
  const efficiencyScore = scoreRange(efficiency, 0.55, role === 'UTILITY' ? 1.05 : 1.28)
  return toPercent(efficiencyScore * 0.56 + gpmScore * 0.44)
}

function objectiveScore(role: StrengthRole, participant: AnyRecord, minutes: number, teamObjectiveDamage: number): number {
  const objectiveDamage = num(participant.damageDealtToObjectives)
  const share = safeDivide(objectiveDamage, teamObjectiveDamage)
  const perMinute = safeDivide(objectiveDamage, minutes)
  const epic = challenge(participant, 'dragonTakedowns') + challenge(participant, 'baronTakedowns')
  const turrets = challenge(participant, 'turretTakedowns') || num(participant.turretTakedowns)
  const target = role === 'JUNGLE' ? 360 : role === 'BOTTOM' ? 290 : 230
  return toPercent(
    scoreRange(perMinute, 20, target) * 0.38 +
    scoreRange(share, 0.08, role === 'JUNGLE' ? 0.45 : 0.32) * 0.32 +
    scoreRange(epic * 0.9 + turrets * 0.45, 0, 2.2) * 0.3,
  )
}

function visionScore(role: StrengthRole, participant: AnyRecord, minutes: number, visionPerMinute: number): number {
  const target = roleTarget(role, { TOP: 0.75, JUNGLE: 0.95, MIDDLE: 0.75, BOTTOM: 0.65, UTILITY: 1.65, ARAM: 0.28, SPECIAL: 0.25, UNKNOWN: 0.75 })
  const wardWork = safeDivide(
    num(participant.wardsPlaced) +
      num(participant.wardsKilled) +
      num(participant.detectorWardsPlaced) * 1.5 +
      challenge(participant, 'wardTakedowns') * 0.6 +
      challenge(participant, 'wardsGuarded') * 0.4,
    minutes,
  )
  return toPercent(
    scoreRange(visionPerMinute, target * 0.28, target) * 0.72 +
    scoreRange(wardWork, 0.05, role === 'UTILITY' ? 0.75 : 0.35) * 0.28,
  )
}

function durabilityScore(role: StrengthRole, participant: AnyRecord, minutes: number, damageTakenShare: number): number {
  const survival = 1 - scoreRange(safeDivide(num(participant.deaths), minutes), 0.16, 0.7)
  const pressure = scoreRange(damageTakenShare, 0.08, role === 'TOP' || role === 'UTILITY' ? 0.32 : 0.24)
  const utilityPerMinute = safeDivide(
    num(participant.damageSelfMitigated) +
      num(participant.totalHeal) * 0.35 +
      num(participant.totalHealsOnTeammates) * 0.8 +
      num(participant.totalDamageShieldedOnTeammates),
    minutes,
  )
  const utilityTarget = role === 'UTILITY' || role === 'TOP' ? 820 : 560
  return toPercent(survival * 0.46 + pressure * 0.32 + scoreRange(utilityPerMinute, utilityTarget * 0.18, utilityTarget) * 0.22)
}

function farmingScore(role: StrengthRole, csPerMinute: number): number {
  const target = roleTarget(role, { TOP: 7.2, JUNGLE: 5.8, MIDDLE: 7.4, BOTTOM: 7.8, UTILITY: 1.3, ARAM: 4.2, SPECIAL: 4.5, UNKNOWN: 6.2 })
  return toPercent(scoreRange(csPerMinute, target * 0.35, target))
}

function winsorizeScores(scores: number[]): number[] {
  if (scores.length < 8) return scores
  const sorted = [...scores].sort((a, b) => a - b)
  const low = percentile(sorted, 0.05)
  const high = percentile(sorted, 0.95)
  return scores.map((score) => clamp(score, low, high))
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = p * (sorted.length - 1)
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)
}

function standardDeviation(values: number[]): number {
  if (values.length === 0) return 0
  const avg = average(values)
  return Math.sqrt(average(values.map((value) => (value - avg) ** 2)))
}

function weightedAverage(values: number[], weights: number[]): number {
  const totalWeight = weights.reduce((total, value) => total + value, 0)
  if (values.length === 0 || totalWeight <= 0) return 0
  return values.reduce((total, value, index) => total + value * (weights[index] ?? 1), 0) / totalWeight
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length
}

function sum(values: AnyRecord[], mapper: (value: AnyRecord) => unknown): number {
  return values.reduce((total, value) => total + num(mapper(value)), 0)
}

function num(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function challenge(participant: AnyRecord, key: string): number {
  const value = participant?.challenges?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function challengeFlag(participant: AnyRecord, key: string): boolean {
  const value = participant?.challenges?.[key]
  return value === true || (typeof value === 'number' && value > 0)
}

function scoreRange(value: number, zeroAt: number, fullAt: number): number {
  if (fullAt === zeroAt) return value >= fullAt ? 1 : 0
  return clamp((value - zeroAt) / (fullAt - zeroAt), 0, 1)
}

function safeDivide(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0
}

function toPercent(value: number): number {
  return clamp(value * 100, 0, 100)
}

function toDisplayScore(internalScore: number): number {
  const normalized = clamp(internalScore, 0, 100) / 100
  const contrasted = clamp(0.5 + (normalized - 0.5) * DISPLAY_CONTRAST, 0, 1)
  return DISPLAY_MIN_SCORE + contrasted * (DISPLAY_MAX_SCORE - DISPLAY_MIN_SCORE)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
