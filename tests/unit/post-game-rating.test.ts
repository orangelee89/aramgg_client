import { describe, expect, it } from 'vitest'
import { computeHorseRatings, HORSE_RATING_WEIGHTS } from '../../src/main/services/post-game-rating.ts'

const player = (key: string, team: string, stats: Record<string, number>) => ({ key, team, stats })

describe('post-game horse ratings', () => {
  it('normalizes each metric to the match maximum and weights them', () => {
    const ratings = computeHorseRatings([
      player('carry', 'ORDER', { damageDealtToChampions: 60000, damageTaken: 20000, timeCCingOthers: 10, healsOnTeammates: 0 }),
      player('tank', 'ORDER', { damageDealtToChampions: 20000, damageTaken: 60000, timeCCingOthers: 40, healsOnTeammates: 0 }),
      player('support', 'ORDER', { damageDealtToChampions: 15000, damageTaken: 25000, timeCCingOthers: 20, healsOnTeammates: 12000, shieldsOnTeammates: 8000 }),
    ])

    const carry = ratings.get('carry')!
    expect(carry.breakdown).toEqual({ damage: 1, tank: 20000 / 60000, control: 0.25, support: 0 })
    expect(carry.score).toBeCloseTo(
      (HORSE_RATING_WEIGHTS.damage + HORSE_RATING_WEIGHTS.tank / 3 + HORSE_RATING_WEIGHTS.control * 0.25) * 10,
      2
    )
    expect(ratings.get('support')!.breakdown.support).toBe(1)
  })

  it('assigns exactly one top and one bottom horse per team', () => {
    const ratings = computeHorseRatings([
      player('a1', 'ORDER', { damageDealtToChampions: 50000, damageTaken: 30000 }),
      player('a2', 'ORDER', { damageDealtToChampions: 30000, damageTaken: 30000 }),
      player('a3', 'ORDER', { damageDealtToChampions: 10000, damageTaken: 10000 }),
      player('b1', 'CHAOS', { damageDealtToChampions: 45000, damageTaken: 20000 }),
      player('b2', 'CHAOS', { damageDealtToChampions: 5000, damageTaken: 5000 }),
    ])

    const tiers = (team: string) => [...ratings.values()].filter((rating) => rating.team === team).map((rating) => rating.tier).sort()
    expect(tiers('ORDER')).toEqual(['bottom', 'mid', 'top'])
    expect(tiers('CHAOS')).toEqual(['bottom', 'top'])
    expect(ratings.get('a1')!.rank).toBe(1)
    expect(ratings.get('a3')!.rank).toBe(3)
    expect(ratings.get('a3')!.teamSize).toBe(3)
  })

  it('counts self-mitigated damage at half weight inside the tank metric', () => {
    const ratings = computeHorseRatings([
      player('mitigator', 'ORDER', { damageDealtToChampions: 1000, damageTaken: 10000, damageSelfMitigated: 20000 }),
      player('plain', 'ORDER', { damageDealtToChampions: 1000, damageTaken: 20000 }),
    ])

    expect(ratings.get('mitigator')!.breakdown.tank).toBe(1)
    expect(ratings.get('plain')!.breakdown.tank).toBe(1)
  })

  it('returns nothing without at least two players carrying damage data', () => {
    expect(computeHorseRatings([player('solo', 'ORDER', { damageDealtToChampions: 100 })]).size).toBe(0)
    expect(computeHorseRatings([
      player('x', 'ORDER', { kills: 3 } as never),
      player('y', 'ORDER', { kills: 2 } as never),
    ]).size).toBe(0)
  })
})
