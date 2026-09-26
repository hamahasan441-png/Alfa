"""forge's Harbor adapter — the parts that need no Harbor.

The provider table, the pinned Node and its hash check, the run command, and
the mapping from forge's result file onto Harbor's context. Kept apart from
agent.py (which subclasses Harbor's BaseInstalledAgent and so needs harbor,
Python >= 3.12, installed) so that these — the parts that decide what runs,
with which key, on which verified binary — are tested by any python3,
including in forge's own CI where Harbor is not installed.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import shlex
import tarfile
import tempfile
import urllib.request
from pathlib import Path
from typing import Any

#: Harbor's canonical provider slug (after its own aliasing: gemini -> google,
#: together_ai -> together) -> (forge provider name, the env var forge reads).
#: tests/test-harbor-adapter.mjs checks every entry against forge's CATALOG, so
#: this table cannot drift from what forge actually accepts.
PROVIDER_MAP: dict[str, tuple[str, str]] = {
    "anthropic": ("anthropic", "ANTHROPIC_API_KEY"),
    "openai": ("openai", "OPENAI_API_KEY"),
    "deepseek": ("deepseek", "DEEPSEEK_API_KEY"),
    "groq": ("groq", "GROQ_API_KEY"),
    "openrouter": ("openrouter", "OPENROUTER_API_KEY"),
    "google": ("gemini", "GEMINI_API_KEY"),
    "mistral": ("mistral", "MISTRAL_API_KEY"),
    "xai": ("xai", "XAI_API_KEY"),
    "together": ("together", "TOGETHER_API_KEY"),
    "cerebras": ("cerebras", "CEREBRAS_API_KEY"),
    "nvidia_nim": ("nvidia", "NVIDIA_API_KEY"),
    "huggingface": ("huggingface", "HF_TOKEN"),
    "dashscope": ("qwen", "QWEN_API_KEY"),
    "zai": ("zai", "ZAI_API_KEY"),
}

#: forge's own checkout: integrations/harbor/forge_harbor/agent.py -> repo root.
DEFAULT_FORGE_ROOT = Path(__file__).resolve().parents[3]

REMOTE_DIR = "/installed-agent/forge"
REMOTE_NODE_DIR = "/installed-agent/node"
REMOTE_BIN = "/usr/local/bin/forge"
RESULT_FILENAME = "forge-result.json"
LOG_FILENAME = "forge.txt"
PID_PATH = "/logs/agent/forge.pid"

#: Run in the container when Harbor's agent timeout cancels the run. Harbor
#: cancels the exec from the HOST, which does not stop the process inside the
#: container — measured at v150, forge ran on for another 11 steps (~15s)
#: after the timeout, through verification, spending tokens nobody counted and
#: able to change files the verifier was reading. This sends SIGTERM (forge
#: writes its final ABORTED result and exits) and waits up to 5s for it to go.
#: Only shell builtins and coreutils: `kill` is a bash builtin, so no pkill
#: (procps is missing from minimal images).
#: How long the adapter waits for STOP_COMMAND before letting the timeout
#: propagate regardless. Longer than STOP_COMMAND's own 5s wait plus the exec.
STOP_TIMEOUT_SEC = 15

STOP_COMMAND = (
    f'p=$(cat {PID_PATH} 2>/dev/null) || exit 0; '
    '[ -n "$p" ] || exit 0; '
    'kill -TERM "$p" 2>/dev/null || exit 0; '
    # A process that has exited but not been reaped is a zombie, and `kill -0`
    # still succeeds on it — so "gone" also means state Z. That happens when
    # forge's parent shell is gone and it is re-parented to a PID 1 that never
    # reaps (`sleep infinity` is common). Found by the test that stops a real
    # process: without it the command waited out the full 5s every time.
    'for i in $(seq 50); do '
    'kill -0 "$p" 2>/dev/null || exit 0; '
    '[ "$(sed "s/.*) //" /proc/$p/stat 2>/dev/null | cut -c1)" = Z ] && exit 0; '
    'sleep 0.1; done; '
    'kill -KILL "$p" 2>/dev/null; exit 0'
)
MIN_NODE_MAJOR = 20

#: The Node forge runs on when the task image has none. Downloaded on the HOST
#: (where Harbor runs), checked against these hashes — committed here, so the
#: check does not trust the server it downloads from — cached, and uploaded
#: into the task container. The task itself needs no network: Terminal-Bench
#: images do not ship Node, and a runtime fetched from inside the task would
#: make installing the agent depend on the task's network. Hashes are from
#: https://nodejs.org/dist/v22.23.3/SHASUMS256.txt.
NODE_VERSION = "v22.23.3"
NODE_SHA256 = {
    "x64": "1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af",
    "arm64": "5ced2d48d1d7198739b7f86804de0171aefb6823b684b12341d3321afc3cb0b2",
}
#: `uname -m` -> Node's arch name. Official builds are glibc-only; musl (Alpine)
#: is refused with a clear error rather than a binary that cannot start.
NODE_ARCH = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}
NODE_CACHE = Path(os.environ.get("FORGE_HARBOR_CACHE", Path.home() / ".cache" / "forge-harbor"))

# Runs forge on the Node the install provided: the uploaded runtime first,
# then nvm's (node_install="nvm"), then the image's own (which the install
# only keeps when it is >= 20). The runtime is NOT put on the task's PATH —
# the agent's Node must not change what the task's own commands see.
WRAPPER = f"""#!/usr/bin/env bash
if [ -x {REMOTE_NODE_DIR}/bin/node ]; then
  NODE={REMOTE_NODE_DIR}/bin/node
