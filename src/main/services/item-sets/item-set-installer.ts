import logger from '../../modules/logger.ts'
import { getLCUServiceInstance } from '../lcu/lcu-service.ts'
import {
  loadChampionBuild,
  loadChampionName,
} from '../../data-loader.ts'

type SingleChampionItemSetInstallOptions = {
  championId: string | number
  builds?: any[]
  championName?: ChampionLike | null
}

type ChampionLike = {
  championId?: string | number
  id?: string | number
  nameEN?: string
  alias?: string
  nameCN?: string
}

type BuildRecord = {
  id?: string | number
  itemId?: string | number
  itemIds?: Array<string | number>
  items?: Array<string | number>
  winRate?: number
  pick_rate?: number
  win_rate?: number
  pickRate?: number
  games?: number
  averageIndex?: number
  distinctiveScore?: number
  distinctive_score?: number
}

type ChampionInstallResult = {
  championId: number
  championKey: string
  lcuSuccess?: boolean
  lcuError?: string | null
  lcuMethod?: string | null
  lcuStatus?: number | null
  lcuRemovedCount?: number | null
  lcuItemSetCount?: number | null
  localRemovedCount?: number | null
  localWrittenCount?: number | null
  writtenItemSetCount?: number | null
  success: boolean
  skipped?: boolean
  reason?: string
}

const SUMMONERS_RIFT_MAP_ID = 11
const ARAM_MAP_ID = 12
const MIN_RECOMMENDATION_GAMES = 2
const MIN_BUILD_GAMES = 300
const MIN_CORE_SEQUENCE_GAMES = 20
const MAX_ITEM_SETS_PER_CHAMPION = 4
// 写进 LoL 客户端的推荐页分区与英雄详情窗口（AugmentWinrateOverlay.vue）保持一致：
// 出门装 ×2 → 核心 1～4（每组一套三件）→ 完整出装 ×3 → 后续装备 ×12 → 备选装备 ×12。
const MAX_STARTING_SEQUENCES = 2
const MAX_CORE_SEQUENCES = 4
const MAX_FULL_BUILD_SEQUENCES = 3
const MAX_LATER_ITEMS = 12
const MAX_SITUATIONAL_ITEMS = 12
const ITEM_SET_SORT_RANK = 100

function getChampionId(champion: ChampionLike): number {
  return Number(champion.championId ?? champion.id ?? 0)
}

function getChampionKey(champion: ChampionLike, championName: ChampionLike | null = null): string {
  const rawKey = champion.alias || champion.nameEN || championName?.alias || championName?.nameEN || ''
  return String(rawKey).replace(/[^a-zA-Z0-9]/g, '')
}

function normalizeItemIds(record: BuildRecord): string[] {
  const ids = Array.isArray(record?.itemIds) ? record.itemIds : record?.items
  if (Array.isArray(ids)) {
    return ids.map((id) => String(id).trim()).filter(Boolean)
  }

  const singleId = record?.itemId ?? record?.id
  if (singleId != null && singleId !== '') {
    return [String(singleId).trim()].filter(Boolean)
  }

  return []
}

function getRecordGames(record: BuildRecord): number {
  const games = Number(record?.games || 0)
  return Number.isFinite(games) ? games : 0
}

function getRecordPickRate(record: BuildRecord): number {
  const pickRate = Number(record?.pickRate ?? record?.pick_rate ?? 0)
  return Number.isFinite(pickRate) ? pickRate : 0
}

function hasRecommendationEvidence(record: BuildRecord): boolean {
  return getRecordGames(record) >= MIN_RECOMMENDATION_GAMES || getRecordPickRate(record) > 0
}

function compareRecordsByConfidence(left: BuildRecord, right: BuildRecord): number {
  const gamesDiff = getRecordGames(right) - getRecordGames(left)
  if (gamesDiff !== 0) {
    return gamesDiff
  }

  const pickDiff = getRecordPickRate(right) - getRecordPickRate(left)
  if (pickDiff !== 0) {
    return pickDiff
  }

  return Number(right?.winRate || 0) - Number(left?.winRate || 0)
}

