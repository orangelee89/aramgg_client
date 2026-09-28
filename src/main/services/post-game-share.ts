import { net } from 'electron'
import fs from 'fs-extra'
import path from 'path'
import logger from '../modules/logger.ts'
import { getAppDataDir } from '../modules/app-paths.ts'
import store from '../modules/app-store.ts'
import type LCUService from './lcu/lcu-service.ts'
import {
  getChampionAugmentStats,
  loadAugmentDetail,
  loadChampionName,
  loadChampionRoster,
} from '../data-loader.ts'
import { computeHorseRatings, type HorseRating } from './post-game-rating.ts'

type AnyRecord = Record<string, any>

export type PostGameShareStatBlock = {
  kills: number | null
  deaths: number | null
  assists: number | null
  kda: number | null
  damageDealtToChampions: number | null
  damageTaken: number | null
  goldEarned: number | null
  creepScore: number | null
  killParticipation: number | null
  damageSelfMitigated: number | null
  timeCCingOthers: number | null
  healsOnTeammates: number | null
  shieldsOnTeammates: number | null
}

export type PostGameShareChampion = {
  id: number | null
  name: string
  nameEN: string
  title: string
  imageUrl: string
  imageDataUrl: string | null
}

export type PostGameShareAugment = {
  id: number | null
  augmentId: number | null
  name: string
  rarity: string
  iconPath: string | null
  iconUrl: string
  imageDataUrl: string | null
  winRate: number | null
  pickRate: number | null
  recommendScore: number | null
  source: string
}

export type PostGameSharePlayer = {
  key: string
  summonerName: string
  team: 'ORDER' | 'CHAOS' | ''
  isSelf: boolean
  champion: PostGameShareChampion
  stats: PostGameShareStatBlock
  rating: HorseRating | null
}

export type PostGameSharePosterData = {
  status: 'ready' | 'partial' | 'unavailable'
  reason: string
  result: 'victory' | 'defeat' | 'unknown'
  gameMode: string
  queueName: string
  durationSeconds: number | null
  summonerName: string
  champion: PostGameShareChampion
  stats: PostGameShareStatBlock
  augments: PostGameShareAugment[]
  players: PostGameSharePlayer[]
  rating: HorseRating | null
  sources: string[]
  updatedAt: number
}

type SnapshotChampion = {
  id: number | null
  name: string
  nameEN: string
  title: string
  imageUrl: string
}

type SnapshotAugment = Omit<PostGameShareAugment, 'imageDataUrl'>

type SnapshotPlayer = Omit<PostGameSharePlayer, 'champion' | 'rating'> & {
  champion: SnapshotChampion
}

type PostGameShareSnapshot = {
  result: PostGameSharePosterData['result']
  gameMode: string
  queueName: string
  durationSeconds: number | null
  summonerName: string
  champion: SnapshotChampion
  stats: PostGameShareStatBlock
  augments: SnapshotAugment[]
  players: SnapshotPlayer[]
  identityCandidates: string[]
  sources: string[]
  updatedAt: number
}

type SnapshotUpdate = Partial<Omit<PostGameShareSnapshot, 'sources' | 'updatedAt'>> & {
  sources?: string[]
}

const LIVE_SNAPSHOT_THROTTLE_MS = 5000
const IMAGE_FETCH_TIMEOUT_MS = 1800
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024
const MAX_RECURSION_DEPTH = 7

const statKeySets = {
  kills: new Set(['kills', 'numkills', 'championskilled']),
  deaths: new Set(['deaths', 'numdeaths']),
  assists: new Set(['assists', 'numassists']),
  damageDealtToChampions: new Set([
    'totaldamagedealttochampions',
    'damagedealttochampions',
    'totaldamagechampions',
  ]),
  damageTaken: new Set(['totaldamagetaken', 'damagetaken']),
  goldEarned: new Set(['goldearned', 'gold']),
  creepScore: new Set(['creepscore', 'minionskilled', 'totalminionskilled']),
  killParticipation: new Set(['killparticipation', 'teamkillparticipation']),
  // 赛后 eog-stats-block 用大写下划线键（归一化后无下划线），战绩接口用驼峰；两套都认。
  damageSelfMitigated: new Set(['totaldamageselfmitigated', 'damageselfmitigated']),
  timeCCingOthers: new Set(['timeccingothers', 'totaltimeccingothers', 'timeccothers', 'totaltimeccdealt']),
  healsOnTeammates: new Set(['totalhealonteammates', 'totalhealsonteammates', 'healsonteammates', 'healonteammates']),
  shieldsOnTeammates: new Set(['totaldamageshieldedonteammates', 'damageshieldedonteammates', 'shieldsonteammates']),
}

const championIdKeys = new Set([
  'championid',
  'championids',
  'selectedchampionid',
  'playerchampionid',
])
const championNameKeys = new Set(['championname', 'rawchampionname', 'skinname'])
const summonerNameKeys = new Set([
  'summonername',
  'riotid',
  'riotidgamename',
  'displayname',
  'gamename',
  'name',
])
const identityKeys = new Set([
  'summonername',
  'riotid',
  'riotidgamename',
  'displayname',
  'gamename',
  'internalname',
  'name',
  'puuid',
])
const resultKeys = new Set(['win', 'won', 'victory', 'gamewon', 'iswinner', 'result', 'gameresult'])
const localPlayerKeys = new Set(['islocalplayer', 'localplayer', 'islocal', 'iscurrentplayer'])
const teamKeys = new Set(['team', 'teamid'])
const MAX_POSTER_PLAYERS = 10
const durationKeys = new Set(['gamelength', 'gamelengthseconds', 'gameduration', 'duration'])

let liveSnapshotAt = 0
let currentSnapshot: PostGameShareSnapshot = createEmptySnapshot('init')
let latestPosterData: PostGameSharePosterData | null = null
let preparePosterPromise: Promise<{ success: boolean; data: PostGameSharePosterData; error?: string }> | null = null
let championLookupPromise: Promise<Map<string, number>> | null = null
let mockAugmentCountCursor = 0

function createEmptyStats(): PostGameShareStatBlock {
  return {
    kills: null,
    deaths: null,
    assists: null,
    kda: null,
    damageDealtToChampions: null,
    damageTaken: null,
    goldEarned: null,
    creepScore: null,
    killParticipation: null,
    damageSelfMitigated: null,
    timeCCingOthers: null,
    healsOnTeammates: null,
    shieldsOnTeammates: null,
  }
}

function createEmptyChampion(): SnapshotChampion {
  return {
    id: null,
    name: '',
    nameEN: '',
    title: '',
    imageUrl: '',
  }
}

