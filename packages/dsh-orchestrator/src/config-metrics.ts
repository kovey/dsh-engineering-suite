/**
 * The `metrics` configuration section (交付度量的默认参数).
 *
 * Moved out of `config.ts` for the structural ratchet (that file must not grow
 * past its accepted length) and because the parsing rules here are one
 * self-contained policy: two integer knobs, host-level only, with unusable
 * values reported instead of silently applied.
 *
 * Keys are **host-level**: `docs/ARCHITECTURE.md` states the orchestrator has no
 * project-level configuration (the pipeline itself is a host policy), so adding
 * a project override here would be a new policy rather than a local refinement.
 * A repository that wants a different window passes `windowDays` to the action.
 *
 * @module dsh-orchestrator/config-metrics
 */

import { DEFAULT_MAX_IN_FLIGHT, DEFAULT_METRICS_WINDOW_DAYS, MAX_MAX_IN_FLIGHT, MAX_METRICS_WINDOW_DAYS } from './metrics.js'

/**
 * The `metrics` keys this package understands. Anything else is reported, never
 * silently ignored: `windowDay` (a typo) would otherwise leave a host believing
 * it had changed the window.
 */
const METRICS_KEYS: readonly string[] = ['windowDays', 'maxInFlight']

/** The resolved section (structurally `OrchestratorConfig['metrics']`). */
export interface MetricsConfig {
    /** 窗口天数（默认 90）：mission 创建时间 ≥ now - windowDays·86400s。 */
    windowDays: number
    /** 在飞列表最多显示多少条（默认 20，最老的在前）。 */
    maxInFlight: number
    /** 被拒绝的覆盖及其原因（GAP-10：不可用的配置必须被报告）。 */
    issues: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * One integer key with a host default, validated against a range.
 *
 * 不可用的值（非数字、非整数、越界）**保留宿主值并报告**：一个"看起来生效了"的
 * 配置比一个报错的配置危险得多（GAP-10 的同一条规则）。
 */
function intInRange(value: unknown, fallback: number, range: { min: number; max: number }, key: string, issues: string[]): number {
    if (value === undefined) return fallback
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < range.min || value > range.max) {
        issues.push(`${key} 必须是 ${range.min}–${range.max} 的整数（收到 ${JSON.stringify(value) ?? String(value)}）：已保留宿主值 ${fallback}`)
        return fallback
    }
    return value
}

/**
 * Parse the `metrics` section (交付度量的默认参数).
 * @param value - the raw `metrics` config value.
 * @returns the resolved section plus the rejected overrides.
 */
export function resolveMetrics(value: unknown): MetricsConfig {
    const raw = isRecord(value) ? value : {}
    const issues: string[] = []
    if (value !== undefined && !isRecord(value)) {
        issues.push('metrics 必须是对象（收到非对象）：已整体忽略，使用宿主默认值')
    } else if (isRecord(value)) {
        const unknown = Object.keys(raw).filter((key) => !METRICS_KEYS.includes(key))
        if (unknown.length > 0) issues.push(`metrics 里有未知键：${unknown.join('、')}（可用：${METRICS_KEYS.join('、')}）——未知键被忽略`)
    }
    return {
        windowDays: intInRange(raw['windowDays'], DEFAULT_METRICS_WINDOW_DAYS, { min: 1, max: MAX_METRICS_WINDOW_DAYS }, 'metrics.windowDays', issues),
        maxInFlight: intInRange(raw['maxInFlight'], DEFAULT_MAX_IN_FLIGHT, { min: 1, max: MAX_MAX_IN_FLIGHT }, 'metrics.maxInFlight', issues),
        issues,
    }
}
