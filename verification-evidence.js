/**
 * Forge Verification Evidence Engine — v122.2.
 *
 * Structured, provenance-aware evidence. It distinguishes:
 *   - command observed vs requirement actually verified
 *   - passed check vs sufficient evidence
 *   - relevant vs unrelated evidence
 *   - current vs stale evidence
 *
 * Additive: it does not replace the existing verification ledger/governor.
 */
import crypto from 'node:crypto'

export const EVIDENCE_KINDS = Object.freeze({
  TEST: 'test', BUILD: 'build', SYNTAX: 'syntax', SECURITY: 'security',
  RUNTIME: 'runtime', INTEGRATION: 'integration', ARTIFACT: 'artifact', ACCEPTANCE: 'acceptance',
})

export const EVIDENCE_STATUS = Object.freeze({
  OBSERVED: 'OBSERVED', VERIFIED: 'VERIFIED', FAILED: 'FAILED', STALE: 'STALE', SKIPPED: 'SKIPPED', UNKNOWN: 'UNKNOWN',
})

const clean = (v, n = 500) => String(v ?? '').slice(0, n)
const norm = (v) => clean(v, 300).replace(/^\.\//, '').replace(/\\/g, '/')
const id = (prefix, input) => `${prefix}-${crypto.createHash('sha256').update(`${Date.now()}|${input}|${Math.random()}`).digest('hex').slice(0, 12)}`

function overlaps(a = [], b = []) {
  const A = a.map(norm), B = b.map(norm)
  if (!A.length || !B.length) return true
  return A.some(x => B.some(y => x === y || x.endsWith('/' + y) || y.endsWith('/' + x)))
}

export function evidenceConfidence(kind, { passed = false, exitCodeKnown = false, outputObserved = true, artifactObserved = false } = {}) {
  if (!passed || !exitCodeKnown || !outputObserved) return 0
  if (kind === EVIDENCE_KINDS.ARTIFACT && !artifactObserved) return 0
  if (kind === EVIDENCE_KINDS.ACCEPTANCE) return 0.9
  if (kind === EVIDENCE_KINDS.SECURITY) return 0.95
  return 0.85
}

export function createVerificationEvidence({ taskId = null, runId = null } = {}) {
  const requirements = new Map()
  const records = []
  let epoch = 0

  function bindRequirement({ requirementId, text, kind, affectedFiles = [], required = true } = {}) {
    if (!requirementId) return { ok: false, reason: 'requirementId required' }
    const rec = { requirementId: clean(requirementId, 80), text: clean(text, 400), kind: clean(kind || EVIDENCE_KINDS.ACCEPTANCE, 40), affectedFiles: affectedFiles.map(norm).slice(0, 50), required: required !== false }
    requirements.set(rec.requirementId, rec)
    return { ok: true, requirement: rec }
  }

  function record(input = {}) {
    epoch += 1
    const kind = clean(input.kind || EVIDENCE_KINDS.ACCEPTANCE, 40)
    const passed = input.passed === true
    const stale = input.stale === true
    const skipped = input.skipped === true
    const affectedFiles = Array.isArray(input.affectedFiles) ? input.affectedFiles.map(norm).slice(0, 50) : []
    const rec = {
      evidenceId: input.evidenceId || id('ev', JSON.stringify(input)),
      taskId: input.taskId ?? taskId,
      runId: input.runId ?? runId,
      epoch: input.epoch ?? epoch,
      requirementIds: Array.isArray(input.requirementIds) ? input.requirementIds.map(x => clean(x, 80)).slice(0, 30) : [],
      kind, status: skipped ? EVIDENCE_STATUS.SKIPPED : stale ? EVIDENCE_STATUS.STALE : passed ? EVIDENCE_STATUS.VERIFIED : (input.known === false ? EVIDENCE_STATUS.UNKNOWN : EVIDENCE_STATUS.FAILED),
      passed, skipped, stale, affectedFiles,
      command: clean(input.command, 300),
      exitCode: Number.isInteger(input.exitCode) ? input.exitCode : null,
      exitCodeKnown: input.exitCodeKnown === true,
      outputObserved: input.outputObserved !== false,
      artifactObserved: input.artifactObserved === true,
      output: clean(input.output, 2000),
      reason: clean(input.reason, 400),
      timestamp: input.timestamp ?? Date.now(),
    }
    rec.confidence = evidenceConfidence(kind, rec)
    records.push(rec)
    if (records.length > 256) records.splice(0, records.length - 256)
    return rec
  }

  function invalidate(files = [], reason = 'files changed after evidence') {
    let n = 0
    for (const r of records) {
      if (r.status !== EVIDENCE_STATUS.VERIFIED) continue
      if (overlaps(r.affectedFiles, files)) { r.status = EVIDENCE_STATUS.STALE; r.passed = false; r.stale = true; r.reason = clean(reason, 400); n++ }
    }
    epoch += 1
    return n
  }

  function coverage({ requirementIds = null, changedFiles = [] } = {}) {
    const wanted = requirementIds ? requirementIds.map(String) : [...requirements.keys()]
    return wanted.map(rid => {
      const req = requirements.get(rid)
      const relevant = records.filter(r => r.requirementIds.includes(rid) && overlaps(r.affectedFiles, req?.affectedFiles || changedFiles))
      const valid = relevant.filter(r => r.status === EVIDENCE_STATUS.VERIFIED && r.passed)
      const failed = relevant.filter(r => r.status === EVIDENCE_STATUS.FAILED)
      return { requirementId: rid, text: req?.text || null, kind: req?.kind || null, required: req?.required !== false, evidence: valid.slice(-4), failed: failed.slice(-4), covered: valid.length > 0, unrelated: relevant.length === 0 }
    })
  }

  function verdict({ changedFiles = [], requirementIds = null } = {}) {
    const rows = coverage({ changedFiles, requirementIds })
    const required = rows.filter(x => x.required)
    const missing = required.filter(x => !x.covered).map(x => x.requirementId)
    const failed = required.filter(x => x.failed.length).map(x => x.requirementId)
    const ok = missing.length === 0 && failed.length === 0
    return {
      ok,
      status: ok ? 'VERIFIED' : (failed.length ? 'FAILED' : 'INCOMPLETE'),
      coverage: rows,
      missing,
      failed,
      checked: required.length,
      covered: required.filter(x => x.covered).length,
      reason: ok ? 'all bound required criteria have current evidence' : failed.length ? `required evidence failed: ${failed.join(', ')}` : `missing evidence for: ${missing.join(', ')}`,
    }
  }

  function serialize() { return { v: '1.0.0', taskId, runId, epoch, requirements: [...requirements.values()], records: records.slice(-256) } }
  function restore(s) {
    if (!s || typeof s !== 'object') return false
    for (const r of Array.isArray(s.requirements) ? s.requirements : []) if (r?.requirementId) requirements.set(r.requirementId, r)
    records.push(...(Array.isArray(s.records) ? s.records.slice(-256) : []))
    epoch = Math.max(epoch, Number(s.epoch) || 0)
    return true
  }

  return { bindRequirement, record, invalidate, coverage, verdict, serialize, restore, get epoch() { return epoch }, records: () => records.slice(), requirements: () => [...requirements.values()] }
}
