import { isTitleTextCompatibleWithNames } from './augment-title-matcher.ts'

export type PartialAugment = {
    id?: string | number | null
    name?: string
    displayName?: string
    matchName?: string
    rarity?: string
    confidence?: number | null
    detectedSlot?: number
    missing?: boolean
    [key: string]: unknown
}

export type AugmentSlotDiagnostic = {
    slot?: number
    matchedId?: string | number | null
    text?: unknown
    titleFingerprint?: unknown
}

type InitialPartialSelectionOptions = {
    augments?: PartialAugment[]
    slotDiagnostics?: AugmentSlotDiagnostic[]
    minimumKnownAugments?: number
}

type MergePartialAugmentsOptions = {
    augments?: PartialAugment[]
    slotDiagnostics?: AugmentSlotDiagnostic[]
    lastDetectedAugmentIds?: string[]
    lastDetectedAugments?: PartialAugment[]
    lastDetectedSlotFingerprints?: unknown[]
}

export function getAugmentIds(augments: PartialAugment[] = []): string[] {
    return augments.slice(0, 3).map(augment => {
        if (augment?.id == null) {
            return null
        }

        return String(augment.id)
    }).filter((id): id is string => Boolean(id))
}

export function createEmptyAugmentSlot(slot: number): PartialAugment {
    return {
        id: null,
        name: '',
        rarity: 'unknown',
        confidence: null,
        detectedSlot: slot,
        missing: true,
    }
}

