import { describe, expect, it } from 'vitest'
import {
  COUNTER_ITEM_BONUS,
  computeCounterItemBonus,
  computeHorseRatings,
} from '../../src/main/services/post-game-rating.ts'

const player = (
  key: string,
  team: string,
  stats: Record<string, number>,
  extra: { championId?: number; items?: number[] } = {}
) => ({ key, team, stats, ...extra })

describe('post-game horse honors', () => {
  it('names the team MVP by composite score and hands stat honors to team leaders', () => {
    const ratings = computeHorseRatings([
      player('carry', 'ORDER', { kills: 12, deaths: 3, assists: 10, damageDealtToChampions: 60000, damageTaken: 20000, timeCCingOthers: 10 }),
      player('tank', 'ORDER', { kills: 2, deaths: 6, assists: 20, damageDealtToChampions: 15000, damageTaken: 70000, timeCCingOthers: 60 }),
      player('feeder', 'ORDER', { kills: 1, deaths: 11, assists: 4, damageDealtToChampions: 9000, damageTaken: 18000 }),
      player('enemy', 'CHAOS', { kills: 14, deaths: 9, assists: 4, damageDealtToChampions: 40000, damageTaken: 25000 }),
      player('enemy2', 'CHAOS', { kills: 5, deaths: 4, assists: 12, damageDealtToChampions: 20000, damageTaken: 22000 }),
    ])

    expect(ratings.get('carry')?.honors).toEqual(['leader', 'top', 'kills'])
    expect(ratings.get('carry')?.score).toBeGreaterThan(ratings.get('tank')!.score)
    expect(ratings.get('tank')?.honors).toEqual(['tank', 'assists'])
    expect(ratings.get('feeder')?.honors).toEqual(['deaths'])
    expect(ratings.get('enemy')?.honors).toEqual(['leader', 'top', 'tank', 'kills', 'deaths'])
    expect(ratings.get('enemy2')?.honors).toEqual(['assists'])
    expect(ratings.get('carry')?.playerCount).toBe(5)
  })

  it('redistributes weight for metrics nobody on the team has', () => {
    const ratings = computeHorseRatings([
      player('a', 'ORDER', { kills: 5, deaths: 2, assists: 5, damageDealtToChampions: 30000, damageTaken: 30000 }),
      player('b', 'ORDER', { kills: 5, deaths: 2, assists: 5, damageDealtToChampions: 30000, damageTaken: 30000 }),
    ])

    // 两人各项相同且没有治疗/控制数据：满分 10，且并列领头
    expect(ratings.get('a')?.score).toBe(10)
    expect(ratings.get('a')?.honors).toContain('leader')
    expect(ratings.get('b')?.honors).toContain('leader')
  })

  it('only credits anti-heal / anti-shield items when the enemy team calls for them', () => {
    expect(computeCounterItemBonus([3033], [16, 1])).toBe(COUNTER_ITEM_BONUS)
    expect(computeCounterItemBonus([3033], [1, 3])).toBe(0)
    expect(computeCounterItemBonus([6695], [117])).toBe(COUNTER_ITEM_BONUS)
    expect(computeCounterItemBonus([3033, 6695], [16, 117])).toBe(COUNTER_ITEM_BONUS * 2)
    expect(computeCounterItemBonus([3033, 3165, 6695], [16, 117])).toBe(0.12)
    expect(computeCounterItemBonus([], [16, 117])).toBe(0)
  })

  it('does not let counter items lift a mediocre player over the real MVP', () => {
    const ratings = computeHorseRatings([
      player('mvp', 'ORDER', { kills: 15, deaths: 3, assists: 12, damageDealtToChampions: 70000, damageTaken: 30000 }),
      player('shopper', 'ORDER', { kills: 4, deaths: 8, assists: 6, damageDealtToChampions: 20000, damageTaken: 20000 }, { items: [3033, 6695] }),
      player('healer', 'CHAOS', { kills: 2, deaths: 5, assists: 20, damageDealtToChampions: 12000, damageTaken: 20000 }, { championId: 16 }),
      player('shielder', 'CHAOS', { kills: 6, deaths: 5, assists: 10, damageDealtToChampions: 30000, damageTaken: 25000 }, { championId: 117 }),
    ])

    expect(ratings.get('shopper')?.itemBonus).toBe(0.12)
    expect(ratings.get('mvp')?.honors).toContain('leader')
    expect(ratings.get('shopper')?.honors).not.toContain('leader')
  })

  it('lets counter items decide a close race', () => {
    const ratings = computeHorseRatings([
      player('a', 'ORDER', { kills: 10, deaths: 4, assists: 10, damageDealtToChampions: 50000, damageTaken: 30000 }),
      player('b', 'ORDER', { kills: 10, deaths: 4, assists: 10, damageDealtToChampions: 48000, damageTaken: 30000 }, { items: [3165] }),
      player('healer', 'CHAOS', { kills: 2, deaths: 5, assists: 20, damageDealtToChampions: 12000, damageTaken: 20000 }, { championId: 16 }),
    ])

    expect(ratings.get('b')?.honors).toContain('leader')
    expect(ratings.get('a')?.honors).not.toContain('leader')
  })

  it('returns nothing without at least two players carrying stats', () => {
    expect(computeHorseRatings([player('solo', 'ORDER', { kills: 3 })]).size).toBe(0)
  })
})