else
  if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; fi
  NODE=node
fi
exec "$NODE" {REMOTE_DIR}/forge.js "$@"
"""


def node_tarball(arch: str, cache_dir: Path = NODE_CACHE) -> Path:
    """The verified Node tarball for `arch`, downloading it once into the cache.

    A cached file is re-verified before use; a mismatch is deleted and raised,
    never uploaded. Downloads go to a temp file and are renamed into place, so
    concurrent trials installing at once cannot read a half-written file.
    """
    if arch not in NODE_SHA256:
        raise ValueError(f"no pinned Node build for arch {arch!r}")
    name = f"node-{NODE_VERSION}-linux-{arch}.tar.gz"
    path = cache_dir / name
    want = NODE_SHA256[arch]

    def digest(p: Path) -> str:
        h = hashlib.sha256()
        with p.open("rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()

    if path.is_file():
        if digest(path) == want:
            return path
        path.unlink()
    cache_dir.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=cache_dir, prefix=f".{name}.")
    try:
        with os.fdopen(fd, "wb") as out, urllib.request.urlopen(
            f"https://nodejs.org/dist/{NODE_VERSION}/{name}", timeout=120
        ) as resp:
            while chunk := resp.read(1 << 20):
                out.write(chunk)
        got = digest(Path(tmp))
        if got != want:
            raise RuntimeError(f"{name}: sha256 {got} does not match the pinned {want}")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return path


def forge_package_files(root: Path) -> list[Path]:
    """The files `npm publish` would ship: package.json plus its `files` list."""
    pkg = json.loads((root / "package.json").read_text())
    out = [root / "package.json"]
    for entry in pkg.get("files", []):
        p = root / entry
        if p.is_dir():
            out.extend(sorted(f for f in p.rglob("*") if f.is_file()))
        elif p.is_file():
            out.append(p)
    return out


def build_forge_tarball(root: Path) -> bytes:
    """A gzipped tar of forge's published files, paths relative to the root."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for f in forge_package_files(root):
            tar.add(f, arcname=f.relative_to(root).as_posix(), recursive=False)
    return buf.getvalue()


def split_model(model_name: str | None) -> tuple[str, str]:
    """'anthropic/claude-opus-5' -> ('anthropic', 'claude-opus-5'). Split once:
    OpenRouter ids carry their own slash ('openrouter/anthropic/claude-...')."""
    if not model_name or "/" not in model_name:
        raise ValueError("model must be provider/model, e.g. anthropic/claude-opus-5")
    provider, model_id = model_name.split("/", 1)
    if not model_id:
        raise ValueError("model must be provider/model, e.g. anthropic/claude-opus-5")
    return provider, model_id


#: Where the task's MCP servers are written for `forge agent --mcp-config`.
#: Under /logs/agent so the job directory keeps what the agent was given.
MCP_CONFIG_PATH = "/logs/agent/forge-mcp.json"


def _field(server: Any, name: str, default: Any = None) -> Any:
    if isinstance(server, dict):
        return server.get(name, default)
    return getattr(server, name, default)


