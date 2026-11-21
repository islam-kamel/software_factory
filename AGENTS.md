# AGENTS.md — Software Factory

This file defines the development rules, workflow, and code style for **Software Factory**. Every AI agent (Planner, Builder, Reviewer) and human contributor must follow these rules.

For architectural details and data contracts, refer to [docs/architecture.md](docs/architecture.md) and [docs/system_design.md](docs/system_design.md).

---

## Tech Stack

- **Purpose:** A vendor-neutral, Git-worktree-isolated AI Software Factory that turns scoped tickets into verified Draft Pull Requests across existing (brownfield) and new repositories through swappable adapters.
- **Language / Runtime:** TypeScript 7.0 / Node.js v26.13.1 / Shell (Bash)
- **Framework & Key Libraries:** Lightweight CLI/engine architecture (no heavy web framework); `yaml@2.9.1` (YAML config parsing), `zod@4.6.7` (runtime schema validation for configs and JSON contracts), `vitest@5.1.1` (unit & integration tests), `eslint@10.15.0` + `prettier@3.10.1` (linting & formatting), `gitleaks` (pre-push secret scanning), `vite@8.3.7` (complier)
- **Package Manager:** Yarn

---

## 1. Repository Map

```text
config/             # YAML settings (factory.yaml, models.yaml, repos.example.yaml, gitignored repos.yaml, contexts/)
src/agents/         # Role prompts (planner, builder, reviewer) and single entry point run.sh
src/engine/         # Core orchestration (orchestrator, state_manager, workspace, context_builder)
src/self_healing/   # Quality gate (verifier, error_parser, retry_loop)
src/adapters/       # Swappable external integrations (llm, cli_runner, tracker, git_host, notifier)
templates/          # Starter templates (e.g., AGENTS.template.md for target repos)
docs/               # Architecture and system design specifications
logs/               # Runtime logs and cost/run history (never commit sensitive output)
```

---

## 2. Core Development Rules

1. **Zero Vendor Lock-In:** Never call external CLIs or SDKs (`gh`, `glab`, OpenRouter, Ollama, Telegram, etc.) directly inside `src/engine/`, `src/agents/`, or `src/self_healing/`. All external integrations must live in `src/adapters/` behind a standard interface and be selected via `config/factory.yaml` or `config/models.yaml`.
2. **Respect Standard Data Contracts:** Modules communicate through simple files and the standard JSON schemas defined in `docs/system_design.md` (`Ticket`, `AgentResult`, `VerificationResult`). Do not invent ad-hoc output formats.
3. **Strict Role Separation:**
   - **Planner:** Read-only. Produces `PLAN.md`. Never edits source files.
   - **Builder:** Writes code and unit tests inside an isolated worktree.
   - **Reviewer:** Fresh session, read-only. Reviews `git diff` against the ticket and `PLAN.md`.
4. **Safe Git Isolation:** Never edit, commit, or push directly to `main` or `develop`. Always work in an isolated `git worktree` on a branch prefixed with `ai/` (e.g., `ai/issue-42`) and open **Draft PRs** only.
5. **Real Verification Over Assumptions:** Never claim code works without running the configured verification command (lint, typecheck, tests, build).
6. **Hard Circuit Breakers:** Enforce `max_self_heal_retries` (default: `3`) and `agent_timeout_minutes` (default: `15`). On hitting the limit, stop immediately, save logs, mark state `ai_failed`, and notify the developer.
7. **Secret Isolation & Fail-Closed Privacy:** Never commit API keys, tokens, `.env` files, or `config/repos.yaml` (commit `config/repos.example.yaml` instead and reference secrets via `token_env`). Enforce `privacy.allow_cloud_llm: false` fail-closed and run `verification.secret_scan` before pushing.
8. **Minimal, Scoped Diffs:** Change only what the ticket requires. Do not reformat unrelated files or refactor untouched modules.

### Protected Files (Do Not Touch Without Explicit Approval)
- `.env`, `.env.*.local`
- `config/repos.yaml` (local private registry; update `config/repos.example.yaml` for schema changes)
- `.github/workflows/*`
- `docs/architecture.md` and `docs/system_design.md` (unless the ticket specifically updates documentation)

---

## 3. Development Workflow

Follow this exact lifecycle for every task:

