// tests/confidence.test.js — unit tests for scripts/confidence.js
// Uses Node.js built-in node:test and node:assert (zero external dependencies)

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  inputCountFactor,
  captureAgeFactor,
  driftHistoryFactor,
  confidenceLabel,
  computeConfidence
} from '../scripts/confidence.js'

// ─── inputCountFactor ───────────────────────────────────────────────────────

describe('inputCountFactor', () => {
  it('returns 0.1 for 0 inputs', () => {
    assert.equal(inputCountFactor(0), 0.1)
  })

  it('returns 0.1 for 1 input', () => {
    assert.equal(inputCountFactor(1), 0.1)
  })

  it('returns 0.4 for 2 inputs', () => {
    assert.equal(inputCountFactor(2), 0.4)
  })

  it('returns 0.4 for 3 inputs', () => {
    assert.equal(inputCountFactor(3), 0.4)
  })

  it('returns 0.7 for 4 inputs', () => {
    assert.equal(inputCountFactor(4), 0.7)
  })

  it('returns 0.7 for 6 inputs', () => {
    assert.equal(inputCountFactor(6), 0.7)
  })

  it('returns 1.0 for 7 inputs', () => {
    assert.equal(inputCountFactor(7), 1.0)
  })

  it('returns 1.0 for 100 inputs', () => {
    assert.equal(inputCountFactor(100), 1.0)
  })
})

// ─── captureAgeFactor ───────────────────────────────────────────────────────

describe('captureAgeFactor', () => {
  it('returns 0.5 for age < 1 day (too new, unproven)', () => {
    assert.equal(captureAgeFactor(0), 0.5)
    assert.equal(captureAgeFactor(0.5), 0.5)
  })

  it('returns 0.8 for age 1-7 days', () => {
    assert.equal(captureAgeFactor(1), 0.8)
    assert.equal(captureAgeFactor(3), 0.8)
    assert.equal(captureAgeFactor(7), 0.8)
  })

  it('returns 1.0 for age > 7 days (well established)', () => {
    assert.equal(captureAgeFactor(8), 1.0)
    assert.equal(captureAgeFactor(30), 1.0)
    assert.equal(captureAgeFactor(365), 1.0)
  })
})

// ─── driftHistoryFactor ─────────────────────────────────────────────────────

describe('driftHistoryFactor', () => {
  it('returns 1.0 when no drift/update history', () => {
    assert.equal(driftHistoryFactor(false), 1.0)
  })

  it('returns 0.6 when drift/update history exists', () => {
    assert.equal(driftHistoryFactor(true), 0.6)
  })
})

// ─── confidenceLabel ────────────────────────────────────────────────────────

describe('confidenceLabel', () => {
  it('returns HIGH for score >= 0.8', () => {
    assert.equal(confidenceLabel(0.8), 'HIGH')
    assert.equal(confidenceLabel(0.9), 'HIGH')
    assert.equal(confidenceLabel(1.0), 'HIGH')
  })

  it('returns MEDIUM for score 0.5 to 0.799', () => {
    assert.equal(confidenceLabel(0.5), 'MEDIUM')
    assert.equal(confidenceLabel(0.6), 'MEDIUM')
    assert.equal(confidenceLabel(0.79), 'MEDIUM')
  })

  it('returns LOW for score < 0.5', () => {
    assert.equal(confidenceLabel(0.49), 'LOW')
    assert.equal(confidenceLabel(0.0), 'LOW')
    assert.equal(confidenceLabel(0.1), 'LOW')
  })
})

// ─── computeConfidence ──────────────────────────────────────────────────────

