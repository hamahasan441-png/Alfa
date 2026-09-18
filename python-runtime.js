/**
 * Forge V4 Phase 2 — isolated Python runtime for skill scripts.
 *
 * Responsibilities:
 *   - detect Python-backed skills from their script/manifest files
 *   - keep each skill's environment under <project>/.forge/venvs/<skill>
 *   - create the venv lazily and install a requirements.txt when present
 *   - resolve the interpreter without rewriting unrelated commands
 *
 * This module is deliberately dependency-free and uses execFileSync only for
 * bounded interpreter/bootstrap commands. It never builds a shell command.
 */
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"

const PYTHON_CANDIDATES = process.platform === "win32"
  ? ["python", "py"]
  : ["python3", "python"]

function exists(p) { try { return fs.existsSync(p) } catch { return false } }
function file(p) { try { return exists(p) && fs.statSync(p).isFile() } catch { return false } }
function dir(p) { try { return exists(p) && fs.statSync(p).isDirectory() } catch { return false } }

export function safeSkillName(name) {
  const n = String(name ?? "").trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  return n.slice(0, 80) || "skill"
}

export function findPython(python = null) {
  const candidates = python ? [python] : PYTHON_CANDIDATES
  for (const candidate of candidates) {
    try {
      const out = execFileSync(candidate, ["--version"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] }).trim()
      if (/python\s+3\./i.test(out)) return { command: candidate, version: out }
    } catch {}
  }
  return null
}

function skillRootFromScript(scriptPath, skillsDir) {
  const script = path.resolve(scriptPath)
  const base = skillsDir ? path.resolve(skillsDir) : null
  if (!base) return null
  const rel = path.relative(base, script)
  if (!rel || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return null
  const skill = rel.split(path.sep)[0]
  if (!skill || skill.startsWith(".")) return null
  const root = path.join(base, skill)
  return dir(root) ? { name: skill, root } : null
}

export function detectPythonSkill({ scriptPath, skillsDir, skillRoot = null } = {}) {
  const rootInfo = skillRoot
    ? { name: path.basename(path.resolve(skillRoot)), root: path.resolve(skillRoot) }
    : skillRootFromScript(scriptPath, skillsDir)
  if (!rootInfo) return { python: false, reason: "script is outside configured skills directory" }
  const root = rootInfo.root
  const req = file(path.join(root, "requirements.txt")) ? path.join(root, "requirements.txt") : null
  const pyproject = file(path.join(root, "pyproject.toml")) ? path.join(root, "pyproject.toml") : null
  const setup = file(path.join(root, "setup.py")) ? path.join(root, "setup.py") : null
  const pythonFiles = scriptPath && /\.(py|pyw)$/i.test(String(scriptPath))
  const detected = !!(pythonFiles || req || pyproject || setup)
  return {
    python: detected,
    name: rootInfo.name,
    root,
    script: scriptPath ? path.resolve(scriptPath) : null,
    requirements: req,
    pyproject,
    setup,
    reason: detected ? "python skill" : "no python runtime marker",
  }
}

export function venvDir({ root, skillName }) {
  return path.join(path.resolve(root), ".forge", "venvs", safeSkillName(skillName))
}

export function venvPython(dirPath) {
  return process.platform === "win32"
    ? path.join(dirPath, "Scripts", "python.exe")
    : path.join(dirPath, "bin", "python")
}

function run(fileName, args, opts = {}) {
  return execFileSync(fileName, args, {
    cwd: opts.cwd,
    env: opts.env,
    encoding: "utf8",
    timeout: opts.timeout ?? 120000,
    stdio: ["ignore", "pipe", "pipe"],
  })
}

/**
 * Ensure the isolated venv exists. By default requirements are installed when
 * a requirements.txt exists. Tests/diagnostics can pass install:false.
 */
export function ensureSkillVenv({ root, skillName, requirements = null, python = null, install = true, timeout = 120000 } = {}) {
  if (!root) throw new Error("python venv root is required")
  const name = safeSkillName(skillName)
  const dirPath = venvDir({ root, skillName: name })
  const interpreter = findPython(python)
  if (!interpreter) throw new Error("Python 3 is not available")
  const py = venvPython(dirPath)
  if (!file(py)) {
    fs.mkdirSync(path.dirname(dirPath), { recursive: true })
    run(interpreter.command, ["-m", "venv", dirPath], { cwd: root, timeout })
  }
  if (!file(py)) throw new Error(`Python venv was not created: ${py}`)
  const req = requirements && file(requirements) ? path.resolve(requirements) : null
  let installed = false
  if (install && req) {
    run(py, ["-m", "pip", "install", "-r", req], { cwd: path.dirname(req), timeout })
    installed = true
  }
  return { ok: true, skillName: name, dir: dirPath, python: py, requirements: req, installed }
}

/** Resolve a skill Python interpreter, creating/provisioning its venv. */
export function prepareSkillPython({ scriptPath, skillsDir, projectRoot, install = true, python = null } = {}) {
  const detected = detectPythonSkill({ scriptPath, skillsDir })
  if (!detected.python) return { ok: false, detected, reason: detected.reason }
  const env = ensureSkillVenv({
    root: projectRoot,
    skillName: detected.name,
    requirements: detected.requirements,
    python,
    install,
  })
  return { ok: true, detected, env }
}

/**
 * Only rewrite a simple direct Python script invocation. Compound shell
 * commands remain untouched so existing shell semantics are preserved.
 */
export function parseDirectPythonCommand(command) {
  const s = String(command ?? "").trim()
  const m = /^(?:python3(?:\.\d+)?|python)\s+((?:"[^"]+")|(?:'[^']+')|\S+)(.*)$/i.exec(s)
  if (!m) return null
  const script = m[1].replace(/^['"]|['"]$/g, "")
  if (!/\.pyw?$/i.test(script)) return null
  return { script, suffix: m[2] || "" }
}

export function rewritePythonSkillCommand(command, { cwd, skillsDir, projectRoot, install = true, python = null } = {}) {
  const parsed = parseDirectPythonCommand(command)
  if (!parsed) return { changed: false, command: String(command ?? "") }
  const scriptPath = path.resolve(cwd || process.cwd(), parsed.script)
  const prepared = prepareSkillPython({ scriptPath, skillsDir, projectRoot: projectRoot || cwd || process.cwd(), install, python })
  if (!prepared.ok) return { changed: false, command: String(command ?? ""), prepared }
  const quoted = JSON.stringify(prepared.env.python)
  const scriptArg = JSON.stringify(parsed.script)
  return {
    changed: true,
    command: `${quoted} ${scriptArg}${parsed.suffix}`,
    prepared,
  }
}

export function pythonEnvironment({ venv }) {
  const root = path.resolve(venv)
  return {
    VIRTUAL_ENV: root,
    PATH: `${path.dirname(venvPython(root))}${path.delimiter}${process.env.PATH || ""}`,
    PYTHONNOUSERSITE: "1",
  }
}
