import store from './app-store.ts'

export const USER_PREFERENCE_KEYS = {
    showChampionDetails: 'championInsight.showDetails',
    hideChampionInsightOnGameStart: 'championInsight.hideOnGameStart',
    championInsightAlwaysOnTop: 'championInsight.alwaysOnTop',
    showAugmentTopOverlay: 'augments.showTopOverlay',
    showAugmentSidePanel: 'augments.showSidePanel',
    autoShowPostGameShare: 'postGameShare.autoShow',
    postGamePosterWindow: 'postGameShare.popupWindow',
}

export function getBooleanPreference(key: string, defaultValue = true): boolean {
    const value = store.get(key)
    if (value == null) {
        return defaultValue
    }

    return value !== false
}

export function shouldShowChampionDetails(): boolean {
    return getBooleanPreference(USER_PREFERENCE_KEYS.showChampionDetails, true)
}

export function shouldHideChampionInsightOnGameStart(): boolean {
    return getBooleanPreference(USER_PREFERENCE_KEYS.hideChampionInsightOnGameStart, true)
}

export function shouldKeepChampionInsightOnTop(): boolean {
    return getBooleanPreference(USER_PREFERENCE_KEYS.championInsightAlwaysOnTop, false)
}

export function shouldShowAugmentTopOverlay(): boolean {
    return getBooleanPreference(USER_PREFERENCE_KEYS.showAugmentTopOverlay, true)
}

export function shouldShowAugmentSidePanel(): boolean {
    return getBooleanPreference(USER_PREFERENCE_KEYS.showAugmentSidePanel, true)
}

export function shouldAutoShowPostGameShare(): boolean {
    return getBooleanPreference(USER_PREFERENCE_KEYS.autoShowPostGameShare, true)
}

/** 赛后海报以独立小窗弹在屏幕右下角，而不是在主窗口里打开。 */
export function shouldUsePostGamePosterWindow(): boolean {
    return getBooleanPreference(USER_PREFERENCE_KEYS.postGamePosterWindow, true)
}
