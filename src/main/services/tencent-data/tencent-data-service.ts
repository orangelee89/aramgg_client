import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import path from 'path'
import logger from '../../modules/logger.ts'
import { getAppDataDir } from '../../modules/app-paths.ts'
import {
  parseAugmentRank,
  parseChampionAugments,
  parseHeroRank,
  parseKiwiAugments,
  unwrapOdpPayload,
  type TencentChampionStat,
} from './tencent-parsers.ts'
import type { TencentChampionSnapshot, TencentGlobalSnapshot } from './tencent-overlay.ts'
import {
  fetchMirrorManifest,
  resolveMirrorBaseUrl,
  syncChampionFromMirror,
  syncGlobalFromMirror,
  type MirrorManifest,
  type RawResponse,
} from './tencent-mirror-client.ts'

const ODP_ORIGIN = 'https://mlol.qt.qq.com/go/battle_info/odp_proxy'
const AUGMENT_NAMES_URL = 'https://game.gtimg.cn/images/lol/act/img/js/kiwi/kiwi_augments.json'

// GitHub Actions 每天把掌盟数据推到本仓库的 tencent-data 分支（见 scripts/tencent-data/）。
// 只能由这里或本机环境变量 ARAMGG_TENCENT_MIRROR_ORIGIN 指定，远端配置不能改。
const TENCENT_MIRROR_BASE_URL = 'https://raw.githubusercontent.com/orangelee89/aramgg_client/tencent-data'

const REQUEST_TIMEOUT_MS = 10 * 1000
const FIRST_LOAD_WAIT_MS = 8 * 1000
const CHAMPION_LOAD_WAIT_MS = 4 * 1000
const MIN_AUGMENT_ROWS = 50
const MIN_CHAMPION_ROWS = 50
const SNAPSHOT_SCHEMA_VERSION = 1
const CONTENT_IGNORED_FIELDS = ['fetchedAt', 'mirrorHash', 'sourceFetchedAt']

// 每次启动只检查一次：全局数据在启动时同步，单英雄在本次运行首次打开详情时按启动拿到的 manifest 比对。
let electronFetch: any = null
let globalSnapshot: TencentGlobalSnapshot | null = null
let globalDiskLoaded = false
let startupSyncPromise: Promise<TencentGlobalSnapshot | null> | null = null
let mirrorManifest: MirrorManifest | null = null
const championSnapshots = new Map<string, TencentChampionSnapshot>()
const championSyncPromises = new Map<string, Promise<TencentChampionSnapshot | null>>()
const updateListeners = new Set<() => void>()

export function isTencentDataEnabled(): boolean {
  return process.env.ARAMGG_DISABLE_TENCENT_DATA !== '1'
}

export function getTencentMirrorBaseUrl(): string {
  return resolveMirrorBaseUrl(process.env.ARAMGG_TENCENT_MIRROR_ORIGIN ?? TENCENT_MIRROR_BASE_URL)
}

export function onTencentDataUpdated(listener: () => void): () => void {
  updateListeners.add(listener)
  return () => updateListeners.delete(listener)
}

function notifyUpdated(): void {
  for (const listener of updateListeners) {
    try {
      listener()
    } catch (error: any) {
      logger.warn('[tencent-data] update listener failed:', error?.message)
    }
  }
}

async function getTransportFetch(): Promise<any> {
  if (process.versions?.electron) {
    if (!electronFetch) {
      const { net } = await import('electron')
      electronFetch = net.fetch.bind(net)
    }

    return electronFetch
  }

  return fetch
}

async function requestRaw(url: string): Promise<RawResponse> {
  const transportFetch = await getTransportFetch()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await transportFetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    return { status: response.status, text: await response.text() }
  } finally {
    clearTimeout(timeout)
  }
}

