import { describe, expect, it } from 'vitest'
import { calculatePlayerStrengthScore, getStrengthGrade } from '../../src/main/services/aram/teammate-strength.ts'
import { assignHorseTitles, summarizePlayer } from '../../src/main/services/aram/teammate-analysis.ts'
import type { TeammateAnalysisPlayer } from '../../src/shared/ipc-contract.ts'

const PUUID = '11111111-2222-3333-4444-555555555555'

function participant(overrides: Record<string, unknown> = {}) {
  return {
    puuid: PUUID,
    teamId: 100,
    championId: 1,
    win: true,
    kills: 10,
    deaths: 4,
    assists: 20,
    totalDamageDealtToChampions: 30000,
    totalDamageTaken: 25000,
    goldEarned: 13000,
    damageDealtToObjectives: 3000,
    totalMinionsKilled: 60,
    neutralMinionsKilled: 0,
    timePlayed: 1200,
    riotIdGameName: '斑马',
    riotIdTagline: 'NA1',
    ...overrides,
  }
}

function game(id: number, self: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const mates = [2, 3, 4, 5].map((n) => ({
    puuid: `00000000-0000-0000-0000-00000000000${n}`,
    teamId: 100,
    kills: 5,
    deaths: 6,
    assists: 12,
    totalDamageDealtToChampions: 20000,
    totalDamageTaken: 22000,
    goldEarned: 11000,
    damageDealtToObjectives: 1500,
    win: self.win ?? true,
  }))
  return {
    gameId: id,
    gameMode: 'ARAM',
    queueId: 2400,
    gameDuration: 1200,
    participants: [participant(self), ...mates],
    ...extra,
  }
}

function basePlayer(overrides: Partial<TeammateAnalysisPlayer> = {}): TeammateAnalysisPlayer {
  return {
    floor: 1,
    cellId: 0,
    puuid: PUUID,
    gameName: '',
    tagLine: '',
    championId: 0,
    isSelf: false,
    status: 'empty',
    games: 0,
    wins: 0,
    winRate: null,
    avgKills: 0,
    avgDeaths: 0,
    avgAssists: 0,
    kda: null,
    score: null,
    grade: null,
    lowConfidence: false,
    title: 'newbie',
    error: null,
    ...overrides,
  }
}

describe('teammate strength score', () => {
  it('scores within the 3-16 display range and rewards better games', () => {
    const strong = calculatePlayerStrengthScore([game(1), game(2), game(3)], PUUID)
    const weak = calculatePlayerStrengthScore(
      [1, 2, 3].map((id) => game(id, { win: false, kills: 1, deaths: 12, assists: 3, totalDamageDealtToChampions: 6000 })),
      PUUID,
    )
    expect(strong).not.toBeNull()
    expect(weak).not.toBeNull()
    expect(strong!.score).toBeGreaterThan(weak!.score)
    for (const value of [strong!.score, weak!.score]) {
      expect(value).toBeGreaterThanOrEqual(3)
      expect(value).toBeLessThanOrEqual(16)
    }
    expect(strong!.lowConfidence).toBe(true)
  })

  it('skips early surrenders and games with AFK teammates', () => {
    const games = [
      game(1, { gameEndedInEarlySurrender: true }),
      game(2, { challenges: { hadAfkTeammate: 1 } }),
    ]
    expect(calculatePlayerStrengthScore(games, PUUID)).toBeNull()
  })

  it('maps scores to grades', () => {
    expect(getStrengthGrade(15.2)).toBe('legendary')
    expect(getStrengthGrade(10)).toBe('balanced')
    expect(getStrengthGrade(4)).toBe('critical')
  })
})

describe('teammate analysis', () => {
  it('summarizes win rate, KDA and name from SGP games of the current queue', () => {
    const result = summarizePlayer(basePlayer(), [game(1), game(2, { win: false }), game(3, {}, { queueId: 450 })], 2400)
    expect(result).toMatchObject({ status: 'ok', games: 2, wins: 1, winRate: 0.5, gameName: '斑马', tagLine: 'NA1' })
    expect(result.kda).toBeCloseTo((20 + 40) / 8)
    expect(result.score).not.toBeNull()
  })

  it('marks players without games in this mode as empty', () => {
    expect(summarizePlayer(basePlayer(), [game(1, {}, { queueId: 450 })], 2400).status).toBe('empty')
  })

  it('assigns horse titles by score rank and leaves unscored players as newbie', () => {
    const players = [
      basePlayer({ floor: 1, score: 9 }),
      basePlayer({ floor: 2, score: 14 }),
      basePlayer({ floor: 3, score: null }),
      basePlayer({ floor: 4, score: 11 }),
      basePlayer({ floor: 5, score: 6 }),
    ]
    assignHorseTitles(players)
    expect(players.map((player) => player.title)).toEqual(['mid', 'ace', 'newbie', 'high', 'low'])
  })
})
