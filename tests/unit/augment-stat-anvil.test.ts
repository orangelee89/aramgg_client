import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/data-loader.ts', () => ({
  DEFAULT_DATA_LOCALE: 'zh-CN',
  SUPPORTED_DATA_LOCALES: [{ code: 'zh-CN' }],
  getDataLocale: () => 'zh-CN',
  loadAugmentBaseForOcrLocale: vi.fn(),
  tryNormalizeDataLocale: () => null,
}))
vi.mock('../../src/main/services/lcu/process-auth-discovery.ts', () => ({
  discoverLcuAuthFromProcess: vi.fn(async () => [null, null]),
}))

const { isStatAnvilSlotText } = await import('../../src/main/image-analyzer.ts')

describe('stat anvil shard cards', () => {
  it('recognizes shard card titles seen in real OCR logs', () => {
    for (const text of [
      '物理防御碎片 属性铁砧',
      '勇猛碎片 属性铁砧',
      '魔法攻击碎片 属性铁',
      '攻击速度碎片',
      '屬性鐵砧',
      'Armor Shard Stat Anvil',
    ]) {
      expect(isStatAnvilSlotText(text)).toBe(true)
    }
  })

  it('does not reject real augment titles', () => {
    for (const text of ['已升级风暴激涌 伤害', '生机迸发 辅助', '属性！ 一般', '俯冲轰炸 友军 伤害', 'Sharpshooter', '']) {
      expect(isStatAnvilSlotText(text)).toBe(false)
    }
  })
})