async function requestJson(url: string): Promise<any> {
  const response = await requestRaw(url)
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}`)
  }

  return JSON.parse(response.text)
}

// 英雄排行接口必须带统计日期；与腾讯攻略站一致取北京时间前一天（当天数据仍在累计）。
function getStatDate(daysAgo: number): string {
  const beijing = new Date(Date.now() + 8 * 60 * 60 * 1000 - daysAgo * 24 * 60 * 60 * 1000)
  const y = beijing.getUTCFullYear()
  const m = String(beijing.getUTCMonth() + 1).padStart(2, '0')
  const d = String(beijing.getUTCDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

function getSnapshotDir(): string {
  return process.env.ARAMGG_TENCENT_DATA_DIR || path.join(getAppDataDir(), 'tencent-data')
}

async function readSnapshotFile<T>(fileName: string): Promise<T | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(getSnapshotDir(), fileName), 'utf-8'))
    return parsed?.schemaVersion === SNAPSHOT_SCHEMA_VERSION ? (parsed.snapshot as T) : null
  } catch {
    return null
  }
}

async function writeSnapshotFile(fileName: string, snapshot: unknown): Promise<void> {
  const filePath = path.join(getSnapshotDir(), fileName)
  await mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.tmp`
  await writeFile(tempPath, JSON.stringify({ schemaVersion: SNAPSHOT_SCHEMA_VERSION, snapshot }), 'utf-8')
  await rename(tempPath, filePath)
}

function championFileName(championId: string): string {
  return path.join('champions', `${championId}.json`)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      }
    )
  })
}

function sameContent(left: unknown, right: unknown): boolean {
  const strip = (value: any) => {
    if (!value) return value
    const copy = { ...value }
    for (const key of CONTENT_IGNORED_FIELDS) delete copy[key]
    return JSON.stringify(copy)
  }

  return strip(left) === strip(right)
}

function isOlderSource(next: { sourceFetchedAt?: string }, current: { sourceFetchedAt?: string; fetchedAt: string } | null) {
  if (!current || !next.sourceFetchedAt) {
    return false
  }

  const nextTime = Date.parse(next.sourceFetchedAt)
  const currentTime = Date.parse(current.sourceFetchedAt || current.fetchedAt)
  return Number.isFinite(nextTime) && Number.isFinite(currentTime) && nextTime < currentTime
}

function buildGlobalSnapshot(
  namesPayload: any,
  runePayload: any,
  championStats: TencentChampionStat[],
  extra: Partial<TencentGlobalSnapshot> = {}
): TencentGlobalSnapshot {
  const augments = parseKiwiAugments(namesPayload)
  const runeInner = unwrapOdpPayload(runePayload)
  const augmentStats = parseAugmentRank(runeInner)

  if (augments.length < MIN_AUGMENT_ROWS || augmentStats.length < MIN_AUGMENT_ROWS) {
    throw new Error(`unexpected augment data shape (names=${augments.length}, stats=${augmentStats.length})`)
  }

  if (championStats.length < MIN_CHAMPION_ROWS) {
    throw new Error(`unexpected hero rank shape (rows=${championStats.length})`)
  }

  const statDate = String(runeInner?.dtstatdate || '')
  return {
    fetchedAt: new Date().toISOString(),
    statDate: /^\d{8}$/.test(statDate)
      ? `${statDate.slice(0, 4)}-${statDate.slice(4, 6)}-${statDate.slice(6)}`
      : '',
    augments,
    augmentStats,
    championStats,
    ...extra,
  }
}

async function fetchDirectChampionStats(): Promise<TencentChampionStat[]> {
  for (const daysAgo of [1, 2]) {
    const payload = await requestJson(`${ODP_ORIGIN}/fuwen_aram_hero_rank_v2?dtstatdate=${getStatDate(daysAgo)}`)
    const stats = parseHeroRank(unwrapOdpPayload(payload))
    if (stats.length >= MIN_CHAMPION_ROWS) {
      return stats
    }
  }

  throw new Error('hero rank returned too few rows')
}

