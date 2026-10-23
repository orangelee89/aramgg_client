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
} from './tencent-parsers.ts'
import type { TencentChampionSnapshot, TencentGlobalSnapshot } from './tencent-overlay.ts'

const ODP_ORIGIN = 'https://mlol.qt.qq.com/go/battle_info/odp_proxy'
const AUGMENT_NAMES_URL = 'https://game.gtimg.cn/images/lol/act/img/js/kiwi/kiwi_augments.json'

const REFRESH_INTERVAL_MS = 3 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 10 * 1000
const FIRST_LOAD_WAIT_MS = 8 * 1000
const CHAMPION_FIRST_LOAD_WAIT_MS = 4 * 1000
const MIN_AUGMENT_ROWS = 50
const MIN_CHAMPION_ROWS = 50
const SNAPSHOT_SCHEMA_VERSION = 1

let electronFetch: any = null
let globalSnapshot: TencentGlobalSnapshot | null = null
let globalDiskLoaded = false
let globalRefreshPromise: Promise<TencentGlobalSnapshot | null> | null = null
let autoRefreshTimer: ReturnType<typeof setInterval> | null = null
const championSnapshots = new Map<string, TencentChampionSnapshot>()
const championRefreshPromises = new Map<string, Promise<TencentChampionSnapshot | null>>()
const updateListeners = new Set<() => void>()

