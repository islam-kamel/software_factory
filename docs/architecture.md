# Software Factory — Architecture Guide

This document explains the **structure** of the Software Factory. It is designed to be simple for beginners, safe for existing projects, and **100% free from Vendor Lock-in**.

---

## 1. Core Principles

Before looking at folders, keep these 4 simple rules in mind:

1. **Small, Focused Roles:** One AI does not do everything. We split the work into **Planner**, **Builder**, and **Reviewer**. Each role starts with a fresh, clean memory (context).
2. **Real Tools Check the Code:** Never trust an AI when it says _"I fixed it."_ Always run real commands (lint, typecheck, tests, build) to prove the code works.
3. **Safe Isolation:** Managed Phase 2 runs create an isolated `ai/` linked worktree outside the repository, enforce protected-file diff checks, and open **Draft PRs** only (while the legacy Phase 1 API still accepts a caller-provided worktree). Linux child processes run in Bubblewrap (`bwrap`) with scoped repository access.
4. **Zero Vendor Lock-in:** The core uses swappable adapters for trackers (Local Markdown, GitHub), CLI runners (OpenCode, Agy, Codex), Git hosting (GitHub Draft PR delivery), and notifiers (Console, Telegram).

---

## 2. Complete Folder Structure

Here is the expanded version of your folder tree. Every folder has one clear job:

```text
software_factory/
├── config/                             # Settings files (change tools here, not in code)
│   ├── factory.yaml                    # Global limits (max retries, active adapters)
│   ├── models.yaml                     # Assigns which AI model runs each role
│   ├── repos.example.yaml              # Committed template for connecting existing projects
│   ├── repos.yaml                      # Your local project registry (gitignored for privacy)
│   ├── runtime-profile.example.yaml    # Operator-owned Linux bwrap allowlist template
│   ├── runtime-profile.yaml            # Local Linux bwrap mount/command closure (gitignored)
│   └── contexts/                       # Optional external AGENTS.md / extra rules for client repos
│
├── src/
│   ├── agents/                         # AI roles and prompt instructions
│   │   ├── planner/                    # prompt.md + role.yaml (read-only)
│   │   ├── builder/                    # prompt.md + role.yaml (read-write)
│   │   ├── reviewer/                   # prompt.md + role.yaml (read-only)
│   │   ├── run.sh                      # Shell entry point delegating to run_agent.ts
│   │   └── run_agent.ts                # Resolves role/repo config, runs CLI inside bwrap, writes AgentResult
│   │
│   ├── engine/                         # Host Orchestration Layer (Trusted Zone)
│   │   ├── config_loader.ts            # Loads & merges factory, models, and repo configs
│   │   ├── config_schemas.ts           # Zod validation schemas for configs
│   │   ├── contracts.ts                # Standard Ticket, AgentResult, and VerificationResult contracts
│   │   ├── privacy_guard.ts            # Fail-closed check for privacy.allow_cloud_llm
│   │   ├── context_builder.ts          # Collects AGENTS.md + Ticket + Plan + Diff
│   │   ├── orchestrator.ts             # Exports legacy Phase 1 & managed Phase 2 APIs
│   │   ├── automation.ts               # Managed Phase 2 lifecycle (planManagedTicket, resumeManagedTicket)
│   │   ├── automation_delivery.ts      # Draft PR delivery, receipt persistence & tracker reconciliation
│   │   ├── automation_state.ts         # Managed run state & receipt schemas
│   │   ├── state_manager.ts            # Local atomic ticket claims & strict state transitions
│   │   └── workspace.ts                # Managed git worktree creation, ownership proof & safe cleanup
│   │
│   ├── self_healing/                   # Deterministic Quality Gate
│   │   ├── verifier.ts                 # Ordered checks (secret_scan -> lint -> typecheck -> test) + protected-file diff gate
│   │   ├── error_parser.ts             # Trims noisy terminal logs into bounded failure summaries
│   │   └── retry_loop.ts               # Caps verification attempts (default 3 total) with circuit breaker
│   │
│   └── adapters/                       # Anti-Vendor-Lock-in Layer (Swappable Plugins)
│       ├── cli_runner/                 # opencode.ts, agy.ts, codex.ts, sandbox.ts (bwrap),
│       │                               # sandbox_git.ts, runtime_profile.ts, workspace.ts
│       ├── tracker/                    # local_md.ts, github.ts (+ future GitLab/Jira)
│       ├── git_host/                   # github.ts, delivery_git.ts, workspace.ts (ai/ push + Draft PR only)
│       ├── notifier/                   # console.ts, telegram.ts (+ future Discord/Slack)
│       └── llm/                        # [Phase 3 - Infra] egress_proxy.ts (outbound LLM gateway client)
│
├── infra/                              # [Phase 3 - Infra] Local Nginx Egress Proxy
│   ├── docker-compose.yml              # Runs outbound-only LLM proxy container
│   └── nginx.conf                      # Injects LLM API keys & enforces allow_cloud_llm routing
│
├── templates/
│   └── AGENTS.template.md              # Starter project guide for existing repos
│
└── logs/                               # Run history, error logs, and cost tracking
```

