#!/usr/bin/env node
/**
 * forge keeps its data in its own folder; only the provider API keys live
 * outside it (datadir.js). Proven on a REAL install: the runtime files are
 * copied to a temp folder and the CLI runs from there with a temp HOME and
 * none of FORGE_HOME / FORGE_DATA_DIR / FORGE_CONFIG set — the default an
 * installed forge gets. Deleting that folder is "uninstalling forge".
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${extra ? "  — " + String(extra).slice(0, 400) : ""}`) }
}
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want), `want ${JSON.stringify(want)}`)

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "forge-portable-"))
const D = await import("../datadir.js")

/** A fresh "install": every plain file package.json ships, copied. */
function install(name) {
  const dir = path.join(TMP, name)
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"))
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(dir, "package.json"))
  for (const f of pkg.files) {
    const src = path.join(ROOT, f)
    try { if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(dir, f)) } catch { /* listed directories are not needed here */ }
  }
  return dir
}
/** Run that install's CLI with only PATH and HOME — the installed default. */
const run = (dir, home, ...args) => spawnSync(process.execPath, [path.join(dir, "forge.js"), ...args], {
  encoding: "utf8", cwd: TMP, env: { PATH: process.env.PATH, HOME: home, NO_COLOR: "1" }, timeout: 60000,
})
const listAll = (dir) => { const out = []; const w = (d, r) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const rr = r ? `${r}/${e.name}` : e.name; e.isDirectory() ? w(path.join(d, e.name), rr) : out.push(rr) } }; try { w(dir, "") } catch {} return out.sort() }

