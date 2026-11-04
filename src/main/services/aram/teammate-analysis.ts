/**
 * 选人阶段队友战绩分析（牛马检测器）。
 *
 * 流程参考 WJZ-P/sona 的 analyzeTeammates：读取选人会话里的己方 5 人 → 用 SGP 查各自
 * 本模式近期战绩 → 计算胜率 / KDA / 综合评分 → 按队内评分排名给出千里马 ~ 纯牛马。
 * 只读：不发聊天、不改选人状态。名字被隐藏（匿名选人）的玩家不做身份还原，直接标记为匿名。
 */
import axios from 'axios'
import logger from '../../modules/logger.ts'
import type LCUService from '../lcu/lcu-service.ts'
import type { ChampSelectSnapshot } from '../lcu/types.ts'
import { getSgpMatchHistoryOrigin } from '../match-history/sgp-match-history-service.ts'
import { calculatePlayerStrengthScore, shouldSkipGameForPlayer, type StrengthGrade } from './teammate-strength.ts'
import type { TeammateAnalysis, TeammateAnalysisPlayer, TeammateHorseTitle } from '../../../shared/ipc-contract.ts'

type AnyRecord = Record<string, any>

export const DEFAULT_TEAMMATE_FETCH_COUNT = 20
const SGP_TIMEOUT_MS = 12_000
const PUUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HORSE_TITLES: TeammateHorseTitle[] = ['ace', 'high', 'mid', 'low', 'burden']

let cachedKey = ''
let cachedTask: Promise<TeammateAnalysis> | null = null
let cachedPlatformId = ''

export function createEmptyTeammateAnalysis(status: TeammateAnalysis['status'], error: string | null = null): TeammateAnalysis {
  return { status, gameId: null, queueId: null, fetchCount: 0, players: [], error, updatedAt: Date.now() }
}

/** 同一局选人只查一次；换了对局（gameId 变化）或改了查询场数才重新查。 */
export function getTeammateAnalysis(
  service: LCUService,
  snapshot: ChampSelectSnapshot,
  fetchCount = DEFAULT_TEAMMATE_FETCH_COUNT,
): Promise<TeammateAnalysis> {
  const session = snapshot.champSelectSession as AnyRecord | null
  if (!snapshot.isInChampSelect || !session) {
    return Promise.resolve(createEmptyTeammateAnalysis('not-in-champ-select'))
  }

  const gameId = Number(session.gameId) || 0
  const members = Array.isArray(session.myTeam) ? session.myTeam : []
  const key = `${gameId}:${fetchCount}:${members.map((member: AnyRecord) => member.puuid || member.cellId).join(',')}`
  if (cachedTask && key === cachedKey) {
    return cachedTask
  }

  cachedKey = key
  cachedTask = runAnalysis(service, session, fetchCount).catch((error) => {
    logger.warn('[TeammateAnalysis] failed:', error instanceof Error ? error.message : String(error))
    // 失败不缓存，下次刷新重试。
    cachedKey = ''
    cachedTask = null
    return createEmptyTeammateAnalysis('error', error instanceof Error ? error.message : String(error))
  })
  return cachedTask
}

async function runAnalysis(service: LCUService, session: AnyRecord, fetchCount: number): Promise<TeammateAnalysis> {
  const startedAt = Date.now()
  const queueId = Number(session.queueId) || 0
  const platformId = await getPlatformId(service)
  if (!platformId || !getSgpMatchHistoryOrigin(platformId)) {
    return createEmptyTeammateAnalysis('error', `不支持的大区：${platformId || '未知'}`)
  }

  const members: AnyRecord[] = (Array.isArray(session.myTeam) ? session.myTeam : [])
    .filter((member: AnyRecord) => member && Number(member.cellId) >= 0)
    .sort((a: AnyRecord, b: AnyRecord) => Number(a.cellId) - Number(b.cellId))
  const localCellId = Number(session.localPlayerCellId)

  const players = await Promise.all(members.map(async (member, index): Promise<TeammateAnalysisPlayer> => {
    const puuid = typeof member.puuid === 'string' && PUUID_PATTERN.test(member.puuid) ? member.puuid : ''
    const base: TeammateAnalysisPlayer = {
      floor: index + 1,
      cellId: Number(member.cellId),
      puuid,
      gameName: String(member.gameName || ''),
      tagLine: String(member.tagLine || ''),
      championId: Number(member.championId) || 0,
      isSelf: Number(member.cellId) === localCellId,
      status: puuid ? 'empty' : 'hidden',
      games: 0,
      wins: 0,
      winRate: null,
      avgKills: 0,
      avgDeaths: 0,
      avgAssists: 0,
      kda: null,
      score: null,
      grade: null,
      lowConfidence: false,
      title: 'newbie',
      error: null,
    }
    if (!puuid) return base

    try {
      const games = await fetchPlayerGames(service, platformId, puuid, queueId, fetchCount)
      return summarizePlayer(base, games, queueId)
    } catch (error) {
      logger.warn(`[TeammateAnalysis] floor ${index + 1} query failed:`, error instanceof Error ? error.message : String(error))
      return { ...base, status: 'error', error: error instanceof Error ? error.message : String(error) }
    }
  }))

  assignHorseTitles(players)
  logger.info('[TeammateAnalysis] done', {
    queueId,
    fetchCount,
    durationMs: Date.now() - startedAt,
    players: players.map((player) => `${player.floor}:${player.status}:${player.games}:${player.score?.toFixed(1) ?? '-'}:${player.title}`),
  })

  return {
    status: 'ready',
    gameId: Number(session.gameId) || null,
    queueId: queueId || null,
    fetchCount,
    players,
    error: null,
    updatedAt: Date.now(),
  }
}

