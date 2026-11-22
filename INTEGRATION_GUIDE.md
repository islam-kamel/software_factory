# Integration Guide — Software Factory

This step-by-step guide walks you through setting up **Software Factory** and connecting it safely to your personal, team, or confidential client repositories.

---

## 1. Prerequisites

Before connecting a repository, make sure you have:

- **Git 2.20+** (with `git worktree` support)
- **Linux with Bubblewrap (`bwrap`) and working user namespaces** for isolated child processes
- **A private runtime profile** at `config/runtime-profile.yaml`; child commands run only with explicitly mounted files
- **At least one supported CLI** installed and authenticated: OpenCode, Agy, or Codex
- **A dedicated unprivileged Linux service account**; the sandbox uses a fresh `/home/factory`, not the host home
- **A GitHub token** only when using the GitHub tracker; Local Markdown supports offline use
- **Secret scanner (recommended):** `gitleaks` or `trufflehog` installed locally for `verification.secret_scan`
- **Local LLM runtime (optional):** `ollama` (for confidential/NDA repos with `allow_cloud_llm: false`)

---

## 2. One-Time Factory Setup

### Step 1: Configure Secrets (`.env`)

Copy the template and add only the credentials you need:

```bash
cp .env.example .env
```

- Store LLM keys (`OPENROUTER_API_KEY`, `OPENCODE_API_KEY`), Git tokens (`GITHUB_TOKEN` or per-client tokens like `FINTECH_GH_TOKEN`), and optional notifier tokens (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) in `.env`.
- `.env` is gitignored—never commit secrets or paste raw tokens into YAML files.

### Step 2: Select Active Adapters & Limits (`config/factory.yaml`)

Open [config/factory.yaml](config/factory.yaml) and choose your active adapters:

- `adapters.tracker`: `github` | `gitlab` | `jira` | `local_md`
- `adapters.git_host`: `github` | `gitlab` | `bitbucket` | `local_git`
- `adapters.cli_runner`: `opencode` | `agy` | `codex`
- `adapters.notifier`: `telegram` | `discord` | `slack` | `console` | `none`

Keep `security.require_human_approval: true`, `security.require_secret_scan: true`, and `security.fail_closed_on_cloud_violation: true` enabled.

### Step 3: Assign Role Models (`config/models.yaml`)

Open [config/models.yaml](config/models.yaml) to configure which provider and model handles each role:

- **Planner:** Strong reasoning model (e.g., `anthropic/claude-sonnet` via OpenRouter)
- **Builder:** Fast, cost-effective coding model (e.g., `glm-5.3` via OpenCode Go)
- **Reviewer:** High-precision audit model (e.g., `anthropic/claude-opus` or a local `ollama-local` model)

The native CLI providers `antigravity` (Agy) and `openai` (Codex) use `auth_mode: "cli"` and `is_local: false`. The sandbox does not inherit host CLI login: provide only the required auth material as explicit file mounts under its fresh home, then validate that login works inside the profile-backed runtime. Configured API-key routes receive only their selected environment variables where the runner supports them. OpenCode remains the default route. To use Agy for Planner, override its route in `config/models.yaml`:

```yaml
roles:
  planner:
    cli: "agy"
    provider: "antigravity"
    model: "your-logged-in-model"
    access: "read_only"
    temperature: 0.2
```

For Codex, set `cli: "codex"` and `provider: "openai"`. These are cloud routes and fail closed when `privacy.allow_cloud_llm: false`.

### Step 4: Review Global Factory Rules

Check [config/contexts/global-factory-rules.md](config/contexts/global-factory-rules.md). These rules enforce role boundaries, `ai/` worktree use, secret hygiene, and minimal diffs across managed repositories.

---

## 3. Connecting an Existing (Brownfield) Repository

### Step 1: Create Your Private Registry (`config/repos.yaml`)

Copy the committed example file to your local gitignored registry:

```bash
cp config/repos.example.yaml config/repos.yaml
```

Add an entry under `repos:` with a unique `id`, `local_path`, `base_branch`, and `use_worktree: true`.

### Step 2: Choose a Context Layering Mode (`context.mode`)

Pick the mode that fits your repository:

| Scenario                                                      | `context.mode` | How It Works                                                                              |
| :------------------------------------------------------------ | :------------- | :---------------------------------------------------------------------------------------- |
| Repo already has a complete `AGENTS.md`                       | `repo_only`    | Uses the repo's `AGENTS.md` directly (zero duplicate maintenance)                         |
| Team repo has `AGENTS.md` + you want extra factory guardrails | `merge`        | Includes root repo `AGENTS.md` once with `factory_extra`, without editing the team's file |
| Client or legacy repo has no `AGENTS.md` (Zero Footprint)     | `factory_only` | Uses only a file under `./config/contexts/` so nothing is added to the client repo        |

**Precedence Rule (in `merge` mode):** Factory rules take precedence for security and workflow. The selected root instruction is included inline once; runners disable CLI project auto-loading. Other instruction files are safe relative path pointers. Ignore patterns are applied before file reads.

`factory_only` requires a readable factory context file. The product targets Linux and requires Bubblewrap (`bwrap`) with user namespaces. Use a dedicated unprivileged service account. The sandbox supplies a fresh home and exposes only configured workspace paths plus explicit runtime-profile mounts; it does not guarantee secrecy from host administrators or unrelated host processes.

### Required Linux runtime profile

The sandbox has no general host-root bind. Before running agents, create the operator-owned,
gitignored `config/runtime-profile.yaml` outside the repository worktree and verifier scratch directory.
Its strict YAML shape is `version: 1`, `mounts: [{source, target}]`, and `commands: {name: mounted-file-target}`.
Use normalized absolute paths. Mount only exact executable/library files and explicitly selected code-package
directories; directory mounts are limited to selected package roots. Every command name must resolve to a
mounted file. The profile and its sources must remain outside the target worktree and scratch directory.