function createEmptySnapshot(reason: string): PostGameShareSnapshot {
  return {
    result: 'unknown',
    gameMode: 'ARAM',
    queueName: 'ARAM',
    durationSeconds: null,
    summonerName: '',
    champion: createEmptyChampion(),
    stats: createEmptyStats(),
    augments: [],
    players: [],
    identityCandidates: [],
    sources: reason ? [reason] : [],
    updatedAt: Date.now(),
  }
}

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function normalizeIdentityText(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .trim()
}

function normalizeChampionLookupText(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/^game_character_displayname_/i, '')
    .replace(/[''.\s_-]+/g, '')
    .trim()
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }

  if (typeof value === 'string') {
    const normalized = value.trim().replace(/,/g, '')
    if (!normalized) {
      return null
    }
    const parsed = Number(normalized)
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

function toPositiveInteger(value: unknown): number | null {
  const numberValue = toFiniteNumber(value)
  if (numberValue == null || !Number.isInteger(numberValue) || numberValue <= 0) {
    return null
  }

  return numberValue
}

function getStringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readNumberByKeys(value: unknown, keys: Set<string>, depth = 0, seen = new WeakSet<object>()): number | null {
  if (depth > MAX_RECURSION_DEPTH || value == null) {
    return null
  }

  const directNumber = toFiniteNumber(value)
  if (directNumber != null && depth === 0) {
    return directNumber
  }

  if (!isRecord(value) && !Array.isArray(value)) {
    return null
  }

  if (seen.has(value)) {
    return null
  }
  seen.add(value)

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 40)) {
      const found = readNumberByKeys(item, keys, depth + 1, seen)
      if (found != null) {
        return found
      }
    }
    return null
  }

  for (const [key, child] of Object.entries(value)) {
    if (keys.has(normalizeKey(key))) {
      const found = toFiniteNumber(child)
      if (found != null) {
        return found
      }
    }
  }

  for (const child of Object.values(value)) {
    const found = readNumberByKeys(child, keys, depth + 1, seen)
    if (found != null) {
      return found
    }
  }

  return null
}

function readStringByKeys(value: unknown, keys: Set<string>, depth = 0, seen = new WeakSet<object>()): string {
  if (depth > MAX_RECURSION_DEPTH || value == null || (!isRecord(value) && !Array.isArray(value))) {
    return ''
  }

  if (seen.has(value)) {
    return ''
  }
  seen.add(value)

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 40)) {
      const found = readStringByKeys(item, keys, depth + 1, seen)
      if (found) {
        return found
      }
    }
    return ''
  }

  for (const [key, child] of Object.entries(value)) {
    if (keys.has(normalizeKey(key))) {
      const found = getStringValue(child)
      if (found) {
        return found
      }
    }
  }

  for (const child of Object.values(value)) {
    const found = readStringByKeys(child, keys, depth + 1, seen)
    if (found) {
      return found
    }
  }

  return ''
}

function readBooleanByKeys(value: unknown, keys: Set<string>, depth = 0, seen = new WeakSet<object>()): boolean | null {
  if (depth > MAX_RECURSION_DEPTH || value == null || (!isRecord(value) && !Array.isArray(value))) {
    return null
  }

  if (seen.has(value)) {
    return null
  }
  seen.add(value)

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 40)) {
      const found = readBooleanByKeys(item, keys, depth + 1, seen)
      if (found != null) {
        return found
      }
    }
    return null
  }

  for (const [key, child] of Object.entries(value)) {
    if (keys.has(normalizeKey(key)) && typeof child === 'boolean') {
      return child
    }
  }

  for (const child of Object.values(value)) {
    const found = readBooleanByKeys(child, keys, depth + 1, seen)
    if (found != null) {
      return found
    }
  }

  return null
}

function normalizeResult(value: unknown): PostGameSharePosterData['result'] {
  if (typeof value === 'boolean') {
    return value ? 'victory' : 'defeat'
  }

  const text = String(value || '').trim().toLowerCase()
  if (!text) {
    return 'unknown'
  }

  if (['win', 'won', 'victory', 'victorious', 'success'].includes(text)) {
    return 'victory'
  }

  if (['loss', 'lose', 'lost', 'defeat', 'fail', 'failed'].includes(text)) {
    return 'defeat'
  }

  return 'unknown'
}

function readResult(value: unknown): PostGameSharePosterData['result'] {
  const booleanResult = readBooleanByKeys(value, resultKeys)
  if (booleanResult != null) {
    return normalizeResult(booleanResult)
  }

  return normalizeResult(readStringByKeys(value, resultKeys))
}

function extractChampionId(value: unknown): number | null {
  return toPositiveInteger(readNumberByKeys(value, championIdKeys))
}

function extractChampionName(value: unknown): string {
  return readStringByKeys(value, championNameKeys)
}

function extractSummonerName(value: unknown): string {
  return readStringByKeys(value, summonerNameKeys)
}

function extractDurationSeconds(value: unknown): number | null {
  const duration = readNumberByKeys(value, durationKeys)
  if (duration == null || duration <= 0) {
    return null
  }

  return duration > 10000 ? Math.round(duration / 1000) : Math.round(duration)
}

function extractStats(value: unknown): PostGameShareStatBlock {
  const stats = createEmptyStats()
  stats.kills = readNumberByKeys(value, statKeySets.kills)
  stats.deaths = readNumberByKeys(value, statKeySets.deaths)
  stats.assists = readNumberByKeys(value, statKeySets.assists)
  stats.damageDealtToChampions = readNumberByKeys(value, statKeySets.damageDealtToChampions)
  stats.damageTaken = readNumberByKeys(value, statKeySets.damageTaken)
  stats.goldEarned = readNumberByKeys(value, statKeySets.goldEarned)
  stats.creepScore = readNumberByKeys(value, statKeySets.creepScore)
  stats.killParticipation = readNumberByKeys(value, statKeySets.killParticipation)
  stats.damageSelfMitigated = readNumberByKeys(value, statKeySets.damageSelfMitigated)
  stats.timeCCingOthers = readNumberByKeys(value, statKeySets.timeCCingOthers)
  stats.healsOnTeammates = readNumberByKeys(value, statKeySets.healsOnTeammates)
  stats.shieldsOnTeammates = readNumberByKeys(value, statKeySets.shieldsOnTeammates)

  if (stats.kills != null && stats.deaths != null && stats.assists != null) {
    stats.kda = stats.deaths === 0
      ? stats.kills + stats.assists
      : Number(((stats.kills + stats.assists) / stats.deaths).toFixed(2))
  }

  if (stats.killParticipation != null && stats.killParticipation > 1 && stats.killParticipation <= 100) {
    stats.killParticipation = stats.killParticipation / 100
  }

  return stats
}

function hasAnyStats(stats: PostGameShareStatBlock): boolean {
  return Object.values(stats).some((value) => value != null)
}