function getTrustedRecords(records: BuildRecord[]): BuildRecord[] {
  return records
    .filter(hasRecommendationEvidence)
    .sort(compareRecordsByConfidence)
}

function getBestCoreGames(records: BuildRecord[]): number {
  return records.reduce((best, record) => Math.max(best, getRecordGames(record)), 0)
}

function getBuildGames(build: any): number {
  const games = Number(build?.games ?? build?.stats?.games ?? 0)
  return Number.isFinite(games) ? games : 0
}

function getBuildTags(build: any): string[] {
  const rawTags = build?.tags && typeof build.tags === 'object'
    ? Object.values(build.tags)
    : []
  const values = [
    build?.buildTags,
    ...(rawTags as any[]),
  ]
  const seen = new Set<string>()

  return values
    .flatMap((value) => String(value || '').split(','))
    .map((value) => value.trim())
    .filter((value) => {
      if (!value) {
        return false
      }

      const key = value.toLowerCase()
      if (seen.has(key)) {
        return false
      }

      seen.add(key)
      return true
    })
}

function getBuildTitleTag(build: any, index: number): string {
  const tags = getBuildTags(build)
  if (tags.length) {
    return tags.join(' / ')
  }

  return build?.tier || build?.role || `Build ${index + 1}`
}

function getBuildSkipReason(build: any): string | null {
  const coreRecords = build?.coreItems || build?.recommended || []
  const buildGames = getBuildGames(build)
  const bestCoreGames = getBestCoreGames(coreRecords)
  const hasRateBasedCore = coreRecords.some((record: BuildRecord) => getRecordPickRate(record) > 0)

  if (buildGames < MIN_BUILD_GAMES && !hasRateBasedCore) {
    return `low-build-games:${buildGames}`
  }

  if (bestCoreGames < MIN_CORE_SEQUENCE_GAMES && !hasRateBasedCore) {
    return `low-core-games:${bestCoreGames}`
  }

  return null
}

function collectBuilds(builds: any): any[] {
  const records: any[] = Array.isArray(builds)
    ? builds
    : Array.isArray(builds?.builds)
      ? builds.builds
      : []

  const seen = new Set<string>()
  return records
    .filter((build) => build && typeof build === 'object' && !Array.isArray(build))
    .filter((build) => {
      const coreKey = Array.isArray(build?.coreItems)
        ? build.coreItems
          .slice(0, 3)
          .map((record: BuildRecord) => normalizeItemIds(record).join('-'))
          .join('|')
        : ''
      const key = `${getBuildTags(build).join('|')}:${coreKey}:${build?.role || ''}:${build?.tier || ''}`
      if (seen.has(key)) {
        return false
      }

      seen.add(key)
      return true
    })
    .slice(0, MAX_ITEM_SETS_PER_CHAMPION)
}

function normalizePercent(value: unknown): number | null {
  const numberValue = Number(value)
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    return null
  }

  return numberValue <= 1 ? numberValue * 100 : numberValue
}

function toBlockItems(itemIds: string[]) {
  return itemIds.map((id) => ({
    id,
    count: 1,
  }))
}

/**
 * 块标题里的紧凑统计：`（631场 胜率54.0%）`；没有场次只有选取率时显示 `（选取16.1%）`。
 */
function formatCompactStats(record: { games?: number; pickRate?: number; winRate?: number } | null | undefined): string {
  if (!record) {
    return ''
  }

  const parts = []
  const games = Number(record.games || 0)
  const winRate = normalizePercent(record.winRate)
  const pickRate = normalizePercent(record.pickRate)

  if (games > 0) {
    parts.push(`${Math.round(games)}场`)
  } else if (pickRate) {
    parts.push(`选取${pickRate.toFixed(1)}%`)
  }

  if (winRate) {
    parts.push(`胜率${winRate.toFixed(1)}%`)
  }

  return parts.length ? `（${parts.join(' ')}）` : ''
}

/**
 * 每条记录一块：`核心 1（631场 胜率54.0%）`，顺序与详情页一致（场次 → 选取率 → 胜率）。
 */
