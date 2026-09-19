/**
 * forge — language intelligence (v32, zero dependencies)
 *
 * UNIFIED §32: grow language coverage without rewriting the core and without
 * Tree-sitter as a runtime dep. Adapters are data + regex. Unknown language
 * is discovered (ext / shebang / basename), not refused.
 *
 * JS / Python / Go / Rust extractors are the v23 regexes moved here so the
 * repo-map contract stays byte-stable. Extra adapters (Java, Kotlin, Ruby,
 * PHP, C/C++, C#, Swift, Dart, Zig, Elixir, Shell, SQL, Terraform, …) add
 * symbols the map previously skipped.
 */
import fs from "node:fs"
import path from "node:path"

const JS_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"])
const PY_EXT = new Set([".py", ".pyw"])
const GO_EXT = new Set([".go"])
const RS_EXT = new Set([".rs"])

/**
 * v126 — how many imports one file may contribute to the graph.
 *
 * Every import extractor passed a literal 20. Measured on forge: agent.js has
 * 48 static imports, so 28 of its edges were dropped — among them
 * `./completion.js`, which is why `consumersOf("completion.js")` listed
 * bench/evolve/meta and not the one module that most depends on it. A cap
 * that silently truncates a real module's edges makes the importer graph
 * wrong, not smaller, and every blast radius computed from it under-reports.
 * 200 is still a bound (a generated file cannot flood the index) and is far
 * above any hand-written module.
 */
export const MAX_IMPORTS_PER_FILE = 200

/**
 * The same bound for the other per-file lists (exports, calls, types). Kept a
 * separate name because they answer a different question, and kept at the old
 * 20 for `calls` only — jsCalls already stops at 30 matches of its own.
 */
export const MAX_SYMBOLS_PER_FILE = 200

function uniq(arr, cap = 40) {
  return [...new Set((arr || []).filter(Boolean))].slice(0, cap)
}

function matchAll(src, re, pick = 1) {
  const out = []
  const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")
  let m
  while ((m = r.exec(src))) out.push(m[pick] || m[1] || m[2] || m[0])
  return out
}

// ---------------------------------------------------------------------------
// v23 extractors (frozen for JS/PY/GO/RS — test-repomap pins them)
// ---------------------------------------------------------------------------

export function jsSymbols(src) {
  const out = []
  const re = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm
  let m
  while ((m = re.exec(src))) out.push(m[1])
  const reNamed = /^\s*export\s*\{([^}]+)\}/gm
  while ((m = reNamed.exec(src))) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/i).pop().trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.push(name)
    }
  }
  return out
}
export function pySymbols(src) {
  const out = []
  const re = /^(?:def|class)\s+([A-Za-z_]\w*)/gm
  let m
  while ((m = re.exec(src))) out.push(m[1])
  return out
}
export function goSymbols(src) {
  const out = []
  const re = /^\s*func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)|^\s*type\s+([A-Z]\w*)/gm
  let m
  while ((m = re.exec(src))) out.push(m[1] || m[2])
  return out
}
export function rsSymbols(src) {
  const out = []
  const re = /^\s*pub\s+(?:async\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z_]\w*)/gm
  let m
  while ((m = re.exec(src))) out.push(m[1])
  return out
}