function collectIdentityCandidates(value: unknown, results = new Set<string>(), depth = 0, seen = new WeakSet<object>()): string[] {
  if (depth > MAX_RECURSION_DEPTH || value == null || (!isRecord(value) && !Array.isArray(value))) {
    return [...results]
  }

  if (seen.has(value)) {
    return [...results]
  }
  seen.add(value)

  if (Array.isArray(value)) {
    value.slice(0, 20).forEach((item) => collectIdentityCandidates(item, results, depth + 1, seen))
    return [...results]
  }

  for (const [key, child] of Object.entries(value)) {
    if (identityKeys.has(normalizeKey(key))) {
      const normalized = normalizeIdentityText(child)
      if (normalized) {
        results.add(normalized)
      }
    }
  }

  return [...results]
}

function getNestedValue(source: unknown, path: string[]): unknown {
  return path.reduce<unknown>((current, key) => isRecord(current) ? current[key] : undefined, source)
}

function getLikelyChampionIdFromGameflowSession(session: unknown): number | null {
  const directPaths = [
    ['gameData', 'playerChampionSelection', 'championId'],
    ['gameData', 'playerChampionSelection', 'selectedChampionId'],
    ['gameData', 'selectedChampionId'],
    ['gameData', 'championId'],
    ['playerChampionSelection', 'championId'],
    ['playerChampionSelection', 'selectedChampionId'],
  ]

  for (const path of directPaths) {
    const championId = toPositiveInteger(getNestedValue(session, path))
    if (championId) {
      return championId
    }
  }

  return extractChampionId(session)
}

async function getChampionLookup(): Promise<Map<string, number>> {
  if (championLookupPromise) {
    return championLookupPromise
  }

  championLookupPromise = (async () => {
    const roster = await loadChampionRoster()
    const lookup = new Map<string, number>()
    for (const champion of roster) {
      const championId = toPositiveInteger(champion?.championId ?? champion?.id)
      if (!championId) {
        continue
      }

      const keys = [
        champion?.alias,
        champion?.nameEN,
        champion?.nameCN,
      ]
        .map(normalizeChampionLookupText)
        .filter(Boolean)

      keys.forEach((key) => lookup.set(key, championId))
    }
    return lookup
  })().catch((error: unknown) => {
    const err = error as Error
    championLookupPromise = null
    logger.warn('[post-game-share] failed to load champion lookup:', err.message)
    return new Map<string, number>()
  })

  return championLookupPromise
}

async function resolveChampionIdFromName(championName: string): Promise<number | null> {
  const normalized = normalizeChampionLookupText(championName)
  if (!normalized) {
    return null
  }

  const lookup = await getChampionLookup()
  return lookup.get(normalized) || null
}

function looksLikePlayerRecord(record: AnyRecord): boolean {
  // 容器对象（整局数据、队伍）自己也带 stats/ID，会把第一名玩家的身份和一份全 0 的队伍统计
  // 混成一个假"玩家"；只要下面挂着玩家数组就不是玩家。
  if (
    Array.isArray(record.allPlayers) ||
    Array.isArray(record.teams) ||
    Array.isArray(record.participants) ||
    Array.isArray(record.players)
  ) {
    return false
  }

  const stats = extractStats(record)
  if (!hasAnyStats(stats)) {
    return false
  }

  return Boolean(
    extractChampionId(record) ||
    extractChampionName(record) ||
    extractSummonerName(record) ||
    collectIdentityCandidates(record).length
  )
}

function collectPlayerCandidates(value: unknown, results: AnyRecord[] = [], depth = 0, seen = new WeakSet<object>()): AnyRecord[] {
  if (depth > MAX_RECURSION_DEPTH || value == null || (!isRecord(value) && !Array.isArray(value))) {
    return results
  }

  if (seen.has(value)) {
    return results
  }
  seen.add(value)

  if (Array.isArray(value)) {
    value.slice(0, 80).forEach((item) => collectPlayerCandidates(item, results, depth + 1, seen))
    return results
  }

  if (looksLikePlayerRecord(value)) {
    results.push(value)
  }

  Object.values(value).forEach((child) => collectPlayerCandidates(child, results, depth + 1, seen))
  return results
}

function scorePlayerCandidate(candidate: AnyRecord, context: {
  championId: number | null
  identityCandidates: string[]
  championName: string
}): number {
  let score = 0

  if (readBooleanByKeys(candidate, localPlayerKeys) === true) {
    score += 100
  }

  const candidateChampionId = extractChampionId(candidate)
  if (candidateChampionId && context.championId && candidateChampionId === context.championId) {
    score += 40
  }

  const candidateChampionName = normalizeChampionLookupText(extractChampionName(candidate))
  const contextChampionName = normalizeChampionLookupText(context.championName)
  if (candidateChampionName && contextChampionName && candidateChampionName === contextChampionName) {
    score += 30
  }

  const candidateIdentities = collectIdentityCandidates(candidate)
  if (candidateIdentities.some((identity) => context.identityCandidates.includes(identity))) {
    score += 80
  }

  if (hasAnyStats(extractStats(candidate))) {
    score += 10
  }

  return score
}

function selectPlayerRecord(payload: unknown, context: {
  championId: number | null
  identityCandidates: string[]
  championName: string
}): AnyRecord | null {
  const candidates = collectPlayerCandidates(payload)
  if (!candidates.length) {
    return null
  }

  const ranked = candidates
    .map((candidate) => ({
      candidate,
      score: scorePlayerCandidate(candidate, context),
    }))
    .sort((left, right) => right.score - left.score)

  if (ranked[0]?.score > 0 || ranked.length === 1) {
    return ranked[0].candidate
  }

  return null
}

function isKnownAugmentValue(value: unknown, augmentBaseById: Record<string, any>): number | null {
  const augmentId = toPositiveInteger(value)
  if (!augmentId) {
    return null
  }

  return augmentBaseById[String(augmentId)] ? augmentId : null
}

function collectKnownAugmentIdsFromSubtree(
  value: unknown,
  augmentBaseById: Record<string, any>,
  results: number[],
  depth = 0,
  seen = new WeakSet<object>()
): void {
  if (depth > 4 || value == null) {
    return
  }

  const directId = isKnownAugmentValue(value, augmentBaseById)
  if (directId && !results.includes(directId)) {
    results.push(directId)
    return
  }

  if (!isRecord(value) && !Array.isArray(value)) {
    return
  }

  if (seen.has(value)) {
    return
  }
  seen.add(value)

  if (Array.isArray(value)) {
    value.slice(0, 20).forEach((item) =>
      collectKnownAugmentIdsFromSubtree(item, augmentBaseById, results, depth + 1, seen)
    )
    return
  }

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = normalizeKey(key)
    if (['id', 'augmentid', 'cardid', 'upgradeid'].includes(normalizedKey)) {
      const augmentId = isKnownAugmentValue(child, augmentBaseById)
      if (augmentId && !results.includes(augmentId)) {
        results.push(augmentId)
      }
    }

    collectKnownAugmentIdsFromSubtree(child, augmentBaseById, results, depth + 1, seen)
  }
}

