import { describe, expect, it, vi } from 'vitest'
import { createItemSets } from '../../src/main/services/item-sets/item-set-installer.ts'

vi.mock('../../src/main/modules/logger.ts', () => ({
  default: { info: vi.fn(), warn: vi.fn() },
}))
vi.mock('../../src/main/services/lcu/lcu-service.ts', () => ({
  getLCUServiceInstance: vi.fn(),
}))
vi.mock('../../src/main/data-loader.ts', () => ({
  loadChampionBuild: vi.fn(),
  loadChampionName: vi.fn(),
}))

describe('ARAM item set builder', () => {
  const firstBuild = {
    tags: { style: 'AP' },
    patch: '16.12',
    games: 1000,
    winRate: 0.54,
    startingItems: [{ itemIds: [1056, 2003], games: 160, winRate: 0.52 }],
    coreItems: [{ itemIds: [6653, 3020, 4645], games: 500, winRate: 0.55 }],
    itemExtensions: [{ itemIds: [3089], games: 90, winRate: 0.56 }],
    situationalItems: [{ itemId: 3157, games: 120, winRate: 0.57 }],
  }

  const secondBuild = {
    tags: { style: 'Burn' },
    games: 900,
    winRate: 0.53,
    coreItems: [{ itemIds: [6655, 3020, 4646], games: 420, winRate: 0.54 }],
  }

  it('creates one LCU item set per trusted build variant', () => {
    const result = createItemSets(
      { championId: 1, alias: 'Annie' },
      null,
      { builds: [firstBuild, secondBuild] }
    )

    expect(result.totalBuilds).toBe(2)
    expect(result.skippedBuilds).toEqual([])
    expect(result.itemSets).toHaveLength(2)
    expect(result.itemSets[0].title).toBe('AP')
    expect(result.itemSets[1].title).toBe('Burn')
    expect(result.itemSets[0].sortrank).toBe(100)
    expect(result.itemSets[0].blocks.map(block => block.type)).toEqual([
      '出门装 1',
      '核心 1',
      '后续装备',
      '备选装备',
    ])
  })

  it('mirrors the champion detail layout: starters, core sequences, later and alternative items', () => {
    const result = createItemSets(
      { championId: 875, alias: 'Sett' },
      null,
      [{
        tags: { style: 'Bruiser' },
        games: 5480,
        startingItems: [
          { itemIds: [2003, 3067], games: 1, pickRate: 0.00008, winRate: 0.5 },
          { itemIds: [1036, 2003, 2051], games: 1, pickRate: 0.00008, winRate: 0.5 },
          { itemIds: [1028, 3006], games: 1, pickRate: 0.00008, winRate: 0.5 },
        ],
        coreItems: [
          { itemIds: [3748, 3111, 6631], games: 613, winRate: 0.56 },
          { itemIds: [3084, 3111, 6631], games: 631, winRate: 0.54 },
          { itemIds: [3748, 3111, 3053], games: 376, winRate: 0.51 },
        ],
        itemExtensions: [
          { step: 1, itemIds: [3053], games: 133 },
          { step: 2, itemIds: [3053, 3143], games: 149 },
          { step: 1, itemIds: [3748], games: 67 },
        ],
        situationalItems: [
          { itemId: 3047, games: 1588, distinctiveScore: 1.2 },
          { itemId: 3143, games: 1356, distinctiveScore: 2.9 },
          { itemId: 3053, games: 811, distinctiveScore: 2.1 },
        ],
      }]
    )

    const blocks = result.itemSets[0].blocks
    const itemsOf = (index: number) => blocks[index].items.map(item => item.id)

    expect(blocks.map(block => block.type)).toEqual([
      '出门装 1',
      '出门装 2',
      '核心 1',
      '核心 2',
      '核心 3',
      '后续装备',
      '备选装备',
    ])
    // 631 与 613 场都属于"场次多"，按胜率 56% 的序列排前面
    expect(itemsOf(2)).toEqual(['3748', '3111', '6631'])
    expect(itemsOf(3)).toEqual(['3084', '3111', '6631'])
    // 后续装备摊平成单件、按场次排序、去重
    expect(itemsOf(5)).toEqual(['3053', '3143', '3748'])
    // 备选装备按区分度排序
    expect(itemsOf(6)).toEqual(['3143', '3053', '3047'])
  })

  it('numbers item sets that share the same route name', () => {
    const result = createItemSets(
      { championId: 1, alias: 'Annie' },
      null,
      [
        { tags: { style: 'AD, Bruiser' }, games: 1000, coreItems: [{ itemIds: [3084, 3111, 6631], games: 500 }] },
        { tags: { style: 'AD, Bruiser' }, games: 900, coreItems: [{ itemIds: [3748, 3111, 6631], games: 400 }] },
      ]
    )

    expect(result.itemSets.map(itemSet => itemSet.title)).toEqual(['AD / Bruiser', 'AD / Bruiser 2'])
  })

  it('does not number a route whose name is a prefix of another route', () => {
    const result = createItemSets(
      { championId: 22, alias: 'Ashe' },
      null,
      [
        { tags: { style: 'AD, Crit' }, games: 1000, coreItems: [{ itemIds: [3031, 3006, 3072], games: 500 }] },
        { tags: { style: 'AD' }, games: 900, coreItems: [{ itemIds: [3142, 3006, 6676], games: 400 }] },
      ]
    )

    expect(result.itemSets.map(itemSet => itemSet.title)).toEqual(['AD / Crit', 'AD'])
  })

  it('splits later and alternative items into rows of five without dropping any', () => {
    const result = createItemSets(
      { championId: 1, alias: 'Annie' },
      null,
      [{
        tags: { style: 'AP' },
        games: 1000,
        coreItems: [{ itemIds: [6653, 3020, 4645], games: 500 }],
        itemExtensions: Array.from({ length: 8 }, (_, index) => ({ itemIds: [4000 + index], games: 100 - index })),
        situationalItems: Array.from({ length: 9 }, (_, index) => ({ itemId: 5000 + index, games: 100 - index })),
      }]
    )

    const blocks = result.itemSets[0].blocks
    const types = blocks.map(block => block.type)
    expect(types).toEqual(['核心 1', '后续装备 1', '后续装备 2', '备选装备 1', '备选装备 2'])
    expect(blocks[1].items).toHaveLength(5)
    expect(blocks[2].items).toHaveLength(3)
    expect(blocks[3].items).toHaveLength(5)
    expect(blocks[4].items).toHaveLength(4)
  })

  it('orders sequences and builds by games tier first, then win rate', () => {
    const result = createItemSets(
      { championId: 1, alias: 'Annie' },
      null,
      [
        {
          tags: { style: 'AP' },
          games: 900,
          winRate: 0.5,
          coreItems: [
            { itemIds: [1, 2, 3], games: 1000, winRate: 0.5 },
            { itemIds: [4, 5, 6], games: 900, winRate: 0.56 },
            { itemIds: [7, 8, 9], games: 100, winRate: 0.7 },
            { itemIds: [10, 11, 12], games: 80, winRate: 0.4 },
          ],
        },
        { tags: { style: 'Burn' }, games: 1000, winRate: 0.53, coreItems: [{ itemIds: [13, 14, 15], games: 500 }] },
        { tags: { style: 'Tank' }, games: 300, winRate: 0.6, coreItems: [{ itemIds: [16, 17, 18], games: 300 }] },
      ]
    )

    // 路线：Burn(1000场 53%) 与 AP(900场 50%) 场次多，Burn 胜率高在前；Tank 场次少排最后
    expect(result.itemSets.map(itemSet => itemSet.title)).toEqual(['Burn', 'AP', 'Tank'])
    const apBlocks = result.itemSets[1].blocks.filter(block => block.type.startsWith('核心'))
    expect(apBlocks.map(block => block.items.map(item => item.id))).toEqual([
      ['4', '5', '6'],
      ['1', '2', '3'],
      ['7', '8', '9'],
      ['10', '11', '12'],
    ])
  })

  it('also accepts a raw builds array', () => {
    const result = createItemSets(
      { championId: 1, alias: 'Annie' },
      null,
      [firstBuild, secondBuild]
    )

    expect(result.itemSets).toHaveLength(2)
  })

  it('accepts the current Tencent build when only recommendation rates are available', () => {
    const result = createItemSets(
      { championId: 35, alias: 'Shaco' },
      null,
      [{
        patch: '16.15',
        tier: 'Tencent',
        games: 0,
        startingItems: [{ itemIds: [3802], games: 0, pickRate: 0.1638, winRate: 0.5155 }],
        coreItems: [{ itemIds: [126697, 6676, 3031], games: 0, pickRate: 0.161, winRate: 0.4337 }],
        fullItems: [{ itemIds: [126697, 3031, 3036, 3508, 6676, 6699], games: 0, pickRate: 0.0297, winRate: 0.505 }],
        itemExtensions: [],
        situationalItems: [{ itemId: 3020, games: 0, pickRate: 0.1306, winRate: 0.4893 }],
      }]
    )

    expect(result.skippedBuilds).toEqual([])
    expect(result.itemSets).toHaveLength(1)
    expect(result.itemSets[0].blocks.map(block => block.type)).toEqual([
      '出门装 1',
      '核心 1',
      '完整出装 1',
      '备选装备',
    ])
  })

  it('still rejects builds without game counts or recommendation rates', () => {
    const result = createItemSets(
      { championId: 35, alias: 'Shaco' },
      null,
      [{ coreItems: [{ itemIds: [6676, 3031, 3036], games: 0, pickRate: 0 }] }]
    )

    expect(result.itemSets).toHaveLength(0)
    expect(result.skippedBuilds).toHaveLength(1)
  })
})
