import { describe, expect, it } from 'vitest'
import {
  gradeToTier,
  parseAugmentRank,
  parseChampionAugments,
  parseHeroRank,
  parseKiwiAugments,
  rankToTier,
  unwrapOdpPayload,
} from '../../src/main/services/tencent-data/tencent-parsers.ts'
import {
  overlayAugmentsPayload,
  overlayChampionDetail,
  overlayChampionsPayload,
  type TencentChampionSnapshot,
  type TencentGlobalSnapshot,
} from '../../src/main/services/tencent-data/tencent-overlay.ts'

function odp(inner: Record<string, unknown>) {
  return { code: 0, data: { _fieldValues: { R15381: JSON.stringify(inner) } } }
}

const kiwiSample = [
  {
    augmentID: 1001,
    name_en: 'ARAM_ImTheJuggernaut',
    name_cn: '泰坦的坚决',
    mode: 'KIWI, KIWI_JADE',
    level: 'kPrismatic',
    isPBE: 0,
    isNew: 0,
    desc: '在承受或造成伤害时获得层数。',
    tooltip: '获得层数。',
    large_Icon: 'https://game.gtimg.cn/images/lol/act/img/rune/iamthejuggernaut_large.png',
  },
  {
    augmentID: 3081,
    name_en: 'WeaponOfDestiny',
    name_cn: '命运之武器',
    mode: 'KIWI',
    level: 'kGold',
    isPBE: 0,
    isNew: 1,
    large_Icon: 'https://game.gtimg.cn/images/lol/act/img/rune/weaponofdestiny_large.png',
  },
  { augmentID: 3999, name_cn: '体验服专属', mode: 'KIWI', level: 'kGold', isPBE: 1, isNew: 1 },
  { augmentID: 4000, name_cn: '斗魂竞技场', mode: 'CHERRY', level: 'kGold', isPBE: 0, isNew: 1 },
  { augmentID: 4001, name_cn: '', mode: 'KIWI', level: 'kGold' },
]

describe('tencent parsers', () => {
  it('unwraps the odp proxy envelope', () => {
    expect(unwrapOdpPayload(odp({ dtstatdate: '20261022' }))).toEqual({ dtstatdate: '20261022' })
    expect(unwrapOdpPayload({ code: 0, data: null })).toBeNull()
    expect(unwrapOdpPayload({ data: { _fieldValues: { R1: 'not json' } } })).toBeNull()
  })

  it('parses augment rank rows and skips malformed rows', () => {
    const rows = parseAugmentRank({
      augmentlist:
        '1001_255_0.1692_90_-13_0.4805_199_13_223,36,50#1004_255_0.2925_36_-3_0.5868_11_-7_13,4#bad_row#1005_255_1.5_1_0_0.5_1_0_',
    })
    expect(rows).toEqual([
      { id: '1001', pickRate: 0.1692, pickRank: 90, winRate: 0.4805, winRank: 199 },
      { id: '1004', pickRate: 0.2925, pickRank: 36, winRate: 0.5868, winRank: 11 },
    ])
  })

  it('parses hero rank rows', () => {
    const rows = parseHeroRank({
      listcollect: '120_1_未变化_0.5577_0.118_17,0.059,0.6036,1&136,0.0513,0.6176,2_12.3_0.6_0.2_0.3_#17_2_上升1位_0.5453_0.1357_',
    })
    expect(rows).toEqual([
      { championId: '120', rank: 1, winRate: 0.5577, pickRate: 0.118 },
      { championId: '17', rank: 2, winRate: 0.5453, pickRate: 0.1357 },
    ])
  })

  it('prefers the overall 255 segment for per-champion augments', () => {
    const rows = parseChampionAugments({
      augment_json_irank:
        '255:1|1|3055|255|0.1393|S#2|1|1068|255|0.1204|S#3|1|1030|255|0.1165|A&kGold:1|1|1104|kGold|0.1613',
    })
    expect(rows.map((row) => row.augmentId)).toEqual(['3055', '1068', '1030'])
    expect(rows[0]).toEqual({ augmentId: '3055', rank: 1, pickRate: 0.1393, grade: 'S' })
  })

  it('merges rarity segments by pick rate when no overall segment exists', () => {
    const rows = parseChampionAugments({
      augment_json: 'kGold:1|1|1104|kGold|0.1613#2|1|1068|kGold|0.1204&kPrismatic:1|1|1030|kPrismatic|0.1365',
    })
    expect(rows.map((row) => [row.augmentId, row.rank])).toEqual([
      ['1104', 1],
      ['1030', 2],
      ['1068', 3],
    ])
  })

  it('keeps only ARAM mayhem augments from the name table', () => {
    const augments = parseKiwiAugments(kiwiSample)
    expect(augments.map((augment) => augment.id)).toEqual(['1001', '3081'])
    expect(augments[1]).toMatchObject({ name: '命运之武器', rarity: 'kGold', isNew: true })
  })

  it('maps rank percentiles to client tiers like the Tencent site', () => {
    expect(rankToTier(1, 100)).toBe(1)
    expect(rankToTier(5, 100)).toBe(2)
    expect(rankToTier(30, 100)).toBe(3)
    expect(rankToTier(40, 100)).toBe(4)
    expect(rankToTier(41, 100)).toBe(5)
    expect(rankToTier(0, 100)).toBeNull()
    expect(gradeToTier('s')).toBe(1)
    expect(gradeToTier('?')).toBeNull()
  })
})

