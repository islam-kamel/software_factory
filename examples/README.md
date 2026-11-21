# Examples — AI Software Factory

Copy-and-paste examples for integrating **Software Factory** with GitHub repositories.

## GitHub Examples (`examples/github/`)

| File | Copy To (Target Repo) | Purpose |
| :--- | :--- | :--- |
| [github/ai-factory-caller.yml](github/ai-factory-caller.yml) | `.github/workflows/ai-factory.yml` | Reusable GitHub Actions caller workflow for `ai-ready` and `/approve` triggers |
| [github/ISSUE_TEMPLATE_ai-task.yml](github/ISSUE_TEMPLATE_ai-task.yml) | `.github/ISSUE_TEMPLATE/ai-task.yml` | Structured GitHub Issue Form with required Acceptance Criteria |
| [github/issue-patterns.md](github/issue-patterns.md) | Reference guide | Wrong vs. right issues, 3 reusable issue patterns, and full comment lifecycle |
| [github/labels.json](github/labels.json) | Import via `gh` CLI | The 7 factory state labels (`ai-ready` through `ai-failed`) with colors and descriptions |

## Quick Label Setup (`gh` CLI)

Create all 7 state labels in a target GitHub repository using `examples/github/labels.json`:

```bash
jq -c '.[]' examples/github/labels.json | while read -r label; do
  name=$(echo "$label" | jq -r '.name')
  color=$(echo "$label" | jq -r '.color')
  desc=$(echo "$label" | jq -r '.description')
  gh label create "$name" --color "$color" --description "$desc" --repo "your-username/your-repo" --force
done
```

For full onboarding steps, see [INTEGRATION_GUIDE.md](../INTEGRATION_GUIDE.md).
