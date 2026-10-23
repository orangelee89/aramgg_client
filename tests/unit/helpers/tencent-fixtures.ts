// 模拟掌盟接口的返回格式（外层 JSON 套一层 JSON 字符串），供取数脚本与客户端测试共用。

export const HERO_IDS = Array.from({ length: 60 }, (_, index) => String(index + 1))

export function odpText(inner: Record<string, unknown>, key = 'R15381'): string {
  return JSON.stringify({ code: 0, data: { _fieldValues: { [key]: JSON.stringify(inner) } } })
}

export function namesText(count = 60): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      augmentID: 1001 + index,
      name_cn: index === 0 ? '命运之武器' : `海克斯${index}`,
      mode: 'KIWI',
      level: 'kGold',
      isPBE: 0,
      isNew: index === 0 ? 1 : 0,
      large_Icon: `https://game.gtimg.cn/images/lol/act/img/rune/a${index}.png`,
    }))
  )
}

export function runeText(winRate = 0.5, count = 60): string {
  const list = Array.from(
    { length: count },
    (_, index) => `${1001 + index}_255_0.1_${index + 1}_0_${winRate}_${index + 1}_0_1,2,3`
  ).join('#')
  return odpText({ dtstatdate: '20261022', augmentlist: list })
}

export function heroRankText(winRate = 0.5): string {
  const list = HERO_IDS.map((id, index) => `${id}_${index + 1}_未变化_${winRate}_0.05_2,0.05,0.6,1_10_0.5_0.2_0.2_`).join('#')
  return odpText({ listcollect: list }, 'R15380')
}

export function championText(championId: string, pickRate = 0.2): string {
  const rows = [1001, 1002, 1003]
    .map((augmentId, index) => `${index + 1}|${championId}|${augmentId}|255|${pickRate - index * 0.01}|S`)
    .join('#')
  return odpText({ augment_json_irank: `255:${rows}` }, 'R15318')
}

// Riot zh_MY（马来西亚简中）译名：1001 对应国服「命运之武器」，马服叫「命定武器」（取自 CDragon 实际数据）。
export const ZH_MY_WEAPON_NAME = '命定武器'
export const ZH_MY_MISSING_ID = 1060

export function cdragonAugmentsText(): string {
  const list: any[] = Array.from({ length: 60 }, (_, index) => ({
    id: 1001 + index,
    augmentNameId: index === 0 ? 'WeaponOfDestiny' : `ARAM_Augment${index}`,
    nameTRA: index === 0 ? ZH_MY_WEAPON_NAME : `马服海克斯${index}`,
    rarity: 'kGold',
  })).filter((entry) => entry.id !== ZH_MY_MISSING_ID)
  for (let index = 0; index < 60; index++) {
    list.push({ id: 5001 + index, augmentNameId: `ARAM_Extra${index}`, nameTRA: `马服额外${index}`, rarity: 'kSilver' })
  }
  list.push({ id: 9001, augmentNameId: 'ArenaOnly', nameTRA: '斗魂竞技场专属', rarity: 'kGold' })
  return JSON.stringify(list)
}

export function cdragonChampionsText(): string {
  return JSON.stringify([
    { id: -1, name: '无' },
    ...Array.from({ length: 120 }, (_, index) => ({ id: index + 1, name: `马服英雄${index + 1}` })),
  ])
}

export function cdragonItemsText(): string {
  return JSON.stringify(Array.from({ length: 120 }, (_, index) => ({ id: 3000 + index, name: `马服装备${index}` })))
}

export type FakeTencent = {
  winRate: number
  championPick: Record<string, number>
  failChampions: Set<string>
  brokenRune: boolean
  cdragonDown: boolean
  calls: string[]
}

export function createFakeTencent(): FakeTencent {
  return { winRate: 0.5, championPick: {}, failChampions: new Set(), brokenRune: false, cdragonDown: false, calls: [] }
}

export function fakeTencentResponse(tencent: FakeTencent, url: string): Response | null {
  if (url.startsWith('https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/zh_my/v1/')) {
    tencent.calls.push(url)
    if (tencent.cdragonDown) {
      return new Response('down', { status: 503 })
    }

    if (url.endsWith('/cherry-augments.json')) return new Response(cdragonAugmentsText())
    if (url.endsWith('/champion-summary.json')) return new Response(cdragonChampionsText())
    if (url.endsWith('/items.json')) return new Response(cdragonItemsText())
    return null
  }

  if (url.startsWith('https://game.gtimg.cn/images/lol/act/img/js/kiwi/kiwi_augments.json')) {
    tencent.calls.push(url)
    return new Response(namesText())
  }

  if (url.includes('/fuwen_aram_rune_rank_v2')) {
    tencent.calls.push(url)
    return new Response(tencent.brokenRune ? '{"code":0,"data":null}' : runeText(tencent.winRate))
  }

  if (url.includes('/fuwen_aram_hero_rank_v2')) {
    tencent.calls.push(url)
    return new Response(heroRankText(tencent.winRate))
  }

  const champion = /\/fuwen_hero_rank\?championid=(\d+)/.exec(url)
  if (champion) {
    tencent.calls.push(url)
    if (tencent.failChampions.has(champion[1])) {
      return new Response('error', { status: 500 })
    }

    return new Response(championText(champion[1], tencent.championPick[champion[1]] ?? 0.2))
  }

  return null
}
