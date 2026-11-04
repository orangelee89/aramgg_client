/**
 * 大乱斗席位换人条：选人阶段在 LOL 客户端「可使用的英雄」那一排上方浮一条独立小窗，
 * 列出席位英雄，点头像即调用 bench swap（无 CD）。
 *
 * 只在 用户开启「大乱斗无CD换英雄」+ ChampSelect + 本局有席位（benchEnabled）+ 找到客户端窗口 时显示。
 * 位置按客户端窗口的相对比例保存，客户端移动/缩放时跟随；用户拖动后记住新位置。
 */
import { createRequire } from 'module'
import { screen, type BrowserWindow, type Rectangle } from 'electron'
import logger from './logger.ts'
import store from './app-store.ts'
import {
    ensureBenchSwapStripWindow,
    getBenchSwapStripWindow,
    hideBenchSwapStripWindow,
    showBenchSwapStripWindow,
} from './window-manager.ts'

const require = createRequire(import.meta.url)

export const BENCH_SWAP_STRIP_SIZE = { width: 600, height: 76 }
export const BENCH_SWAP_STRIP_ANCHOR_KEY = 'windows.benchSwapStripAnchor'
/** 默认：水平居中，顶边贴着客户端顶部那一排席位。 */
export const DEFAULT_BENCH_SWAP_STRIP_ANCHOR = { rx: 0.5, ry: 0.0 }
const TICK_MS = 800

export interface StripAnchor { rx: number; ry: number }

type NativeWindow = {
    title(): string
    appName?(): string
    x(): number
    y(): number
    width(): number
    height(): number
    isMinimized(): boolean
}

let phase: string | null = null
let timer: NodeJS.Timeout | null = null
let tickInFlight = false
let lastClientRect: Rectangle | null = null
let lastAppliedBounds: Rectangle | null = null
let userDragging = false
let listenersAttached: BrowserWindow | null = null
let hasBenchProvider: () => Promise<boolean> = async () => false
let nativeLoadFailed = false
// 用户点了关闭：本次选人不再弹出，换阶段后恢复。
let dismissed = false

export function configureBenchSwapStrip(options: { hasBench: () => Promise<boolean> }): void {
    hasBenchProvider = options.hasBench
}

export function setBenchSwapStripPhase(nextPhase: string | null): void {
    if (nextPhase !== phase) dismissed = false
    phase = nextPhase
    refreshBenchSwapStrip()
}

/** 阶段或开关变化时调用：需要显示就启动跟随定时器，否则隐藏并停表。 */
export function refreshBenchSwapStrip(): void {
    if (shouldRun()) {
        if (!timer) {
            timer = setInterval(() => { void tick() }, TICK_MS)
        }
        void tick()
    } else {
        stop()
    }
}

function shouldRun(): boolean {
    return (process.platform === 'win32' || process.platform === 'darwin') && phase === 'ChampSelect' && !dismissed && store.get('aram.benchNoCooldown') === true
}

function stop(): void {
    if (timer) {
        clearInterval(timer)
        timer = null
    }
    lastClientRect = null
    lastAppliedBounds = null
    hideBenchSwapStripWindow()
}

async function tick(): Promise<void> {
    if (tickInFlight) return
    tickInFlight = true
    try {
        if (!shouldRun()) {
            stop()
            return
        }
        const clientRect = findLeagueClientRect()
        const hasBench = clientRect ? await hasBenchProvider().catch(() => false) : false
        if (!shouldRun()) return
        if (!clientRect || !hasBench) {
            lastClientRect = null
            hideBenchSwapStripWindow()
            return
        }

        const window = await ensureBenchSwapStripWindow()
        if (!shouldRun() || window.isDestroyed()) return
        attachMoveListeners(window)
        lastClientRect = clientRect
        if (!userDragging) {
            const bounds = computeStripBounds(clientRect, readAnchor(), BENCH_SWAP_STRIP_SIZE)
            if (!sameBounds(bounds, lastAppliedBounds) || !window.isVisible()) {
                lastAppliedBounds = bounds
                window.setBounds(bounds)
            }
        }
        showBenchSwapStripWindow()
    } catch (error) {
        logger.debug('[bench-swap-strip] tick failed', error instanceof Error ? error.message : String(error))
    } finally {
        tickInFlight = false
    }
}

