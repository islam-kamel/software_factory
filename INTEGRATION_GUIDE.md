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
not configure native CLI cached authentication. On Linux, authenticate Agy with `agy acp --login`, then add
these two exact read-only file mounts to the existing profile. Use paths under the authenticated account's
Agy home; never mount the whole home directory or put auth values in YAML.

```yaml
mounts:
  - source: /path/to/agy-home/.gemini/antigravity-cli/antigravity-oauth-token
    target: /home/factory/.gemini/antigravity-cli/antigravity-oauth-token
  - source: /path/to/agy-home/.gemini/antigravity-cli/cache/acp-auth-state.json
    target: /home/factory/.gemini/antigravity-cli/cache/acp-auth-state.json
```

The file-backed login was verified with Agy 1.5.14 in the profile-backed Linux lifecycle below. The files must
be canonical regular files outside the repository and scratch directories. This does not verify SecretService,
keyring, other CLI versions, or persistent credential refresh. Only selected provider API-key variables and
OpenCode flags are passed through.

Git metadata is mounted only when `privacy.ignore_paths` is empty and no configured blocked path resolves
inside the workspace. Protected runs receive no Git metadata, so repository-aware Git commands cannot read
repository state; the Engine supplies scoped context and diff instead. Unprotected runs get only a scratch Git snapshot and
read-only objects, refs, and packed refs. Repository config, hooks, alternates, and other worktree metadata
are not exposed. Do not mount broad system directories or assume host configuration is visible.
Profile-backed Linux sandbox checks and a complete real Agy lifecycle passed on Debian 13 ARM64 with Node.js
26.13.1 and Bubblewrap 0.12. The lifecycle used a synthetic repository and hash-bound synthetic local approval;
it did not create a PR or test a real operator's approval flow. Codex and OpenCode were not live-tested.

### Approval and current Phase 1 boundary

For Local Markdown tickets, a human sets approval frontmatter after reviewing the latest `factory_plan` and matching `factory_plan_hash`; ticket author text is not authenticated identity. The live Phase 1 lifecycle exercised this path with a synthetic allowed operator. For GitHub, the tracker checks the actual comment account, exact `/approve`, the allowlist, and that approval follows the latest published plan. Prompts, plans, reports, and run metadata are stored outside the repository.

