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
# verifier decides), forge-smoke-nonode 1 (an image with no Node), and — with
# TB_REAL — the real tasks run with 0 exceptions and reward 0 (the stub cannot
# solve them; the run proves install + headless + verify on real images).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HARBOR="${HARBOR:-harbor}"
command -v "$HARBOR" >/dev/null || { echo "harbor not found (uv tool install harbor, or HARBOR=/path/to/harbor)"; exit 2; }
docker info >/dev/null 2>&1 || { echo "Docker is not running"; exit 2; }
JOBS="$(mktemp -d)"
GW="$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')"

node "$ROOT/tests/tbench-stub-model.mjs" 0 0.0.0.0 > "$JOBS/stub.port" &
STUB=$!
trap 'kill $STUB 2>/dev/null || true' EXIT
for _ in $(seq 50); do grep -q listening "$JOBS/stub.port" 2>/dev/null && break; sleep 0.1; done
PORT="$(awk '{print $2}' "$JOBS/stub.port")"

run() {
  env PYTHONPATH="$ROOT/integrations/harbor" ANTHROPIC_API_KEY=stub-key ANTHROPIC_BASE_URL="http://$GW:$PORT" \
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

if [ "${TB_REAL:-}" = "1" ]; then
  run -d terminal-bench@2.0 -i fix-git -i regex-log -i log-summary-date-ranges -n 3 --job-name tb2
  node "$ROOT/forge.js" tbench report "$JOBS/tb2"
fi
echo "jobs: $JOBS"