async function fetchDirectGlobalSnapshot(): Promise<TencentGlobalSnapshot> {
  const [namesPayload, runePayload, championStats] = await Promise.all([
    requestJson(AUGMENT_NAMES_URL),
    requestJson(`${ODP_ORIGIN}/fuwen_aram_rune_rank_v2?augmentid_level=255`),
    fetchDirectChampionStats(),
  ])
  return buildGlobalSnapshot(namesPayload, runePayload, championStats)
}

async function commitGlobalSnapshot(next: TencentGlobalSnapshot): Promise<TencentGlobalSnapshot> {
  const current = globalSnapshot
  const candidate = current && isOlderSource(next, current) ? { ...current, mirrorHash: next.mirrorHash } : next
  // 直连掌盟拿不到补丁号，沿用上一次镜像给的值。
  const merged = !candidate.gamePatch && current?.gamePatch ? { ...candidate, gamePatch: current.gamePatch } : candidate
  const changed = !sameContent(current, merged)
  globalSnapshot = merged
  await writeSnapshotFile('global.json', merged).catch((error: any) => {
    logger.warn('[tencent-data] failed to persist snapshot:', error?.message)
  })
  if (changed) {
    logger.info('[tencent-data] snapshot updated', {
      source: merged.mirrorHash ? 'mirror' : 'direct',
      statDate: merged.statDate,
      augments: merged.augmentStats.length,
      champions: merged.championStats.length,
    })
    notifyUpdated()
  }
  return merged
}

// 返回 null 表示镜像不可用，需要回退直连掌盟。
async function syncGlobalViaMirror(baseUrl: string): Promise<TencentGlobalSnapshot | null> {
  try {
    mirrorManifest = await fetchMirrorManifest(baseUrl, requestRaw)
    const result = await syncGlobalFromMirror(baseUrl, globalSnapshot?.mirrorHash || null, mirrorManifest, requestRaw)
    if (result.status === 'unchanged') {
      return globalSnapshot
    }

    const championStats = parseHeroRank(unwrapOdpPayload(result.hero))
    return await commitGlobalSnapshot(
      buildGlobalSnapshot(result.names, result.rune, championStats, {
        mirrorHash: result.hash,
        sourceFetchedAt: result.sourceFetchedAt,
        ...(result.localizedNames ? { localizedNames: result.localizedNames } : {}),
        ...(result.gamePatch ? { gamePatch: result.gamePatch } : {}),
      })
    )
  } catch (error: any) {
    mirrorManifest = null
    logger.warn('[tencent-data] mirror unavailable; falling back to direct:', error?.message)
    return null
  }
}

async function runStartupSync(): Promise<TencentGlobalSnapshot | null> {
  if (!globalDiskLoaded) {
    globalDiskLoaded = true
    globalSnapshot = globalSnapshot || (await readSnapshotFile<TencentGlobalSnapshot>('global.json'))
  }

  try {
    const baseUrl = getTencentMirrorBaseUrl()
    const fromMirror = baseUrl ? await syncGlobalViaMirror(baseUrl) : null
    if (fromMirror) {
      return fromMirror
    }

    return await commitGlobalSnapshot(await fetchDirectGlobalSnapshot())
  } catch (error: any) {
    logger.warn('[tencent-data] startup sync failed; keeping local snapshot:', error?.message)
    return globalSnapshot
  }
}

// 每次启动调用一次：先比对镜像 manifest，内容有变化才下载替换本地；镜像不可用时直连掌盟一次。
export function syncTencentDataOnStartup(): Promise<TencentGlobalSnapshot | null> {
  if (!isTencentDataEnabled()) {
    return Promise.resolve(null)
  }

  if (!startupSyncPromise) {
    startupSyncPromise = runStartupSync()
  }

  return startupSyncPromise
}

