// ============================================================
// privacy_guard.ts
// Purpose : Reject cloud model routes for local-only repositories
// Feature : Privacy and Security
// Role    : Domain Service
// API Doc : config/repos.example.yaml
// ============================================================
import type { FactoryConfig, ManagedRepository } from "./config_loader.js";

export function assertPrivacy(config: FactoryConfig, repository: ManagedRepository): void {
  if (repository.privacy.allow_cloud_llm) return;
  for (const role of ["planner", "builder", "reviewer"] as const) {
    const route = repository.agents[role];
    const provider = config.models.providers[route.provider];
    if (!Object.hasOwn(config.models.providers, route.provider)) {
      throw new Error(`Unknown provider for ${repository.id} ${role}: ${route.provider}`);
    }
    if (!provider) throw new Error(`Unknown provider for ${repository.id} ${role}: ${route.provider}`);
    if (!provider.is_local) throw new Error(`Cloud provider ${route.provider} is blocked for ${repository.id} ${role}`);
  }
}