function collectKnownAugmentIds(
  value: unknown,
  augmentBaseById: Record<string, any>,
  results: number[] = [],
  path = '$',
  depth = 0,
  seen = new WeakSet<object>()
): number[] {
  if (depth > MAX_RECURSION_DEPTH || value == null || (!isRecord(value) && !Array.isArray(value))) {
    return results
  }

  if (seen.has(value)) {
    return results
  }
  seen.add(value)

  if (Array.isArray(value)) {
    value.slice(0, 40).forEach((item, index) =>
      collectKnownAugmentIds(item, augmentBaseById, results, `${path}[${index}]`, depth + 1, seen)
    )
    return results
  }

  for (const [key, child] of Object.entries(value)) {
    const nextPath = `${path}.${key}`
    const normalizedKey = normalizeKey(key)
    const pathLooksAugmentRelated = /augment|upgrade|hextech|hex/.test(normalizedKey)

    if (pathLooksAugmentRelated) {
      collectKnownAugmentIdsFromSubtree(child, augmentBaseById, results)
    }

    collectKnownAugmentIds(child, augmentBaseById, results, nextPath, depth + 1, seen)
  }

  return results
}

function normalizeTeam(value: unknown): PostGameSharePlayer['team'] {
  const text = String(value ?? '').trim().toUpperCase()
  if (text === '100' || text === 'ORDER' || text === 'BLUE') {
    return 'ORDER'
  }
  if (text === '200' || text === 'CHAOS' || text === 'RED') {
    return 'CHAOS'
  }
  return ''
}

function readTeam(record: AnyRecord): PostGameSharePlayer['team'] {
  for (const [key, value] of Object.entries(record)) {
    if (teamKeys.has(normalizeKey(key))) {
      const team = normalizeTeam(value)
      if (team) {
        return team
      }
    }
  }
  return ''
}

function buildPlayerKey(summonerName: string, team: string, championId: number | null): string {
  const identity = normalizeIdentityText(summonerName)
  if (identity) {
    return `name:${identity}`
  }
  return `slot:${team || 'unknown'}:${championId || 'unknown'}`
}

/**
 * 从对局数据里收集所有玩家（Live Client Data 的 allPlayers、赛后 eog-stats-block 的 teams[].players），
 * 供海报做输出/承伤对比。自己那条用 selectedPlayer 的引用或身份候选来标记。
 */
export async function collectPosterPlayers(
  payload: unknown,
  selectedPlayer: AnyRecord | null,
  identityCandidates: string[]
): Promise<SnapshotPlayer[]> {
  const candidates = collectPlayerCandidates(payload)
  if (candidates.length < 2) {
    return []
  }

  const playersByKey = new Map<string, SnapshotPlayer>()

  for (const candidate of candidates) {
    const summonerName = extractSummonerName(candidate)
    const championName = extractChampionName(candidate)
    const championId = extractChampionId(candidate) ||
      (championName ? await resolveChampionIdFromName(championName) : null)
    const team = readTeam(candidate)
    const key = buildPlayerKey(summonerName, team, championId)
    const candidateIdentities = collectIdentityCandidates(candidate)
    const isSelf = candidate === selectedPlayer ||
      readBooleanByKeys(candidate, localPlayerKeys) === true ||
      candidateIdentities.some((identity) => identityCandidates.includes(identity))
    const stats = extractStats(candidate)

    // 同一个人可能出现多次（队伍列表里一条、localPlayer 一条），合并而不是丢弃后者：
    // 自己的标记取并集，缺的数据用后来的补上。
    const existing = playersByKey.get(key)
    if (existing) {
      existing.isSelf = existing.isSelf || isSelf
      existing.stats = mergePlayerStats(existing.stats, stats)
      if (!existing.team && team) {
        existing.team = team
      }
      continue
    }

    if (playersByKey.size >= MAX_POSTER_PLAYERS) {
      continue
    }

    playersByKey.set(key, {
      key,
      summonerName,
      team,
      isSelf,
      champion: await createChampion(championId, championName),
      stats,
    })
  }

  const players = [...playersByKey.values()]

  // 只有一个人（例如只带 activePlayer 的心跳数据）没有对比意义。
  if (players.length < 2) {
    return []
  }

  let selfKept = false
  for (const player of players) {
    if (!player.isSelf) {
      continue
    }
    if (selfKept) {
      player.isSelf = false
    }
    selfKept = true
  }

  return players
}

function mergePlayers(existing: SnapshotPlayer[], incoming?: SnapshotPlayer[]): SnapshotPlayer[] {
  if (!incoming || incoming.length === 0) {
    return existing
  }

  const merged = new Map<string, SnapshotPlayer>()
  existing.forEach((player) => merged.set(player.key, player))
  incoming.forEach((player) => {
    const previous = merged.get(player.key)
    merged.set(player.key, previous
      ? {
        ...previous,
        ...player,
        isSelf: previous.isSelf || player.isSelf,
        champion: mergeChampion(previous.champion, player.champion),
        stats: mergePlayerStats(previous.stats, player.stats),
      }
      : player)
  })

  return [...merged.values()]
}

/**
 * 同一个玩家多条记录合并：有效的非零值优先，避免某条只带占位 0 的记录把真实数据盖掉。
 */
function mergePlayerStats(existing: PostGameShareStatBlock, incoming?: PostGameShareStatBlock): PostGameShareStatBlock {
  if (!incoming) {
    return existing
  }

  const merged = createEmptyStats()
  for (const key of Object.keys(merged) as Array<keyof PostGameShareStatBlock>) {
    const next = incoming[key]
    const previous = existing[key]
    merged[key] = next != null && next !== 0 ? next : (previous ?? next ?? null)
  }
  return merged
}

function mergeStats(existing: PostGameShareStatBlock, incoming?: PostGameShareStatBlock): PostGameShareStatBlock {
  if (!incoming) {
    return existing
  }

  return {
    kills: incoming.kills ?? existing.kills,
    deaths: incoming.deaths ?? existing.deaths,
    assists: incoming.assists ?? existing.assists,
    kda: incoming.kda ?? existing.kda,
    damageDealtToChampions: incoming.damageDealtToChampions ?? existing.damageDealtToChampions,
    damageTaken: incoming.damageTaken ?? existing.damageTaken,
    goldEarned: incoming.goldEarned ?? existing.goldEarned,
    creepScore: incoming.creepScore ?? existing.creepScore,
    killParticipation: incoming.killParticipation ?? existing.killParticipation,
    damageSelfMitigated: incoming.damageSelfMitigated ?? existing.damageSelfMitigated,
    timeCCingOthers: incoming.timeCCingOthers ?? existing.timeCCingOthers,
    healsOnTeammates: incoming.healsOnTeammates ?? existing.healsOnTeammates,
    shieldsOnTeammates: incoming.shieldsOnTeammates ?? existing.shieldsOnTeammates,
  }
}

