import { describe, expect, it } from 'vitest'
import {
  getTopPickKey,
  mergeWinrateWithDetectedSlots
} from '../../src/renderer/service/augment-display.js'

const detected = (id, detectedSlot, extra = {}) => ({
  id,
  name: `augment-${id}`,
  rarity: 'gold',
  detectedSlot,
  ...extra,
})

const displayed = (id, detectedSlot, recommendScore) => ({
  id,
  augmentId: id,
  name: `augment-${id}`,
  rarity: 'gold',
  detectedSlot,
  recommendScore,
  winRate: recommendScore,
  pickRate: 0.1,
})

describe('augment floating display merge', () => {
  it('keeps unchanged slot stats while a rerolled slot is waiting for winrate data', () => {
    const previous = [
      displayed(101, 0, 0.42),
      displayed(102, 1, 0.48),
      displayed(103, 2, 0.63),
    ]
    const result = mergeWinrateWithDetectedSlots([], [
      detected(101, 0),
      detected(202, 1),
      detected(103, 2),
    ], previous)

    expect(result.map(augment => augment.id)).toEqual([101, 202, 103])
    expect(result[0].recommendScore).toBe(0.42)
    expect(result[1].recommendScore).toBeNull()
    expect(result[2].recommendScore).toBe(0.63)
    expect(getTopPickKey(result)).toBe(103)
  })

  it('does not show a top pick when only OCR fallback data is available', () => {
    const result = mergeWinrateWithDetectedSlots([], [
      detected(101, 0),
      detected(102, 1),
      detected(103, 2),
    ])

    expect(result.map(augment => augment.recommendScore)).toEqual([null, null, null])
    expect(getTopPickKey(result)).toBeNull()
  })

  it('keeps unread slots empty instead of carrying stale data', () => {
    const previous = [
      displayed(101, 0, 0.42),
      displayed(102, 1, 0.74),
      displayed(103, 2, 0.63),
    ]
    const result = mergeWinrateWithDetectedSlots([], [
      detected(101, 0),
      { id: null, missing: true, detectedSlot: 1 },
      detected(103, 2),
    ], previous)

    expect(result[1].missing).toBe(true)
    expect(result[1].id).toBeNull()
    expect(getTopPickKey(result)).toBe(103)
  })

  it('highlights the card with the highest champion win rate even when another card ranks higher', () => {
    const result = [
      detected(101, 0, { rank: 12, recommendScore: 0.8, winRate: 0.6 }),
      detected(102, 1, { rank: 1, recommendScore: 0.4, winRate: 0.5 }),
      detected(103, 2, { rank: 8, recommendScore: 0.6, winRate: 0.55 }),
    ]

    expect(getTopPickKey(result)).toBe(101)
  })

  it('ignores cards without a win rate when another card has one', () => {
    const result = [
      detected(101, 0, { rank: 1, winRate: null }),
      detected(102, 1, { rank: 30, winRate: 0.48 }),
      detected(103, 2, { rank: 2 }),
    ]

    expect(getTopPickKey(result)).toBe(102)
  })

  it('falls back to official rank when no card has a win rate', () => {
    const result = [
      detected(101, 0, { rank: 12, pickRate: 0.2 }),
      detected(102, 1, { rank: 1, pickRate: 0.1 }),
      detected(103, 2, { rank: 8, pickRate: 0.3 }),
    ]

    expect(getTopPickKey(result)).toBe(102)
  })

  it('pickRate mode follows the official pick-rate rank even when win rates exist', () => {
    const result = [
      detected(101, 0, { rank: 12, winRate: 0.6 }),
      detected(102, 1, { rank: 1, winRate: 0.5 }),
      detected(103, 2, { rank: 8, winRate: 0.55 }),
    ]

    expect(getTopPickKey(result, 'pickRate')).toBe(102)
  })

  it('weighted mode combines win rate, pick rate and games', () => {
    const result = [
      // 0.52*0.6 + 0.30*0.2 + 1*0.2 = 0.572
      detected(101, 0, { rank: 3, winRate: 0.52, pickRate: 0.3, playCount: 5000 }),
      // 0.58*0.6 + 0.01*0.2 + 0.1*0.2 = 0.37
      detected(102, 1, { rank: 9, winRate: 0.58, pickRate: 0.01, playCount: 100 }),
      detected(103, 2, { rank: 1 }),
    ]

    expect(getTopPickKey(result, 'weighted')).toBe(101)
    expect(getTopPickKey(result, 'winRate')).toBe(102)
  })

  it('weighted mode falls back to pick-rate rank when no card has a win rate', () => {
    const result = [
      detected(101, 0, { rank: 5, pickRate: 0.2 }),
      detected(102, 1, { rank: 2, pickRate: 0.1 }),
    ]

    expect(getTopPickKey(result, 'weighted')).toBe(102)
  })

  it('treats an unknown mode as the default win-rate mode', () => {
    const result = [
      detected(101, 0, { rank: 1, winRate: 0.4 }),
      detected(102, 1, { rank: 2, winRate: 0.6 }),
    ]

    expect(getTopPickKey(result, 'bogus')).toBe(102)
  })
})
