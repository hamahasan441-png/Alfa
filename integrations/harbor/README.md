# forge on Terminal-Bench (Harbor adapter)

[Harbor](https://github.com/laude-institute/harbor) is the official harness for
[Terminal-Bench](https://www.tbench.ai). It starts each task's container,
installs an agent in it, runs the agent on the task, and scores the result
with the task's own tests. `forge_harbor` is the adapter that makes forge one
of those agents. Nothing in Harbor needs to change.

## Run it

Needs Docker and Harbor (Python ≥ 3.12):

```bash
uv tool install harbor                       # or: pip install harbor
export ANTHROPIC_API_KEY=...                 # the key for the model you are scoring

PYTHONPATH=integrations/harbor harbor run \
  --dataset terminal-bench@2.0 \
  --agent forge_harbor.agent:ForgeAgent \
  --model anthropic/claude-opus-5 \
  --n-concurrent 4

forge tbench report jobs/<job-name>
```

`forge tbench` prints the same command with the adapter's absolute path, so it
also works from an `npm i -g` install.

Every full run spends real tokens: 89 tasks, each a long agent loop. Try one
task first with `--include-task-name fix-git`.

When this was written, the public registry held `terminal-bench@2.0` (89
tasks); `@3.0` and `@4.0` returned "not found".

## What it does

- **install**: packs *this* forge checkout (the files `package.json` would
  publish) into the task container. If the image has no Node ≥ 20 (Terminal-Bench's
  images don't), it uploads Node v22.23.3 from the host. The build is downloaded
  once, checked against SHA-256 hashes committed in `core.py`, cached in
  `~/.cache/forge-harbor`, and never added to the task's `PATH`. The task needs
  no network for any of this. `--ak node_install=nvm` switches to Harbor's nvm
  helper instead, which does need the task's network.
- **run**: `forge agent --headless --yolo --provider … --model … --result-json
  /logs/agent/forge-result.json -- <task>`, with stdin closed and output
  written to `/logs/agent/forge.txt`. `--yolo` is used because the task
  container *is* the sandbox.
- **report**: forge's token counts and status go into Harbor's `agent_result`.
  Cost is `null`: forge carries no price table and doesn't guess one.
- **timeouts** (v151): Harbor ends a timed-out run by cancelling it from the
  host, which doesn't signal anything inside the container. forge therefore
  keeps its result file current during the run, written atomically with
  status `RUNNING`. When the cancellation arrives, the adapter sends forge a
  SIGTERM in the container (by the PID the run command recorded). forge
  answers with a final `ABORTED` record and stops before the verifier runs.
  A timed-out trial reports what it spent, and forge doesn't keep editing
  files while the tests read them.

- **MCP servers** (v154): a task's `mcp_servers` (task.toml) are written to
  `/logs/agent/forge-mcp.json` in the `.mcp.json` shape and passed with
  `--mcp-config`, for that run only. `stdio` and `streamable-http` servers
  work, and so does `sse`, which is Harbor's default when a task gives only a
  `url`. Since v162, forge falls back to the HTTP+SSE transport of MCP
  2024-11-05 the way the spec describes.

Options (`--ak key=value`): `max_steps` (1–1000), `deep` (true/false),
`node_install` (`upload` | `nvm`), `forge_root` (another checkout to install).

## Providers

Harbor model names are `provider/model`. The adapter maps Harbor's provider to
forge's, and passes the key under the variable **forge** reads (Harbor's
`google` accepts `GOOGLE_API_KEY`; forge's `gemini` reads `GEMINI_API_KEY`):
anthropic, openai, deepseek, groq, openrouter, google→gemini, mistral, xai,
together, cerebras, nvidia_nim→nvidia, huggingface, dashscope→qwen, zai.
`tests/test-tbench-report.mjs` checks every entry against forge's catalog.

## Layout

- `forge_harbor/core.py`: the provider table, pinned Node and hash check,
  run command, and result mapping. No Harbor import, so forge's CI tests it
  with any python3.
- `forge_harbor/agent.py`: the `BaseInstalledAgent` subclass. It needs Harbor.

## Tests

- `tests/test_harbor_adapter.py`: the core half always runs; the agent half
  runs against Harbor's real base classes when `FORGE_HARBOR_PYTHON` points at
  a Python with Harbor installed.
- `tests/harbor-e2e.sh` (opt-in): real Harbor + Docker + forge, driven by a
  scripted stub model so no key is spent. Includes a task that ships its own
  MCP server (`tests/harbor-tasks-mcp`). `TB_REAL=1` adds three real
  Terminal-Bench 2.0 tasks.
