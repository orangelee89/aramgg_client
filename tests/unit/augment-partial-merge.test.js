import { describe, expect, it } from 'vitest'
import {
    createInitialPartialAugmentSelection,
    getFingerprintHammingDistance,
    mergePartialAugments,
} from '../../src/main/augment-partial-merge.ts'

const augment = (id, detectedSlot) => ({
    id,
    name: `augment-${id}`,
    rarity: 'silver',
    confidence: 0.95,
    detectedSlot,
})

describe('mergePartialAugments', () => {
    it('measures title fingerprint distance from hex average hashes', () => {
        expect(getFingerprintHammingDistance(
            '00000000000000000000000000000000',
            'ffffffffffffffffffffffffffffffff'
        )).toBe(128)
        expect(getFingerprintHammingDistance('abcd', 'abcd')).toBe(0)
        expect(getFingerprintHammingDistance('abcd', '')).toBeNull()
    })

    it('does not open an overlay from a partial OCR frame without previous stable ids', () => {
        const result = mergePartialAugments({
            augments: [augment(1071, 1)],
            lastDetectedAugmentIds: [],
            lastDetectedAugments: [],
        })

        expect(result).toBeNull()
    })

    it('opens an initial partial selection when one title has no database match', () => {
        const result = createInitialPartialAugmentSelection({
            augments: [
                augment(2102, 0),
                augment(2132, 2),
            ],
            slotDiagnostics: [
                { slot: 0, text: '高压锅', matchedId: 2102 },
                { slot: 1, text: '双发快射', matchedId: null },
                { slot: 2, text: '术士果汁盒', matchedId: 2132 },
            ],
        })

        expect(result?.reason).toBe('unmatched-title-slot')
        expect(result?.missingSlots).toEqual([1])
        expect(result?.augments.map(item => item.id)).toEqual([2102, null, 2132])
        expect(result?.augments[1].missing).toBe(true)
    })

    it('does not open an initial partial selection for an empty transient slot', () => {
        const result = createInitialPartialAugmentSelection({
            augments: [
                augment(2102, 0),
                augment(2132, 2),
            ],
            slotDiagnostics: [
                { slot: 0, text: '高压锅', matchedId: 2102 },
                { slot: 1, text: '', matchedId: null },
                { slot: 2, text: '术士果汁盒', matchedId: 2132 },
            ],
        })

        expect(result).toBeNull()
    })

    it('fills fixed slots when a visible overlay receives a partial OCR frame with a new augment id', () => {
        const result = mergePartialAugments({
            augments: [augment(1071, 1)],
            lastDetectedAugmentIds: ['1032', '1996', '1211'],
            lastDetectedAugments: [
                augment(1032, 0),
                augment(1996, 1),
                augment(1211, 2),
            ],
        })

        expect(result?.reason).toBe('new-id')
        expect(result?.augments.map(item => item.id)).toEqual([null, 1071, null])
        expect(result?.augments[0].missing).toBe(true)
        expect(result?.augments[2].missing).toBe(true)
    })

    it('clears a stale slot when the title image changed and OCR has not matched an id yet', () => {
        const result = mergePartialAugments({
            augments: [augment(1334, 1), augment(1070, 2)],
            slotDiagnostics: [
                { slot: 0, text: '台所之舞', matchedId: null, titleFingerprint: 'ffffffffffffffffffffffffffffffff' },
                { slot: 1, text: '升级: 雪球', matchedId: 1334, titleFingerprint: '11111111111111111111111111111111' },
                { slot: 2, text: '无体回复', matchedId: 1070, titleFingerprint: '22222222222222222222222222222222' },
            ],
            lastDetectedAugmentIds: ['1133', '1334', '1070'],
            lastDetectedAugments: [
                augment(1133, 0),
                augment(1334, 1),
                augment(1070, 2),
            ],
            lastDetectedSlotFingerprints: [
                '00000000000000000000000000000000',
                '11111111111111111111111111111111',
                '22222222222222222222222222222222',
            ],
        })

        expect(result?.reason).toBe('slot-visual-changed')
        expect(result?.changedUnmatchedSlots).toEqual([0])
        expect(result?.augments.map(item => item.id)).toEqual([null, 1334, 1070])
        expect(result?.augments[0].missing).toBe(true)
    })

    it('does not clear a slot when OCR text is wrong but the title image did not change', () => {
        const result = mergePartialAugments({
            augments: [augment(1334, 1), augment(1070, 2)],
            slotDiagnostics: [
                { slot: 0, text: '台所之舞', matchedId: null, titleFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
                { slot: 1, text: '升级: 雪球', matchedId: 1334, titleFingerprint: '11111111111111111111111111111111' },
                { slot: 2, text: '无体回复', matchedId: 1070, titleFingerprint: '22222222222222222222222222222222' },
            ],
            lastDetectedAugmentIds: ['1133', '1334', '1070'],
            lastDetectedAugments: [
                augment(1133, 0),
                augment(1334, 1),
                augment(1070, 2),
            ],
            lastDetectedSlotFingerprints: [
                'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                '11111111111111111111111111111111',
                '22222222222222222222222222222222',
            ],
        })

        expect(result).toBeNull()
    })

    it('clears a stale slot when OCR reads a different title and the fingerprint moved slightly', () => {
        // 4K 缩略图上 "收缩射线" 被读成别的名字、指纹只差几位时，旧的 "缩小引擎" 不能一直挂着。
        const result = mergePartialAugments({
            augments: [augment(2132, 1), augment(1238, 2)],
            slotDiagnostics: [
                { slot: 0, text: '收缩射线', matchedId: null, titleFingerprint: '0000000000000000000000000000000f' },
                { slot: 1, text: '术士果汁盒', matchedId: 2132, titleFingerprint: '11111111111111111111111111111111' },
                { slot: 2, text: '质变：棱彩阶', matchedId: 1238, titleFingerprint: '22222222222222222222222222222222' },
            ],
            lastDetectedAugmentIds: ['1373', '2132', '1238'],
            lastDetectedAugments: [
                { ...augment(1373, 0), name: '缩小引擎', displayName: '缩小引擎' },
                augment(2132, 1),
                augment(1238, 2),
            ],
            lastDetectedSlotFingerprints: [
                '00000000000000000000000000000000',
                '11111111111111111111111111111111',
                '22222222222222222222222222222222',
            ],
        })

        expect(result?.reason).toBe('slot-visual-changed')
        expect(result?.changedUnmatchedSlots).toEqual([0])
        expect(result?.augments.map(item => item.id)).toEqual([null, 2132, 1238])
    })

    it('keeps a slot when OCR only read part of the same title during a transition', () => {
        const result = mergePartialAugments({
            augments: [augment(2132, 1), augment(1238, 2)],
            slotDiagnostics: [
                { slot: 0, text: '缩小引', matchedId: null, titleFingerprint: '0000000000000000000000000000000f' },
                { slot: 1, text: '术士果汁盒', matchedId: 2132, titleFingerprint: '11111111111111111111111111111111' },
                { slot: 2, text: '质变：棱彩阶', matchedId: 1238, titleFingerprint: '22222222222222222222222222222222' },
            ],
            lastDetectedAugmentIds: ['1373', '2132', '1238'],
            lastDetectedAugments: [
                { ...augment(1373, 0), name: '缩小引擎' },
                augment(2132, 1),
                augment(1238, 2),
            ],
            lastDetectedSlotFingerprints: [
                '00000000000000000000000000000000',
                '11111111111111111111111111111111',
                '22222222222222222222222222222222',
            ],
        })

        expect(result).toBeNull()
    })

    it('keeps the previous overlay during noisy unmatched text', () => {
        const result = mergePartialAugments({
            augments: [augment(1334, 1), augment(1070, 2)],
            slotDiagnostics: [
                { slot: 0, text: '0', matchedId: null, titleFingerprint: 'ffffffffffffffffffffffffffffffff' },
                { slot: 1, text: '升级: 雪球', matchedId: 1334, titleFingerprint: '11111111111111111111111111111111' },
                { slot: 2, text: '无体回复', matchedId: 1070, titleFingerprint: '22222222222222222222222222222222' },
            ],
            lastDetectedAugmentIds: ['1133', '1334', '1070'],
            lastDetectedAugments: [
                augment(1133, 0),
                augment(1334, 1),
                augment(1070, 2),
            ],
            lastDetectedSlotFingerprints: [
                '00000000000000000000000000000000',
                '11111111111111111111111111111111',
                '22222222222222222222222222222222',
            ],
        })

        expect(result).toBeNull()
    })
})
