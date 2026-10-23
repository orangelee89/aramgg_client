import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  overlayAugmentsPayload,
  overlayChampionDetail,
  overlayChampionsPayload,
  overlayItemsPayload,
  type TencentGlobalSnapshot,
} from '../../src/main/services/tencent-data/tencent-overlay.ts'
import { parseKiwiAugments } from '../../src/main/services/tencent-data/tencent-parsers.ts'
import { syncGlobalFromMirror } from '../../src/main/services/tencent-data/tencent-mirror-client.ts'

// 名字取自 CDragon zh_my 实际数据：3081 国服「命运之武器」/ 马服「命定武器」，1141 国服「全心为你」/ 马服「为你而战」。
const mirrorNames = [
  { augmentID: 3081, name_cn: '命定武器', name_cn_tencent: '命运之武器', mode: 'KIWI', level: 'kGold', isPBE: 0, isNew: 1 },
  { augmentID: 1141, name_cn: '为你而战', name_cn_tencent: '全心为你', mode: 'KIWI', level: 'kGold', isPBE: 0, isNew: 0 },
  { augmentID: 3060, name_cn: '单曲红人', mode: 'KIWI', level: 'kGold', isPBE: 0, isNew: 1 },
]

function snapshot(overrides: Partial<TencentGlobalSnapshot> = {}): TencentGlobalSnapshot {
  return {
    fetchedAt: '2026-10-23T04:17:00.000Z',
    statDate: '2026-10-22',
    augments: parseKiwiAugments(mirrorNames),
    augmentStats: [{ id: '1141', pickRate: 0.03, pickRank: 205, winRate: 0.5046, winRank: 148 }],
    championStats: [{ championId: '1', rank: 3, winRate: 0.55, pickRate: 0.02 }],
    localizedNames: { champions: { '1': '安妮(马服)' }, items: { '3089': '死亡之帽' } },
    ...overrides,
  }
}