function snapshot(overrides: Partial<TencentGlobalSnapshot> = {}): TencentGlobalSnapshot {
  return {
    fetchedAt: '2026-10-22T08:00:00.000Z',
    statDate: '2026-10-22',
    augments: parseKiwiAugments(kiwiSample),
    augmentStats: [
      { id: '1001', pickRate: 0.17, pickRank: 2, winRate: 0.48, winRank: 2 },
      { id: '3081', pickRate: 0.05, pickRank: 1, winRate: 0.55, winRank: 1 },
    ],
    championStats: [{ championId: '1', rank: 1, winRate: 0.53, pickRate: 0.02 }],
    ...overrides,
  }
}

describe('tencent overlay', () => {
  it('updates existing augment stats and adds new augments', () => {
    const payload = {
      dataVersion: '16.20.4',
      data: [
        {
          id: 1001,
          name: '泰坦的坚决',
          rarity: 2,
          rarityName: 'prismatic',
          iconUrl: 'https://cdn.dtodo.cn/a.png',
          stats: { tier: 5, winRate: 0.4, pickRate: 0.1, gamePatch: '16.20', date: '2026-10-12' },
        },
      ],
    }

    const merged = overlayAugmentsPayload(payload, snapshot())
    expect(merged.dataVersion).toBe('16.20.4')
    expect(merged.data).toHaveLength(2)
    expect(merged.data[0]).toMatchObject({
      id: 1001,
      iconUrl: 'https://cdn.dtodo.cn/a.png',
      stats: { winRate: 0.48, pickRate: 0.17, gamePatch: '16.20', date: '2026-10-22', source: 'tencent' },
    })
    expect(merged.data[1]).toMatchObject({
      id: 3081,
      name: '命运之武器',
      rarity: 1,
      rarityName: 'gold',
      statsAvailable: true,
      stats: { winRate: 0.55, rank: 1 },
    })
    expect(payload.data[0].stats.winRate).toBe(0.4)
  })

  it('returns the original payload without a snapshot', () => {
    const payload = { data: [] }
    expect(overlayAugmentsPayload(payload, null)).toBe(payload)
    expect(overlayChampionsPayload(payload, null)).toBe(payload)
    expect(overlayChampionDetail(payload, null, null)).toBe(payload)
  })

  it('replaces champion stats from the hero rank', () => {
    const merged = overlayChampionsPayload(
      { data: [{ id: 1, name: '安妮', stats: { tier: 5, winRate: 0.48, gamePatch: '16.20' } }, { id: 2, stats: {} }] },
      snapshot()
    )
    expect(merged.data[0].stats).toMatchObject({ tier: 1, winRate: 0.53, pickRate: 0.02, gamePatch: '16.20' })
    expect(merged.data[1].stats).toEqual({})
  })

  it('reorders champion augments by Tencent pick rank and keeps uploaded win rates', () => {
    const detail = {
      championId: 1,
      champion: { id: 1, name: '安妮', stats: { tier: 5 } },
      augments: [
        {
          id: 1001,
          name: '泰坦的坚决',
          stats: { winRate: 0.46, wins: 172, games: 374, winRateSource: 'aramgg-client-upload', pickRate: 0.01 },
        },
        { id: 1004, name: '回归基本功', stats: { winRate: 0.5, pickRate: 0.002 } },
      ],
      builds: [{ itemIds: ['3020'] }],
    }
    const championSnapshot: TencentChampionSnapshot = {
      fetchedAt: '2026-10-22T08:00:00.000Z',
      championId: '1',
      augments: [
        { augmentId: '3081', rank: 1, pickRate: 0.14, grade: 'S' },
        { augmentId: '1001', rank: 2, pickRate: 0.12, grade: 'A' },
        { augmentId: '1004', rank: 3, pickRate: 0.01, grade: 'B' },
      ],
    }

    const merged = overlayChampionDetail(detail, snapshot(), championSnapshot)
    expect(merged.builds).toBe(detail.builds)
    expect(merged.champion.stats).toMatchObject({ winRate: 0.53, tier: 1 })
    expect(merged.augments.map((augment: any) => augment.id)).toEqual([3081, 1001, 1004])
    expect(merged.augments[0]).toMatchObject({ name: '命运之武器', stats: { tier: 1, pickRate: 0.14, winRate: null } })
    expect(merged.augments[1].stats).toMatchObject({ winRate: 0.46, games: 374, pickRate: 0.12, tier: 2, rank: 2 })
    expect(merged.augments[2].stats).toMatchObject({ winRate: null, pickRate: 0.01, tier: 3 })
  })
})