The legacy `planTicket` and `resumeTicket` APIs keep the Phase 1 contract: the caller supplies an `ai/` linked worktree to resume, and the lifecycle ends after review. They do not create managed worktrees, use Phase 2 ticket claims, publish Draft PRs, or send Phase 2 notifications. The managed APIs below add those behaviors. The sandbox boundary is described in [Required Linux runtime profile](#required-linux-runtime-profile).

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

For GitHub tracker discovery, create the `ai-ready` label. Tracker polling is not part of the managed API; a caller invokes it with a ticket ID. Managed calls claim the ticket before planning and use configured tracker state transitions:

`ai-ready`

---

## 4. Choosing a Deployment Mode

### Mode A: Local Polling Runner (Recommended for Client Repos)

Run the factory on a supported Linux host. Legacy Phase 1 calls use a caller-provided linked `ai/` worktree. Phase 2 callers invoke the managed API with a ticket ID; tracker polling remains outside this API.

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
4. **Build, verify, and review:** With the legacy API, provide a validated `ai/` linked worktree. With the managed API, the factory creates a linked `ai/issue-<id>` worktree after it validates approval. Configured checks run in order; a failing check may invoke a repair Builder within the total attempt limit, then a fresh-context Reviewer runs.
5. **Inspect the outcome:** Legacy calls return a reviewed outcome for a separate PR workflow. Managed calls verify the reviewed diff again, create a commit on the issue branch, recheck the committed snapshot, and open a Draft PR.

## Managed Phase 2 Lifecycle

The built `dist/orchestrator.js` entry exports `planManagedTicket` and `resumeManagedTicket`. The caller supplies a resolved repository, factory config, configured `TrackerAdapter`, factory root, and a trusted external run-artifact directory. `loadConfig` is available from `dist/config_loader.js`; the tracker instance remains part of the caller's adapter setup.

Configure the global factory settings:

```yaml
adapters:
  git_host: "github"
  notifier: "console" # console | telegram | none
limits:
  max_self_heal_retries: 3 # Total verification attempts, including the first
workspace:
  use_worktree: true
  worktree_root: "/var/lib/software-factory/worktrees"
  draft_pr_only: true
```

Configure the managed repository and delivery requirements:

```yaml
base_branch: "main" # main, master, or develop is a read-only starting ref
use_worktree: true
draft_pr: true
tracker:
  provider: "local_md" # The ticket tracker may be Local Markdown or GitHub
  repo: "your-org/your-repo" # Required GitHub destination for Draft delivery
  token_env: "GITHUB_TOKEN" # Required GitHub token variable name, never a token value
verification:
  secret_scan: "gitleaks detect --source . --no-git"
```

`tracker.repo` and `tracker.token_env` are required for GitHub delivery even when the ticket tracker uses Local Markdown. The Git host must be `github`; the adapter pushes the verified commit to the configured GitHub origin and creates Draft PRs only. The plan, verification summary, and full Reviewer report are included in the PR body. Before pushing, the adapter checks that an existing PR for the branch is a Draft with the exact verified commit and report body, and rejects reports that exceed GitHub's supported body size. It refuses delivery without a configured secret-scan command and passing verification. Live GitHub delivery has not been accepted against a real repository.

`workspace.worktree_root` must be absolute and outside both the target repository and factory artifacts. The engine resolves existing symlinked ancestors and validates the canonical path before creating directories. If the GitHub create-PR request has an uncertain response, the managed call returns `delivery_pending`, keeps the active ticket claim and committed branch, and removes only its owned worktree. A later resume stops before launching agents or contacting GitHub; manual inspection and reconciliation are required before any retry. The engine does not retry an uncertain create request automatically. If the Draft PR is known to exist but updating tracker state fails, the result keeps the PR URL and returns a tracker warning without reporting the run as failed.

If the known receipt was saved and owned-worktree cleanup succeeded, a tracker read or `ai_pr_ready` update failure releases only the run's active execution while preserving its receipt and outer ticket claim. Resume using the same `runFile` reconciles `ai_reviewing` to `ai_pr_ready`, or accepts an already-ready ticket, then finishes the claim without repeating approval, agents, worktree creation, verification, commit, push, or PR creation. Any other ticket state requires manual reconciliation and is not overwritten. A live active execution stays protected; abandoned active state and crash, receipt-persistence, or cleanup uncertainty require operator inspection, with no automatic stale-claim takeover. Unknown PR creation remains `delivery_pending` and is never retried automatically.

Plan first, then wait for a human to approve the exact plan hash through the configured tracker. Persist the returned `runFile` and pass it to `resumeManagedTicket` after approval. The plan and run artifacts live under the caller's trusted external `outputDirectory`. Verifier full logs, when produced, are stored under the run's `verification-logs` directory with private permissions; repair feedback uses a bounded parsed summary. Notifications contain only the ticket ID, repository ID, state, and Draft URL when available.

The default notifier is console. Set `adapters.notifier: "telegram"` or the repository's `notifications.external.provider: "telegram"` to select Telegram; provide `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in the runtime environment. Set `adapters.notifier: "none"` to disable notifications. Setting `notifications.external.enabled: false` selects console fallback unless the global notifier is `none`. Telegram delivery has mocked tests only, not live acceptance.

Claims are filesystem-scoped to the canonical configured worktree root and coordinate processes sharing that root. They do not provide distributed multi-host locking or automatic stale-claim takeover. A crash can leave claim state behind; inspect the ticket, run artifacts, and matching worktree before operator recovery. Do not remove an active claim or force-remove a worktree without proving it belongs to the failed run.

Managed worktrees use branch `ai/issue-<id>` from the configured base ref, including protected base branches as read-only starting points. Cleanup verifies the private ownership record and linked-worktree identity before removal. If ownership cannot be proven or cleanup fails, the run retains its worktree and reports a cleanup error for inspection. Git commit delivery refuses repositories with configured Git filters because executing arbitrary filters during staging is outside the supported safety boundary; review the repository's filter setup before enabling managed delivery.

Phase 2 unit tests use synthetic local Git repositories and mocked HTTP. They do not establish live GitHub, Telegram, or complete managed Linux runtime acceptance. Phase 3 offline verification, network proxying, and sandbox resource caps remain deferred.

---

## 6. Troubleshooting & Guardrails

- **Ticket marked `ai_failed`:** The managed retry limit was reached or a hard verification gate failed. `limits.max_self_heal_retries` is the total number of verification attempts (default `3`), so there can be at most two repair Builder runs. Inspect the bounded summary and the private `verification-logs` under the external run-artifact directory; do not copy raw logs into prompts or notifications.
- **Engine refuses to start on a confidential repo:** Verify `privacy.allow_cloud_llm: false` is paired only with providers marked `is_local: true` in `config/models.yaml` (fail-closed behavior).
- **Secret scan failure:** A secret or credential pattern was detected by `verification.secret_scan`. Remove the secret from the diff/test fixture before re-running.
- **Avoid duplicate `AGENTS.md` context:** The context builder includes the selected root instruction inline once and runners disable CLI project auto-loading. Other repo instruction files are passed as safe path pointers; ignored paths are not read.
