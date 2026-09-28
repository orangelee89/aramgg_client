import { describe, expect, it } from 'vitest'
import { computeHorseRatings } from '../../src/main/services/post-game-rating.ts'

const player = (key: string, team: string, stats: Record<string, number>) => ({ key, team, stats })

describe('post-game horse honors', () => {
  it('hands each honor to the leader of its stat within each team', () => {
    const ratings = computeHorseRatings([
      player('carry', 'ORDER', { kills: 8, deaths: 3, assists: 10, damageDealtToChampions: 60000, damageTaken: 20000 }),
      player('tank', 'ORDER', { kills: 2, deaths: 6, assists: 20, damageDealtToChampions: 15000, damageTaken: 70000 }),
      player('assassin', 'CHAOS', { kills: 14, deaths: 9, assists: 4, damageDealtToChampions: 40000, damageTaken: 25000 }),
      player('support', 'CHAOS', { kills: 1, deaths: 5, assists: 30, damageDealtToChampions: 9000, damageTaken: 18000 }),
      player('filler', 'CHAOS', { kills: 5, deaths: 4, assists: 12, damageDealtToChampions: 20000, damageTaken: 22000 }),
    ])

    // 我方：carry 输出+人头最高，tank 承伤+助攻+死亡最多——即使对面 assassin 人头更多，carry 仍是队内 K头
    expect(ratings.get('carry')?.honors).toEqual(['top', 'kills'])
    expect(ratings.get('carry')?.honorValues).toEqual({ top: 60000, kills: 8 })
    expect(ratings.get('tank')?.honors).toEqual(['tank', 'assists', 'deaths'])
    // 对面：assassin 输出+承伤+人头+死亡，support 助攻，filler 什么都不沾
    expect(ratings.get('assassin')?.honors).toEqual(['top', 'tank', 'kills', 'deaths'])
    expect(ratings.get('support')?.honors).toEqual(['assists'])
    expect(ratings.get('filler')?.honors).toEqual([])
    expect(ratings.get('filler')?.playerCount).toBe(5)
  })

  it('stacks honors in name order for a player who leads several stats', () => {
    const ratings = computeHorseRatings([
      player('monster', 'ORDER', { kills: 20, deaths: 10, assists: 25, damageDealtToChampions: 80000, damageTaken: 60000 }),
      player('quiet', 'CHAOS', { kills: 2, deaths: 2, assists: 3, damageDealtToChampions: 10000, damageTaken: 10000 }),
    ])

    expect(ratings.get('monster')?.honors).toEqual(['top', 'tank', 'kills', 'assists', 'deaths'])
    // quiet 独自一队，队内每项都是自己最高
    expect(ratings.get('quiet')?.honors).toEqual(['top', 'tank', 'kills', 'assists', 'deaths'])
  })

  it('shares an honor between teammates tied at the top value', () => {
    const ratings = computeHorseRatings([
      player('a', 'ORDER', { kills: 9, deaths: 2, assists: 5, damageDealtToChampions: 30000, damageTaken: 30000 }),
      player('b', 'ORDER', { kills: 9, deaths: 4, assists: 4, damageDealtToChampions: 20000, damageTaken: 20000 }),
    ])

    expect(ratings.get('a')?.honors).toEqual(['top', 'tank', 'kills', 'assists'])
    expect(ratings.get('b')?.honors).toEqual(['kills', 'deaths'])
  })

  it('returns nothing without at least two players carrying stats', () => {
    expect(computeHorseRatings([player('solo', 'ORDER', { kills: 3 })]).size).toBe(0)
  })
})