export async function getTencentGlobalSnapshot(): Promise<TencentGlobalSnapshot | null> {
  if (!isTencentDataEnabled()) {
    return null
  }

  if (!globalDiskLoaded) {
    globalDiskLoaded = true
    globalSnapshot = globalSnapshot || (await readSnapshotFile<TencentGlobalSnapshot>('global.json'))
  }

  if (globalSnapshot) {
    return globalSnapshot
  }

  return withTimeout(syncTencentDataOnStartup(), FIRST_LOAD_WAIT_MS)
}

async function commitChampionSnapshot(next: TencentChampionSnapshot): Promise<TencentChampionSnapshot> {
  const previous = championSnapshots.get(next.championId) || null
  const merged = previous && isOlderSource(next, previous) ? { ...previous, mirrorHash: next.mirrorHash } : next
  championSnapshots.set(next.championId, merged)
  await writeSnapshotFile(championFileName(next.championId), merged).catch(() => {})
  if (previous && !sameContent(previous, merged)) {
    notifyUpdated()
  }
  return merged
}

function buildChampionSnapshot(
  championId: string,
  payload: any,
  extra: Partial<TencentChampionSnapshot> = {}
): TencentChampionSnapshot {
  const augments = parseChampionAugments(unwrapOdpPayload(payload))
  if (augments.length === 0) {
    throw new Error('no augment rows')
  }

  return { fetchedAt: new Date().toISOString(), championId, augments, ...extra }
}

// 返回 undefined 表示镜像帮不上忙（不可用或没有这个英雄），需要回退直连。
async function syncChampionViaMirror(
  baseUrl: string,
  championId: string,
  local: TencentChampionSnapshot | null
): Promise<TencentChampionSnapshot | null | undefined> {
  if (!mirrorManifest) {
    return undefined
  }

  try {
    const result = await syncChampionFromMirror(baseUrl, championId, local?.mirrorHash || null, mirrorManifest, requestRaw)
    if (result.status === 'missing') {
      return undefined
    }

    if (result.status === 'unchanged') {
      return local
    }

    return await commitChampionSnapshot(
      buildChampionSnapshot(championId, result.payload, {
        mirrorHash: result.hash,
        sourceFetchedAt: result.sourceFetchedAt,
      })
    )
  } catch (error: any) {
    logger.warn(`[tencent-data] mirror champion ${championId} unavailable; falling back to direct:`, error?.message)
    return undefined
  }
}

async function syncChampion(championId: string, local: TencentChampionSnapshot | null): Promise<TencentChampionSnapshot | null> {
  await withTimeout(syncTencentDataOnStartup(), FIRST_LOAD_WAIT_MS)

  try {
    const baseUrl = getTencentMirrorBaseUrl()
    const fromMirror = baseUrl ? await syncChampionViaMirror(baseUrl, championId, local) : undefined
    if (fromMirror !== undefined) {
      return fromMirror
    }

    const payload = await requestJson(`${ODP_ORIGIN}/fuwen_hero_rank?championid=${encodeURIComponent(championId)}`)
    return await commitChampionSnapshot(buildChampionSnapshot(championId, payload))
  } catch (error: any) {
    logger.warn(`[tencent-data] champion ${championId} sync failed; keeping local:`, error?.message)
    return local
  }
}

export async function getTencentChampionSnapshot(
  championIdInput: string | number
): Promise<TencentChampionSnapshot | null> {
  const championId = String(championIdInput)
  if (!isTencentDataEnabled() || !/^\d+$/.test(championId)) {
    return null
  }

  let local = championSnapshots.get(championId) || null
  if (!local) {
    local = await readSnapshotFile<TencentChampionSnapshot>(championFileName(championId))
    if (local) {
      championSnapshots.set(championId, local)
    }
  }

  // 本次运行内每个英雄只同步一次。
  let pending = championSyncPromises.get(championId)
  if (!pending) {
    pending = syncChampion(championId, local)
    championSyncPromises.set(championId, pending)
  }

  return (await withTimeout(pending, CHAMPION_LOAD_WAIT_MS)) || championSnapshots.get(championId) || local
}