try {
  console.log("== where data and keys go (rules) ==")
  {
    eq("default data folder is forge's own folder", D.resolveDataDir({}), D.INSTALL_DATA_DIR)
    ok("…which is <install>/data", D.INSTALL_DATA_DIR === path.join(ROOT, "data"))
    eq("FORGE_HOME wins", D.resolveDataDir({ FORGE_HOME: "/x/h" }), "/x/h")
    eq("FORGE_DATA_DIR is the alias", D.resolveDataDir({ FORGE_DATA_DIR: "/x/d" }), "/x/d")
    eq("keys: XDG config folder", D.keysFilePath({ HOME: "/h", XDG_CONFIG_HOME: "/h/xdg" }, { platform: "linux" }), "/h/xdg/forge/keys.json")
    eq("keys: ~/.config by default", D.keysFilePath({ HOME: "/h" }, { platform: "darwin" }), "/h/.config/forge/keys.json")
    eq("keys: %APPDATA% on Windows", D.keysFilePath({ HOME: "/h", APPDATA: "/h/AppData/Roaming" }, { platform: "win32" }), path.join("/h/AppData/Roaming", "forge", "keys.json"))
    eq("an explicit FORGE_HOME keeps keys in its config", D.keysFilePath({ HOME: "/h", FORGE_HOME: "/x" }), null)
    eq("…so does FORGE_CONFIG", D.keysFilePath({ HOME: "/h", FORGE_CONFIG: "/x/c.json" }), null)
    eq("FORGE_KEYS_FILE wins over everything", D.keysFilePath({ HOME: "/h", FORGE_HOME: "/x", FORGE_KEYS_FILE: "/k/keys.json" }), "/k/keys.json")
    // a FILE where the data folder should be: mkdir fails even for root
    const blocker = path.join(TMP, "not-a-dir"); fs.writeFileSync(blocker, "x")
    const fb = D.chooseDataDir({ HOME: path.join(TMP, "fbhome") }, { installDataDir: path.join(blocker, "data") })
    ok("an unwritable install folder falls back to ~/.forge — and says why", fb.source === "fallback" && fb.dir === path.join(TMP, "fbhome", ".forge") && /not writable/.test(fb.fallback ?? ""), JSON.stringify(fb))
  }

  console.log("== API keys split out of a config ==")
  {
    const cfg = { activeProvider: "openai", providers: { openai: { apiKey: "sk-a", model: "m" }, ollama: { apiKey: "", model: "l" } }, retrieval: { embeddings: { apiKey: "emb-k" } } }
    eq("every non-empty apiKey, by path", D.collectKeys(cfg), { "providers.openai.apiKey": "sk-a", "retrieval.embeddings.apiKey": "emb-k" })
    ok("the config without them keeps everything else", JSON.stringify(D.withoutKeys(cfg)) === JSON.stringify({ activeProvider: "openai", providers: { openai: { model: "m" }, ollama: { model: "l" } }, retrieval: { embeddings: {} } }), JSON.stringify(D.withoutKeys(cfg)))
    eq("keys back into a tree", D.keysToTree(D.collectKeys(cfg)), { providers: { openai: { apiKey: "sk-a" } }, retrieval: { embeddings: { apiKey: "emb-k" } } })
    eq("a keys file cannot write anything but an apiKey, or touch __proto__", D.keysToTree({ "a.model": "x", "__proto__.apiKey": "p", "constructor.prototype.apiKey": "q", "ok.apiKey": "v" }), { ok: { apiKey: "v" } })
  }

  console.log("== an installed forge keeps data in its folder, keys outside ==")
  const H = path.join(TMP, "home"); fs.mkdirSync(H)
  const A = install("forge-a")
  {
    const set = run(A, H, "config", "set", "providers.openai.apiKey", "sk-test-1234567890abcdef")
    eq("forge config set exits 0", set.status, 0)
    ok("…and says the key went to the keys file", set.stdout.includes(path.join(H, ".config", "forge", "keys.json")), set.stdout + set.stderr)
    run(A, H, "config", "set", "providers.openai.model", "gpt-test")
    const cfg = JSON.parse(fs.readFileSync(path.join(A, "data", "config.json"), "utf8"))
    eq("settings are in <install>/data/config.json", cfg.providers?.openai?.model, "gpt-test")
    ok("…which holds no API key", !JSON.stringify(cfg).includes("sk-test"), JSON.stringify(cfg))
    const keysFile = path.join(H, ".config", "forge", "keys.json")
    const keys = JSON.parse(fs.readFileSync(keysFile, "utf8"))
    eq("the key is in the keys file", keys.keys?.["providers.openai.apiKey"], "sk-test-1234567890abcdef")
    eq("…readable only by you (0600)", (fs.statSync(keysFile).mode & 0o777).toString(8), "600")
    ok("nothing was written to ~/.forge", !fs.existsSync(path.join(H, ".forge")))
    eq("HOME holds only the keys file", listAll(H), [".config/forge/keys.json"])
    const got = run(A, H, "config", "get", "providers.openai.apiKey")
    ok("forge reads the key back (masked)", /sk-tes.*cdef/.test(got.stdout), got.stdout + got.stderr)
    const st = JSON.parse(run(A, H, "data", "status", "--json").stdout || "{}")
    eq("forge data status: the data root", st.root, path.join(A, "data"))
    eq("…chosen as forge's folder", st.via, "forge's folder")
    eq("…and where the keys are", st.keys, keysFile)
    // clearing a key removes it from the keys file too
    run(A, H, "config", "set", "providers.anthropic.apiKey", "sk-ant-zzzzzzzzzzzz")
    run(A, H, "config", "unset", "providers.anthropic.apiKey")
    ok("unsetting a key removes it from the keys file", !fs.readFileSync(keysFile, "utf8").includes("sk-ant"), fs.readFileSync(keysFile, "utf8"))
  }

  console.log("== removing forge removes its data; the keys stay ==")
  {
    fs.rmSync(A, { recursive: true, force: true })
    eq("after removing forge's folder, HOME holds only the keys", listAll(H), [".config/forge/keys.json"])
    const B = install("forge-b")
    const got = run(B, H, "config", "get", "providers.openai.apiKey")
    ok("a fresh install finds the key", /sk-tes.*cdef/.test(got.stdout), got.stdout + got.stderr)
    eq("…but none of the old settings (they went with the old folder)", run(B, H, "config", "get", "providers.openai.model").stdout.trim(), "(unset)")
  }

  console.log("== forge data migrate: an older forge's ~/.forge ==")
  {
    const H2 = path.join(TMP, "home2")
    const old = path.join(H2, ".forge")
    fs.mkdirSync(path.join(old, "sessions"), { recursive: true }); fs.mkdirSync(path.join(old, "runtime", "x"), { recursive: true })
    fs.writeFileSync(path.join(old, "config.json"), JSON.stringify({ activeProvider: "openai", providers: { openai: { apiKey: "sk-old-key-abcdefgh", model: "old-m" } } }))
    fs.writeFileSync(path.join(old, "memory.md"), "remember: tabs\n")
    fs.writeFileSync(path.join(old, "sessions", "s1.json"), "{}")
    fs.writeFileSync(path.join(old, "runtime", "x", "cache.js"), "1")
    const C = install("forge-c")
    const hint = run(C, H2, "agent", "hi")
    const said = `${hint.stdout}\n${hint.stderr}`
    ok("with no provider, forge points at the older data", /n older forge's settings and API keys are in .*\.forge\/config\.json/.test(said) && /forge data migrate/.test(said), said.slice(0, 600))
    const m = run(C, H2, "data", "migrate")
    eq("migrate exits 0", m.status, 0)
    ok("memory and sessions are copied into forge's folder", fs.readFileSync(path.join(C, "data", "memory.md"), "utf8") === "remember: tabs\n" && fs.existsSync(path.join(C, "data", "sessions", "s1.json")))
    ok("caches are not copied", !fs.existsSync(path.join(C, "data", "runtime")))
    const cfg = JSON.parse(fs.readFileSync(path.join(C, "data", "config.json"), "utf8"))
    ok("the settings came across, without the key", cfg.providers?.openai?.model === "old-m" && !JSON.stringify(cfg).includes("sk-old"), JSON.stringify(cfg))
    eq("the key went to the keys file", JSON.parse(fs.readFileSync(path.join(H2, ".config", "forge", "keys.json"), "utf8")).keys["providers.openai.apiKey"], "sk-old-key-abcdefgh")
    ok("~/.forge is left in place without --remove-old", fs.existsSync(old) && /forge data migrate --remove-old/.test(m.stdout), m.stdout)
    // a conflict blocks removal
    fs.writeFileSync(path.join(C, "data", "memory.md"), "something newer\n")
    fs.writeFileSync(path.join(old, "memory.md"), "remember: tabs and spaces\n")
    const c2 = run(C, H2, "data", "migrate", "--remove-old")
    ok("a file that differs is a conflict, and nothing is deleted", c2.status === 1 && /conflict\s+memory\.md/.test(c2.stdout) && /NOT removed/.test(c2.stdout) && fs.existsSync(old), c2.stdout)
    eq("…and the newer copy was not overwritten", fs.readFileSync(path.join(C, "data", "memory.md"), "utf8"), "something newer\n")
    fs.writeFileSync(path.join(old, "memory.md"), "something newer\n")
    const c3 = run(C, H2, "data", "migrate", "--remove-old")
    ok("with everything verified, --remove-old deletes ~/.forge", c3.status === 0 && !fs.existsSync(old), c3.stdout)
    eq("HOME then holds only the keys", listAll(H2), [".config/forge/keys.json"])
  }

  console.log("== the single-file build keeps its data where it always did ==")
  {
    const out = path.join(TMP, "dist", "forge.mjs")
    const b = spawnSync(process.execPath, [path.join(ROOT, "scripts", "build-single-file.mjs"), "--out", out], { encoding: "utf8", timeout: 120000 })
    eq("the bundle builds", b.status, 0)
    const H3 = path.join(TMP, "home3"); fs.mkdirSync(H3)
    const st = spawnSync(process.execPath, [out, "data", "status", "--json"], { encoding: "utf8", cwd: TMP, env: { PATH: process.env.PATH, HOME: H3, NO_COLOR: "1" }, timeout: 60000 })
    const j = (() => { try { return JSON.parse(st.stdout) } catch { return null } })()
    eq("its data root is ~/.forge (it unpacks there; its own folder is a build cache)", j?.root, path.join(H3, ".forge"))
    ok("…not inside the unpacked runtime tree", !/runtime/.test(String(j?.root)), String(j?.root))
  }

  console.log("== the agent may not write forge's own state, wherever it is ==")
  {
    const S = await import("../shellguard.js")
    const dataDir = path.join(TMP, "proj", "data")
    const keysDir = path.join(TMP, "home", ".config", "forge")
    const dirs = [dataDir, keysDir]
    ok("a plugin file in the data folder is protected", /forge's own state/.test(S.protectedDestinationReason(path.join(dataDir, "tools", "pwn.mjs"), path.join(TMP, "home"), { forgeDirs: dirs }) ?? ""))
    ok("the keys folder is protected", /forge's own state/.test(S.protectedDestinationReason(path.join(keysDir, "keys.json"), path.join(TMP, "home"), { forgeDirs: dirs }) ?? ""))
    ok("a project file next to it is not", S.protectedDestinationReason(path.join(TMP, "proj", "src", "a.js"), path.join(TMP, "home"), { forgeDirs: dirs }) === null)
    ok("~/.forge stays protected too", /protected location/.test(S.protectedDestinationReason(path.join(TMP, "home", ".forge", "tools", "x.mjs"), path.join(TMP, "home"), { forgeDirs: [] }) ?? ""))
    // and through the real classifier, for this process's own data folder
    const mine = S.forgeStatePaths()
    ok("this process knows its own state folders", mine.length >= 1, JSON.stringify(mine))
    const r = S.classifyCommand(`echo x > ${path.join(mine[0], "tools", "pwn.mjs")}`, { cwd: mine[0], root: mine[0], home: path.join(TMP, "home") })
    ok("a shell write into it is flagged, even from inside it", r.level === "danger" || r.level === "block", JSON.stringify(r))
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true })
}

console.log(`\n== portable-data suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