function mergeChampion(existing: SnapshotChampion, incoming?: SnapshotChampion): SnapshotChampion {
  if (!incoming) {
    return existing
  }

  return {
    id: incoming.id ?? existing.id,
    name: incoming.name || existing.name,
    nameEN: incoming.nameEN || existing.nameEN,
    title: incoming.title || existing.title,
    imageUrl: incoming.imageUrl || existing.imageUrl,
  }
}

function mergeAugments(existing: SnapshotAugment[], incoming: SnapshotAugment[] = []): SnapshotAugment[] {
  const result: SnapshotAugment[] = []
  const byKey = new Map<string, SnapshotAugment>()

  for (const augment of [...existing, ...incoming]) {
    const key = augment.id != null ? `id:${augment.id}` : `name:${augment.name}`
    const previous = byKey.get(key)
    const merged = previous
      ? {
          ...previous,
          ...augment,
          name: augment.name || previous.name,
          rarity: augment.rarity !== 'unknown' ? augment.rarity : previous.rarity,
          iconPath: augment.iconPath || previous.iconPath,
          iconUrl: augment.iconUrl || previous.iconUrl,
          winRate: augment.winRate ?? previous.winRate,
          pickRate: augment.pickRate ?? previous.pickRate,
          recommendScore: augment.recommendScore ?? previous.recommendScore,
        }
      : augment

    if (!previous) {
      result.push(merged)
    } else {
      const index = result.findIndex((item) => (item.id != null ? `id:${item.id}` : `name:${item.name}`) === key)
      if (index >= 0) {
        result[index] = merged
      }
    }

    byKey.set(key, merged)
  }

  return result.filter((augment) => augment.id != null || augment.name).slice(0, 6)
}

function mergeSnapshot(update: SnapshotUpdate): void {
  const sources = new Set([...currentSnapshot.sources, ...(update.sources || [])].filter(Boolean))
  currentSnapshot = {
    ...currentSnapshot,
    ...update,
    champion: mergeChampion(currentSnapshot.champion, update.champion),
    stats: mergeStats(currentSnapshot.stats, update.stats),
    augments: mergeAugments(currentSnapshot.augments, update.augments),
    players: mergePlayers(currentSnapshot.players, update.players),
    identityCandidates: [
      ...new Set([
        ...currentSnapshot.identityCandidates,
        ...(update.identityCandidates || []),
      ].filter(Boolean)),
    ],
    sources: [...sources],
    updatedAt: Date.now(),
  }
}

function getChampionIconUrl(championId: number | null, fallbackUrl = ''): string {
  if (fallbackUrl && /^https?:\/\//i.test(fallbackUrl)) {
    return fallbackUrl
  }

  return championId
    ? `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/${championId}.png`
    : ''
}

function getAugmentIconUrl(iconPath: string): string {
  if (!iconPath) {
    return ''
  }

  if (/^https?:\/\//i.test(iconPath)) {
    return iconPath
  }

  const cleanPath = iconPath.toLowerCase().replace(/\\/g, '/')
  return `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/${cleanPath}`
}

async function createChampion(championId: number | null, fallbackName = ''): Promise<SnapshotChampion> {
  if (!championId) {
    return {
      id: null,
      name: fallbackName || '',
      nameEN: '',
      title: '',
      imageUrl: '',
    }
  }

  const championName = await loadChampionName(championId)
  return {
    id: championId,
    name: championName?.nameCN || fallbackName || `英雄 ${championId}`,
    nameEN: championName?.nameEN || '',
    title: championName?.title || '',
    imageUrl: getChampionIconUrl(championId, championName?.iconUrl || ''),
  }
}

async function decorateAugments(
  augments: SnapshotAugment[],
  championId: number | null
): Promise<SnapshotAugment[]> {
  if (!augments.length) {
    return []
  }

  const [augmentBaseById, championAugmentStats] = await Promise.all([
    loadAugmentDetail(),
    championId ? getChampionAugmentStats(championId).catch(() => []) : Promise.resolve([]),
  ])
  const statsById = new Map(
    championAugmentStats.map((augment: AnyRecord) => [
      Number(augment.augmentId ?? augment.id),
      augment,
    ])
  )

  return augments.map((augment) => {
    const id = augment.id ?? augment.augmentId
    const base = id != null ? augmentBaseById[String(id)] || {} : {}
    const stat = id != null ? statsById.get(Number(id)) || {} : {}
    const iconPath = augment.iconPath || stat.iconPath || stat.iconUrl || base.iconPath || base.iconUrl || null

    return {
      ...augment,
      id: id ?? null,
      augmentId: id ?? null,
      name: augment.name || stat.name || base.name || (id ? `海克斯 ${id}` : '未知海克斯'),
      rarity: augment.rarity !== 'unknown' ? augment.rarity : stat.rarity || base.rarity || 'unknown',
      iconPath,
      iconUrl: getAugmentIconUrl(iconPath || ''),
      winRate: augment.winRate ?? toFiniteNumber(stat.winRate),
      pickRate: augment.pickRate ?? toFiniteNumber(stat.pickRate),
      recommendScore: augment.recommendScore ?? toFiniteNumber(stat.recommendScore),
    }
  })
}

