// ============================================================
// privacy_guard.ts
// Purpose : Reject cloud model routes for repositories that forbid them
// Feature : Security
// Role    : Domain Service
// API Doc : docs/implementation_plan.md, Phase 0
// ============================================================
import type { ModelsConfig, ResolvedRepository } from "@/engine/config_schemas";

export function assertRepositoryPrivacy(repositories: ResolvedRepository[], models: ModelsConfig): void {
  for (const repository of repositories) {
    if (typeof repository.privacy.allow_cloud_llm !== "boolean") {
      throw new Error(`repos.${repository.id}.privacy.allow_cloud_llm must be boolean`);
    }

    for (const role of ["planner", "builder", "reviewer"] as const) {
      const providerName = repository.agents[role].provider;
      const provider = Object.hasOwn(models.providers, providerName) ? models.providers[providerName] : undefined;
      if (!provider) throw new Error(`repos.${repository.id}.agents.${role}.provider references an unknown provider`);
      if (typeof provider.is_local !== "boolean") throw new Error(`providers.${providerName}.is_local must be boolean`);
      if (!repository.privacy.allow_cloud_llm && !provider.is_local) {
        throw new Error(`repos.${repository.id} forbids cloud LLMs but role ${role} uses a cloud provider`);
      }
    }
  }
}
