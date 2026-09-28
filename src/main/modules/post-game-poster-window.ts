import logger from './logger.ts'
import {
    ensurePostGamePosterWindow,
    showPostGamePosterWindow,
} from './window-manager.ts'
import {
    shouldAutoShowPostGameShare,
    shouldUsePostGamePosterWindow,
} from './user-preferences.ts'

/**
 * 赛后海报小窗：开启自动展示且启用小窗模式时，把海报推给独立小窗并在屏幕右下角弹出，
 * 不呼出主窗口。`force` 用于主界面"模拟生成"这类手动预览，忽略自动展示开关。
 */
export async function showPostGamePosterPopup(
    poster: unknown,
    reason: string,
    options: { force?: boolean } = {}
): Promise<boolean> {
    if (!shouldUsePostGamePosterWindow()) {
        return false
    }
    if (!options.force && !shouldAutoShowPostGameShare()) {
        return false
    }

    try {
        const posterWindow = await ensurePostGamePosterWindow()
        if (!posterWindow || posterWindow.isDestroyed()) {
            return false
        }
        posterWindow.webContents.send('post-game-share-ready', poster)
        showPostGamePosterWindow()
        logger.info('[post-game-share] poster window shown', { reason })
        return true
    } catch (error) {
        logger.warn('[post-game-share] failed to show poster window:', error instanceof Error ? error.message : String(error))
        return false
    }
}