> **Tip for Beginners:** You can write the files inside `engine/`, `self_healing/`, and `adapters/` using **Bash**, **Node.js (TypeScript)**, or **Python**. Because they talk through simple files and JSON, the design stays the same no matter which language you prefer.

---

## 3. High-Level Architecture Diagram

This diagram shows how the **Core Factory** stays completely separate from **External Tools** by sitting behind the **Adapters Layer**.

```mermaid
flowchart TB
    subgraph External["External Tools (Easy to Swap Anytime)"]
        T["Issue Trackers<br/>(GitHub / GitLab / Jira / Local Files)"]
        L["AI Providers & CLIs<br/>(OpenCode / Agy / Codex)"]
        N["Notifications<br/>(Telegram / Discord / Comments)"]
        G["Git Hosting<br/>(GitHub / GitLab / Local Git)"]
    end

    subgraph Adapters["src/adapters/ (Translation Layer)"]
        AT["Tracker Adapter"]
        AL["LLM & CLI Runner Adapter"]
        AN["Notifier Adapter"]
        AG["Git Host Adapter"]
    end

    subgraph Core["Core Factory (100% Vendor-Neutral)"]
        ENG["src/engine/<br/>Orchestrator, State, Workspace, Context"]
        AGT["src/agents/<br/>Planner, Builder, Reviewer + run.sh"]
        SH["src/self_healing/<br/>Verifier, Error Parser, Retry Loop"]
    end

    subgraph Repos["Your Existing Projects (Isolated)"]
        WT1["Git Worktree #1<br/>(Task A)"]
        WT2["Git Worktree #2<br/>(Task B)"]
    end

    T <--> AT
    L <--> AL
    N <--> AN
    G <--> AG

    AT <--> ENG
    AN <--> ENG
    AG <--> ENG

    ENG --> AGT
    AGT <--> AL
    ENG <--> SH
    SH --> AGT

    ENG --> WT1
    ENG --> WT2
    SH --> WT1
    SH --> WT2
```

### 3.1 Implemented `bwrap` & Phase 2 Architecture + Phase 3 Infra Roadmap

This diagram maps the **actual `src/` modules** after Phase 2 alongside planned Phase 3 network and egress hardening:

- **Green (`Done — Phase 0/1/2`):** Implemented and covered by automated unit/integration tests today.
- **Orange (`Phase 3 Hardening`):** Implemented modules scheduled for `--unshare-net` offline isolation and raw API key removal from sandbox env.
- **Blue dashed (`Planned — Phase 3 Infra`):** Outbound Nginx Egress Proxy and adapter.

