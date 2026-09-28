import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))
vi.mock('../../src/main/modules/logger.ts', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../../src/main/modules/app-store.ts', () => ({
  default: { get: vi.fn(() => null), set: vi.fn() },
}))
vi.mock('../../src/main/data-loader.ts', () => ({
  getChampionAugmentStats: vi.fn(async () => []),
  loadAugmentDetail: vi.fn(async () => ({})),
  loadChampionName: vi.fn(async (championId: number) => ({
    nameCN: `英雄${championId}`,
    nameEN: `Champion${championId}`,
    title: '',
    iconUrl: '',
  })),
  loadChampionRoster: vi.fn(async () => []),
}))

import { collectPosterPlayers } from '../../src/main/services/post-game-share.ts'

const eogPlayer = (summonerName: string, championId: number, teamId: number, dealt: number, taken: number, extra: Record<string, unknown> = {}) => ({
  summonerName,
  championId,
  teamId,
  stats: {
    CHAMPIONS_KILLED: 5,
    NUM_DEATHS: 3,
    ASSISTS: 12,
    TOTAL_DAMAGE_DEALT_TO_CHAMPIONS: dealt,
    TOTAL_DAMAGE_TAKEN: taken,
    GOLD_EARNED: 14000,
  },
  ...extra,
})

describe('post-game poster players', () => {
  it('collects every player from an end-of-game stats block with team and self flags', async () => {
    const payload = {
      teams: [
        { teamId: 100, players: [eogPlayer('Me#NA1', 875, 100, 41000, 30000, { isLocalPlayer: true }), eogPlayer('Buddy', 1, 100, 25000, 18000)] },
        { teamId: 200, players: [eogPlayer('Rival', 2, 200, 38000, 22000)] },
      ],
    }

    const players = await collectPosterPlayers(payload, null, [])

    expect(players.map((player) => player.summonerName)).toEqual(['Me#NA1', 'Buddy', 'Rival'])
    expect(players.map((player) => player.team)).toEqual(['ORDER', 'ORDER', 'CHAOS'])
    expect(players.map((player) => player.isSelf)).toEqual([true, false, false])
    expect(players[0].champion.id).toBe(875)
    expect(players[0].champion.name).toBe('英雄875')
    expect(players[1].stats.damageDealtToChampions).toBe(25000)
    expect(players[2].stats.damageTaken).toBe(22000)
    expect(players[0].key).toBe('name:me#na1')
  })

  it('marks self through identity candidates and keeps only one self', async () => {
    const payload = {
      allPlayers: [
        { summonerName: 'Me', championName: 'Sett', team: 'ORDER', scores: { kills: 1, deaths: 2, assists: 3 } },
        { summonerName: 'Other', championName: 'Annie', team: 'CHAOS', scores: { kills: 4, deaths: 5, assists: 6 } },
      ],
    }

    const players = await collectPosterPlayers(payload, null, ['me'])

    expect(players).toHaveLength(2)
    expect(players[0].isSelf).toBe(true)
    expect(players[1].isSelf).toBe(false)
    expect(players[1].team).toBe('CHAOS')
    expect(players[1].stats.kills).toBe(4)
  })

  it('returns nothing when the payload only describes one player', async () => {
    const players = await collectPosterPlayers({ activePlayer: { summonerName: 'Me', scores: { kills: 1, deaths: 1, assists: 1 } } }, null, [])
    expect(players).toEqual([])
  })
})
