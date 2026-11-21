# Global Factory Rules (`config/contexts/global-factory-rules.md`)

> **Precedence Rule:** When merged with a target repository's own `AGENTS.md` (`context.mode: "merge"`), **these factory rules take precedence on security, privacy, Git workflow, and role boundaries**, while the repository's `AGENTS.md` takes precedence on code style, tech stack, and architecture.

---

## 1. Role Boundaries

- **Planner (`read_only`):** Analyze the ticket and codebase, then output a concise, step-by-step `PLAN.md` listing target files, edge cases, and tests. Never modify repository files.
- **Builder (`read_write`):** Implement only what is approved in `PLAN.md` inside the assigned isolated `git worktree`, and write unit tests covering every acceptance criterion.
- **Reviewer (`read_only`):** Review `git diff` against the ticket and `PLAN.md` in a fresh session. Flag bugs, security risks, or out-of-scope edits without modifying code.

## 2. Git & Pull Request Safety

- Never commit or push directly to `main`, `master`, or `develop`.
- Work strictly on the factory-assigned `ai/` branch inside the isolated worktree.
- Open **Draft PRs** only — never auto-merge or mark a PR ready for merge without human review.
- Never force-push (`git push --force`) or rewrite shared history.

## 3. Privacy & Secret Hygiene

- Never read, print, log, or modify files matching the repository's `privacy.ignore_paths` (such as `.env*`, `*.pem`, `*.key`, `certs/**`, `secrets/**`).
- Never hardcode API keys, tokens, passwords, or private URLs in source code, tests, or comments.
- Treat any failure from `verification.secret_scan` as a hard stop before pushing.

## 4. Verification & Self-Healing Discipline

- Never claim a task is complete without passing all configured `verification` commands (`secret_scan`, `lint`, `typecheck`, `test`).
- During self-healing retries, fix the root cause reported by `error_parser` rather than disabling lint rules, skipping tests, or weakening assertions.
- Respect the configured `max_retries` circuit breaker; if blocked after the final attempt, report the exact failing step clearly.

## 5. Minimal Diffs & Zero Footprint

- Keep diffs tightly scoped to the ticket's acceptance criteria. Do not reformat or refactor unrelated files.
- Do not commit temporary factory files (`PLAN.md`, `agent_output.md`, logs, or scratch scripts) into the target repository.