function createSequenceBlocks(records: BuildRecord[], label: string, limit: number) {
  return getTrustedRecords(records)
    .map((record) => ({
      record,
      itemIds: normalizeItemIds(record),
    }))
    .filter(({ itemIds }) => itemIds.length > 0)
    .slice(0, limit)
    .map(({ record, itemIds }, index) => ({
      type: `${label} ${index + 1}${formatCompactStats(record)}`,
      items: toBlockItems(itemIds),
    }))
}

function getDistinctiveScore(record: BuildRecord): number {
  const score = Number(record?.distinctiveScore ?? record?.distinctive_score ?? record?.averageIndex ?? 0)
  return Number.isFinite(score) ? score : 0
}

// 备选装备按"区分度"排序：这件装备相对该英雄常规出装有多特别，和详情页同一规则。
function compareSituationalRecords(left: BuildRecord, right: BuildRecord): number {
  const scoreDiff = getDistinctiveScore(right) - getDistinctiveScore(left)
  return scoreDiff !== 0 ? scoreDiff : compareRecordsByConfidence(left, right)
}

/**
 * 把记录里的所有装备摊平成单件（后续装备的 step 2 记录含两件），排序后去重，合成一块。
 */
function createFlattenedItemBlock(
  records: BuildRecord[],
  title: string,
  limit: number,
  compareRecords: (left: BuildRecord, right: BuildRecord) => number = compareRecordsByConfidence
) {
  const seen = new Set<string>()
  const itemIds = records
    .filter(hasRecommendationEvidence)
    .flatMap((record) => normalizeItemIds(record).map((itemId) => ({ ...record, itemId, itemIds: [itemId] })))
    .sort(compareRecords)
    .map((record) => record.itemId as string)
    .filter((itemId) => {
      if (!itemId || seen.has(itemId)) {
        return false
      }

      seen.add(itemId)
      return true
    })
    .slice(0, limit)

  if (!itemIds.length) {
    return []
  }

  return [
    {
      type: title,
      items: toBlockItems(itemIds),
    },
  ]
}

function createItemSet(
  champion: ChampionLike,
  _championName: ChampionLike | null,
  build: any,
  index: number
) {
  const championId = getChampionId(champion)
  const buildTag = getBuildTitleTag(build, index)
  const coreRecords = build?.coreItems || build?.recommended || []
  const blocks = [
    ...createSequenceBlocks(build?.startingItems || [], '出门装', MAX_STARTING_SEQUENCES),
    ...createSequenceBlocks(coreRecords, '核心', MAX_CORE_SEQUENCES),
    ...createSequenceBlocks(build?.fullItems || [], '完整出装', MAX_FULL_BUILD_SEQUENCES),
    ...createFlattenedItemBlock(build?.itemExtensions || [], '后续装备', MAX_LATER_ITEMS),
    ...createFlattenedItemBlock(
      build?.situationalItems || [],
      '备选装备',
      MAX_SITUATIONAL_ITEMS,
      compareSituationalRecords
    ),
  ]

  if (!championId || !blocks.length) {
    return null
  }

  // sortrank 高的排在前面，OP.GG 桌面端写的页是 1，这里用 100 保证 ARAMGG 页默认选中。
  return {
    title: buildTag,
    associatedMaps: [SUMMONERS_RIFT_MAP_ID, ARAM_MAP_ID],
    associatedChampions: [championId],
    blocks,
    map: 'any',
    mode: 'any',
    preferredItemSlots: [],
    sortrank: ITEM_SET_SORT_RANK,
    sortRank: ITEM_SET_SORT_RANK,
    startedFrom: 'blank',
    type: 'custom',
  }
}