export function summarizePlayer(base: TeammateAnalysisPlayer, rawGames: AnyRecord[], queueId: number): TeammateAnalysisPlayer {
  const games = queueId > 0 ? rawGames.filter((game) => Number(game?.queueId) === queueId) : rawGames
  const valid = games.filter((game) => !shouldSkipGameForPlayer(game, base.puuid))
  if (valid.length === 0) {
    return { ...base, status: 'empty' }
  }

  let wins = 0
  let kills = 0
  let deaths = 0
  let assists = 0
  for (const game of valid) {
    const participant = game.participants.find((item: AnyRecord) => item?.puuid === base.puuid)
    if (participant.win) wins += 1
    kills += Number(participant.kills) || 0
    deaths += Number(participant.deaths) || 0
    assists += Number(participant.assists) || 0
  }

  const total = valid.length
  const strength = calculatePlayerStrengthScore(valid, base.puuid)
  const fallback = base.gameName ? null : firstName(valid, base.puuid)
  return {
    ...base,
    gameName: base.gameName || fallback?.gameName || '',
    tagLine: base.tagLine || fallback?.tagLine || '',
    status: 'ok',
    games: total,
    wins,
    winRate: wins / total,
    avgKills: kills / total,
    avgDeaths: deaths / total,
    avgAssists: assists / total,
    kda: deaths === 0 ? kills + assists : (kills + assists) / deaths,
    score: strength?.score ?? null,
    grade: (strength?.grade ?? null) as StrengthGrade | null,
    lowConfidence: strength?.lowConfidence ?? true,
  }
}

function firstName(games: AnyRecord[], puuid: string): { gameName: string; tagLine: string } {
  for (const game of games) {
    const participant = game.participants.find((item: AnyRecord) => item?.puuid === puuid)
    if (participant?.riotIdGameName) {
      return { gameName: String(participant.riotIdGameName), tagLine: String(participant.riotIdTagline || '') }
    }
  }
  return { gameName: '', tagLine: '' }
}

/** 有评分的人按分数从高到低依次给 千里马 / 上等马 / 中等马 / 下等马 / 纯牛马，没有战绩的是「萌新」。 */
export function assignHorseTitles(players: TeammateAnalysisPlayer[]): void {
  const ranked = players
    .filter((player) => player.score != null)
    .sort((a, b) => (b.score as number) - (a.score as number))
  ranked.forEach((player, index) => {
    player.title = HORSE_TITLES[Math.min(index, HORSE_TITLES.length - 1)]
  })
}

async function getPlatformId(service: LCUService): Promise<string> {
  if (cachedPlatformId) return cachedPlatformId
  const chat = await service.getReadOnlyJsonEndpoint('/lol-chat/v1/me')
  const platformId = String(chat?.data?.platformId || '').toUpperCase()
  if (/^[A-Z0-9]{2,8}$/.test(platformId)) {
    cachedPlatformId = platformId
  }
  return platformId
}

async function fetchPlayerGames(
  service: LCUService,
  platformId: string,
  puuid: string,
  queueId: number,
  count: number,
): Promise<AnyRecord[]> {
  const origin = getSgpMatchHistoryOrigin(platformId)
  if (!origin) throw new Error(`SGP origin missing for ${platformId}`)

  let lastError: unknown = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const accessToken = await service.getEntitlementsAccessToken()
    if (!accessToken) throw new Error('League Client did not provide an entitlements access token')
    try {
      const response = await axios.get(
        `${origin}/match-history-query/v1/products/lol/player/${encodeURIComponent(puuid)}/SUMMARY`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: {
            startIndex: 0,
            count: Math.max(1, Math.min(count, 100)),
            ...(queueId > 0 ? { tag: `q_${queueId}` } : {}),
          },
          proxy: false,
          timeout: SGP_TIMEOUT_MS,
        },
      )
      const games = Array.isArray(response.data?.games) ? response.data.games : []
      return games
        .map((entry: AnyRecord) => entry?.json)
        .filter((game: AnyRecord) => game && Array.isArray(game.participants))
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('SGP request failed')
}

/** 测试用：清空跨局缓存。 */
export function resetTeammateAnalysisCache(): void {
  cachedKey = ''
  cachedTask = null
  cachedPlatformId = ''
}
