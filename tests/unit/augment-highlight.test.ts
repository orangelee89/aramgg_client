import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AUGMENT_HIGHLIGHT_MODE,
  getWeightedAugmentScore,
  isAugmentHighlightMode,
  normalizeAugmentHighlightMode,
} from '../../src/shared/augment-highlight.ts'

describe('augment highlight mode', () => {
  it('accepts only the three supported modes', () => {
    expect(isAugmentHighlightMode('pickRate')).toBe(true)
    expect(isAugmentHighlightMode('winRate')).toBe(true)
    expect(isAugmentHighlightMode('weighted')).toBe(true)
    expect(isAugmentHighlightMode('tier')).toBe(false)
    expect(isAugmentHighlightMode(1)).toBe(false)
  })

  it('defaults to win rate for missing or unknown values', () => {
    expect(DEFAULT_AUGMENT_HIGHLIGHT_MODE).toBe('winRate')
    expect(normalizeAugmentHighlightMode(undefined)).toBe('winRate')
    expect(normalizeAugmentHighlightMode('nope')).toBe('winRate')
    expect(normalizeAugmentHighlightMode('weighted')).toBe('weighted')
  })

  it('computes the weighted score from either naming style', () => {
    expect(getWeightedAugmentScore({ winRate: 0.5, pickRate: 0.1, playCount: 500 })).toBeCloseTo(0.5 * 0.6 + 0.1 * 0.2 + 0.5 * 0.2)
    expect(getWeightedAugmentScore({ win_rate: '0.5', pick_rate: '0.1', num_games: '2000' })).toBeCloseTo(0.3 + 0.02 + 0.2)
    expect(getWeightedAugmentScore({ winRate: 0.5 })).toBeCloseTo(0.3)
    expect(getWeightedAugmentScore({ pickRate: 0.3 })).toBeNull()
  })
})
