// 海克斯三卡浮窗「高亮最优卡」的计算方式，用户在主界面控制台选择，主进程持久化。
export type AugmentHighlightMode = 'pickRate' | 'winRate' | 'weighted'

export const AUGMENT_HIGHLIGHT_MODES: readonly AugmentHighlightMode[] = ['pickRate', 'winRate', 'weighted']
export const DEFAULT_AUGMENT_HIGHLIGHT_MODE: AugmentHighlightMode = 'winRate'
export const AUGMENT_HIGHLIGHT_MODE_STORE_KEY = 'augments.highlightMode'

export function isAugmentHighlightMode(value: unknown): value is AugmentHighlightMode {
  return typeof value === 'string' && (AUGMENT_HIGHLIGHT_MODES as readonly string[]).includes(value)
}

export function normalizeAugmentHighlightMode(value: unknown): AugmentHighlightMode {
  return isAugmentHighlightMode(value) ? value : DEFAULT_AUGMENT_HIGHLIGHT_MODE
}

function toFiniteNumber(value: unknown): number | null {
  if (value == null || value === '') {
    return null
  }

  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export type WeightedScoreInput = {
  winRate?: unknown
  win_rate?: unknown
  pickRate?: unknown
  pick_rate?: unknown
  playCount?: unknown
  num_games?: unknown
  games?: unknown
}

// 加权分 = 胜率 × 0.6 + 选取率 × 0.2 + min(场次 / 1000, 1) × 0.2；没有胜率时为 null。
export function getWeightedAugmentScore(record: WeightedScoreInput | null | undefined): number | null {
  const winRate = toFiniteNumber(record?.winRate ?? record?.win_rate)
  if (winRate == null) {
    return null
  }

  const pickRate = toFiniteNumber(record?.pickRate ?? record?.pick_rate) ?? 0
  const games = toFiniteNumber(record?.playCount ?? record?.num_games ?? record?.games) ?? 0
  return winRate * 0.6 + pickRate * 0.2 + Math.min(games / 1000, 1) * 0.2
}