function jsImports(src) {
  const out = []
  const re = /^\s*import\s+(?:.*?\s+from\s+)?["']([^"']+)["']|require\(["']([^"']+)["']\)/gm
  let m
  while ((m = re.exec(src))) out.push(m[1] || m[2])
  return uniq(out, MAX_IMPORTS_PER_FILE)
}
function pyImports(src) {
  const out = []
  const re = /^\s*(?:from\s+([A-Za-z0-9_.]+)\s+import|import\s+([A-Za-z0-9_.]+))/gm
  let m
  while ((m = re.exec(src))) out.push(m[1] || m[2])
  return uniq(out, MAX_IMPORTS_PER_FILE)
}
function goImports(src) {
  const out = []
  const re = /^\s*import\s+(?:\(\s*)?["']([^"']+)["']/gm
  let m
  while ((m = re.exec(src))) out.push(m[1])
  return uniq(out, MAX_IMPORTS_PER_FILE)
}

function jsExports(src) {
  const out = []
  const re = /export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g
  let m
  while ((m = re.exec(src))) out.push(m[1])
  return uniq(out, MAX_SYMBOLS_PER_FILE)
}
function jsCalls(src) {
  const out = []
  const re = /\b([A-Za-z_$][\w$]*)\s*\(/g
  let m
  let count = 0
  while ((m = re.exec(src)) && count < 30) {
    const name = m[1]
    if (!["if", "for", "while", "switch", "catch", "function", "return", "import", "export"].includes(name)) {
      out.push(name)
      count++
    }
  }
  return uniq(out, MAX_SYMBOLS_PER_FILE)
}
function jsTypes(src, file) {
  if (!file.endsWith(".ts") && !file.endsWith(".tsx")) return []
  const out = []
  const re = /\b(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g
  let m
  while ((m = re.exec(src))) out.push(m[1])
  return uniq(out, MAX_SYMBOLS_PER_FILE)
}

// ---------------------------------------------------------------------------
// adapters
// ---------------------------------------------------------------------------

export const ADAPTERS = Object.freeze([
  { id: "javascript", name: "JavaScript", ext: [".js", ".mjs", ".cjs", ".jsx"], shebang: /\b(node|nodejs)\b/i, family: "js" },
  { id: "typescript", name: "TypeScript", ext: [".ts", ".tsx", ".mts", ".cts"], family: "js" },
  { id: "python", name: "Python", ext: [".py", ".pyw"], shebang: /\bpython[0-9.]*\b/i, files: ["Pipfile"] },
  { id: "go", name: "Go", ext: [".go"], files: ["go.mod"] },
  { id: "rust", name: "Rust", ext: [".rs"], files: ["Cargo.toml"] },
  { id: "java", name: "Java", ext: [".java"], files: ["pom.xml"] },
  { id: "kotlin", name: "Kotlin", ext: [".kt", ".kts"] },
  { id: "ruby", name: "Ruby", ext: [".rb"], shebang: /\bruby\b/i, files: ["Gemfile"] },
  { id: "php", name: "PHP", ext: [".php"], shebang: /\bphp\b/i, files: ["composer.json"] },
  { id: "c", name: "C", ext: [".c", ".h"] },
  { id: "cpp", name: "C++", ext: [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"] },
  { id: "csharp", name: "C#", ext: [".cs"] },
  { id: "swift", name: "Swift", ext: [".swift"] },
  { id: "dart", name: "Dart", ext: [".dart"] },
  { id: "zig", name: "Zig", ext: [".zig"] },
  { id: "elixir", name: "Elixir", ext: [".ex", ".exs"] },
  { id: "shell", name: "Shell", ext: [".sh", ".bash", ".zsh"], shebang: /\b(bash|sh|zsh|dash)\b/i },
  { id: "sql", name: "SQL", ext: [".sql"] },
  { id: "terraform", name: "Terraform", ext: [".tf", ".tfvars"] },
  { id: "docker", name: "Docker", files: ["Dockerfile", "Dockerfile.dev"] },
  { id: "make", name: "Make", files: ["Makefile", "makefile", "GNUmakefile"] },
  { id: "protobuf", name: "Protocol Buffers", ext: [".proto"] },
  { id: "graphql", name: "GraphQL", ext: [".graphql", ".gql"] },
])

export const UNKNOWN = Object.freeze({ id: "unknown", name: "Unknown", ext: [] })

const EXT_TO = new Map()
const FILE_TO = new Map()
for (const a of ADAPTERS) {
  for (const e of a.ext || []) EXT_TO.set(e, a)
  for (const f of a.files || []) FILE_TO.set(f, a)
}

export function detectLanguage(file, src = "") {
  const base = path.basename(String(file || ""))
  if (FILE_TO.has(base)) return FILE_TO.get(base)
  const ext = path.extname(base).toLowerCase()
  if (EXT_TO.has(ext)) return EXT_TO.get(ext)
  const head = String(src || "").slice(0, 160)
  const bang = head.match(/^#!\s*(\S+[^\n]*)/m)
  if (bang) {
    const line = bang[0]
    for (const a of ADAPTERS) {
      if (a.shebang && a.shebang.test(line)) return a
    }
  }
  return UNKNOWN
}

export function isSourceFile(file, src = "") {
  const lang = detectLanguage(file, src)
  return lang.id !== "unknown" && lang.id !== "docker" && lang.id !== "make"
}

export function isConfigFile(file) {
  const base = path.basename(String(file || "")).toLowerCase()
  if (["package.json", "tsconfig.json", "cargo.toml", "go.mod", "pyproject.toml", "makefile", ".gitignore",
    "gemfile", "composer.json", "pom.xml", "build.gradle", "build.gradle.kts", "dockerfile",
    "requirements.txt", "pipfile", "go.sum"].includes(base)) return true
  const ext = path.extname(base).toLowerCase()
  return [".toml", ".yaml", ".yml", ".ini", ".cfg", ".json", ".tf", ".tfvars"].includes(ext)
}

/**
 * v126 — the canonical "is this a test file?" for the whole product.
 *
 * The old matcher was a list of literal fragments:
 *
 *   /\.test\.|\.spec\.|__tests__|test_|_test\.go|_test\.py|\.test\.ts|
 *    \.test\.js|_spec\.rb|Tests\.java/i
 *
 * It recognised `foo.test.js` and `test_foo.py` and missed almost everything
 * else, including THIS repository's entire suite. Measured on forge itself:
 * 267 files under `tests/`, every one named `test-<name>.mjs`, and
 * `isTestFile` answered false for all 267. The cross-graph therefore carried
 * **0 TEST edges**, and `testsForFiles()` — the function that tells the agent
 * which tests cover the files it just changed — returned `[]` for every input
 * it was ever asked about. v125 built the verification hint on top of that
 * empty list.
 *
 * Also missed: `_test.js`/`_test.ts` (only `.go` and `.py` were listed),
 * `MyTest.java` (only the plural `Tests.java`), `conftest.py`, and any file
 * sitting in a `tests/`, `test/`, `spec/` or `testing/` directory.
 *
 * The rule now has two halves, and both are conservative about false
 * positives — a source file wrongly called a test is invisible to the
 * importer graph, which is the more damaging direction:
 *
 *   1. a directory whose whole job is holding tests, matched as a full path
 *      component (so `src/latest/` and `protest/` do not qualify)
 *   2. a conventional stem, where `test`/`spec` is a separate word — bounded
 *      by a separator or the name's edge (so `latest.js` and `contest.js` do
 *      not qualify), plus the PascalCase Java/C# suffix, which is case
 *      sensitive on purpose for the same reason.
 */
const TEST_DIR_RE = /(^|\/)(tests?|specs?|__tests__|testing)\//i
const TEST_STEM_RE = /(^|[.\-_])(tests?|specs?)([.\-_]|$)/i
const TEST_SUFFIX_RE = /(Test|Tests|Spec|Specs)$/

export function isTestFile(file) {
  const p = String(file ?? "").replace(/\\/g, "/")
  if (!p) return false
  if (TEST_DIR_RE.test(p)) return true
  const base = p.slice(p.lastIndexOf("/") + 1)
  const stem = base.replace(/\.[^.]+$/, "")
  if (!stem) return false
  if (TEST_STEM_RE.test(stem)) return true
  if (TEST_SUFFIX_RE.test(stem)) return true
  if (/^conftest$/i.test(stem)) return true
  return false
}

export function extractSymbols(file, src) {
  const lang = detectLanguage(file, src)
  if (lang.family === "js") return jsSymbols(src)
  if (lang.id === "python") return pySymbols(src)
  if (lang.id === "go") return goSymbols(src)
  if (lang.id === "rust") return rsSymbols(src)
  switch (lang.id) {
    case "java":
    case "kotlin":
      return uniq([
        ...matchAll(src, /^\s*(?:public\s+|protected\s+|private\s+)?(?:static\s+)?(?:final\s+)?(?:class|interface|enum|record|object|fun)\s+(\w+)/gm),
      ])
    case "ruby":
      return uniq(matchAll(src, /^(?:def|class|module)\s+(\w+)/gm))
    case "php":
      return uniq(matchAll(src, /^\s*(?:class|function|interface|trait)\s+(\w+)/gm))
    case "c":
    case "cpp":
      return uniq(matchAll(src, /^(?:[A-Za-z_][\w\s\*]*)\b([A-Za-z_]\w+)\s*\([^;]*\)\s*\{/gm))
    case "csharp":
      return uniq(matchAll(src, /^\s*(?:public|internal|protected|private)?\s*(?:static\s+)?(?:class|interface|struct|enum|record)\s+(\w+)/gm))
    case "swift":
      return uniq(matchAll(src, /^\s*(?:public\s+|private\s+|internal\s+)?(?:func|class|struct|enum|protocol)\s+(\w+)/gm))
    case "dart":
      return uniq(matchAll(src, /^(?:class|mixin|enum|void|Future)\s+(\w+)/gm))
    case "zig":
      return uniq(matchAll(src, /^\s*pub\s+(?:fn|const|var)\s+(\w+)/gm))
    case "elixir":
      return uniq(matchAll(src, /^\s*(?:def|defp|defmodule)\s+(\w+)/gm))
    case "sql":
      return uniq(matchAll(src, /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|FUNCTION|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_]\w*)/gim))
    case "terraform":
      return uniq(matchAll(src, /^\s*resource\s+"([^"]+)"\s+"([^"]+)"/gm, 2))
    case "shell":
      return uniq(matchAll(src, /^(?:function\s+)?([A-Za-z_]\w*)\s*(?:\(\)|\{)/gm))
    default:
      return []
  }
}

export function extractImports(file, src) {
  const lang = detectLanguage(file, src)
  if (lang.family === "js") return jsImports(src)
  if (lang.id === "python") return pyImports(src)
  if (lang.id === "go") return goImports(src)
  switch (lang.id) {
    case "rust":
      return uniq(matchAll(src, /^\s*use\s+([A-Za-z0-9_:]+)/gm), MAX_IMPORTS_PER_FILE)
    case "java":
    case "kotlin":
      return uniq(matchAll(src, /^\s*import\s+([\w.*]+)/gm), MAX_IMPORTS_PER_FILE)
    case "ruby":
      return uniq(matchAll(src, /^\s*require(?:_relative)?\s+["']([^"']+)["']/gm), MAX_IMPORTS_PER_FILE)
    case "php":
      return uniq(matchAll(src, /^\s*(?:use|require|include)(?:_once)?\s+\\?([\w\\]+)/gm), MAX_IMPORTS_PER_FILE)
    case "c":
    case "cpp":
      return uniq(matchAll(src, /^\s*#\s*include\s+[<"]([^>"]+)[>"]/gm), MAX_IMPORTS_PER_FILE)
    case "csharp":
      return uniq(matchAll(src, /^\s*using\s+([\w.]+)\s*;/gm), MAX_IMPORTS_PER_FILE)
    case "swift":
      return uniq(matchAll(src, /^\s*import\s+(\w+)/gm), MAX_IMPORTS_PER_FILE)
    case "dart":
      return uniq(matchAll(src, /^\s*import\s+["']([^"']+)["']/gm), MAX_IMPORTS_PER_FILE)
    case "elixir":
      return uniq(matchAll(src, /^\s*alias\s+([\w.]+)/gm), MAX_IMPORTS_PER_FILE)
    default:
      return []
  }
}

export function extractExports(file, src) {
  const lang = detectLanguage(file, src)
  if (lang.family === "js") return jsExports(src)
  return []
}

export function extractCalls(file, src) {
  const lang = detectLanguage(file, src)
  if (lang.family === "js") return jsCalls(src)
  return []
}

export function extractTypes(file, src) {
  const lang = detectLanguage(file, src)
  if (lang.family === "js") return jsTypes(src, file)
  return []
}

export function extractRecord(file, src, fullPath = file) {
  const lang = detectLanguage(file, src)
  const symbols = [...new Set(extractSymbols(file, src))]
  return {
    lang: lang.id,
    symbols,
    imports: extractImports(file, src),
    exports: extractExports(file, src),
    calls: extractCalls(file, src),
    types: extractTypes(file, src),
    test: isTestFile(fullPath),
    config: isConfigFile(file),
  }
}

/**
 * Project-native toolchain from manifests that actually exist.
 * Never invents a command for a missing ecosystem.
 */
export function discoverToolchain(cwd = process.cwd()) {
  const has = (f) => {
    try { return fs.existsSync(path.join(cwd, f)) } catch { return false }
  }
  const out = { test: "", build: "", lint: "", format: "", languages: [] }
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"))
      if (pkg.scripts?.test) out.test = "npm test"
      else if (pkg.scripts?.build) out.build = "npm run build"
      if (pkg.scripts?.lint) out.lint = "npm run lint"
      if (pkg.scripts?.build && !out.build) out.build = "npm run build"
      out.languages.push("javascript")
    } catch {}
  }
  if (!out.test && (has("pytest.ini") || has("pyproject.toml") || has("conftest.py"))) {
    out.test = "pytest -q"
    out.languages.push("python")
  }
  if (!out.test && has("go.mod")) { out.test = "go test ./..."; out.languages.push("go") }
  if (!out.test && has("Cargo.toml")) { out.test = "cargo test"; out.languages.push("rust") }
  if (!out.test && has("Gemfile")) { out.test = has("spec") || has("spec/") ? "bundle exec rspec" : "bundle exec rake test"; out.languages.push("ruby") }
  if (!out.test && has("composer.json")) { out.test = "vendor/bin/phpunit"; out.languages.push("php") }
  if (!out.test && has("pom.xml")) { out.test = "mvn test"; out.languages.push("java") }
  if (!out.test && (has("build.gradle") || has("build.gradle.kts"))) { out.test = "gradle test"; out.languages.push("java") }
  if (!out.test && has("Makefile")) out.test = "make test"
  return out
}

export function adapterCount() {
  return ADAPTERS.length
}