describe('computeConfidence', () => {
  it('returns HIGH for many inputs, old capture, no drift', () => {
    const result = computeConfidence({ inputCount: 10, ageDays: 30, hasDriftOrUpdate: false })
    assert.equal(result.label, 'HIGH')
    assert.ok(result.score >= 0.8)
  })

  it('returns LOW for 1 input, brand new, with drift', () => {
    const result = computeConfidence({ inputCount: 1, ageDays: 0, hasDriftOrUpdate: true })
    assert.equal(result.label, 'LOW')
    assert.ok(result.score < 0.5)
  })

  it('returns MEDIUM for moderate inputs and age with no drift', () => {
    // 2-3 inputs: f1=0.4, age 3 days: f2=0.8, no drift: f3=1.0
    // score = 0.4*0.5 + 0.8*0.2 + 1.0*0.3 = 0.20 + 0.16 + 0.30 = 0.66 → MEDIUM
    const result = computeConfidence({ inputCount: 2, ageDays: 3, hasDriftOrUpdate: false })
    assert.equal(result.label, 'MEDIUM')
    assert.ok(result.score >= 0.5 && result.score < 0.8)
  })

  it('score degrades when drift is present', () => {
    const noDrift = computeConfidence({ inputCount: 7, ageDays: 30, hasDriftOrUpdate: false })
    const withDrift = computeConfidence({ inputCount: 7, ageDays: 30, hasDriftOrUpdate: true })
    assert.ok(withDrift.score < noDrift.score)
  })

  it('score improves with more inputs', () => {
    const fewInputs = computeConfidence({ inputCount: 1, ageDays: 10, hasDriftOrUpdate: false })
    const manyInputs = computeConfidence({ inputCount: 7, ageDays: 10, hasDriftOrUpdate: false })
    assert.ok(manyInputs.score > fewInputs.score)
  })

  it('score improves with age', () => {
    const newCapture = computeConfidence({ inputCount: 5, ageDays: 0, hasDriftOrUpdate: false })
    const oldCapture = computeConfidence({ inputCount: 5, ageDays: 30, hasDriftOrUpdate: false })
    assert.ok(oldCapture.score > newCapture.score)
  })

  it('returns factors object with inputCount, captureAge, driftHistory', () => {
    const result = computeConfidence({ inputCount: 5, ageDays: 5, hasDriftOrUpdate: true })
    assert.ok('inputCount' in result.factors)
    assert.ok('captureAge' in result.factors)
    assert.ok('driftHistory' in result.factors)
    assert.equal(result.factors.inputCount, 0.7)
    assert.equal(result.factors.captureAge, 0.8)
    assert.equal(result.factors.driftHistory, 0.6)
  })

  it('score is rounded to 3 decimal places', () => {
    const result = computeConfidence({ inputCount: 2, ageDays: 3, hasDriftOrUpdate: false })
    const decimals = (result.score.toString().split('.')[1] || '').length
    assert.ok(decimals <= 3, `score has ${decimals} decimal places, expected <= 3`)
  })

  it('edge case: 0 inputs with drift and new capture is LOW', () => {
    const result = computeConfidence({ inputCount: 0, ageDays: 0, hasDriftOrUpdate: true })
    assert.equal(result.label, 'LOW')
    // f1=0.1, f2=0.5, f3=0.6 → 0.1*0.5 + 0.5*0.2 + 0.6*0.3 = 0.05 + 0.10 + 0.18 = 0.33
    assert.ok(result.score < 0.5)
  })

  it('edge case: maximum confidence with all factors optimal', () => {
    const result = computeConfidence({ inputCount: 100, ageDays: 365, hasDriftOrUpdate: false })
    assert.equal(result.label, 'HIGH')
    // f1=1.0, f2=1.0, f3=1.0 → 1.0*0.5 + 1.0*0.2 + 1.0*0.3 = 1.0
    assert.equal(result.score, 1.0)
  })

  it('drift reduces confidence from HIGH to MEDIUM for borderline case', () => {
    // 4 inputs: f1=0.7, age 30d: f2=1.0, no drift: f3=1.0 → 0.7*0.5+1.0*0.2+1.0*0.3 = 0.85 → HIGH
    const noDrift = computeConfidence({ inputCount: 4, ageDays: 30, hasDriftOrUpdate: false })
    assert.equal(noDrift.label, 'HIGH')
    // With drift: f3=0.6 → 0.7*0.5+1.0*0.2+0.6*0.3 = 0.35+0.20+0.18 = 0.73 → MEDIUM
    const withDrift = computeConfidence({ inputCount: 4, ageDays: 30, hasDriftOrUpdate: true })
    assert.equal(withDrift.label, 'MEDIUM')
  })
})