```mermaid
---
config:
  layout: dagre
---
flowchart TB
    subgraph SRC["src/ — Implemented Phase 2 Automation & Phase 3 Infra Roadmap"]
        subgraph ENG["src/engine/ (Host - Trusted Zone)"]
            E_CFG["config_loader.ts, config_schemas.ts,<br/>privacy_guard.ts, contracts.ts [Done]"]
            E_CTX["context_builder.ts [Done]"]
            E_ORCH["orchestrator.ts + automation.ts<br/>automation_delivery.ts + automation_state.ts [Done]"]
            E_WS["workspace.ts<br/>Managed worktree creation & verified cleanup [Done]"]
            E_STATE["state_manager.ts<br/>Local atomic claims & state machine [Done]"]
        end

        subgraph SH["src/self_healing/ (Quality Gate)"]
            S_VER["verifier.ts (checks + protected-file diff gate)<br/>[Phase 3] Add offline: true (--unshare-net)"]
            S_PARSE["error_parser.ts [Done]"]
            S_LOOP["retry_loop.ts (default 3 total attempts) [Done]"]
        end

        subgraph ADP["src/adapters/ (Vendor-Neutral)"]
            A_CLI["cli_runner/ (agy, codex, opencode,<br/>runtime_profile, sandbox_git, workspace) [Done]"]
            A_SBX["cli_runner/sandbox.ts (Linux bwrap)<br/>[Phase 3] Add --unshare-net & drop raw API keys from env"]
            A_TRK["tracker/ (local_md.ts, github.ts) [Done]"]
            A_GIT["git_host/ (github.ts, delivery_git.ts, workspace.ts)<br/>Push ai/ branch, Draft PR & receipt recovery [Done]"]
            A_NOTIF["notifier/ (console.ts, telegram.ts) [Done]"]
            A_EGRESS["llm/egress_proxy.ts + infra/nginx.conf<br/>[Phase 3 - Infra] Inject LLM keys & enforce allow_cloud_llm"]
        end

        subgraph AGT["src/agents/"]
            G_RUN["run.sh, run_agent.ts &<br/>planner/builder/reviewer (prompt.md, role.yaml) [Done]"]
        end
    end

    E_CFG & E_CTX --> E_ORCH
    E_ORCH <--> E_STATE
    E_ORCH --> E_WS
    E_ORCH <--> A_TRK
    E_ORCH --> A_GIT & A_NOTIF

    E_ORCH --> G_RUN
    G_RUN --> A_CLI
    A_CLI --> A_SBX
    A_SBX -.->|"Outbound LLM Calls Only (No Keys in Sandbox)"| A_EGRESS

    E_ORCH <--> S_LOOP
    S_LOOP --> E_STATE
    S_LOOP --> S_VER
    S_VER -->|"offline: true (--unshare-net)"| A_SBX
    S_VER --> S_PARSE
    S_PARSE --> S_LOOP

    classDef Done fill:#E8F5E9,stroke:#2E7D32,color:#000000
    classDef Update fill:#FFF3E0,stroke:#EF6C00,stroke-width:2px,color:#000000
    classDef Next fill:#E3F2FD,stroke:#1565C0,stroke-width:2px,stroke-dasharray:5 5,color:#000000

    class E_CFG,E_CTX,E_ORCH,E_WS,E_STATE,S_PARSE,S_LOOP,A_CLI,A_TRK,A_GIT,A_NOTIF,G_RUN Done
    class S_VER,A_SBX Update
    class A_EGRESS Next
```

---

## 4. Deep Dive Into Each Module

### A. `src/agents/` (The Workers)

Instead of hardcoding prompts inside scripts, each worker lives in its own folder with clear instructions:

- **`planner/`**: Reads the ticket and project guide (`AGENTS.md`). Outputs a step-by-step `PLAN.md`. **Not allowed to edit code.**
- **`builder/`**: Reads `PLAN.md` and writes the actual code plus unit tests inside an isolated folder.
- **`reviewer/`**: Opens a brand-new session, reads `git diff`, checks for bugs or extra unnecessary code, and writes a review summary.
- **`run.sh`**: The single command the engine calls. Example:
  ```bash
  ./src/agents/run.sh --role builder --workspace /tmp/wt-42 --prompt context.md
  ```
  `run.sh` reads `config/models.yaml`, picks the right CLI adapter, runs the AI, and returns a clean exit status.

### B. `src/engine/` (The Factory Manager)