1. **Lock Ticket (`ai_ready` -> `ai_planning`):** Update ticket state first so no second worker picks up the same task.
2. **Plan (`PLAN.md` -> `needs_approval`):** Read the ticket and `AGENTS.md`. Produce a concise step-by-step plan listing target files, edge cases, and test cases. Wait for human `/approve` before writing code.
3. **Isolate (`ai_approved` -> `ai_building`):** Create a clean `git worktree` and branch (`ai/issue-<id>`) from the configured `base_branch`.
4. **Implement & Test:** Follow `PLAN.md`, write clean modular code, and add unit tests covering every acceptance criterion.
5. **Verify & Self-Heal (`verifying`):**
   - Run the project's `verify_command`.
   - If it fails, trim logs with `error_parser` and feed only the failing summary back to Builder.
   - Retry up to `3` times. If it still fails, trip the circuit breaker (`ai_failed`) and alert the developer.
6. **Review (`ai_reviewing`):** Run Reviewer in a fresh context against `git diff` and the ticket's acceptance criteria.
7. **Deliver & Clean Up (`ai_pr_ready`):** Open a **Draft PR** with a summary and verification results, notify the developer, and remove the temporary `git worktree`.

### Branch & Commit Conventions
- **Branches:** `ai/issue-<id>` for automated runs; `feat/<slug>`, `fix/<slug>`, or `chore/<slug>` for manual work.
- **Commits:** Use [Conventional Commits](https://www.conventionalcommits.org/):
  - `feat(adapters): add local markdown tracker adapter`
  - `fix(self_healing): cap retry loop at configured max_retries`
  - `docs: add AGENTS.md development rules and style guide`

---

## 4. Code Style & Simple Examples (Wrong vs. Right)

Core modules may be written in **Bash**, **TypeScript (Node.js)**, or **Python**. Regardless of language, keep functions small, explicit, typed/validated, and easy to test.

### 4.1 Zero Vendor Lock-In (Use Adapters, Not Direct Calls)

**Wrong (`❌`)** — Hardcoding GitHub CLI directly inside the core engine:
```bash
# src/engine/orchestrator.sh
issues=$(gh issue list --label "ai-ready" --json number,title)
```

**Right (`✅`)** — Delegating through the configured adapter interface:
```bash
# src/engine/orchestrator.sh
tracker_adapter="src/adapters/tracker/${TRACKER_ADAPTER}.sh"
issues=$("${tracker_adapter}" get_ready_tickets)
```

---

### 4.2 Safe Shell Scripts (`run.sh` and Bash Modules)

**Wrong (`❌`)** — Missing strict mode, unquoted variables, and silent failures:
```bash
#!/bin/bash
cd $WORKSPACE
./run_tool.sh $PROMPT_FILE
```

**Right (`✅`)** — Strict mode, validated inputs, and quoted variables:
```bash
#!/usr/bin/env bash
set -euo pipefail

workspace="${1:?workspace path is required}"
prompt_file="${2:?prompt file is required}"

cd "${workspace}"
./run_tool.sh "${prompt_file}"
```

---

### 4.3 Configuration & Secrets Handling

**Wrong (`❌`)** — Hardcoding provider, model, and API key in source code:
```python
API_KEY = "sk-or-v1-hardcoded-secret"
MODEL = "anthropic/claude-sonnet"
```

**Right (`✅`)** — Reading secrets from environment variables and models from `config/models.yaml`:
```python
import os

api_key = os.environ.get("OPENROUTER_API_KEY")
if not api_key:
    raise RuntimeError("Missing required env var: OPENROUTER_API_KEY")

role_config = load_role_config("config/models.yaml", role="planner")
model = role_config["model"]
```

---

### 4.4 Standard JSON Contracts & Clean Error Parsing

**Wrong (`❌`)** — Returning raw, noisy multi-thousand-line terminal output:
```python
def run_verifier(cmd: str) -> str:
    return run_shell(cmd).stdout  # 2,000+ lines of noise
```

**Right (`✅`)** — Returning the standard `VerificationResult` contract with a focused summary:
```python
def run_verifier(cmd: str, attempt: int) -> dict:
    result = run_shell(cmd)
    return {
        "passed": result.returncode == 0,
        "attempt": attempt,
        "failed_step": "unit_tests" if result.returncode != 0 else None,
        "summary": parse_error_summary(result.stderr or result.stdout),
    }
```

---

### 4.5 Guard Clauses Over Deep Nesting

**Wrong (`❌`)** — Deeply nested conditionals that obscure the happy path:
```typescript
function canRetry(ticket: Ticket, attempt: number, maxRetries: number): boolean {
  if (ticket.state === "verifying") {
    if (attempt < maxRetries) {
      if (!ticket.lockedByHuman) {
        return true;
      }
    }
  }
  return false;
}
```

**Right (`✅`)** — Flat guard clauses with early returns:
```typescript
function canRetry(ticket: Ticket, attempt: number, maxRetries: number): boolean {
  if (ticket.state !== "verifying") return false;
  if (ticket.lockedByHuman) return false;
  return attempt < maxRetries;
}
```

---

### 4.6 Import Aliases (`@/` -> `src/`)

Always use the `@/` path alias mapped to `src/` for cross-module imports in TypeScript instead of deep relative paths (`../../`). Relative imports (`./`) are only allowed for sibling files within the same folder.

**Wrong (`❌`)** — Deep relative paths across modules:
```typescript
import { loadConfig } from "../../engine/config_loader";
import { parseErrorSummary } from "../../self_healing/error_parser";
```

**Right (`✅`)** — Clean `@/` alias mapped to `src/`:
```typescript
import { loadConfig } from "@/engine/config_loader";
import { parseErrorSummary } from "@/self_healing/error_parser";
```

---

### 4.7 Naming & Modularity

- **Files & Folders:** `snake_case` for shell/Python modules (`error_parser.py`, `state_manager.sh`) and YAML config keys (`max_self_heal_retries`).
- **Functions:** Verb-first, single responsibility (`lock_ticket`, `create_worktree`, `parse_error_summary`).
- **Constants:** `UPPER_SNAKE_CASE` (`MAX_RETRIES`, `DEFAULT_TIMEOUT_MINUTES`).
- **Comments:** Explain *why* a guardrail or constraint exists, not *what* obvious syntax does.

---

## 5. Documentation Rules & Patterns

Keep documentation accurate, beginner-friendly, and strictly in sync with code and config changes.

### 5.1 Documentation Sync Matrix (When to Update Docs)

| When You Change... | Also Update... |
| :--- | :--- |
| `config/factory.yaml`, `config/models.yaml`, or `config/repos.example.yaml` | `INTEGRATION_GUIDE.md`, `README.md`, and `.env.example` (if new env vars are added) |
| New agent role (`src/agents/<role>/`) or adapter (`src/adapters/*`) | `docs/architecture.md`, `CONTRIBUTING.md`, and `README.md` |
| Data contracts, state machine, or security guardrails | `docs/system_design.md` and `AGENTS.md` |
| Phase milestones completed or scope adjusted | `docs/implementation_plan.md` |

### 5.2 Writing Patterns

1. **Single Source of Truth:** Link to canonical specs (`docs/system_design.md`, `config/repos.example.yaml`) rather than copy-pasting full schemas across multiple Markdown files.
2. **Relative Links Only:** Always use repository-relative Markdown links (`[docs/architecture.md](docs/architecture.md)`), never machine-specific paths (`/Users/...` or `/Volumes/...`).
3. **Zero Real Secrets or Private Paths:** Use neutral placeholders (`your-username`, `/path/to/projects/...`, `token_env: "GITHUB_TOKEN"`) in all examples and templates.
4. **Scannable Structure:** Use short sections, Markdown tables for comparisons, fenced code blocks with language tags (`yaml`, `bash`, `json`, `mermaid`), and **Mermaid** diagrams for architecture or execution flows.
5. **Preserve Protected Docs Rule:** Do not rewrite `docs/architecture.md` or `docs/system_design.md` during routine feature tickets unless the ticket and approved `PLAN.md` explicitly include a documentation update.

### 5.3 Documentation Example (Wrong vs. Right)

**Wrong (`❌`)** — Hardcoded local path, raw token, and duplicated schema with no link:
```markdown
Edit `/Users/islam/dev/software_factory/config/repos.yaml` and add `token: "ghp_12345"`.
(Also pastes a 60-line copy of the entire Ticket JSON contract inside README.md)
```

**Right (`✅`)** — Relative link, placeholder path, `token_env`, and single source of truth:
```markdown
Copy [config/repos.example.yaml](config/repos.example.yaml) to `config/repos.yaml`,
set `local_path: "/path/to/projects/my-app"`, and reference your token via `token_env: "GITHUB_TOKEN"`.
See [docs/system_design.md](docs/system_design.md) for the standard `Ticket` JSON schema.
```

---

## 6. Pre-PR Verification Checklist

Before marking a task `ai_pr_ready`, confirm:

- [ ] Changes stay strictly within the approved `PLAN.md` scope and touch no protected files.
- [ ] No external vendor logic leaked into `src/engine/`, `src/agents/`, or `src/self_healing/`.
- [ ] All secrets come from environment variables; nothing sensitive is committed or logged.
- [ ] Unit tests cover new behavior and edge cases.
- [ ] Related docs and `.env.example` are updated per Section 5.1 (using relative links and zero real secrets).
- [ ] Project verification checks (lint, typecheck, tests, build) pass with zero errors.
- [ ] Work is on an `ai/` (or feature/fix) branch and opened as a **Draft PR**, with the temporary worktree cleaned up.