export function createItemSets(champion: ChampionLike, championName: ChampionLike | null, builds: any): {
  itemSets: any[]
  skippedBuilds: Array<{ title: string; reason: string }>
  totalBuilds: number
} {
  const trustedBuilds = collectBuilds(builds)
  const itemSets: any[] = []
  const skippedBuilds: Array<{ title: string; reason: string }> = []

  trustedBuilds.forEach((build, index) => {
    const title = getBuildTitleTag(build, index)
    const skipReason = getBuildSkipReason(build)
    if (skipReason) {
      skippedBuilds.push({ title, reason: skipReason })
      return
    }

    const itemSet = createItemSet(champion, championName, build, index)
    if (itemSet) {
      // 标签直接用出装路线名（与英雄详情页一致，如 "Tank"、"AD / Bruiser"）；重名时加序号。
      const duplicates = itemSets.filter((existing) => existing.title === title || existing.title.startsWith(`${title} `)).length
      itemSet.title = duplicates === 0 ? title : `${title} ${duplicates + 1}`
      itemSets.push(itemSet)
    } else {
      skippedBuilds.push({ title, reason: 'missing-build-blocks' })
    }
  })

  return {
    itemSets,
    skippedBuilds,
    totalBuilds: trustedBuilds.length,
  }
}

function withItemSetUid(itemSet: any, index = 0): any {
  return {
    ...itemSet,
    uid: index === 0 ? 'aramgg-aram-current' : `aramgg-aram-current-${index + 1}`,
  }
}

function formatInstallError(reason: string | null | undefined): string {
  if (reason === 'low-confidence-build-data') {
    return '出装样本不足，已跳过写入'
  }

  if (reason === 'missing-build-data' || reason === 'missing-build-blocks') {
    return '没有可用的出装数据'
  }

  if (reason === 'missing-champion-key') {
    return '未识别到英雄名称，无法写入出装'
  }

  return reason || '装备推荐写入失败'
}

async function installCurrentItemSets(itemSets: any[], championKey: string): Promise<{
  success: boolean
  error: string | null
  method: string | null
  status: number | null
  removedCount: number | null
  itemSetCount: number | null
  localRemovedCount: number | null
  localWrittenCount: number | null
}> {
  const managedItemSets = itemSets.map((itemSet, index) => withItemSetUid(itemSet, index))

  try {
    const service = getLCUServiceInstance()
    logger.info('[item-set] LCU item set sync requested', {
      championKey,
      itemSetCount: managedItemSets.length,
      titles: managedItemSets.map((itemSet) => itemSet?.title || null),
      blockCounts: managedItemSets.map((itemSet) =>
        Array.isArray(itemSet?.blocks) ? itemSet.blocks.length : 0
      ),
    })
    const result = await service.syncItemSets(managedItemSets)

    return {
      success: result.success,
      error: result.success ? null : result.error || 'LCU 装备同步失败',
      method: result.method || null,
      status: result.status || null,
      removedCount: result.removedCount ?? null,
      itemSetCount: result.itemSetCount ?? null,
      localRemovedCount: 0,
      localWrittenCount: 0,
    }
  } catch (error) {
    const err = error as Error
    return {
      success: false,
      error: err.message,
      method: null,
      status: null,
      removedCount: null,
      itemSetCount: null,
      localRemovedCount: 0,
      localWrittenCount: 0,
    }
  }
}