- **`orchestrator.ts` & `automation.ts` / `automation_delivery.ts` / `automation_state.ts`**: Export both the legacy Phase 1 API (`planTicket`, `resumeTicket`) and the managed Phase 2 API (`planManagedTicket`, `resumeManagedTicket`), including Draft PR delivery, delivery receipt persistence (`delivery_pending`), and idempotent tracker reconciliation.
- **`state_manager.ts`**: Enforces strict ticket state transitions and coordinates local atomic ticket claims under the configured worktree root so concurrent processes sharing that filesystem do not double-run a ticket.
- **`workspace.ts`**: Creates isolated `ai/issue-<id>` worktrees outside the repository and removes only worktrees whose ownership record, Git common directory, branch, and path still match.
- **`context_builder.ts`**: Prepares a small, focused package of text for each agent (Ticket + `AGENTS.md` + `PLAN.md` + scoped diff) so the AI does not waste tokens reading unrelated files.

### C. `src/self_healing/` (Quality Control)

- **`verifier.ts`**: Runs configured `secret_scan`, `lint`, `typecheck`, and `test` commands in order inside the Linux Bubblewrap sandbox, plus a protected-files and `privacy.ignore_paths` diff gate (`adapters/git_host/workspace.ts`) that blocks changes to `.env*`, `.github/workflows/**`, or `config/repos.yaml` before push. Phase 3 adds `--unshare-net` (`offline: true`) so verification runs without host network access.
- **`error_parser.ts`**: Strips terminal noise while retaining useful failure diagnostics in a bounded summary for repair prompts.
- **`retry_loop.ts`**: Runs at most `limits.max_self_heal_retries` total verification attempts (default `3`, allowing up to two repair Builder runs) before tripping the circuit breaker and marking `ai_failed`.

### D. `src/adapters/` (How We Avoid Vendor Lock-in)

Think of adapters like a **wall power socket and travel plugs**:

- Your **Core Factory** is the wall socket. It only speaks one simple internal language (Standard Interfaces).
- Each **Adapter** is a small plug that translates between the factory and a specific service.

```mermaid
flowchart LR
    Core["Core Engine<br/>Calls: tracker.getReadyTickets()"] --> Interface{{"Standard Tracker<br/>Interface"}}

    Interface --> GH["github_adapter<br/>Uses: gh issue list"]
    Interface --> GL["gitlab_adapter<br/>Uses: glab issue list"]
    Interface --> MD["local_md_adapter<br/>Reads: ./tickets/*.md"]
```

If tomorrow you move from **GitHub** to **GitLab**, or from **OpenRouter** to a **local Ollama model**, you do **not** touch `engine/`, `agents/`, or `self_healing/`. You only change one setting in `config/`.

---

## 5. Configuration-Driven Switching (Zero Code Changes)

To prove there is no vendor lock-in, here is how you control your tools using two simple YAML files.

### `config/factory.yaml`

Choose which external services are active right now:

```yaml
adapters:
  tracker: "github" # Options: github | gitlab | jira | local_md
  git_host: "github" # Options: github | gitlab | local_git
  cli_runner: "opencode" # Options: opencode | agy | codex
  notifier: "telegram" # Options: telegram | discord | slack | console

limits:
  max_self_heal_retries: 3
  max_parallel_tasks: 2
  agent_timeout_minutes: 15
```

### `config/models.yaml`

Mix cheap and smart models across different providers for each role:

```yaml
roles:
  planner:
    provider: "openrouter"
    model: "anthropic/claude-sonnet" # Strong reasoning for planning
  builder:
    provider: "opencode_go"
    model: "deepseek-v4-flash" # Fast and cheap for coding loops
  reviewer:
    provider: "ollama"
    model: "qwen3-coder:32b" # Free local model for diff review
```

---

## 6. Connecting Existing (Brownfield) Projects

You do **not** need to copy the factory into every project. Keep the factory in one place, copy [`config/repos.example.yaml`](../config/repos.example.yaml) to `config/repos.yaml` (gitignored so local paths and client repos stay private), and configure your repositories there.

### Structure of `config/repos.yaml`

