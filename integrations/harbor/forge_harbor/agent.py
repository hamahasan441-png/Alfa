"""forge as a Harbor installed agent — the way forge runs Terminal-Bench.

Harbor (https://github.com/laude-institute/harbor) is the official harness for
Terminal-Bench. It starts each task's container, installs the agent inside it,
runs the agent on the task text, and scores the result with the task's own
tests. This module is the "installs the agent" and "runs the agent" half for
forge; nothing in Harbor needs to change::

    PYTHONPATH=integrations/harbor harbor run \\
        --dataset terminal-bench@2.0 \\
        --agent forge_harbor.agent:ForgeAgent \\
        --model anthropic/claude-opus-5

Written against harbor 0.23.0's ``BaseInstalledAgent``, modelled on its
bundled Node-based agents (pi, opencode).

What it relies on in forge (v149's headless contract, pinned by
tests/test-tbench-headless.mjs):

* ``forge agent --headless`` never prompts or onboards, and refuses to start
  unless ``--provider`` and ``--model`` are given: the score is filed under the
  model named here, never one inferred from a stray key in the container.
* ``--result-json FILE`` records status, steps, tool calls and token usage.
* Exit 0 means the run reached an end, COMPLETED or INCOMPLETE; whether the
  task was solved is the verifier's call. Non-zero is a real error, which
  Harbor records as the trial failing to run.
"""

from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path
from typing import Literal, override

from pydantic import Field

from harbor.agents.installed.base import BaseInstalledAgent, PackageSpec, with_prompt_template
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.agents.model_connection import ModelConnectionSpec
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from forge_harbor.core import (  # noqa: F401 — re-exported: agent.X is the public surface
    DEFAULT_FORGE_ROOT,
    LOG_FILENAME,
    MCP_CONFIG_PATH,
    MIN_NODE_MAJOR,
    NODE_ARCH,
    NODE_CACHE,
    NODE_SHA256,
    NODE_VERSION,
    PID_PATH,
    PROVIDER_MAP,
    REMOTE_BIN,
    REMOTE_DIR,
    REMOTE_NODE_DIR,
    RESULT_FILENAME,
    STOP_COMMAND,
    STOP_TIMEOUT_SEC,
    WRAPPER,
    build_forge_tarball,
    build_mcp_config_command,
    build_run_command,
    context_from_result,
    forge_package_files,
    mcp_config,
    node_tarball,
    split_model,
)


class ForgeOptions(InstalledAgentOptions):
    forge_root: str | None = Field(
        default=None,
        description="Path to the forge checkout to install (default: the one this adapter lives in).",
    )
    max_steps: int | None = Field(
        default=None, ge=1, le=1000, description="forge agent --max-steps."
    )
    deep: bool = Field(default=False, description="forge agent --deep (more reasoning effort).")
    node_install: Literal["upload", "nvm"] = Field(
        default="upload",
        description=(
            "When the image has no Node >= 20: 'upload' a pinned, hash-checked build "
            "from the host (no network needed in the task), or install via 'nvm' "
            "inside the task (needs the task's network)."
        ),
    )


