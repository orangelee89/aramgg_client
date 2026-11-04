import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ screen: { screenToDipRect: (_: unknown, rect: unknown) => rect } }))
vi.mock('../../src/main/modules/logger.ts', () => ({ default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }))
vi.mock('../../src/main/modules/app-store.ts', () => ({ default: { get: vi.fn(), set: vi.fn() } }))
vi.mock('../../src/main/modules/window-manager.ts', () => ({
  ensureBenchSwapStripWindow: vi.fn(),
  getBenchSwapStripWindow: vi.fn(() => null),
  hideBenchSwapStripWindow: vi.fn(),
  showBenchSwapStripWindow: vi.fn(),
}))

const { anchorFromBounds, computeStripBounds, parseAnchor, pickLeagueClientWindow, DEFAULT_BENCH_SWAP_STRIP_ANCHOR } =
  await import('../../src/main/modules/bench-swap-strip.ts')

const client = { x: 408, y: 75, width: 1600, height: 900 }
const size = { width: 600, height: 76 }

function nativeWindow(title: string, width = 1600, height = 900, minimized = false, appName = '') {
  return { title: () => title, appName: () => appName, x: () => 0, y: () => 0, width: () => width, height: () => height, isMinimized: () => minimized }
}

describe('bench swap strip placement', () => {
  it('centers the strip at the top of the client by default', () => {
    expect(computeStripBounds(client, DEFAULT_BENCH_SWAP_STRIP_ANCHOR, size)).toEqual({ x: 908, y: 75, width: 600, height: 76 })
  })

  it('round-trips a dragged position through the relative anchor', () => {
    const dragged = { x: 700, y: 300, width: 600, height: 76 }
    const anchor = anchorFromBounds(client, dragged)
    expect(computeStripBounds(client, anchor, size)).toEqual(dragged)
    // 客户端移动后保持相对位置
    expect(computeStripBounds({ ...client, x: 0, y: 0 }, anchor, size)).toEqual({ x: 292, y: 225, width: 600, height: 76 })
  })

  it('falls back to the default anchor for invalid stored values', () => {
    expect(parseAnchor(null)).toEqual(DEFAULT_BENCH_SWAP_STRIP_ANCHOR)
    expect(parseAnchor({ rx: 'x', ry: 0 })).toEqual(DEFAULT_BENCH_SWAP_STRIP_ANCHOR)
    expect(parseAnchor({ rx: 0.3, ry: 0.2 })).toEqual({ rx: 0.3, ry: 0.2 })
  })

  it('picks the League client window, not the game or minimized windows', () => {
    const game = nativeWindow('League of Legends (TM) Client')
    const minimized = nativeWindow('League of Legends', 1600, 900, true)
    const clientWindow = nativeWindow('League of Legends')
    expect(pickLeagueClientWindow([game, minimized, clientWindow], 'win32')).toBe(clientWindow)
    expect(pickLeagueClientWindow([game, minimized], 'win32')).toBeNull()
  })

  it('picks the 16:9 League client on macOS even without a readable title', () => {
    const game = nativeWindow('', 1920, 1080, false, 'League of Legends (TM) Client')
    const gameProcess = nativeWindow('', 1920, 1080, false, 'LeagueofLegends')
    const chat = nativeWindow('', 800, 900, false, 'League of Legends')
    const clientWindow = nativeWindow('', 1280, 720, false, 'LeagueClientUx')
    const other = nativeWindow('Safari', 1600, 900, false, 'Safari')
    expect(pickLeagueClientWindow([game, gameProcess, chat, other, clientWindow], 'darwin')).toBe(clientWindow)
    expect(pickLeagueClientWindow([game, other], 'darwin')).toBeNull()
  })
})
