/**
 * dsh-eng-core — the shared runtime of the dsh engineering suite.
 *
 * This package is a library, not a Cordis plugin: it exports the mission store
 * (the durable contract between the gates), the deterministic command runner,
 * the git fingerprinter, file/JSONL helpers, the specification markdown
 * format, and the structured logger. It imports nothing from
 * `@deepseek-ai/*` at runtime, so every plugin that depends on it stays
 * loadable against any harness build with a compatible public API.
 *
 * @module dsh-eng-core
 */

export * from './types.js'
export * from './log.js'
export * from './paths.js'
export * from './digest.js'
export * from './io.js'
export * from './run.js'
export * from './git.js'
export * from './session.js'
export * from './approval.js'
export * from './impact.js'
export * from './markdown.js'
export * from './spec-edit.js'
export * from './mission.js'
export * from './project-config.js'
export * from './scan.js'
export * from './metrics.js'
