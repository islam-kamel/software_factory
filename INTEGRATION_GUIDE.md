# Integration Guide — Software Factory

This step-by-step guide walks you through setting up **Software Factory** and connecting it safely to your personal, team, or confidential client repositories.

---

## 1. Prerequisites

Before connecting a repository, make sure you have:

- **Git 2.20+** (with `git worktree` support)
- **At least one CLI coding agent** installed locally (e.g., `opencode`, `aider`, `claude`, `codex`, or `copilot-cli`)
- **Tracker/Git host credentials** (e.g., a GitHub Personal Access Token or `gh` CLI authenticated)
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
- `adapters.cli_runner`: `opencode` | `aider` | `claude_code` | `codex` | `copilot-cli`
- `adapters.notifier`: `telegram` | `discord` | `slack` | `console` | `none`

Keep `security.require_human_approval: true`, `security.require_secret_scan: true`, and `security.fail_closed_on_cloud_violation: true` enabled.

### Step 3: Assign Role Models (`config/models.yaml`)
Open [config/models.yaml](config/models.yaml) to configure which provider and model handles each role:

- **Planner:** Strong reasoning model (e.g., `anthropic/claude-sonnet` via OpenRouter)
- **Builder:** Fast, cost-effective coding model (e.g., `glm-5.3` via OpenCode Go)
- **Reviewer:** High-precision audit model (e.g., `anthropic/claude-opus` or a local `ollama-local` model)

Each provider declares `is_local: true | false` so the engine can enforce `privacy.allow_cloud_llm: false` automatically.

### Step 4: Review Global Factory Rules
Check [config/contexts/global-factory-rules.md](config/contexts/global-factory-rules.md). These rules enforce role boundaries, `ai/` Draft PRs, secret hygiene, and minimal diffs across all managed repositories.

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

| Scenario | `context.mode` | How It Works |
| :--- | :--- | :--- |
| Repo already has a complete `AGENTS.md` | `repo_only` | Uses the repo's `AGENTS.md` directly (zero duplicate maintenance) |
| Team repo has `AGENTS.md` + you want extra factory guardrails | `merge` | Combines repo `AGENTS.md` with `factory_extra` without editing the team's file |
| Client or legacy repo has no `AGENTS.md` (Zero Footprint) | `factory_only` | Uses only a file under `./config/contexts/` so nothing is added to the client repo |

**Precedence Rule (in `merge` mode):** Factory rules win on **security, privacy, and Git workflow**; the repository's `AGENTS.md` wins on **code style, tech stack, and architecture**.

### Step 3: Configure Tracker, Approvers & Verification
Inside your repo entry in `config/repos.yaml`:

```yaml
tracker:
  provider: "github"
  repo: "your-org/your-repo"
  token_env: "GITHUB_TOKEN"          # Env var name only — never the raw token
  allowed_approvers:
    - "your-username"                # Only listed users can trigger /approve

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

### Step 6: Create Ticket State Labels
Create these 7 labels in your issue tracker so `state_manager` can lock tickets and track progress:

`ai-ready` · `ai-planning` · `needs-approval` · `ai-approved` · `ai-building` · `ai-pr-ready` · `ai-failed`

---

## 4. Choosing a Deployment Mode

### Mode A: Local Polling Runner (Recommended for Client Repos)
Run the factory locally on your machine or VPS. It polls your configured trackers, spins up isolated `git worktree` checkouts in `/tmp/ai-factory/worktrees`, and leaves **zero factory files** inside target repositories.

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
4. **Automated build, verify, and review:** The factory creates an isolated `git worktree` on `ai/issue-<id>`, implements the plan + unit tests, runs the Self-Healing Loop (up to `max_retries`), and runs a fresh-context Reviewer.
5. **Inspect and merge the Draft PR:** When notified (`ai-pr-ready`), review the Draft PR diff and verification report, then mark ready and merge—or close it safely with zero risk to `main`.

---

## 6. Troubleshooting & Guardrails

- **Ticket marked `ai-failed`:** The self-healing circuit breaker tripped after `max_retries` (default `3`). Check the summary in `./logs/` or the ticket comment, clarify the ticket or fix the underlying environment issue, and re-apply `ai-ready`.
- **Engine refuses to start on a confidential repo:** Verify `privacy.allow_cloud_llm: false` is paired only with providers marked `is_local: true` in `config/models.yaml` (fail-closed behavior).
- **Secret scan failure:** A secret or credential pattern was detected by `verification.secret_scan`. Remove the secret from the diff/test fixture before re-running.
- **Avoid duplicate `AGENTS.md` tokens:** CLI agents like OpenCode, Claude Code, and Codex auto-load root `AGENTS.md`. Keep `context_builder` injecting only `factory_extra` (and path pointers for non-root context files) rather than duplicating root `AGENTS.md` inside the prompt.
