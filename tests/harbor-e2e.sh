#!/usr/bin/env bash
# forge v149 — the real thing, end to end: Harbor (Terminal-Bench's official
# harness) + Docker + forge installed by integrations/harbor, driven by the
# scripted stub model so no key is spent.
#
# Needs: Docker running, and harbor (Python >= 3.12):  uv tool install harbor
# Opt-in — never part of `npm test`:
#
#   bash tests/harbor-e2e.sh              # the three smoke tasks
#   TB_REAL=1 bash tests/harbor-e2e.sh    # plus three real Terminal-Bench 2.0 tasks
#
# Expected: forge-smoke-pass 1, forge-smoke-fail 0 (forge says COMPLETED — the
# verifier decides), forge-smoke-nonode 1 (an image with no Node), and
# forge-smoke-timeout (v151): the 10s agent timeout fires, the adapter stops
# forge in the container, and Harbor records forge's final ABORTED result with
# its steps and tokens — where v150 recorded nothing at all. forge-smoke-mcp
# (v154) scores 1 only if the task's own MCP server reached forge. And — with
# TB_REAL — the real tasks run with 0 exceptions and reward 0 (the stub cannot
# solve them; the run proves install + headless + verify on real images).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HARBOR="${HARBOR:-harbor}"
command -v "$HARBOR" >/dev/null || { echo "harbor not found (uv tool install harbor, or HARBOR=/path/to/harbor)"; exit 2; }
docker info >/dev/null 2>&1 || { echo "Docker is not running"; exit 2; }
JOBS="$(mktemp -d)"
GW="$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')"

start_stub() { # $1 = port file; extra env before the call
  node "$ROOT/tests/tbench-stub-model.mjs" 0 0.0.0.0 > "$1" &
  echo $!
}
STUB=$(start_stub "$JOBS/stub.port")
LOOP=$(STUB_LOOP=1 start_stub "$JOBS/loop.port")
trap 'kill $STUB $LOOP 2>/dev/null || true' EXIT
for f in stub loop; do for _ in $(seq 50); do grep -q listening "$JOBS/$f.port" 2>/dev/null && break; sleep 0.1; done; done
PORT="$(awk '{print $2}' "$JOBS/stub.port")"
LOOP_PORT="$(awk '{print $2}' "$JOBS/loop.port")"

run() {
  env PYTHONPATH="$ROOT/integrations/harbor" ANTHROPIC_API_KEY=stub-key ANTHROPIC_BASE_URL="http://$GW:${USE_PORT:-$PORT}" \
    "$HARBOR" run "$@" -a forge_harbor.agent:ForgeAgent -m anthropic/stub-model -o "$JOBS"
}

run -p "$ROOT/tests/harbor-tasks" -n 3 --job-name smoke
node "$ROOT/forge.js" tbench report "$JOBS/smoke"
node -e '
  const r = (await import(process.argv[1])).readHarborJob(process.argv[2])
  const by = Object.fromEntries(r.trials.map((t) => [t.task, t.reward]))
  const want = { "forge-smoke-pass": 1, "forge-smoke-fail": 0, "forge-smoke-nonode": 1 }
  const bad = Object.entries(want).filter(([k, v]) => by[k] !== v)
  if (bad.length || r.summary.errors) { console.error("UNEXPECTED:", JSON.stringify({ by, errors: r.summary.errors })); process.exit(1) }
  console.log("smoke: as expected")
' "$ROOT/tbench.js" "$JOBS/smoke" --input-type=module

USE_PORT="$LOOP_PORT" run -p "$ROOT/tests/harbor-tasks-timeout" -n 1 --job-name timeout
node "$ROOT/forge.js" tbench report "$JOBS/timeout"
node -e '
  const r = (await import(process.argv[1])).readHarborJob(process.argv[2])
  const t = r.trials[0]
  if (t?.error !== "AgentTimeoutError" || t?.forgeStatus !== "ABORTED" || !(t?.forgeSteps > 0) || !(t?.inputTokens > 0)) {
    console.error("UNEXPECTED:", JSON.stringify(t)); process.exit(1)
  }
  console.log(`timeout: as expected — forge stopped by the adapter after ${t.forgeSteps} steps, ${t.inputTokens} input tokens reported`)
' "$ROOT/tbench.js" "$JOBS/timeout" --input-type=module

# v154: a task that ships its own MCP server and names it in task.toml. The
# verifier passes only if the server's tool was called, so reward 1 proves the
# adapter handed forge the server (with the servers dropped, it scores 0 — and
# forge still says COMPLETED, a false completion).
run -p "$ROOT/tests/harbor-tasks-mcp" -n 1 --job-name mcp
node "$ROOT/forge.js" tbench report "$JOBS/mcp"
node -e '
  const r = (await import(process.argv[1])).readHarborJob(process.argv[2])
  const t = r.trials[0]
  if (t?.reward !== 1 || r.summary.errors) { console.error("UNEXPECTED:", JSON.stringify(t)); process.exit(1) }
  console.log("mcp: as expected — the task-owned MCP server was given to forge and called")
' "$ROOT/tbench.js" "$JOBS/mcp" --input-type=module

if [ "${TB_REAL:-}" = "1" ]; then
  run -d terminal-bench@2.0 -i fix-git -i regex-log -i log-summary-date-ranges -n 3 --job-name tb2
  node "$ROOT/forge.js" tbench report "$JOBS/tb2"
fi
echo "jobs: $JOBS"