class ForgeAgent(BaseInstalledAgent):
    """Installs forge from a local checkout and runs it headless on the task."""

    # Harbor resolves the key and base URL for the model's provider and passes
    # them through under the provider's own env names.
    MODEL_CONNECTION = ModelConnectionSpec(passthrough=True)

    # gzip is what `tar -xz` shells out to; the base table has no entry for it.
    SYSTEM_PACKAGES = {**BaseInstalledAgent.SYSTEM_PACKAGES, "gzip": PackageSpec.standard("gzip")}

    options_model = ForgeOptions
    options: ForgeOptions

    # Per instance so a test can shorten it; not an option.
    _stop_timeout_sec: float = STOP_TIMEOUT_SEC

    @staticmethod
    @override
    def name() -> str:
        return "forge"

    @override
    def get_version_command(self) -> str | None:
        return f"{REMOTE_BIN} --version"

    @override
    def parse_version(self, stdout: str) -> str:
        return stdout.strip().splitlines()[-1].strip()

    def _forge_root(self) -> Path:
        root = Path(self.options.forge_root) if self.options.forge_root else DEFAULT_FORGE_ROOT
        if not (root / "forge.js").is_file() or not (root / "package.json").is_file():
            raise FileNotFoundError(f"not a forge checkout: {root}")
        return root

    async def _install_node(self, environment: BaseEnvironment) -> None:
        has_node = await environment.exec(
            command=(
                "command -v node >/dev/null 2>&1 && "
                f"node -e 'process.exit(+process.versions.node.split(\".\")[0] >= {MIN_NODE_MAJOR} ? 0 : 1)'"
            )
        )
        if has_node.return_code == 0:
            return
        if self.options.node_install == "nvm":
            await self.ensure_system_dependencies(environment, ("curl",))
            await self.exec_as_agent(
                environment, command=f"set -euo pipefail; {nvm_node_install_snippet()}"
            )
            return
        probe = await environment.exec(
            command="uname -m; if ls /lib/ld-musl-* >/dev/null 2>&1; then echo musl; else echo glibc; fi"
        )
        lines = (probe.stdout or "").split()
        machine = lines[0] if lines else ""
        if "musl" in lines:
            raise RuntimeError(
                "the task image is musl-based (Alpine); official Node builds need glibc — "
                "use an image with Node >= 20 installed"
            )
        arch = NODE_ARCH.get(machine)
        if arch is None:
            raise RuntimeError(f"no Node build for the task image's architecture {machine!r}")
        await environment.upload_file(node_tarball(arch), "/installed-agent/node.tgz")
        await self.exec_as_root(
            environment,
            command=(
                f"rm -rf {REMOTE_NODE_DIR} && mkdir -p {REMOTE_NODE_DIR} && "
                f"tar -xzf /installed-agent/node.tgz -C {REMOTE_NODE_DIR} --strip-components=1 && "
                f"rm -f /installed-agent/node.tgz && chmod -R a+rX {REMOTE_NODE_DIR} && "
                f"{REMOTE_NODE_DIR}/bin/node --version"
            ),
        )

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        # No ca_certificates: Node carries its own CA bundle, and asking for it
        # would mean an apt-get inside the task on every install.
        await self.ensure_system_dependencies(environment, ("bash", "tar", "gzip"))
        await self._install_node(environment)

        with tempfile.TemporaryDirectory(prefix="harbor-forge-") as tmp:
            tgz = Path(tmp) / "forge.tgz"
            tgz.write_bytes(build_forge_tarball(self._forge_root()))
            await environment.upload_file(tgz, "/installed-agent/forge.tgz")
            wrapper = Path(tmp) / "forge"
            wrapper.write_text(WRAPPER)
            await environment.upload_file(wrapper, "/installed-agent/forge-wrapper")
        await self.exec_as_root(
            environment,
            command=(
                f"rm -rf {REMOTE_DIR} && mkdir -p {REMOTE_DIR} && "
                f"tar -xzf /installed-agent/forge.tgz -C {REMOTE_DIR} && "
                f"chmod -R a+rX {REMOTE_DIR} && "
                f"install -m 755 /installed-agent/forge-wrapper {REMOTE_BIN}"
            ),
        )
        await self.exec_as_agent(environment, command=f"{REMOTE_BIN} --version")

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        _, model_id = split_model(self.model_name)
        access = self.model_connection
        mapped = PROVIDER_MAP.get(access.provider or "")
        if mapped is None:
            raise ValueError(
                f"forge has no mapping for Harbor provider {access.provider!r}; "
                f"supported: {', '.join(sorted(PROVIDER_MAP))}"
            )
        forge_provider, key_env = mapped
        env: dict[str, str] = {"NO_COLOR": "1"}
        # Under the name FORGE reads, which is not always the one Harbor
        # resolved it from (Harbor's google provider accepts GOOGLE_API_KEY;
        # forge's gemini reads GEMINI_API_KEY). Env, not --key: a key on the
        # command line lands in process listings and command logs.
        if access.api_key:
            env[key_env] = access.api_key
        # The task's MCP servers (task.toml), which Harbor's BaseAgent says to
        # register with the agent: written for this run only, never into a
        # forge config.
        write_mcp = build_mcp_config_command(self.mcp_servers)
        if write_mcp:
            await self.exec_as_agent(environment, command=write_mcp)
        try:
            await self.exec_as_agent(
                environment,
                command=build_run_command(
                    instruction=instruction,
                    forge_provider=forge_provider,
                    model_id=model_id,
                    base_url=access.configured_base_url,
                    max_steps=self.options.max_steps,
                    deep=self.options.deep,
                    mcp_config_path=MCP_CONFIG_PATH if write_mcp else None,
                ),
                env=env,
            )
        except asyncio.CancelledError:
            # Harbor's agent timeout (asyncio.wait_for) cancels this coroutine,
            # and that does not stop forge inside the container. Stop it here,
            # before Harbor reads the logs and runs the verifier: forge answers
            # SIGTERM with a final ABORTED result carrying everything it spent.
            # Bounded, and never allowed to replace the cancellation itself.
            try:
                await asyncio.wait_for(environment.exec(command=STOP_COMMAND), timeout=self._stop_timeout_sec)
            except BaseException:  # noqa: BLE001 — best effort; the cancellation must propagate
                pass
            raise

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        path = self.logs_dir / RESULT_FILENAME
        if not path.exists():
            return
        try:
            result = json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            return
        for field, value in context_from_result(result).items():
            setattr(context, field, value)