function attachMoveListeners(window: BrowserWindow): void {
    if (listenersAttached === window) return
    listenersAttached = window
    window.on('close', () => {
        dismissed = true
        stop()
    })
    window.on('will-move', () => { userDragging = true })
    window.on('moved', () => {
        userDragging = false
        const bounds = window.getBounds()
        if (!lastClientRect || sameBounds(bounds, lastAppliedBounds)) return
        const anchor = anchorFromBounds(lastClientRect, bounds)
        store.set(BENCH_SWAP_STRIP_ANCHOR_KEY, anchor)
        lastAppliedBounds = bounds
        logger.info('[bench-swap-strip] position saved', anchor)
    })
}

function readAnchor(): StripAnchor {
    return parseAnchor(store.get(BENCH_SWAP_STRIP_ANCHOR_KEY))
}

export function parseAnchor(value: unknown): StripAnchor {
    const raw = value as Partial<StripAnchor> | null
    const rx = Number(raw?.rx)
    const ry = Number(raw?.ry)
    if (Number.isFinite(rx) && Number.isFinite(ry) && rx >= -0.5 && rx <= 1.5 && ry >= -0.5 && ry <= 1.5) {
        return { rx, ry }
    }
    return { ...DEFAULT_BENCH_SWAP_STRIP_ANCHOR }
}

/** rx 是条中心相对客户端宽度的比例，ry 是条顶边相对客户端高度的比例。 */
export function computeStripBounds(
    client: Rectangle,
    anchor: StripAnchor,
    size: { width: number; height: number },
): Rectangle {
    return {
        x: Math.round(client.x + client.width * anchor.rx - size.width / 2),
        y: Math.round(client.y + client.height * anchor.ry),
        width: size.width,
        height: size.height,
    }
}

export function anchorFromBounds(client: Rectangle, bounds: Rectangle): StripAnchor {
    const round = (value: number) => Math.round(value * 10000) / 10000
    return {
        rx: round((bounds.x + bounds.width / 2 - client.x) / Math.max(client.width, 1)),
        ry: round((bounds.y - client.y) / Math.max(client.height, 1)),
    }
}

function sameBounds(a: Rectangle | null, b: Rectangle | null): boolean {
    return !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/**
 * 选人界面所在的客户端窗口。
 * Windows：LeagueClientUx 窗口标题固定为 "League of Legends"（游戏本体是 "... (TM) Client"）。
 * macOS：窗口标题需要录屏权限才能读到，且客户端进程名不固定，所以按「名字像 LOL 客户端 + 16:9 + 不是游戏本体」挑最大的那个。
 */
export function pickLeagueClientWindow<T extends NativeWindow>(
    windows: T[],
    platform: NodeJS.Platform = process.platform,
): T | null {
    const usable = windows.filter((window) => {
        try {
            return !window.isMinimized() && window.width() >= 640 && window.height() >= 360
        } catch {
            return false
        }
    })
    if (platform !== 'darwin') {
        return usable.find((window) => window.title() === 'League of Legends') || null
    }

    const candidates = usable.filter((window) => {
        const title = safeText(() => window.title())
        const appName = safeText(() => window.appName?.() || '')
        const text = `${title} ${appName}`
        if (/\(TM\)\s*Client/i.test(text) || /^LeagueofLegends$/i.test(appName)) return false
        if (!/league\s*of\s*legends|leagueclient|英雄联盟|英雄聯盟/i.test(text)) return false
        return Math.abs(window.width() / window.height() - 16 / 9) < 0.06
    })
    return candidates.sort((a, b) => b.width() * b.height() - a.width() * a.height())[0] || null
}

function safeText(read: () => string): string {
    try {
        return String(read() || '')
    } catch {
        return ''
    }
}

function findLeagueClientRect(): Rectangle | null {
    if (nativeLoadFailed) return null
    let windows: NativeWindow[]
    try {
        windows = (require('node-screenshots') as { Window: { all(): NativeWindow[] } }).Window.all()
    } catch (error) {
        nativeLoadFailed = true
        logger.warn('[bench-swap-strip] node-screenshots unavailable', error instanceof Error ? error.message : String(error))
        return null
    }
    const client = pickLeagueClientWindow(windows)
    if (!client) return null
    const rect = { x: client.x(), y: client.y(), width: client.width(), height: client.height() }
    // Windows：node-screenshots 在 Electron（Per-Monitor DPI aware）里返回物理像素，需要换算成 DIP。
    // macOS：返回的已经是点坐标（和 Electron 一致），screenToDipRect 在 macOS 上也不可用。
    return process.platform === 'win32' ? screen.screenToDipRect(null, rect) : rect
}

/** 测试用。 */
export function getBenchSwapStripStateForTest() {
    return { phase, running: !!timer, window: getBenchSwapStripWindow() }
}