async function buildSnapshotUpdateFromPayload(params: {
  payload: unknown
  source: string
  gameflowSession?: unknown
  currentSummoner?: unknown
}): Promise<SnapshotUpdate> {
  const payloadRecord = isRecord(params.payload) ? params.payload : {}
  const activePlayer = isRecord(payloadRecord.activePlayer) ? payloadRecord.activePlayer : {}
  const championIdFromSession = getLikelyChampionIdFromGameflowSession(params.gameflowSession)
  const championIdFromStore = toPositiveInteger(store.get('lastSelectedChampionId'))
  const activeChampionId = extractChampionId(activePlayer)
  const activeChampionName = extractChampionName(activePlayer)
  const summonerIdentityCandidates = collectIdentityCandidates(params.currentSummoner)
  const activeIdentityCandidates = collectIdentityCandidates(activePlayer)
  const context = {
    championId: activeChampionId || championIdFromSession || currentSnapshot.champion.id || championIdFromStore,
    identityCandidates: [
      ...new Set([
        ...currentSnapshot.identityCandidates,
        ...summonerIdentityCandidates,
        ...activeIdentityCandidates,
      ]),
    ],
    championName: activeChampionName || currentSnapshot.champion.name || '',
  }
  const selectedPlayer = selectPlayerRecord(params.payload, context) || activePlayer
  const selectedChampionName = extractChampionName(selectedPlayer) || activeChampionName
  const championId =
    extractChampionId(selectedPlayer) ||
    context.championId ||
    (selectedChampionName ? await resolveChampionIdFromName(selectedChampionName) : null)
  const champion = await createChampion(championId, selectedChampionName)
  const augmentBaseById = await loadAugmentDetail()
  const selectedPlayerAugmentIds = collectKnownAugmentIds(selectedPlayer, augmentBaseById)
  const activePlayerAugmentIds = selectedPlayer === activePlayer
    ? []
    : collectKnownAugmentIds(activePlayer, augmentBaseById)
  const augmentIds = selectedPlayerAugmentIds.length ? selectedPlayerAugmentIds : activePlayerAugmentIds
  const liveAugments = await decorateAugments(
    augmentIds.map((augmentId) => ({
      id: augmentId,
      augmentId,
      name: '',
      rarity: 'unknown',
      iconPath: null,
      iconUrl: '',
      winRate: null,
      pickRate: null,
      recommendScore: null,
      source: params.source,
    })),
    championId
  )
  const stats = extractStats(selectedPlayer)
  const result = readResult(selectedPlayer) !== 'unknown' ? readResult(selectedPlayer) : readResult(params.payload)
  const gameMode = getStringValue(payloadRecord.gameMode || payloadRecord.gameData?.gameMode) || currentSnapshot.gameMode
  const queueName = gameMode.toUpperCase().includes('ARAM') ? 'ARAM' : gameMode || currentSnapshot.queueName
  const summonerName = extractSummonerName(selectedPlayer) || extractSummonerName(activePlayer) || currentSnapshot.summonerName
  const durationSeconds = extractDurationSeconds(params.payload) ?? currentSnapshot.durationSeconds
  const players = await collectPosterPlayers(params.payload, selectedPlayer, [
    ...context.identityCandidates,
    ...collectIdentityCandidates(selectedPlayer),
  ])

  return {
    result,
    gameMode,
    queueName,
    durationSeconds,
    summonerName,
    champion,
    stats,
    augments: liveAugments,
    players,
    identityCandidates: context.identityCandidates,
    sources: [params.source],
  }
}

async function fetchImageDataUrl(url: string): Promise<string | null> {
  if (!/^https?:\/\//i.test(url)) {
    return null
  }

  try {
    const transportFetch = process.versions?.electron ? net.fetch.bind(net) : globalThis.fetch
    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), IMAGE_FETCH_TIMEOUT_MS)
    })
    const response = await Promise.race([
      transportFetch(url, { headers: { accept: 'image/*' } }),
      timeout,
    ])

    if (!response || !response.ok) {
      return null
    }

    const contentType = response.headers.get('content-type') || 'image/png'
    if (!contentType.toLowerCase().startsWith('image/')) {
      return null
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > MAX_INLINE_IMAGE_BYTES) {
      return null
    }

    return `data:${contentType};base64,${buffer.toString('base64')}`
  } catch (error) {
    const err = error as Error
    logger.debug('[post-game-share] image inline fetch failed:', {
      url,
      error: err.message,
    })
    return null
  }
}

async function hydratePosterImages(data: PostGameSharePosterData): Promise<PostGameSharePosterData> {
  const [championImageDataUrl, augmentImageDataUrls, playerImageDataUrls] = await Promise.all([
    fetchImageDataUrl(data.champion.imageUrl),
    Promise.all(data.augments.map((augment) => fetchImageDataUrl(augment.iconUrl))),
    Promise.all(data.players.map((player) => (
      player.champion.imageUrl === data.champion.imageUrl
        ? Promise.resolve<string | null>(null)
        : fetchImageDataUrl(player.champion.imageUrl)
    ))),
  ])

  return {
    ...data,
    champion: {
      ...data.champion,
      imageDataUrl: championImageDataUrl,
    },
    augments: data.augments.map((augment, index) => ({
      ...augment,
      imageDataUrl: augmentImageDataUrls[index] || null,
    })),
    players: data.players.map((player, index) => ({
      ...player,
      champion: {
        ...player.champion,
        imageDataUrl: playerImageDataUrls[index] ||
          (player.champion.imageUrl === data.champion.imageUrl ? championImageDataUrl : null),
      },
    })),
  }
}

function getPosterStatus(snapshot: PostGameShareSnapshot): PostGameSharePosterData['status'] {
  const hasChampion = Boolean(snapshot.champion.id || snapshot.champion.name)
  const hasKda = snapshot.stats.kills != null && snapshot.stats.deaths != null && snapshot.stats.assists != null
  const hasAugments = snapshot.augments.length > 0

  if (hasChampion && hasKda && hasAugments) {
    return 'ready'
  }

  if (hasChampion || hasKda || hasAugments) {
    return 'partial'
  }

  return 'unavailable'
}

async function buildPosterData(reason: string, hydrateImages: boolean): Promise<PostGameSharePosterData> {
  const decoratedAugments = await decorateAugments(currentSnapshot.augments, currentSnapshot.champion.id)
  currentSnapshot = {
    ...currentSnapshot,
    augments: decoratedAugments,
    updatedAt: Date.now(),
  }

  const ratings = computeHorseRatings(currentSnapshot.players)
  const selfSnapshotPlayer = currentSnapshot.players.find((player) => player.isSelf) || null
  const selfRating = selfSnapshotPlayer ? ratings.get(selfSnapshotPlayer.key) || null : null

  const data: PostGameSharePosterData = {
    status: getPosterStatus(currentSnapshot),
    reason,
    result: currentSnapshot.result,
    gameMode: currentSnapshot.gameMode,
    queueName: currentSnapshot.queueName,
    durationSeconds: currentSnapshot.durationSeconds,
    summonerName: currentSnapshot.summonerName,
    champion: {
      ...currentSnapshot.champion,
      imageDataUrl: null,
    },
    stats: currentSnapshot.stats,
    augments: currentSnapshot.augments.map((augment) => ({
      ...augment,
      imageDataUrl: null,
    })),
    players: currentSnapshot.players.map((player) => ({
      ...player,
      champion: {
        ...player.champion,
        imageDataUrl: null,
      },
      rating: ratings.get(player.key) || null,
    })),
    rating: selfRating,
    sources: currentSnapshot.sources,
    updatedAt: currentSnapshot.updatedAt,
  }

  return hydrateImages ? hydratePosterImages(data) : data
}

export function resetPostGameShareSnapshot(reason: string): void {
  currentSnapshot = createEmptySnapshot(reason)
  latestPosterData = null
  liveSnapshotAt = 0
  logger.debug('[post-game-share] snapshot reset', { reason })
}

