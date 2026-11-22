# Contributing to Software Factory

Thank you for contributing to **Software Factory**. Every contribution—whether a new agent role, LLM provider, CLI runner, or bug fix—must preserve **Zero Vendor Lock-In**, **Safe Isolation**, and **Fail-Closed Privacy**.

Before opening a pull request, read [AGENTS.md](AGENTS.md), [docs/architecture.md](docs/architecture.md), and [docs/system_design.md](docs/system_design.md).

---

## 1. Contribution Workflow

1. **Create a scoped branch** from `main`:
   - `feat/<slug>` (new agent, adapter, or capability)
   - `fix/<slug>` (bug fix)
   - `docs/<slug>` (documentation updates)
   - `chore/<slug>` (maintenance or config templates)
2. **Keep changes minimal and tested:** Touch only what your change requires and include unit tests.
3. **Use [Conventional Commits](https://www.conventionalcommits.org/):**
   - `feat(agents): add security_auditor role prompt and config`
   - `feat(adapters): add groq llm provider adapter`
   - `fix(self_healing): trim stack trace noise in error_parser`
4. **Open a Draft PR** with a clear description, test output, and any config/doc updates. The managed Phase 2 API (`planManagedTicket` / `resumeManagedTicket`) automates Draft PR delivery through `src/adapters/git_host/` and notifications through `src/adapters/notifier/`, while the legacy Phase 1 API records a reviewed result without opening a PR.

---

## 2. How to Add a New Agent Role

Follow these 5 steps to add a new role (for example, `security_auditor` or `doc_writer`):

1. **Create the role folder** under `src/agents/<role_name>/`:
   - `src/agents/<role_name>/prompt.md` — Clear constraints, inputs, and required Markdown output format.
   - `src/agents/<role_name>/role.yaml` — Role metadata (`access: read_only | read_write`, default timeout, expected output filename).
2. **Register default model routing** in [config/models.yaml](config/models.yaml) under `roles:`:
   ```yaml
   roles:
     security_auditor:
       cli: "opencode"
       provider: "openrouter"
       model: "anthropic/claude-sonnet"
       access: "read_only"
       temperature: 0.1
   ```
3. **Ensure `src/agents/run.sh` supports the role** without hardcoding role-specific vendor logic, and always emit the standard `AgentResult` JSON contract defined in [docs/system_design.md](docs/system_design.md). Supported native CLI routes are OpenCode, Agy, and Codex; OpenCode is the default.
4. **Hook into `src/engine/orchestrator`** (only if the role runs automatically in the pipeline; keep it configurable in `config/factory.yaml`).
5. **Add tests and update docs** (`docs/architecture.md` and `README.md` if the folder tree changes).

---

## 3. How to Add a New Provider or Adapter

All external services (LLM providers, CLI runners, issue trackers, Git hosts, notifiers) live strictly under `src/adapters/`.

### Adding a New LLM Provider

1. **Register the provider** in [config/models.yaml](config/models.yaml) under `providers:`:
   ```yaml
   providers:
     groq:
       is_local: false # Required: enforces privacy.allow_cloud_llm: false
       api_key_env: "GROQ_API_KEY" # Env var name only — never a raw key
       base_url: "https://api.groq.com/openai/v1"
   ```
2. **Document the env var** in [.env.example](.env.example) with an empty value (`GROQ_API_KEY=`).
3. **Implement the adapter** under `src/adapters/llm/<provider>` (or wire it into the `cli_runner` adapter) so it returns the standard `AgentResult` JSON shape.
4. **Verify fail-closed privacy:** Confirm that when a repo sets `privacy.allow_cloud_llm: false`, the engine refuses to run any provider with `is_local: false`.

### Adding a New CLI Runner, Tracker, Git Host, or Notifier

1. Add your adapter module in the matching subfolder:
   - `src/adapters/cli_runner/`
   - `src/adapters/tracker/` (must output the standard `Ticket` JSON object)
   - `src/adapters/git_host/` (must enforce `ai/` branches and Draft PRs only)
   - `src/adapters/notifier/`
2. Document the new option in [config/factory.yaml](config/factory.yaml) and [config/repos.example.yaml](config/repos.example.yaml).
3. Add any required token env var names to [.env.example](.env.example).

---

## 4. Simple Examples (Wrong vs. Right)

### 4.1 Registering a New LLM Provider (Secrets & `is_local`)

**Wrong (`❌`)** — Hardcoding an API key and omitting `is_local`:

```yaml
# config/models.yaml
providers:
  groq:
    api_key: "gsk_live_hardcoded_secret_key"
    base_url: "https://api.groq.com/openai/v1"
```

**Right (`✅`)** — Referencing an env var and declaring `is_local` for fail-closed privacy:

```yaml
# config/models.yaml
providers:
  groq:
    is_local: false
    api_key_env: "GROQ_API_KEY"
    base_url: "https://api.groq.com/openai/v1"
```

---

### 4.2 Calling a New Provider (Zero Vendor Lock-In)

**Wrong (`❌`)** — Calling a vendor API directly inside `src/engine/`:

```bash
# src/engine/orchestrator.sh
curl -s https://api.groq.com/openai/v1/chat/completions \
  -H "Authorization: Bearer ${GROQ_API_KEY}" \
  -d "${payload}"
```

**Right (`✅`)** — Invoking the configured adapter through `src/agents/run.sh`:

```bash
# src/engine/orchestrator.sh
./src/agents/run.sh \
  --role "planner" \
  --workspace "${worktree_path}" \
  --prompt "${context_file}"
```

---

### 4.3 Adding a New Agent Role (Separation & Least Privilege)

**Wrong (`❌`)** — Embedding an inline prompt inside `run.sh` with write access for a read-only audit role:

```bash
# src/agents/run.sh
if [[ "$ROLE" == "security_auditor" ]]; then
  opencode --write "Check the repo for security bugs and fix them."
fi
```

**Right (`✅`)** — Separating prompt + role config with least privilege (`read_only`):

```yaml
# src/agents/security_auditor/role.yaml
name: "security_auditor"
access: "read_only"
prompt_file: "src/agents/security_auditor/prompt.md"
output_file: "SECURITY_REPORT.md"
```

---

### 4.4 Updating Repo Config Templates

**Wrong (`❌`)** — Committing real client paths or tokens into `config/repos.yaml`:

```yaml
# config/repos.yaml (NEVER commit this file)
repos:
  - id: "acme-bank"
    local_path: "/Users/me/clients/acme-secret"
    tracker:
      token: "ghp_realToken12345"
```

**Right (`✅`)** — Documenting new schema fields in `config/repos.example.yaml` using placeholders and `token_env`:

```yaml
# config/repos.example.yaml
repos:
  - id: "example-client-api"
    local_path: "/path/to/clients/example-api"
    tracker:
      token_env: "EXAMPLE_CLIENT_GH_TOKEN"
```

---

## 5. Pre-PR Checklist

Before submitting your pull request, verify:

- [ ] No vendor-specific CLI/SDK calls exist in `src/engine/`, `src/agents/`, or `src/self_healing/`.
- [ ] Any new provider declares `is_local` in `config/models.yaml` and uses `api_key_env` (with the variable added to `.env.example`).
- [ ] Any new agent has its own `prompt.md` and `role.yaml` under `src/agents/<role>/` and follows least privilege (`read_only` unless editing code).
- [ ] Outputs follow the standard JSON contracts (`Ticket`, `AgentResult`, `VerificationResult`).
- [ ] No secrets, `.env` files, or personal `config/repos.yaml` entries are staged or committed.
- [ ] Tests and verification checks pass, and related docs are updated.
