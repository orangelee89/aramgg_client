import { app } from 'electron'
import { getActiveDataStatus, loadDataApiConfig } from './data-loader.ts'
import { getChangelogEntries } from './changelog.ts'
import logger from './modules/logger.ts'
import { IS_FORK_BUILD } from './fork-info.ts'
import { getTencentGlobalSnapshot } from './services/tencent-data/tencent-data-service.ts'

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/
type VersionSeverity = 'unknown' | 'none' | 'major' | 'minor' | 'patch'

type VersionComparison = {
  severity: VersionSeverity
  shouldPrompt: boolean
  isNewer: boolean
}

function parseVersion(version: unknown): number[] | null {
  const match = VERSION_PATTERN.exec(String(version || '').trim())
  if (!match) {
    return null
  }

  return match.slice(1).map((part) => Number(part))
}

function compareVersion(currentVersion: unknown, latestVersion: unknown): VersionComparison {
  const current = parseVersion(currentVersion)
  const latest = parseVersion(latestVersion)

  if (!current || !latest) {
    return {
      severity: 'unknown',
      shouldPrompt: false,
      isNewer: false,
    }
  }

  const isNewer =
    latest[0] > current[0] ||
    (latest[0] === current[0] && latest[1] > current[1]) ||
    (latest[0] === current[0] && latest[1] === current[1] && latest[2] > current[2])

  if (!isNewer) {
    return {
      severity: 'none',
      shouldPrompt: false,
      isNewer: false,
    }
  }

  if (latest[0] !== current[0]) {
    return {
      severity: 'major',
      shouldPrompt: true,
      isNewer: true,
    }
  }

  if (latest[1] !== current[1]) {
    return {
      severity: 'minor',
      shouldPrompt: true,
      isNewer: true,
    }
  }

  return {
    severity: 'patch',
    shouldPrompt: false,
    isNewer: true,
  }
}

function isVersionLowerThan(currentVersion: unknown, targetVersion: unknown): boolean {
  const comparison = compareVersion(currentVersion, targetVersion)
  return comparison.isNewer
}

function getSeverityText(severity: VersionSeverity): string {
  if (severity === 'major') {
    return '最好更新'
  }

  if (severity === 'minor') {
    return '建议更新'
  }

  if (severity === 'patch') {
    return '有小版本更新'
  }

  return '已是最新'
}

// 掌盟数据由自建镜像每天同步，界面显示镜像记录的正式服补丁号和统计日期，而不是 aramgg 的数据包版本。
function getTencentDisplayVersion(snapshot: Awaited<ReturnType<typeof getTencentGlobalSnapshot>>) {
  const gamePatch = snapshot?.gamePatch || ''
  if (!gamePatch) {
    return null
  }

  const statDate = /^\d{4}-(\d{2}-\d{2})$/.exec(snapshot?.statDate || '')?.[1]
  return {
    gamePatch,
    dataVersion: statDate ? `${gamePatch} · ${statDate}` : gamePatch,
  }
}

export async function getVersionInfo() {
  const [config, activeData, tencentSnapshot] = await Promise.all([
    loadDataApiConfig(),
    getActiveDataStatus(),
    getTencentGlobalSnapshot().catch(() => null),
  ])
  const currentVersion = app.getVersion()
  // fork 有独立版本号，不跟上游 aramgg 的最新/最低版本比较，否则会一直提示更新到官方版。
  const clientConfig = IS_FORK_BUILD ? {} : config?.client || config?.electron || {}
  const tencentVersion = getTencentDisplayVersion(tencentSnapshot)
  const latestVersion = clientConfig.latestVersion || ''
  const minimumVersion = clientConfig.minimumVersion || ''
  const comparison = compareVersion(currentVersion, latestVersion)
  const isBelowMinimumVersion = minimumVersion
    ? isVersionLowerThan(currentVersion, minimumVersion)
    : false
  const shouldPrompt = comparison.shouldPrompt || isBelowMinimumVersion

  return {
    currentVersion,
    latestVersion,
    downloadUrl: clientConfig.downloadUrl || '',
    autoUpdateEnabled: clientConfig.autoUpdateEnabled === true,
    updateFeedUrl: clientConfig.updateFeedUrl || '',
    minimumVersion,
    dataVersion: tencentVersion?.dataVersion || activeData?.dataVersion || config?.dataVersion || '',
    locale: activeData?.locale || config?.locale || '',
    gamePatch: tencentVersion?.gamePatch || activeData?.gamePatch || config?.gamePatch || '',
    apiRelease: config?.apiRelease ?? null,
    generatedAt: activeData?.generatedAt || config?.generatedAt || '',
    publishedAt: config?.publishedAt || '',
    severity: comparison.severity,
    shouldPrompt,
    isNewer: comparison.isNewer,
    isBelowMinimumVersion,
    statusText: getSeverityText(comparison.severity),
    changelog: IS_FORK_BUILD ? getChangelogEntries({}, {}) : getChangelogEntries(config, clientConfig),
  }
}

export async function checkForClientUpdate() {
  let versionInfo

  try {
    versionInfo = await getVersionInfo()
  } catch (error) {
    logger.warn(
      'Failed to check remote client version:',
      error instanceof Error ? error.message : String(error)
    )
    return null
  }

  if (!versionInfo.shouldPrompt) {
    return versionInfo
  }

  logger.info('[update] client update available', {
    currentVersion: versionInfo.currentVersion,
    latestVersion: versionInfo.latestVersion,
    minimumVersion: versionInfo.minimumVersion || null,
    severity: versionInfo.severity,
    isBelowMinimumVersion: versionInfo.isBelowMinimumVersion,
    hasDownloadUrl: !!versionInfo.downloadUrl,
  })

  return versionInfo
}