export async function capturePostGameShareSnapshot(
  lcuService: LCUService,
  reason: string,
  options: { force?: boolean } = {}
): Promise<PostGameShareSnapshot> {
  const now = Date.now()
  if (!options.force && now - liveSnapshotAt < LIVE_SNAPSHOT_THROTTLE_MS) {
    return currentSnapshot
  }

  liveSnapshotAt = now

  try {
    const [liveClientData, gameflowSession, currentSummoner] = await Promise.all([
      lcuService.getLiveClientAllGameData(),
      lcuService.getReadOnlyJsonEndpoint('/lol-gameflow/v1/session'),
      lcuService.getCurrentSummoner(),
    ])

    if (liveClientData?.data) {
      const update = await buildSnapshotUpdateFromPayload({
        payload: liveClientData.data,
        source: `liveclientdata:${reason}`,
        gameflowSession: gameflowSession?.data,
        currentSummoner,
      })
      mergeSnapshot(update)
    } else if (gameflowSession?.data) {
      const championId = getLikelyChampionIdFromGameflowSession(gameflowSession.data)
      if (championId) {
        mergeSnapshot({
          champion: await createChampion(championId, currentSnapshot.champion.name),
          sources: [`gameflow-session:${reason}`],
        })
      }
    }
  } catch (error) {
    const err = error as Error
    logger.debug('[post-game-share] live snapshot failed:', {
      reason,
      error: err.message,
    })
  }

  return currentSnapshot
}

/**
 * 记录赛后数据块里第一名玩家的统计键，用来确认控制时长、治疗/护盾这些字段在当前客户端版本的真实键名。
 */
function logEndOfGameStatKeys(endpoint: string, payload: unknown, update: SnapshotUpdate): void {
  try {
    const candidate = collectPlayerCandidates(payload)[0]
    const statsRecord = candidate && isRecord(candidate.stats) ? candidate.stats : candidate
    const keys = statsRecord ? Object.keys(statsRecord).slice(0, 120) : []
    const players = update.players || []
    logger.info('[post-game-share] end-of-game stat keys', {
      endpoint,
      playerCount: players.length,
      keyCount: keys.length,
      keys,
      ratingFields: players.slice(0, 2).map((player) => ({
        key: player.key,
        damageSelfMitigated: player.stats.damageSelfMitigated,
        timeCCingOthers: player.stats.timeCCingOthers,
        healsOnTeammates: player.stats.healsOnTeammates,
        shieldsOnTeammates: player.stats.shieldsOnTeammates,
      })),
    })
  } catch (error) {
    logger.debug('[post-game-share] failed to log end-of-game stat keys:', (error as Error).message)
  }
}

const EOG_DUMP_DIR_NAME = 'post-game'
const EOG_DUMP_KEEP = 3

/**
 * 把赛后原始数据块存到数据目录（只保留最近几份），用于排查玩家数据解析问题。
 */
async function dumpEndOfGamePayload(endpoint: string, payload: unknown): Promise<void> {
  try {
    const dir = path.join(getAppDataDir(), EOG_DUMP_DIR_NAME)
    await fs.ensureDir(dir)
    const safeEndpoint = endpoint.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '')
    const filePath = path.join(dir, `eog-${Date.now()}-${safeEndpoint}.json`)
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8')

    const files = (await fs.readdir(dir))
      .filter((name) => name.startsWith('eog-') && name.endsWith('.json'))
      .sort()
    const stale = files.slice(0, Math.max(0, files.length - EOG_DUMP_KEEP))
    await Promise.all(stale.map((name) => fs.remove(path.join(dir, name))))
    logger.debug('[post-game-share] end-of-game payload saved', { filePath })
  } catch (error) {
    logger.debug('[post-game-share] failed to save end-of-game payload:', (error as Error).message)
  }
}

async function captureEndOfGameStats(lcuService: LCUService, reason: string): Promise<void> {
  const endpoints = [
    '/lol-end-of-game/v1/eog-stats-block',
    '/lol-end-of-game/v1/gameclient-eog-stats-block',
  ]

  for (const endpoint of endpoints) {
    const result = await lcuService.getReadOnlyJsonEndpoint(endpoint)
    if (!result || result.status < 200 || result.status >= 300 || !result.data) {
      continue
    }

    const update = await buildSnapshotUpdateFromPayload({
      payload: result.data,
      source: `eog:${endpoint}:${reason}`,
    })
    mergeSnapshot(update)
    logEndOfGameStatKeys(endpoint, result.data, update)
    void dumpEndOfGamePayload(endpoint, result.data)

    if (hasAnyStats(update.stats || createEmptyStats())) {
      return
    }
  }
}

export async function preparePostGameSharePosterData(
  lcuService: LCUService,
  reason: string
): Promise<{ success: boolean; data: PostGameSharePosterData; error?: string }> {
  if (preparePosterPromise) {
    return preparePosterPromise
  }

  preparePosterPromise = (async () => {
    try {
      await capturePostGameShareSnapshot(lcuService, reason, { force: true })
      await captureEndOfGameStats(lcuService, reason)
      latestPosterData = await buildPosterData(reason, true)
      logger.info('[post-game-share] poster data prepared', {
        players: latestPosterData.players.map((player) => ({
          key: player.key,
          team: player.team,
          isSelf: player.isSelf,
          championId: player.champion.id,
          hasIcon: Boolean(player.champion.imageDataUrl),
          dealt: player.stats.damageDealtToChampions,
          taken: player.stats.damageTaken,
          honors: player.rating?.honors ?? null,
        })),
        status: latestPosterData.status,
        championId: latestPosterData.champion.id,
        augmentIds: latestPosterData.augments.map((augment) => augment.id),
        sources: latestPosterData.sources,
      })
      return {
        success: true,
        data: latestPosterData,
      }
    } catch (error) {
      const err = error as Error
      logger.warn('[post-game-share] poster data preparation failed:', err.message)
      const fallback = await buildPosterData(reason, false)
      latestPosterData = fallback
      return {
        success: false,
        data: fallback,
        error: err.message,
      }
    } finally {
      preparePosterPromise = null
    }
  })()

  return preparePosterPromise
}

export async function getLatestPostGameSharePosterData(
  lcuService: LCUService,
  reason = 'manual'
): Promise<{ success: boolean; data: PostGameSharePosterData; error?: string }> {
  if (latestPosterData && latestPosterData.status !== 'unavailable') {
    return {
      success: true,
      data: latestPosterData,
    }
  }

  return preparePostGameSharePosterData(lcuService, reason)
}