describe('zh_MY names from the mirror', () => {
  it('keeps the Tencent name as an OCR alias when parsing the mirror name table', () => {
    const [weapon, , untranslated] = parseKiwiAugments(mirrorNames)
    expect(weapon).toMatchObject({ id: '3081', name: '命定武器', aliasNames: ['命运之武器'] })
    expect(untranslated).toMatchObject({ id: '3060', name: '单曲红人', aliasNames: [] })
  })

  it('shows the mirror name and keeps replaced names as aliases', () => {
    const payload = { data: [{ id: 1141, name: '全心为你', rarity: 1, stats: null }] }
    const list = overlayAugmentsPayload(payload, snapshot()).data
    const allForYou = list.find((augment: any) => augment.id === 1141)
    expect(allForYou.name).toBe('为你而战')
    expect(allForYou.aliasNames).toEqual(['全心为你'])

    const weapon = list.find((augment: any) => augment.id === 3081)
    expect(weapon.name).toBe('命定武器')
    expect(weapon.aliasNames).toEqual(['命运之武器'])
  })

  it('tolerates snapshots saved before alias names existed', () => {
    const legacy = snapshot({
      augments: parseKiwiAugments(mirrorNames).map(({ aliasNames: _aliasNames, ...meta }) => meta as any),
    })
    const list = overlayAugmentsPayload({ data: [{ id: 1141, name: '全心为你' }] }, legacy).data
    expect(list[0]).toMatchObject({ name: '为你而战', aliasNames: ['全心为你'] })
  })

  it('uses mirror champion and item names', () => {
    const champions = overlayChampionsPayload({ data: [{ id: 1, name: '安妮', stats: {} }, { id: 2, name: '奥拉夫' }] }, snapshot())
    expect(champions.data.map((champion: any) => champion.name)).toEqual(['安妮(马服)', '奥拉夫'])
    expect(champions.data[0].stats.winRate).toBe(0.55)

    const items = overlayItemsPayload({ data: [{ id: 3089, name: '灭世者的死亡之帽' }, { id: 1001, name: '鞋子' }] }, snapshot())
    expect(items.data.map((item: any) => item.name)).toEqual(['死亡之帽', '鞋子'])
  })

  it('renames the champion and its augments in champion detail', () => {
    const detail = {
      championId: 1,
      champion: { id: 1, name: '安妮', stats: {} },
      augments: [{ id: 1141, name: '全心为你', stats: { winRate: 0.5 } }],
    }
    const result = overlayChampionDetail(detail, snapshot(), {
      fetchedAt: '2026-10-23T04:17:00.000Z',
      championId: '1',
      augments: [
        { augmentId: '3081', rank: 1, pickRate: 0.2, grade: 'S' },
        { augmentId: '1141', rank: 2, pickRate: 0.1, grade: 'A' },
      ],
    })
    expect(result.champion.name).toBe('安妮(马服)')
    expect(result.augments.map((augment: any) => augment.name)).toEqual(['命定武器', '为你而战'])
  })

  it('leaves names alone without mirror translations (direct Tencent fallback)', () => {
    const direct = snapshot({
      augments: parseKiwiAugments([{ augmentID: 1141, name_cn: '全心为你', mode: 'KIWI', level: 'kGold' }]),
      localizedNames: undefined,
    })
    expect(overlayAugmentsPayload({ data: [{ id: 1141, name: '全心为你' }] }, direct).data[0].name).toBe('全心为你')
    expect(overlayItemsPayload({ data: [{ id: 3089, name: '灭世者的死亡之帽' }] }, direct).data[0].name).toBe('灭世者的死亡之帽')
    expect(overlayChampionsPayload({ data: [{ id: 1, name: '安妮' }] }, direct).data[0].name).toBe('安妮')
  })

  it('returns localized champion and item names from the mirror global file', async () => {
    const body = {
      schemaVersion: 1,
      hash: 'aaaaaaaaaaaaaaaa',
      fetchedAt: '2026-10-23T04:17:00.000Z',
      names: mirrorNames,
      rune: {},
      hero: {},
      localizedNames: { locale: 'zh-MY', champions: { '1': '安妮', bad: 'x' }, items: { '3089': '死亡之帽', '1': '' } },
    }
    const result = await syncGlobalFromMirror(
      'https://example.test',
      null,
      { updatedAt: '', global: { hash: 'aaaaaaaaaaaaaaaa', fetchedAt: '' }, champions: {} },
      async () => ({ status: 200, text: JSON.stringify(body) })
    )
    expect(result.status).toBe('updated')
    expect(result.status === 'updated' && result.localizedNames).toEqual({
      champions: { '1': '安妮' },
      items: { '3089': '死亡之帽' },
    })
  })
})

describe('zh_MY OCR names', () => {
  afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('matches both the mirror (zh_MY) name and the Tencent alias of a new augment', async () => {
    vi.doMock('../../src/main/data-loader.ts', () => ({
      DEFAULT_DATA_LOCALE: 'zh-CN',
      SUPPORTED_DATA_LOCALES: [{ code: 'zh-CN' }],
      getDataLocale: () => 'zh-CN',
      loadAugmentBaseForOcrLocale: vi.fn(async (locale: string) => ({
        locale,
        dataVersion: '16.20.4',
        augments: [{ id: 3081, name: '命定武器', aliasNames: ['命运之武器'], rarity: 'kGold', iconPath: null }],
      })),
      tryNormalizeDataLocale: () => null,
    }))
    vi.doMock('../../src/main/services/lcu/process-auth-discovery.ts', () => ({
      discoverLcuAuthFromProcess: vi.fn(async () => [null, null]),
    }))

    const { matchAugmentDatabase, shutdownImageAnalyzer } = await import('../../src/main/image-analyzer.ts')
    try {
      expect(await matchAugmentDatabase('命定武器')).toMatchObject([{ id: '3081', name: '命定武器' }])
      expect(await matchAugmentDatabase('命运之武器')).toMatchObject([{ id: '3081' }])
    } finally {
      await shutdownImageAnalyzer()
    }
  })
})
