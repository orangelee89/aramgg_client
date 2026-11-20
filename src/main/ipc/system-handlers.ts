import { app, BrowserWindow, globalShortcut, shell } from 'electron'
import {
  checkForAppUpdate,
  downloadAppUpdate,
  getAppUpdateState,
  installDownloadedAppUpdate,
} from '../app-update-service.ts'
import autoScreenshotService from '../auto-screenshot-service.ts'
import {
  getAnalyticsStatus,
  setAnalyticsEnabled,
  trackAnalyticsEvent,
} from '../services/analytics-service.ts'
import { logDiagnosticSnapshot } from '../modules/diagnostic-logger.ts'
import logger from '../modules/logger.ts'
import { getVersionInfo } from '../version-checker.ts'
import { runEnvironmentCheck } from '../services/environment-check.ts'
import {
    allowMainWindowClose,
    toggleMainWindow,
} from '../modules/window-manager.ts'
import { trustedIpcMain as ipcMain } from '../security/trusted-ipc.ts'

let quitRequested = false

function requestAppQuit(reason: string): void {
  if (quitRequested) {
    return
  }

  quitRequested = true
  logger.info('[app] quit requested', { reason })

  try {
    globalShortcut.unregisterAll()
  } catch (error) {
    logger.warn('[app] failed to unregister shortcuts before quit:', (error as Error).message)
  }

  try {
    autoScreenshotService.stop(`app quit: ${reason}`)
  } catch (error) {
    logger.warn('[app] failed to stop auto screenshot before quit:', (error as Error).message)
  }

  allowMainWindowClose()

  const forceExitTimer = setTimeout(() => {
    logger.warn('[app] force exiting after quit timeout')
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.destroy()
      }
    }
    app.exit(0)
  }, 1500)

  forceExitTimer.unref?.()
  app.quit()
}

function assertSafeExternalUrl(url: unknown): string {
  if (typeof url !== 'string') {
    throw new Error('External URL must be a string')
  }

  const parsedUrl = new URL(url)
  if (!['http:', 'https:', 'mailto:'].includes(parsedUrl.protocol)) {
    throw new Error(`Unsupported external URL protocol: ${parsedUrl.protocol}`)
  }

  return parsedUrl.toString()
}

export function registerSystemIpcHandlers(): void {
  ipcMain.on('toggle-main-window', () => {
    toggleMainWindow()
  })

  ipcMain.handle('confirm-quit-app', async () => {
    requestAppQuit('user confirmed quit')
    return { success: true, quit: true }
  })

  ipcMain.on('restart-app', () => {
    app.relaunch()
    app.exit()
  })

  ipcMain.handle('get-version-info', async () => {
    try {
      return { success: true, data: await getVersionInfo() }
    } catch (error) {
      const message = (error as Error).message
      logger.warn('Failed to load version info:', message)
      return { success: false, error: message }
    }
  })

  ipcMain.handle('app-update-get-state', async () => ({
    success: true,
    data: getAppUpdateState(),
  }))
  ipcMain.handle('app-update-check', async () => checkForAppUpdate('manual'))
  ipcMain.handle('app-update-download', async () => downloadAppUpdate())
  ipcMain.handle('app-update-install', async () => installDownloadedAppUpdate())

  ipcMain.handle('run-environment-check', async () => {
    try {
      return { success: true, data: await runEnvironmentCheck() }
    } catch (error) {
      const message = (error as Error).message
      logger.warn('[environment-check] failed:', message)
      return { success: false, error: message }
    }
  })

  ipcMain.handle('open-log-directory', async () => {
    try {
      await logDiagnosticSnapshot('open-log-directory')
      const logDir = logger.getLogDir()
      const openError = await shell.openPath(logDir)
      if (openError) {
        throw new Error(openError)
      }

      return {
        success: true,
        path: logDir,
        currentLogFile: logger.getCurrentLogFile(),
      }
    } catch (error) {
      const message = (error as Error).message
      logger.warn('Failed to open log directory:', message)
      return { success: false, error: message }
    }
  })

  ipcMain.handle('analytics-get-status', async () => {
    try {
      return { success: true, data: await getAnalyticsStatus() }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('analytics-set-enabled', async (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      return { success: false, error: 'Analytics enabled state must be boolean' }
    }

    try {
      return { success: true, data: await setAnalyticsEnabled(enabled) }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('analytics-track', async (_event, name: unknown, properties: unknown = {}) => {
    if (typeof name !== 'string' || !name.trim()) {
      return { success: false, error: 'Analytics event name is required' }
    }

    if (properties != null && typeof properties !== 'object') {
      return { success: false, error: 'Analytics properties must be an object' }
    }

    return trackAnalyticsEvent()
  })

  ipcMain.handle('shell-open-external', async (_event, url: unknown) => {
    const safeUrl = assertSafeExternalUrl(url)
    await shell.openExternal(safeUrl)
    return { success: true }
  })
}
