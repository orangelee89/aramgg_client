/**
 * 环境检测：海克斯高亮依赖的系统、显示、识别引擎、客户端连接和游戏设置逐项检查。
 * 首次打开主界面和用户点「重新检测」时运行，结果只用于展示和写日志，不改任何设置。
 */
import { execFile } from 'node:child_process'
import os from 'node:os'
import { screen } from 'electron'
import logger from '../modules/logger.ts'
import store from '../modules/app-store.ts'
import { shouldShowAugmentSidePanel, shouldShowAugmentTopOverlay } from '../modules/user-preferences.ts'
import { tryNormalizeDataLocale } from '../data-loader.ts'
import { probeOcrEngine } from '../image-analyzer.ts'
import { captureNativeScreenFrame, getNativeCaptureLoadError } from '../native-capture.ts'
import { getLCUServiceInstance } from './lcu/lcu-service.ts'
import type {
  EnvironmentCheckItem,
  EnvironmentCheckReport,
  EnvironmentCheckStatus,
} from '../../shared/ipc-contract.ts'

type Params = Record<string, string | number | boolean | null>

function item(id: string, status: EnvironmentCheckStatus, variant: string, params: Params = {}): EnvironmentCheckItem {
  return { id, status, variant, params }
}

const ASPECT_16_9 = 16 / 9

// ---------- 纯判断逻辑（单测覆盖） ----------

export function classifySystem(platform: NodeJS.Platform, arch: string, release: string): EnvironmentCheckItem {
  const params = { platform, arch, release }
  if (platform === 'win32') {
    const [major, , build] = release.split('.').map(Number)
    if (arch !== 'x64') return item('system', 'fail', 'winArch', params)
    if (major < 10 || (major === 10 && Number.isFinite(build) && build < 17763)) {
      return item('system', 'fail', 'winOld', params)
    }
    return item('system', 'pass', 'ok', params)
  }
  if (platform === 'darwin') {
    // Darwin 23 = macOS 14
    if (Number(release.split('.')[0]) < 23) return item('system', 'fail', 'macOld', params)
    return item('system', 'pass', 'ok', params)
  }
  return item('system', 'fail', 'unsupported', params)
}

export function classifyOcrEngine(result: { ready: boolean; modelsFound: boolean; error: string | null }, platform: NodeJS.Platform): EnvironmentCheckItem {
  if (result.ready) return item('ocrEngine', 'pass', 'ok')
  if (!result.modelsFound) return item('ocrEngine', 'fail', 'missingModels')
  const error = String(result.error || '')
  if (platform === 'win32' && /specified module could not be found|找不到指定的模块|dll/i.test(error)) {
    return item('ocrEngine', 'fail', 'missingRuntime', { error: error.slice(0, 160) })
  }
  return item('ocrEngine', 'fail', 'loadFailed', { error: error.slice(0, 160) || null })
}

/** 主显示器物理分辨率（游戏画面的实际像素）。 */
export function classifyDisplay(width: number, height: number): EnvironmentCheckItem {
  const params = { width, height }
  if (!width || !height) return item('display', 'skip', 'unknown')
  const ratio = width / height
  if (Math.abs(ratio - ASPECT_16_9) > 0.03) {
    return item('display', 'warn', 'aspect', { ...params, ratio: Number(ratio.toFixed(2)) })
  }
  if (width < 1280 || height < 720) return item('display', 'warn', 'lowRes', params)
  return item('display', 'pass', 'ok', params)
}

export function classifyMonitors(count: number): EnvironmentCheckItem {
  return count > 1 ? item('monitors', 'warn', 'multi', { count }) : item('monitors', 'pass', 'single', { count })
}

export function classifyLeagueClient(state: { connected: boolean; running: boolean | null; elevated: boolean | null }, platform: NodeJS.Platform): EnvironmentCheckItem {
  if (state.connected) return item('leagueClient', 'pass', 'connected')
  if (state.running === false) return item('leagueClient', 'warn', 'notRunning')
  if (platform === 'win32' && state.running && state.elevated === false) {
    return item('leagueClient', 'fail', 'privilege')
  }
  return item('leagueClient', 'fail', 'notConnected')
}

export function classifyGameLanguage(rawLocale: string | null): EnvironmentCheckItem {
  if (!rawLocale) return item('gameLanguage', 'skip', 'needClient')
  const locale = tryNormalizeDataLocale(rawLocale)
  if (locale) return item('gameLanguage', 'pass', 'ok', { raw: rawLocale, locale })
  // zh_MY、en_SG 这类地区变体没有专门映射，但游戏内文字仍是中文/英文，OCR 会把三种语言都试一遍。
  if (/^(zh|en)([-_]|$)/i.test(rawLocale)) return item('gameLanguage', 'pass', 'ok', { raw: rawLocale, locale: null })
  return item('gameLanguage', 'fail', 'unsupported', { raw: rawLocale })
}

/**
 * LCU /lol-game-settings/v1/game-settings 的 General：WindowMode 0=全屏 1=窗口 2=无边框。
 */