function normalizeSlotText(text: unknown): string {
    return String(text || '')
        .normalize('NFKC')
        .replace(/[\s"'`~!@#$%^&*()_+\-=[\]{};:,.<>/?\\|，。！？、：；（）【】《》“”‘’]/g, '')
}

export function hasMeaningfulSlotText(text: unknown): boolean {
    const normalized = normalizeSlotText(text)
    if (!normalized) {
        return false
    }

    const cjkCount = (normalized.match(/[\u4e00-\u9fff]/g) || []).length
    return cjkCount >= 2 || normalized.length >= 4
}

function isValidDetectedSlot(slot: unknown): slot is number {
    return typeof slot === 'number' && Number.isInteger(slot) && slot >= 0 && slot < 3
}

function findSlotDiagnostic(
    slotDiagnostics: AugmentSlotDiagnostic[] = [],
    slot: number
): AugmentSlotDiagnostic | null {
    return (slotDiagnostics || []).find(diagnostic => diagnostic?.slot === slot) || null
}

export function createInitialPartialAugmentSelection({
    augments = [],
    slotDiagnostics = [],
    minimumKnownAugments = 2,
}: InitialPartialSelectionOptions = {}) {
    const knownAugments = augments.filter(augment =>
        augment?.id != null && isValidDetectedSlot(augment.detectedSlot)
    )

    if (knownAugments.length < minimumKnownAugments || knownAugments.length >= 3) {
        return null
    }

    const knownSlots = new Set(knownAugments.map(augment => augment.detectedSlot))
    const missingSlots = [0, 1, 2].filter(slot => !knownSlots.has(slot))
    const hasMeaningfulUnmatchedTitle = missingSlots.some(slot => {
        const diagnostic = findSlotDiagnostic(slotDiagnostics, slot)
        return diagnostic?.matchedId == null && hasMeaningfulSlotText(diagnostic?.text)
    })

    if (!hasMeaningfulUnmatchedTitle) {
        return null
    }

    const merged: PartialAugment[] = [0, 1, 2].map(createEmptyAugmentSlot)
    for (const augment of knownAugments) {
        const slot = augment.detectedSlot
        if (isValidDetectedSlot(slot)) {
            merged[slot] = augment
        }
    }

    return {
        augments: merged,
        reason: 'unmatched-title-slot',
        missingSlots,
    }
}

const TITLE_FINGERPRINT_CHANGE_THRESHOLD = 18
// 16x8 指纹分不开两个同长度的标题（"收缩射线" vs "缩小引擎"），
// 所以当 OCR 文字明显是另一个名字时，只要指纹有轻微变化就视为卡位已刷新。
const TITLE_FINGERPRINT_TEXT_ASSISTED_THRESHOLD = 4
const HEX_BIT_COUNTS = new Map([
    ['0', 0], ['1', 1], ['2', 1], ['3', 2],
    ['4', 1], ['5', 2], ['6', 2], ['7', 3],
    ['8', 1], ['9', 2], ['a', 2], ['b', 3],
    ['c', 2], ['d', 3], ['e', 3], ['f', 4],
])

export function getFingerprintHammingDistance(left: unknown, right: unknown): number | null {
    const a = String(left || '').toLowerCase()
    const b = String(right || '').toLowerCase()
    if (!a || !b || a.length !== b.length || !/^[0-9a-f]+$/.test(a) || !/^[0-9a-f]+$/.test(b)) {
        return null
    }

    let distance = 0
    for (let index = 0; index < a.length; index++) {
        const xor = (parseInt(a.charAt(index), 16) ^ parseInt(b.charAt(index), 16)).toString(16)
        distance += HEX_BIT_COUNTS.get(xor) ?? 0
    }
    return distance
}

function hasTitleFingerprintChanged(
    currentFingerprint: unknown,
    previousFingerprint: unknown
): boolean {
    const distance = getFingerprintHammingDistance(currentFingerprint, previousFingerprint)
    return distance != null && distance >= TITLE_FINGERPRINT_CHANGE_THRESHOLD
}

function hasTitleTextReplacedAugment(
    diagnostic: AugmentSlotDiagnostic,
    previousAugment: PartialAugment,
    previousFingerprint: unknown
): boolean {
    const distance = getFingerprintHammingDistance(diagnostic.titleFingerprint, previousFingerprint)
    if (distance == null || distance < TITLE_FINGERPRINT_TEXT_ASSISTED_THRESHOLD) {
        return false
    }

    return !isTitleTextCompatibleWithNames(diagnostic.text, [
        previousAugment.name,
        previousAugment.displayName,
        previousAugment.matchName,
    ])
}

function getChangedUnmatchedSlots({
    slotDiagnostics = [],
    lastDetectedAugments = [],
    lastDetectedSlotFingerprints = [],
    hasStablePreviousId = false,
}: MergePartialAugmentsOptions & { hasStablePreviousId?: boolean } = {}): number[] {
    if (!hasStablePreviousId) {
        return []
    }

    return slotDiagnostics.flatMap((diagnostic) => {
        const slot = diagnostic.slot
        if (!isValidDetectedSlot(slot)) {
            return []
        }

        const previousAugment = lastDetectedAugments[slot]
        const previousFingerprint = lastDetectedSlotFingerprints[slot]
        const changed = previousAugment?.id != null &&
                diagnostic.matchedId == null &&
                hasMeaningfulSlotText(diagnostic.text) &&
                (
                    hasTitleFingerprintChanged(diagnostic.titleFingerprint, previousFingerprint) ||
                    hasTitleTextReplacedAugment(diagnostic, previousAugment, previousFingerprint)
                )
        return changed ? [slot] : []
    })
}

export function mergePartialAugments({
    augments = [],
    slotDiagnostics = [],
    lastDetectedAugmentIds = [],
    lastDetectedAugments = [],
    lastDetectedSlotFingerprints = [],
}: MergePartialAugmentsOptions = {}) {
    if (augments.length >= 3) {
        return null
    }

    if (lastDetectedAugmentIds.length === 0) {
        return null
    }

    const partialIds = new Set(getAugmentIds(augments))
    const hasStablePreviousId = [...partialIds].some(id => lastDetectedAugmentIds.includes(id))
    const changedUnmatchedSlots = getChangedUnmatchedSlots({
        slotDiagnostics,
        lastDetectedAugments,
        lastDetectedSlotFingerprints,
        hasStablePreviousId,
    })
    const hasDetectedSlot = augments.some(augment => Number.isInteger(augment?.detectedSlot))
    if (!hasDetectedSlot && changedUnmatchedSlots.length === 0) {
        return null
    }

    const hasNewId = partialIds.size > 0 && [...partialIds].some(id => !lastDetectedAugmentIds.includes(id))
    if (!hasNewId && changedUnmatchedSlots.length === 0) {
        return null
    }

    const merged: PartialAugment[] = [0, 1, 2].map(createEmptyAugmentSlot)
    for (const augment of augments) {
        if (isValidDetectedSlot(augment?.detectedSlot)) {
            merged[augment.detectedSlot] = augment
        }
    }

    return {
        augments: merged.slice(0, 3),
        reason: hasNewId ? 'new-id' : 'slot-visual-changed',
        changedUnmatchedSlots,
    }
}