- **`defaults` & per-repo `overrides`:** Define shared rules once (labels, `ai/` branch prefix, Draft PR settings, retry limits, default models, notifications, and baseline privacy settings), and override only what differs for a specific client or confidential repo.
- **`tracker` (`token_env` + `allowed_approvers`):** Reference only the environment variable name for each repo's token (never raw secrets), and restrict `/approve` to trusted maintainers.
- **`verification`:** Register deterministic checks (`secret_scan`, `lint`, `typecheck`, `test`) that run in order alongside the protected-file diff gate before push.
- **`privacy`:** Classify each repo (`public` | `internal` | `confidential`), define `ignore_paths` (e.g., `.env*`, `certs/**`), and set `allow_cloud_llm: false` on confidential projects so the Engine fails closed if a cloud provider is configured.

### Context Layering (`AGENTS.md` Handling)

Not every existing repository is the same, so `context.mode` supports three modes:

1. **`repo_only`:** Uses the repository's existing `AGENTS.md` directly (zero duplicate maintenance).
2. **`merge`:** Combines the repository's `AGENTS.md` with a factory-side `factory_extra` file (e.g., `./config/contexts/global-factory-rules.md`) without modifying the team's file. **Precedence rule:** factory rules win on security and workflow; the repo's `AGENTS.md` wins on code style and architecture.
3. **`factory_only`:** Uses only a context file stored inside `./config/contexts/` so **zero files** are added to a client's repository (Zero Footprint).

The context builder includes the selected root instruction file inline once, and runners disable project instruction auto-loading. Additional repository instruction files are passed as safe relative path pointers. Ignored paths are never read. `factory_only` requires readable factory context and fails closed otherwise.

### Linux Runtime Boundary

Production execution targets Linux and requires Bubblewrap (`bwrap`) with user namespaces and an operator-owned `config/runtime-profile.yaml` outside the worktree and scratch directory. The sandbox uses an empty controlled root, explicit file mounts and selected package-directory mounts, a fresh `/home/factory`, and a scratch area. It does not inherit host `HOME`, Git global/system configuration, or hooks. Git metadata is available only when there are no `privacy.ignore_paths` and no blocked paths inside the workspace; protected runs receive no repository Git metadata, and the Engine supplies context and diff. The unprotected exception exposes only a scratch Git snapshot and read-only objects, refs, and packed refs. Native cached-login behavior is not verified. Isolation does not guarantee secrecy from a privileged host administrator or unrelated host processes. Managed Phase 2 runs create and clean up isolated `ai/` worktrees automatically; legacy Phase 1 calls accept a caller-provided worktree. See the [runtime profile setup](../INTEGRATION_GUIDE.md#required-linux-runtime-profile).

**Planned Phase 3 Security Hardening (Network & Egress Boundary):**

- **Offline Verification (`--unshare-net`):** Current `bwrap` runs do not yet unshare the network namespace. Adding an `offline: true` mode in `src/adapters/cli_runner/sandbox.ts` for `src/self_healing/verifier.ts` will disable all network access during `secret_scan`, `lint`, `typecheck`, and `test`.
- **Outbound LLM Egress Proxy (`Nginx`):** Currently `sandbox.ts` forwards selected provider API keys (`GOOGLE_API_KEY`, `OPENAI_API_KEY`, `OPENCODE_API_KEY`) into the sandbox environment. Routing outbound LLM calls through a local outbound-only `Nginx` Egress Proxy (`infra/nginx.conf` + `src/adapters/llm/egress_proxy.ts`) keeps real API keys out of agent sandboxes, applies rate limits, and enforces `privacy.allow_cloud_llm: false` at the network boundary (allowing only local providers such as Ollama for confidential repositories).

### Trackers, Delivery, and Artifacts

The Local Markdown tracker uses ticket frontmatter for a human-managed offline approval. The GitHub adapter trusts the authenticated comment author's account, requires an exact `/approve`, checks the configured allowlist, and binds approval to the latest published plan. Plans, prompts, reports, delivery receipts, and run metadata are stored outside the repository. Managed Phase 2 runs (`planManagedTicket` / `resumeManagedTicket`) automate worktree lifecycle, local atomic claims, up to 3 total verification attempts, Draft PR creation (with `delivery_pending` and receipt recovery), and Console/Telegram notifications; live GitHub and Telegram acceptance remains a separate operational verification step.