export function classifyGameDisplay(
  general: { WindowMode?: unknown; Width?: unknown; Height?: unknown } | null,
  screenSize: { width: number; height: number },
): EnvironmentCheckItem {
  if (!general || general.WindowMode == null) return item('gameDisplay', 'skip', 'needClient')
  const mode = Number(general.WindowMode)
  const width = Number(general.Width) || 0
  const height = Number(general.Height) || 0
  const params = { width, height, screenWidth: screenSize.width, screenHeight: screenSize.height }
  if (mode === 2) return item('gameDisplay', 'pass', 'borderless', params)
  if (mode === 0) return item('gameDisplay', 'warn', 'fullscreen', params)
  if (mode === 1) {
    const fillsScreen = width >= screenSize.width - 2 && height >= screenSize.height - 2
    return fillsScreen
      ? item('gameDisplay', 'pass', 'windowedFull', params)
      : item('gameDisplay', 'warn', 'windowed', params)
  }
  return item('gameDisplay', 'skip', 'unknown', params)
}

export function classifyPreferences(state: { autoScreenshot: boolean; topOverlay: boolean; sidePanel: boolean }): EnvironmentCheckItem {
  if (!state.autoScreenshot) return item('preferences', 'fail', 'autoScreenshotOff')
  if (!state.topOverlay && !state.sidePanel) return item('preferences', 'fail', 'overlaysOff')
  return item('preferences', 'pass', 'ok')
}

// ---------- 实际探测 ----------

function run(file: string, args: string[], timeoutMs = 4000): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
        ? (error as unknown as { code: number }).code : 1) : 0
      resolve({ code, stdout: String(stdout || '') })
    })
  })
}

async function isLeagueClientRunning(): Promise<boolean | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run('tasklist', ['/FI', 'IMAGENAME eq LeagueClientUx.exe', '/NH', '/FO', 'CSV'])
      return /LeagueClientUx\.exe/i.test(stdout)
    }
    if (process.platform === 'darwin') {
      const { code } = await run('pgrep', ['-f', 'LeagueClientUx'])
      return code === 0
    }
  } catch {
    // ignore
  }
  return null
}

/** Windows：`net session` 只有管理员能成功。 */
async function isElevated(): Promise<boolean | null> {
  if (process.platform !== 'win32') return null
  try {
    const { code } = await run('net', ['session'])
    return code === 0
  } catch {
    return null
  }
}

async function checkScreenCapture(): Promise<EnvironmentCheckItem> {
  try {
    const frame = await captureNativeScreenFrame()
    if (!frame) {
      return item('screenCapture', 'warn', 'fallback', { error: (getNativeCaptureLoadError() || '').slice(0, 160) || null })
    }
    return item('screenCapture', 'pass', 'ok', {
      width: frame.width,
      height: frame.height,
      ms: Math.round(frame.captureMs),
    })
  } catch (error) {
    return item('screenCapture', 'fail', 'failed', { error: (error instanceof Error ? error.message : String(error)).slice(0, 160) })
  }
}

function primaryPhysicalSize(): { width: number; height: number } {
  const display = screen.getPrimaryDisplay()
  return {
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor),
  }
}

let running: Promise<EnvironmentCheckReport> | null = null

export function runEnvironmentCheck(): Promise<EnvironmentCheckReport> {
  if (!running) {
    running = doRunEnvironmentCheck().finally(() => { running = null })
  }
  return running
}

async function doRunEnvironmentCheck(): Promise<EnvironmentCheckReport> {
  const platform = process.platform
  const screenSize = primaryPhysicalSize()
  const lcu = getLCUServiceInstance()

  const [ocr, capture, connected] = await Promise.all([
    probeOcrEngine().catch((error: unknown) => ({ ready: false, modelsFound: true, error: error instanceof Error ? error.message : String(error) })),
    checkScreenCapture(),
    lcu.getLcuStatus().catch(() => false).then(async (ok) => ok || Boolean(await lcu.getAuthToken(true).catch(() => null))),
  ])

  const [runningState, elevated] = connected
    ? [true, null] as const
    : await Promise.all([isLeagueClientRunning(), isElevated()])

  let rawLocale: string | null = null
  let general: Record<string, unknown> | null = null
  if (connected) {
    const [localeResult, settingsResult] = await Promise.all([
      lcu.getReadOnlyJsonEndpoint('/riotclient/region-locale').catch(() => null),
      lcu.getReadOnlyJsonEndpoint('/lol-game-settings/v1/game-settings').catch(() => null),
    ])
    const localeData = localeResult && localeResult.status < 400 ? localeResult.data : null
    rawLocale = localeData ? String(localeData.locale || localeData.webLanguage || '') || null : null
    const settings = settingsResult && settingsResult.status < 400 ? settingsResult.data : null
    general = settings && typeof settings === 'object' ? (settings.General || null) : null
  }

  const items: EnvironmentCheckItem[] = [
    classifySystem(platform, os.arch(), os.release()),
    classifyOcrEngine(ocr, platform),
    capture,
    classifyDisplay(screenSize.width, screenSize.height),
    classifyMonitors(screen.getAllDisplays().length),
    classifyLeagueClient({ connected, running: runningState, elevated }, platform),
    classifyGameLanguage(rawLocale),
    classifyGameDisplay(general, screenSize),
    classifyPreferences({
      autoScreenshot: store.get('autoScreenshotGameflowControl') !== false,
      topOverlay: shouldShowAugmentTopOverlay(),
      sidePanel: shouldShowAugmentSidePanel(),
    }),
    item('manualTips', 'info', 'hdr'),
  ]

  const report: EnvironmentCheckReport = { checkedAt: Date.now(), platform, items }
  logger.info('[environment-check] completed', items.map((entry) => `${entry.id}=${entry.status}:${entry.variant}`).join(', '), {
    params: Object.fromEntries(items.map((entry) => [entry.id, entry.params])),
  })
  return report
}