The sandbox creates a fresh `/home/factory` and derives `PATH` from mounted command targets. Host `HOME`,
shell startup files, Git global/system configuration, and hooks are not inherited. The example profile does
not configure native CLI cached authentication; host login is unavailable unless a specific auth file is
explicitly mounted and validated in the sandbox. Only selected provider API-key variables and OpenCode flags
are passed through.

Git metadata is mounted only when `privacy.ignore_paths` is empty and no configured blocked path resolves
inside the workspace. Protected runs receive no Git metadata, so repository-aware Git commands cannot read
repository state; the Engine supplies scoped context and diff instead. Unprotected runs get only a scratch Git snapshot and
read-only objects, refs, and packed refs. Repository config, hooks, alternates, and other worktree metadata
are not exposed. Do not mount broad system directories or assume host configuration is visible.
Runtime-profile-backed Linux acceptance remains pending; this setup does not imply a successful end-to-end run.

### Approval and current Phase 1 boundary

For Local Markdown tickets, a human sets approval frontmatter after reviewing the latest `factory_plan` and matching `factory_plan_hash`; ticket author text is not authenticated identity. For GitHub, the adapter checks the actual comment account, exact `/approve`, the allowlist, and that approval follows the latest published plan. Prompts, plans, reports, and run metadata are stored outside the repository. Phase 1 ends at review and does not create worktrees, lock tickets, retry repairs, publish PRs, or notify users. The sandbox boundary is described in [Required Linux runtime profile](#required-linux-runtime-profile).

### Step 3: Configure Tracker, Approvers & Verification

Inside your repo entry in `config/repos.yaml`:

```yaml
tracker:
  provider: "github"
  repo: "your-org/your-repo"
  token_env: "GITHUB_TOKEN" # Env var name only — never the raw token
  allowed_approvers:
    - "your-username" # Only listed users can trigger /approve

verification:
  secret_scan: "gitleaks detect --source . --no-git"
  lint: "npm run lint"
  typecheck: "npm run typecheck"
  test: "npm test"
```

### Step 4: Set Privacy & Model Overrides (Private / NDA Repos)

Match each repository's sensitivity level:

- **Standard private repo:** Use `defaults` (OpenRouter / OpenCode Go with zero-data-retention settings enabled in your provider dashboard).
- **Client / NDA repo:** Override `agents.builder` with `github-copilot` (`copilot-cli`) or a zero-retention provider, and list sensitive paths in `privacy.ignore_paths`.
- **Confidential repo (no code leaves your machine):** Set `privacy.data_classification: "confidential"`, `privacy.allow_cloud_llm: false`, and override all three roles to `ollama-local`. The engine fails closed if any cloud provider is configured.

### Step 5: Protect Your Base Branches

In GitHub/GitLab repository settings, enable **Branch Protection** on `main` and `develop`:

- Block direct pushes and force pushes.
- Require Pull Request review before merging.

### Step 6: Prepare Ticket Labels

For GitHub discovery, create the `ai-ready` label. The remaining lifecycle labels and automatic ticket locking are deferred:

`ai-ready`

---

## 4. Choosing a Deployment Mode

### Mode A: Local Polling Runner (Recommended for Client Repos)

Run the factory on a supported Linux host. Phase 1 uses a caller-provided linked `ai/` worktree; automatic worktree creation and tracker polling are deferred.

### Mode B: CI / Reusable Workflow (GitHub Actions)

If you prefer event-driven cloud execution on your own GitHub repos, add a 10-line caller workflow inside the target repo at `.github/workflows/ai-factory.yml`:

```yaml
name: Connect to AI Factory
on:
  issues:
    types: [labeled]

jobs:
  plan:
    if: github.event.label.name == 'ai-ready'
    uses: your-username/ai-factory/.github/workflows/ai-plan.yml@main
    secrets: inherit
```

---

## 5. Day-to-Day Developer Workflow

1. **Write a clear ticket:** Include a concise problem statement and bulleted **Acceptance Criteria**.
2. **Trigger planning:** Add the `ai-ready` label. The factory locks the ticket (`ai-planning`), runs the read-only Planner, posts `PLAN.md`, and sets `needs-approval`.
3. **Review and approve the plan:**
   - If the plan looks right, comment `/approve` (only users in `allowed_approvers` are accepted).
   - If changes are needed, reply with feedback and move the ticket back to `ai-planning`.
4. **Build, verify, and review:** Provide a validated `ai/` linked worktree. The factory implements the approved plan, runs configured checks in order, then launches a fresh-context Reviewer. A failed check stops the lifecycle.
5. **Inspect reviewed artifacts:** Review the external plan, verification, and reviewer artifacts before using a separate PR workflow.

---

## 6. Troubleshooting & Guardrails

- **Ticket marked `ai-failed`:** The self-healing circuit breaker tripped after `max_retries` (default `3`). Check the summary in `./logs/` or the ticket comment, clarify the ticket or fix the underlying environment issue, and re-apply `ai-ready`.
- **Engine refuses to start on a confidential repo:** Verify `privacy.allow_cloud_llm: false` is paired only with providers marked `is_local: true` in `config/models.yaml` (fail-closed behavior).
- **Secret scan failure:** A secret or credential pattern was detected by `verification.secret_scan`. Remove the secret from the diff/test fixture before re-running.
- **Avoid duplicate `AGENTS.md` context:** The context builder includes the selected root instruction inline once and runners disable CLI project auto-loading. Other repo instruction files are passed as safe path pointers; ignored paths are not read.
