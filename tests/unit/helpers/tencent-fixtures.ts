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

export type FakeTencent = {
  winRate: number
  championPick: Record<string, number>
  failChampions: Set<string>
  brokenRune: boolean
  calls: string[]
}

export function createFakeTencent(): FakeTencent {
  return { winRate: 0.5, championPick: {}, failChampions: new Set(), brokenRune: false, calls: [] }
}

export function fakeTencentResponse(tencent: FakeTencent, url: string): Response | null {
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