def mcp_config(servers: Any) -> dict[str, Any] | None:
    """Harbor's MCPServerConfig list -> forge's `--mcp-config` JSON (v154).

    The `.mcp.json` shape (`{"mcpServers": {...}}`) with the same transport
    names Harbor's Claude Code agent writes: stdio, http (Harbor's
    streamable-http), sse. Since v162 forge speaks sse (the HTTP+SSE
    transport of MCP 2024-11-05, Harbor's default when a task gives only a
    url) by the spec's fallback, so it is passed through like the others.
    None when the task names no servers.
    """
    out: dict[str, dict[str, Any]] = {}
    for server in servers or []:
        name = _field(server, "name")
        transport = _field(server, "transport", "sse")
        if transport == "stdio":
            out[name] = {"type": "stdio", "command": _field(server, "command"), "args": list(_field(server, "args") or [])}
        else:
            out[name] = {"type": "http" if transport in ("streamable-http", "http") else transport, "url": _field(server, "url")}
    return {"mcpServers": out} if out else None


def build_mcp_config_command(servers: Any, path: str = MCP_CONFIG_PATH) -> str | None:
    """The shell command that writes the task's MCP servers for forge, or None."""
    config = mcp_config(servers)
    if config is None:
        return None
    return f"printf '%s' {shlex.quote(json.dumps(config))} > {shlex.quote(path)}"


def build_run_command(
    *,
    instruction: str,
    forge_provider: str,
    model_id: str,
    base_url: str | None = None,
    max_steps: int | None = None,
    deep: bool = False,
    mcp_config_path: str | None = None,
    result_path: str = f"/logs/agent/{RESULT_FILENAME}",
    log_path: str = f"/logs/agent/{LOG_FILENAME}",
    pid_path: str = PID_PATH,
) -> str:
    """The shell command that runs forge on one task.

    `--` before the instruction: task text may itself begin with `--`. stdin is
    /dev/null, so nothing can wait on a person. `--yolo` because the task
    container IS the sandbox — forge's guards exist for a user's machine, and
    a benchmark task legitimately installs packages and rewrites system files.
    """
    args = [
        REMOTE_BIN, "agent", "--headless", "--yolo",
        "--provider", forge_provider, "--model", model_id,
        "--result-json", result_path,
    ]
    if base_url:
        args += ["--base-url", base_url]
    if max_steps is not None:
        args += ["--max-steps", str(max_steps)]
    if deep:
        args.append("--deep")
    if mcp_config_path:
        args += ["--mcp-config", mcp_config_path]
    args += ["--", instruction]
    # `sh -c` records its own pid ($$, POSIX — not bash's $BASHPID) and then
    # execs the wrapper, which execs node: the pid on file IS forge's, for
    # STOP_COMMAND to signal. forge's arguments ride as "$@", so they are
    # quoted exactly once.
    launcher = shlex.quote(f'echo $$ > {shlex.quote(pid_path)}; exec "$@"')
    forge = " ".join(shlex.quote(a) for a in args)
    return f"sh -c {launcher} forge {forge} </dev/null 2>&1 | tee {shlex.quote(log_path)}"


def context_from_result(result: dict[str, Any]) -> dict[str, Any]:
    """Map forge's result file onto Harbor's AgentContext fields.

    forge's inputTokens is ALL input (fresh + cache read + cache write), which
    is Harbor's n_input_tokens convention; n_cache_tokens is the cache reads.
    forge carries no price table, so cost stays None rather than a guess.
    """
    usage = result.get("usage") or {}
    return {
        "n_input_tokens": usage.get("inputTokens"),
        "n_output_tokens": usage.get("outputTokens"),
        "n_cache_tokens": usage.get("cacheReadTokens"),
        "cost_usd": result.get("costUsd"),
        "metadata": {
            "forge_version": result.get("forge"),
            "forge_status": result.get("status"),
            "forge_reason": result.get("reason"),
            "forge_steps": result.get("steps"),
            "forge_tool_calls": result.get("toolCalls"),
            "forge_usage_estimated": usage.get("estimated"),
            "forge_error": result.get("error"),
            # v181: the checks the run ran (how many passed, the last one, the
            # changed files no passing check covers) — COMPLETED says the run
            # reached an end, this says what forge saw of whether it worked
            "forge_checks": result.get("checks"),
            # v200: the run's MCP servers (tools offered, or why none) and the
            # --mcp-config entries skipped before it started
            "forge_mcp": result.get("mcp"),
        },
    }
