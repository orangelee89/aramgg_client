/**
 * 原生屏幕抓帧（node-screenshots / xcap）。
 *
 * Electron 的 desktopCapturer 在 4K 屏上一张缩略图要 0.7～1.2 秒，且只能拿到缩小后的图；
 * 这里直接按显示器物理分辨率抓帧并返回 RGBA 原始像素，整帧只需几十毫秒，
 * 后续 OCR 直接从原始像素裁标题区域，不再经过 PNG 编解码。
 *
 * 原生模块加载失败时返回 null，调用方回退到 desktopCapturer。
 */

import { createRequire } from 'module'

export type RawFrame = {
    buffer: Buffer
    width: number
    height: number
    channels: 4
}

export type NativeCaptureResult = RawFrame & {
    monitorName: string
    scaleFactor: number
    captureMs: number
}

type NativeMonitor = {
    id(): number
    name(): string
    x(): number
    y(): number
    width(): number
    height(): number
    scaleFactor(): number
    isPrimary(): boolean
    captureImage(): Promise<NativeImage>
}

type NativeImage = {
    width: number
    height: number
    toRaw(copyOutputData?: boolean): Promise<Buffer>
    toPng(copyOutputData?: boolean): Promise<Buffer>
}

type NativeScreenshotsModule = {
    Monitor: {
        all(): NativeMonitor[]
        fromPoint(x: number, y: number): NativeMonitor | null
    }
}

const require = createRequire(import.meta.url)

let nativeModule: NativeScreenshotsModule | null | undefined
let loadError: string | null = null

function loadNativeModule(): NativeScreenshotsModule | null {
    if (nativeModule !== undefined) {
        return nativeModule
    }

    if (process.env.ARAMGG_DISABLE_NATIVE_CAPTURE === '1') {
        nativeModule = null
        loadError = 'disabled by ARAMGG_DISABLE_NATIVE_CAPTURE'
        return nativeModule
    }

    try {
        nativeModule = require('node-screenshots') as NativeScreenshotsModule
        loadError = null
    } catch (error) {
        nativeModule = null
        loadError = error instanceof Error ? error.message : String(error)
    }

    return nativeModule
}

export function isNativeCaptureAvailable(): boolean {
    return loadNativeModule() !== null
}

export function getNativeCaptureLoadError(): string | null {
    loadNativeModule()
    return loadError
}

function pickMonitor(module: NativeScreenshotsModule, point?: { x: number, y: number } | null): NativeMonitor | null {
    if (point) {
        const atPoint = module.Monitor.fromPoint(point.x, point.y)
        if (atPoint) {
            return atPoint
        }
    }

    const monitors = module.Monitor.all()
    return monitors.find(monitor => monitor.isPrimary()) || monitors[0] || null
}

/**
 * 抓取显示器整帧。默认主显示器；传入 point 时优先取包含该点的显示器。
 */
export async function captureNativeScreenFrame(
    options: { point?: { x: number, y: number } | null } = {}
): Promise<NativeCaptureResult | null> {
    const module = loadNativeModule()
    if (!module) {
        return null
    }

    const monitor = pickMonitor(module, options.point)
    if (!monitor) {
        throw new Error('no monitor available for native capture')
    }

    const startedAt = performance.now()
    const image = await monitor.captureImage()
    // Electron 主进程里必须拷贝输出数据，否则 napi 外部内存在 GC 时可能崩溃。
    const buffer = await image.toRaw(true)
    const expectedLength = image.width * image.height * 4
    if (buffer.length !== expectedLength) {
        throw new Error(`native capture returned ${buffer.length} bytes, expected ${expectedLength}`)
    }

    return {
        buffer,
        width: image.width,
        height: image.height,
        channels: 4,
        monitorName: monitor.name(),
        scaleFactor: monitor.scaleFactor(),
        captureMs: performance.now() - startedAt,
    }
}

export function isRawFrame(value: unknown): value is RawFrame {
    const frame = value as RawFrame | null
    return !!frame &&
        Buffer.isBuffer(frame.buffer) &&
        Number.isInteger(frame.width) &&
        Number.isInteger(frame.height) &&
        Number.isInteger(frame.channels)
}
