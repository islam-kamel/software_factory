# AGENTS.md — <Project Name>

> Copy this template to the root of your target repository as `AGENTS.md` (or save it under `config/contexts/<repo-id>.AGENTS.md` for Zero-Footprint client repos) and replace the bracketed placeholders.

---

## 1. Project Overview & Tech Stack

- **Purpose:** <1–2 sentence summary of what this repository does>
- **Language / Runtime:** <e.g., TypeScript 5.x on Node.js 22 / Python 3.12 / Go 1.23>
- **Framework & Key Libraries:** <e.g., NestJS, Prisma, PostgreSQL, Vitest>
- **Package Manager:** <e.g., pnpm | npm | uv | poetry>

---

## 2. Folder Structure

```text
src/
├── <module-a>/       # <Responsibility>
├── <module-b>/       # <Responsibility>
└── shared/           # <Shared utilities / types>
tests/                # <Unit & integration tests>
```

---

## 3. Verification Commands

Run these commands to verify any change before finishing:

- **Secret Scan:** `<e.g., gitleaks detect --source . --no-git>`
- **Lint:** `<e.g., pnpm lint>`
- **Typecheck:** `<e.g., pnpm typecheck>`
- **Tests:** `<e.g., pnpm test --run>`
- **Build:** `<e.g., pnpm build>`

---

## 4. Coding Standards & Conventions

- **Naming:** <e.g., `camelCase` for functions/variables, `PascalCase` for types/classes, `kebab-case` for filenames>
- **Error Handling:** <e.g., Use typed domain errors; never swallow exceptions silently>
- **Testing:** <e.g., Colocate `*.test.ts` beside source files; mock external HTTP calls>
- **Dependencies:** Do not add new third-party packages unless approved in `PLAN.md`.

### Example (Wrong vs. Right)

**Wrong (`❌`)** — <Describe anti-pattern specific to this repo>:
```text
<short bad example>
```

**Right (`✅`)** — <Describe preferred pattern specific to this repo>:
```text
<short good example>
```

---

## 5. Protected Files (Do Not Touch Without Explicit Approval)

AI agents must **not** modify these paths unless explicitly approved in the ticket and `PLAN.md`:

- `.env*`, `*.pem`, `*.key`, `secrets/**`
- `.github/workflows/**`
- `<e.g., src/auth/**, src/billing/**>`
- `<e.g., prisma/migrations/** (old migrations)>`

---

## 6. Git & Pull Request Rules

- Never push directly to `<main / develop>`.
- Keep diffs minimal and strictly scoped to the ticket's acceptance criteria.
- Open **Draft PRs** on `ai/` branches and include test/verification results in the PR summary.
