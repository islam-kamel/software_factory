# GitHub Issue Patterns for AI Software Factory

Good issues produce clean `PLAN.md` files and first-pass Draft PRs. Vague issues waste tokens and trigger self-healing retries.

---

## 1. Wrong vs. Right Issue Example

### Wrong (`❌`) — Vague, unbounded, and untestable
```markdown
Title: Fix signup bug

Signup is broken when someone enters the same email twice. Please fix it and clean up the auth folder.
```
**Why this fails:** No expected HTTP status or response format, no test expectation, and "clean up the auth folder" invites out-of-scope refactors into protected files.

### Right (`✅`) — Scoped, testable, and explicit
```markdown
Title: [AI]: Return HTTP 400 on duplicate email signup

## Problem / Goal
When a user signs up with an email that already exists, `POST /api/signup` currently throws an
unhandled database constraint error and returns HTTP 500.

## Acceptance Criteria
- [ ] `POST /api/signup` returns HTTP 400 with `{ "error": "EMAIL_ALREADY_EXISTS" }` when the email is already registered.
- [ ] Email comparison is case-insensitive (`User@Example.com` matches `user@example.com`).
- [ ] Unit tests cover both new signup (201) and duplicate email signup (400).

## Target Files (Optional)
- `src/auth/signup.ts`
- `tests/auth/signup.test.ts`

## Out of Scope
- Do not modify database migrations or password hashing logic.
```

---

## 2. Reusable Issue Patterns

### Pattern A: Bug Fix
```markdown
Title: [AI]: Prevent crash when `config/repos.yaml` has an empty `repos` list

## Problem / Goal
If `repos:` in `config/repos.yaml` is empty (`[]`), the polling runner throws a null reference error.

## Acceptance Criteria
- [ ] Empty `repos: []` logs a clear warning (`No enabled repositories configured`) and exits with code `0`.
- [ ] Unit test covers empty `repos` and all-disabled `repos` (`enabled: false`).

## Out of Scope
- Do not change the YAML schema in `config/repos.example.yaml`.
```

### Pattern B: Small Feature
```markdown
Title: [AI]: Add `--dry-run` flag to `src/agents/run.sh`

## Problem / Goal
Allow developers to validate config resolution, `privacy_guard`, and the assembled CLI command
without calling an external LLM provider.

## Acceptance Criteria
- [ ] `./src/agents/run.sh --role planner --workspace <path> --prompt <file> --dry-run` prints the resolved provider, model, and command, then exits `0`.
- [ ] `--dry-run` still runs `privacy_guard` and exits non-zero if `allow_cloud_llm: false` is violated.
- [ ] Tests cover both valid dry-run and fail-closed privacy rejection.

## Out of Scope
- Do not modify `src/adapters/cli_runner/*` execution logic.
```

### Pattern C: Focused Refactor + Tests
```markdown
Title: [AI]: Extract `trim_stack_trace` helper in `src/self_healing/error_parser`

## Problem / Goal
Stack-trace trimming is duplicated across test and lint error handlers in `error_parser`.

## Acceptance Criteria
- [ ] Extract a pure `trim_stack_trace(raw_output, max_lines)` helper with no behavior change.
- [ ] Existing tests continue to pass without modification.
- [ ] Add unit tests for empty output, ANSI color codes, and logs exceeding `max_lines`.

## Out of Scope
- Do not change the `VerificationResult` JSON schema.
```

---

## 3. End-to-End GitHub Issue Lifecycle Example

1. **Developer** opens Issue `#42` using `.github/ISSUE_TEMPLATE/ai-task.yml` with label `ai-ready`.
2. **Factory Engine** immediately swaps label `ai-ready` -> `ai-planning` (locks ticket).
3. **Planner Agent** posts `PLAN.md` as a comment and sets label `needs-approval`.
4. **Developer** (listed in `allowed_approvers`) reviews the plan and replies:
   ```text
   /approve
   ```
5. **Factory Engine** swaps label to `ai-building`, creates isolated worktree on branch `ai/issue-42`, runs **Builder** + **Self-Healing Verifier** (max 3 retries) + **Reviewer**.
6. **Factory Engine** opens a **Draft PR** (`Fixes #42`) with the Verification Report and Reviewer summary, cleans up the worktree, sets label `ai-pr-ready`, and notifies the developer.
