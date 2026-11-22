#!/usr/bin/env bash
# ============================================================
# run.sh
# Purpose : Launch one configured agent from the factory root
# Feature : Agent execution
# Role    : CLI Entry Point
# API Doc : docs/implementation_plan.md, Phase 1
# ============================================================
set -euo pipefail

factory_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${factory_root}"
exec node --input-type=module -e '
const { runAgentCli } = await import("./dist/run_agent.js");
process.exitCode = await runAgentCli(process.argv.slice(1));
' -- "$@"