export async function createMockPostGameSharePosterData(): Promise<{
  success: boolean
  data: PostGameSharePosterData
  error?: string
}> {
  try {
    const championRoster = await loadChampionRoster().catch(() => [])
    const randomChampion = championRoster.length
      ? championRoster[Math.floor(Math.random() * championRoster.length)]
      : null
    const championId = toPositiveInteger(randomChampion?.championId ?? randomChampion?.id) || 63
    const fallbackChampionName = getStringValue(randomChampion?.nameCN || randomChampion?.name) || '布兰德'
    const champion = await createChampion(championId, fallbackChampionName)
    const augmentStats = await getChampionAugmentStats(championId).catch(() => [])
    const augmentBaseById = await loadAugmentDetail()
    const fallbackAugments = Object.values(augmentBaseById)
    const seenAugmentKeys = new Set<string>()
    const augmentPool = [...augmentStats, ...fallbackAugments].filter((augment): augment is AnyRecord => {
      if (!isRecord(augment)) {
        return false
      }

      const id = toPositiveInteger(augment.augmentId ?? augment.id)
      const name = getStringValue(augment.name)
      const key = id ? `id:${id}` : `name:${name}`
      if (!id && !name) {
        return false
      }

      if (seenAugmentKeys.has(key)) {
        return false
      }

      seenAugmentKeys.add(key)
      return true
    })
    const shuffledAugments = [...augmentPool].sort(() => Math.random() - 0.5)
    const mockAugmentCount = 3 + (mockAugmentCountCursor % 4)
    mockAugmentCountCursor += 1
    const rawAugments: AnyRecord[] = shuffledAugments.slice(0, mockAugmentCount)
    const fallbackRarities = ['kSilver', 'kGold', 'kPrismatic']
    while (rawAugments.length < mockAugmentCount) {
      const index = rawAugments.length
      rawAugments.push({
        id: 9000 + index,
        name: `模拟海克斯 ${index + 1}`,
        rarity: fallbackRarities[index % fallbackRarities.length],
        iconPath: null,
      })
    }
    const kills = 14 + Math.floor(Math.random() * 10)
    const deaths = 2 + Math.floor(Math.random() * 5)
    const assists = 20 + Math.floor(Math.random() * 16)
    const damageDealtToChampions = 46000 + Math.floor(Math.random() * 18000)
    const damageTaken = 26000 + Math.floor(Math.random() * 14000)
    const goldEarned = 14500 + Math.floor(Math.random() * 4200)
    const kda = Number(((kills + assists) / Math.max(1, deaths)).toFixed(2))

    const augments = await decorateAugments(
      rawAugments.map((augment: AnyRecord, index: number) => {
        const id = toPositiveInteger(augment.augmentId ?? augment.id) || 9000 + index
        const iconPath = getStringValue(augment.iconPath || augment.iconUrl) || null
        return {
          id,
          augmentId: id,
          name: getStringValue(augment.name) || `海克斯 ${index + 1}`,
          rarity: getStringValue(augment.rarity) || 'unknown',
          iconPath,
          iconUrl: getAugmentIconUrl(iconPath || ''),
          winRate: toFiniteNumber(augment.winRate) ?? 0.538 + index * 0.012,
          pickRate: toFiniteNumber(augment.pickRate) ?? 0.18 - index * 0.03,
          recommendScore: toFiniteNumber(augment.recommendScore) ?? 88 - index * 4,
          source: 'mock',
        }
      }),
      championId
    )

    const selfStats: PostGameShareStatBlock = {
      kills,
      deaths,
      assists,
      kda,
      damageDealtToChampions,
      damageTaken,
      goldEarned,
      creepScore: 58 + Math.floor(Math.random() * 38),
      killParticipation: 0.72 + Math.random() * 0.22,
      damageSelfMitigated: 20000 + Math.floor(Math.random() * 30000),
      timeCCingOthers: 20 + Math.floor(Math.random() * 60),
      healsOnTeammates: Math.floor(Math.random() * 8000),
      shieldsOnTeammates: Math.floor(Math.random() * 6000),
    }
    const mockPlayers: SnapshotPlayer[] = [{
      key: 'name:aramgg玩家',
      summonerName: 'ARAMGG玩家',
      team: 'ORDER',
      isSelf: true,
      champion,
      stats: selfStats,
    }]
    const mockNames = ['队友甲', '队友乙', '队友丙', '队友丁', '对手一', '对手二', '对手三', '对手四', '对手五']
    for (let index = 0; index < mockNames.length; index += 1) {
      const rosterChampion = championRoster.length
        ? championRoster[Math.floor(Math.random() * championRoster.length)]
        : null
      const mockChampionId = toPositiveInteger(rosterChampion?.championId ?? rosterChampion?.id) || 1 + index
      const mockKills = 3 + Math.floor(Math.random() * 16)
      const mockDeaths = 2 + Math.floor(Math.random() * 9)
      const mockAssists = 10 + Math.floor(Math.random() * 24)
      mockPlayers.push({
        key: `name:${mockNames[index]}`,
        summonerName: mockNames[index],
        team: index < 4 ? 'ORDER' : 'CHAOS',
        isSelf: false,
        champion: await createChampion(mockChampionId, getStringValue(rosterChampion?.nameCN || rosterChampion?.name)),
        stats: {
          kills: mockKills,
          deaths: mockDeaths,
          assists: mockAssists,
          kda: Number(((mockKills + mockAssists) / Math.max(1, mockDeaths)).toFixed(2)),
          damageDealtToChampions: 18000 + Math.floor(Math.random() * 48000),
          damageTaken: 16000 + Math.floor(Math.random() * 30000),
          goldEarned: 11000 + Math.floor(Math.random() * 7000),
          creepScore: 30 + Math.floor(Math.random() * 60),
          killParticipation: 0.4 + Math.random() * 0.5,
          damageSelfMitigated: 8000 + Math.floor(Math.random() * 40000),
          timeCCingOthers: 5 + Math.floor(Math.random() * 90),
          healsOnTeammates: Math.random() < 0.4 ? Math.floor(Math.random() * 15000) : 0,
          shieldsOnTeammates: Math.random() < 0.4 ? Math.floor(Math.random() * 10000) : 0,
        },
      })
    }

    currentSnapshot = {
      result: 'victory',
      gameMode: 'ARAM',
      queueName: 'ARAM',
      durationSeconds: 1128,
      summonerName: 'ARAMGG玩家',
      champion,
      stats: selfStats,
      augments,
      players: mockPlayers,
      identityCandidates: [],
      sources: ['mock'],
      updatedAt: Date.now(),
    }

    latestPosterData = await hydratePosterImages(await buildPosterData('mock', false))
    return {
      success: true,
      data: latestPosterData,
    }
  } catch (error) {
    const err = error as Error
    logger.warn('[post-game-share] mock poster generation failed:', err.message)
    const fallback = await buildPosterData('mock-fallback', false)
    latestPosterData = fallback
    return {
      success: false,
      data: fallback,
      error: err.message,
    }
  }
}
