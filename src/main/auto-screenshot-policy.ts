export type AutomaticCaptureMode = 'idle' | 'active-selection'
export type AutomaticCaptureStage = 'gate' | 'full'

export const GAMEFLOW_ACTIVE_CAPTURE_INTERVAL_MS = 500
export const GAMEFLOW_IDLE_CAPTURE_INTERVAL_MS = 1500
export const GAMEFLOW_CAPTURE_THUMBNAIL_SIZE = { width: 1024, height: 576 } as const
export const GATE_CAPTURE_THUMBNAIL_SIZE = { width: 640, height: 360 } as const
export const SELECTION_CANDIDATE_STREAK_THRESHOLD = 2
export const FULL_OCR_BACKOFF_MS = 4000
/** 门禁帧第一次像海克斯界面后，不等完整的空闲间隔，尽快补一帧确认。 */
export const CANDIDATE_CONFIRM_DELAY_MS = 250

export function resolveGameflowCaptureInterval(
    mode: AutomaticCaptureMode,
    activeIntervalMs = GAMEFLOW_ACTIVE_CAPTURE_INTERVAL_MS,
    idleIntervalMs = GAMEFLOW_IDLE_CAPTURE_INTERVAL_MS
): number {
    return mode === 'active-selection' ? activeIntervalMs : idleIntervalMs
}

export function resolveGameflowNextCaptureDelay({
    mode,
    pendingFullCapture,
    fullOcrCooldownUntil = 0,
    now = Date.now(),
    intervalMs,
    elapsedMs,
    candidateStreak = 0,
}: {
    mode: AutomaticCaptureMode
    pendingFullCapture: boolean
    fullOcrCooldownUntil?: number
    now?: number
    intervalMs: number
    elapsedMs: number
    candidateStreak?: number
}): number {
    const fullCaptureReady = mode === 'idle' && resolveCaptureStage({
        mode,
        pendingFullCapture,
        fullOcrCooldownUntil,
        now,
    }) === 'full'

    if (fullCaptureReady) {
        return 0
    }

    const waitMs = Math.max(0, intervalMs - elapsedMs)
    if (mode === 'idle' && candidateStreak > 0 && candidateStreak < SELECTION_CANDIDATE_STREAK_THRESHOLD) {
        return Math.min(waitMs, CANDIDATE_CONFIRM_DELAY_MS)
    }
    return waitMs
}

export function resolveCaptureModeAfterAnalysis({
    currentMode,
    confirmedSelectionUi,
    hasVisibleAugments,
}: {
    currentMode: AutomaticCaptureMode
    confirmedSelectionUi: boolean
    hasVisibleAugments: boolean
}): AutomaticCaptureMode {
    if (confirmedSelectionUi) {
        return 'active-selection'
    }

    return hasVisibleAugments ? currentMode : 'idle'
}

export function shouldActivateSelectionCapture({
    confirmedSelectionUi,
    recognizedAugmentCount,
    hasVisibleAugments,
}: {
    confirmedSelectionUi: boolean
    recognizedAugmentCount: number
    hasVisibleAugments: boolean
}): boolean {
    return confirmedSelectionUi && (recognizedAugmentCount > 0 || hasVisibleAugments)
}

export function resolveCaptureStage({
    mode,
    pendingFullCapture,
    fullOcrCooldownUntil = 0,
    now = Date.now(),
}: {
    mode: AutomaticCaptureMode
    pendingFullCapture: boolean
    fullOcrCooldownUntil?: number
    now?: number
}): AutomaticCaptureStage {
    if (mode === 'active-selection') {
        return 'full'
    }

    if (pendingFullCapture && (!fullOcrCooldownUntil || now >= fullOcrCooldownUntil)) {
        return 'full'
    }

    return 'gate'
}

export function resolveCandidateStreak({
    gateLikely,
    rerollVisible,
    currentStreak,
}: {
    gateLikely: boolean
    rerollVisible: boolean
    currentStreak: number
}): number {
    return gateLikely && rerollVisible ? currentStreak + 1 : 0
}

export function shouldQueueFullCapture({
    candidateStreak,
    fullOcrCooldownUntil = 0,
    now = Date.now(),
}: {
    candidateStreak: number
    fullOcrCooldownUntil?: number
    now?: number
}): boolean {
    return candidateStreak >= SELECTION_CANDIDATE_STREAK_THRESHOLD &&
        (!fullOcrCooldownUntil || now >= fullOcrCooldownUntil)
}

export function resolveFullOcrBackoffUntil(now = Date.now()): number {
    return now + FULL_OCR_BACKOFF_MS
}