async function installChampionItemSet(
  champion: ChampionLike,
  providedBuilds: any[] | null = null,
  providedChampionName: ChampionLike | null = null
): Promise<ChampionInstallResult> {
  const championId = getChampionId(champion)

  try {
    const hasProvidedBuilds = Array.isArray(providedBuilds)
    const hasProvidedChampionName = providedChampionName && typeof providedChampionName === 'object'
    const [buildData, championName] = await Promise.all([
      hasProvidedBuilds ? Promise.resolve(null) : loadChampionBuild(championId),
      hasProvidedChampionName ? Promise.resolve(providedChampionName) : loadChampionName(championId),
    ])
    const builds = hasProvidedBuilds ? providedBuilds : buildData?.builds
    const championKey = getChampionKey(champion, championName)

    if (!championId || !championKey) {
      return {
        championId,
        championKey,
        writtenItemSetCount: 0,
        success: false,
        skipped: true,
        reason: 'missing-champion-key',
      }
    }

    const buildItemSets = createItemSets(champion, championName, builds)
    if (buildItemSets.skippedBuilds.length > 0) {
      logger.info('[item-set] builds skipped', {
        championId,
        championKey,
        totalBuilds: buildItemSets.totalBuilds,
        skippedBuilds: buildItemSets.skippedBuilds,
      })
    }

    if (!buildItemSets.itemSets.length) {
      const clearResult = await installCurrentItemSets([], championKey)
      return {
        championId,
        championKey,
        lcuSuccess: clearResult.success,
        lcuError: clearResult.error,
        lcuMethod: clearResult.method,
        lcuStatus: clearResult.status,
        lcuRemovedCount: clearResult.removedCount,
        lcuItemSetCount: clearResult.itemSetCount,
        localRemovedCount: clearResult.localRemovedCount,
        localWrittenCount: clearResult.localWrittenCount,
        writtenItemSetCount: 0,
        success: false,
        skipped: true,
        reason: buildItemSets.totalBuilds > 0
          ? 'low-confidence-build-data'
          : 'missing-build-data',
      }
    }

    const installResult = await installCurrentItemSets(buildItemSets.itemSets, championKey)

    if (!installResult.success) {
      logger.warn('[item-set] item set install failed:', installResult.error)
    }

    return {
      championId,
      championKey,
      lcuSuccess: installResult.success,
      lcuError: installResult.error,
      lcuMethod: installResult.method,
      lcuStatus: installResult.status,
      lcuRemovedCount: installResult.removedCount,
      lcuItemSetCount: installResult.itemSetCount,
      localRemovedCount: installResult.localRemovedCount,
      localWrittenCount: installResult.localWrittenCount,
      writtenItemSetCount: installResult.success ? buildItemSets.itemSets.length : 0,
      success: installResult.success,
      reason: installResult.success ? undefined : installResult.error || '装备推荐写入失败',
    }
  } catch (error) {
    const err = error as Error
    logger.warn(`[item-set] failed to install champion ${championId}:`, err.message)
    return {
      championId,
      championKey: getChampionKey(champion),
      writtenItemSetCount: 0,
      success: false,
      reason: err.message,
    }
  }
}

export async function getAramItemSetInstallStatus() {
  return {
    success: true,
    installed: false,
    installedCount: 0,
    mode: 'lcu',
  }
}

export async function installAramItemSetForChampion(options: SingleChampionItemSetInstallOptions) {
  const startedAt = Date.now()
  const championId = Number(options.championId)

  if (!Number.isFinite(championId) || championId <= 0) {
    throw new Error('英雄 ID 无效')
  }

  const result = await installChampionItemSet(
    { championId },
    Array.isArray(options.builds) ? options.builds : null,
    options.championName || null
  )

  logger.info('[item-set] ARAM item set install completed', {
    championId,
    championKey: result.championKey || null,
    success: result.success,
    skipped: result.skipped || false,
    reason: result.reason || null,
    lcuSuccess: result.lcuSuccess || false,
    lcuError: result.lcuError || null,
    lcuMethod: result.lcuMethod || null,
    lcuStatus: result.lcuStatus || null,
    lcuRemovedCount: result.lcuRemovedCount ?? null,
    lcuItemSetCount: result.lcuItemSetCount ?? null,
    localRemovedCount: result.localRemovedCount ?? null,
    localWrittenCount: result.localWrittenCount ?? null,
    writtenItemSetCount: result.writtenItemSetCount ?? null,
    durationMs: Date.now() - startedAt,
  })

  return {
    success: result.success,
    championId,
    championKey: result.championKey,
    mode: 'lcu',
    lcuSuccess: result.lcuSuccess || false,
    lcuError: result.lcuError || null,
    lcuMethod: result.lcuMethod || null,
    lcuStatus: result.lcuStatus || null,
    lcuRemovedCount: result.lcuRemovedCount ?? null,
    lcuItemSetCount: result.lcuItemSetCount ?? null,
    localRemovedCount: result.localRemovedCount ?? null,
    localWrittenCount: result.localWrittenCount ?? null,
    writtenItemSetCount: result.writtenItemSetCount ?? null,
    skipped: result.skipped || false,
    reason: result.reason || null,
    error: result.success ? null : formatInstallError(result.reason),
    durationMs: Date.now() - startedAt,
  }
}