export function isTencentDataEnabled(): boolean {
  return process.env.ARAMGG_DISABLE_TENCENT_DATA !== '1'
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

async function requestJson(url: string): Promise<any> {
  const transportFetch = await getTransportFetch()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await transportFetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    return JSON.parse(await response.text())
  } finally {
    clearTimeout(timeout)
  }
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
  return path.join(getAppDataDir(), 'tencent-data')
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

function isStale(fetchedAt: string | undefined): boolean {
  const time = fetchedAt ? Date.parse(fetchedAt) : NaN
  return !Number.isFinite(time) || Date.now() - time > REFRESH_INTERVAL_MS
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

async function fetchChampionStats() {
  for (const daysAgo of [1, 2]) {
    const payload = await requestJson(`${ODP_ORIGIN}/fuwen_aram_hero_rank_v2?dtstatdate=${getStatDate(daysAgo)}`)
    const stats = parseHeroRank(unwrapOdpPayload(payload))
    if (stats.length >= MIN_CHAMPION_ROWS) {
      return stats
    }
  }

  throw new Error('hero rank returned too few rows')
}

async function fetchGlobalSnapshot(): Promise<TencentGlobalSnapshot> {
  const [namesPayload, runePayload, championStats] = await Promise.all([
    requestJson(AUGMENT_NAMES_URL),
    requestJson(`${ODP_ORIGIN}/fuwen_aram_rune_rank_v2?augmentid_level=255`),
    fetchChampionStats(),
  ])
  const augments = parseKiwiAugments(namesPayload)
  const runeInner = unwrapOdpPayload(runePayload)
  const augmentStats = parseAugmentRank(runeInner)

  if (augments.length < MIN_AUGMENT_ROWS || augmentStats.length < MIN_AUGMENT_ROWS) {
    throw new Error(`unexpected augment data shape (names=${augments.length}, stats=${augmentStats.length})`)
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
  }
}

function sameContent(left: unknown, right: unknown, ignore: string[]): boolean {
  const strip = (value: any) => {
    if (!value) return value
    const copy = { ...value }
    for (const key of ignore) delete copy[key]
    return JSON.stringify(copy)
  }

  return strip(left) === strip(right)
}

export function refreshTencentGlobalSnapshot(): Promise<TencentGlobalSnapshot | null> {
  if (!isTencentDataEnabled()) {
    return Promise.resolve(null)
  }

  if (!globalRefreshPromise) {
    globalRefreshPromise = (async () => {
      try {
        const next = await fetchGlobalSnapshot()
        const changed = !sameContent(globalSnapshot, next, ['fetchedAt'])
        globalSnapshot = next
        await writeSnapshotFile('global.json', next).catch((error: any) => {
          logger.warn('[tencent-data] failed to persist snapshot:', error?.message)
        })
        if (changed) {
          logger.info('[tencent-data] snapshot updated', {
            statDate: next.statDate,
            augments: next.augmentStats.length,
            champions: next.championStats.length,
          })
          championSnapshots.clear()
          notifyUpdated()
        }
        return next
      } catch (error: any) {
        logger.warn('[tencent-data] refresh failed; keeping previous snapshot:', error?.message)
        return globalSnapshot
      } finally {
        globalRefreshPromise = null
      }
    })()
  }

  return globalRefreshPromise
}

export async function getTencentGlobalSnapshot(): Promise<TencentGlobalSnapshot | null> {
  if (!isTencentDataEnabled()) {
    return null
  }

  if (!globalDiskLoaded) {
    globalDiskLoaded = true
    globalSnapshot = globalSnapshot || (await readSnapshotFile<TencentGlobalSnapshot>('global.json'))
  }

  if (!globalSnapshot) {
    return withTimeout(refreshTencentGlobalSnapshot(), FIRST_LOAD_WAIT_MS)
  }

  if (isStale(globalSnapshot.fetchedAt)) {
    void refreshTencentGlobalSnapshot()
  }

  return globalSnapshot
}

function refreshChampionSnapshot(championId: string): Promise<TencentChampionSnapshot | null> {
  const pending = championRefreshPromises.get(championId)
  if (pending) {
    return pending
  }

  const request = (async () => {
    try {
      const payload = await requestJson(`${ODP_ORIGIN}/fuwen_hero_rank?championid=${encodeURIComponent(championId)}`)
      const augments = parseChampionAugments(unwrapOdpPayload(payload))
      if (augments.length === 0) {
        throw new Error('no augment rows')
      }

      const snapshot: TencentChampionSnapshot = {
        fetchedAt: new Date().toISOString(),
        championId,
        augments,
      }
      const previous = championSnapshots.get(championId)
      championSnapshots.set(championId, snapshot)
      await writeSnapshotFile(path.join('champions', `${championId}.json`), snapshot).catch(() => {})
      if (previous && !sameContent(previous, snapshot, ['fetchedAt'])) {
        notifyUpdated()
      }
      return snapshot
    } catch (error: any) {
      logger.warn(`[tencent-data] champion ${championId} refresh failed:`, error?.message)
      return championSnapshots.get(championId) || null
    } finally {
      championRefreshPromises.delete(championId)
    }
  })()

  championRefreshPromises.set(championId, request)
  return request
}

export async function getTencentChampionSnapshot(
  championIdInput: string | number
): Promise<TencentChampionSnapshot | null> {
  const championId = String(championIdInput)
  if (!isTencentDataEnabled() || !/^\d+$/.test(championId)) {
    return null
  }

  let snapshot = championSnapshots.get(championId) || null
  if (!snapshot) {
    snapshot = await readSnapshotFile<TencentChampionSnapshot>(path.join('champions', `${championId}.json`))
    if (snapshot) {
      championSnapshots.set(championId, snapshot)
    }
  }

  if (!snapshot) {
    return withTimeout(refreshChampionSnapshot(championId), CHAMPION_FIRST_LOAD_WAIT_MS)
  }

  if (isStale(snapshot.fetchedAt)) {
    void refreshChampionSnapshot(championId)
  }

  return snapshot
}

export function startTencentDataAutoRefresh(): void {
  if (!isTencentDataEnabled() || autoRefreshTimer) {
    return
  }

  void getTencentGlobalSnapshot()
  autoRefreshTimer = setInterval(() => {
    void refreshTencentGlobalSnapshot()
  }, REFRESH_INTERVAL_MS)
  autoRefreshTimer.unref?.()
}

export function stopTencentDataAutoRefresh(): void {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer)
    autoRefreshTimer = null
  }
}
