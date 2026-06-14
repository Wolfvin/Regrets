// confidence.js — Confidence Score computation per cluster
//
// Computes a HIGH/MEDIUM/LOW label + raw 0.0-1.0 score from metadata
// that already exists in .regret files, manifest, and audit.log.
// Pure function — no file I/O, no side effects.
//
// Formula:
//   Factor 1 — Input count (from manifest inputs array):
//     1 input    -> 0.1
//     2-3 inputs -> 0.4
//     4-6 inputs -> 0.7
//     7+ inputs  -> 1.0
//
//   Factor 2 — Age of golden capture (from "captured:" in .regret metadata):
//     < 1 day    -> 0.5  (too new, unproven)
//     1-7 days   -> 0.8
//     > 7 days   -> 1.0
//
//   Factor 3 — Drift history (from audit.log — any reason containing "drift" or "update"):
//     Has been updated/drifted -> 0.6  (contract changed, less stable)
//     Never                     -> 1.0
//
//   Final score = F1 * 0.5 + F2 * 0.2 + F3 * 0.3
//   Label:
//     score >= 0.8  -> HIGH
//     score >= 0.5  -> MEDIUM
//     score < 0.5   -> LOW

import { existsSync, readFileSync } from 'fs'

/**
 * Compute the input-count factor (F1).
 * @param {number} inputCount - Number of inputs from manifest
 * @returns {number} Factor value 0.0-1.0
 */
export function inputCountFactor(inputCount) {
  if (inputCount <= 1) return 0.1
  if (inputCount <= 3) return 0.4
  if (inputCount <= 6) return 0.7
  return 1.0
}

/**
 * Compute the capture-age factor (F2).
 * @param {number} ageDays - Age in days since capture
 * @returns {number} Factor value 0.0-1.0
 */
export function captureAgeFactor(ageDays) {
  if (ageDays < 1) return 0.5
  if (ageDays <= 7) return 0.8
  return 1.0
}

/**
 * Compute the drift-history factor (F3).
 * @param {boolean} hasDriftOrUpdate - Whether cluster ever appeared in audit.log with drift/update
 * @returns {number} Factor value 0.0-1.0
 */
export function driftHistoryFactor(hasDriftOrUpdate) {
  return hasDriftOrUpdate ? 0.6 : 1.0
}

/**
 * Compute the confidence label from a raw score.
 * @param {number} score - Raw confidence score 0.0-1.0
 * @returns {'HIGH'|'MEDIUM'|'LOW'} Confidence label
 */
export function confidenceLabel(score) {
  if (score >= 0.8) return 'HIGH'
  if (score >= 0.5) return 'MEDIUM'
  return 'LOW'
}

/**
 * Compute full confidence for a cluster.
 * @param {object} opts
 * @param {number} opts.inputCount - Number of inputs from manifest
 * @param {number} opts.ageDays - Age of golden capture in days
 * @param {boolean} opts.hasDriftOrUpdate - Whether cluster has drift/update in audit.log
 * @returns {{ score: number, label: 'HIGH'|'MEDIUM'|'LOW', factors: { inputCount: number, captureAge: number, driftHistory: number } }}
 */
export function computeConfidence({ inputCount, ageDays, hasDriftOrUpdate }) {
  const f1 = inputCountFactor(inputCount)
  const f2 = captureAgeFactor(ageDays)
  const f3 = driftHistoryFactor(hasDriftOrUpdate)
  const score = f1 * 0.5 + f2 * 0.2 + f3 * 0.3
  return {
    score: Math.round(score * 1000) / 1000,  // 3 decimal places
    label: confidenceLabel(score),
    factors: { inputCount: f1, captureAge: f2, driftHistory: f3 }
  }
}

/**
 * Parse audit.log and return a map of cluster-id -> hasDriftOrUpdate.
 * An audit.log entry with type UPDATE or DRIFT marks the cluster as
 * having drift history.
 *
 * @param {string} auditLogPath - Path to regrets/audit.log
 * @returns {Object<string, boolean>} Map keyed by cluster ID, value is true if drift/update found
 */
export function parseAuditForDrift(auditLogPath) {
  const result = {}
  try {
    if (!existsSync(auditLogPath)) return result
    const content = readFileSync(auditLogPath, 'utf8').trim()
    if (!content) return result

    // audit.log format: blocks separated by blank lines
    // Header line: "2024-03-01T09:00:00Z  UPDATE  cluster-id"
    const blocks = content.split('\n\n').filter(Boolean)
    for (const block of blocks) {
      const lines = block.trim().split('\n')
      const header = lines[0]
      const parts = header.trim().split(/\s+/)
      if (parts.length < 3) continue
      const type = parts[1]  // UPDATE, DRIFT, etc.
      const id = parts[2]
      if (!id) continue

      const typeLower = type.toLowerCase()
      const isDriftOrUpdate = typeLower.includes('drift') || typeLower.includes('update')

      if (isDriftOrUpdate) {
        result[id] = true
      }
    }
  } catch {
    // audit.log doesn't exist or can't be read — no drift history
  }
  return result
}
