// ============================================================
// phase3_egress_agent_check_context.mjs
// Purpose : Package the actual TypeScript adapters for the isolated egress image
// Feature : Agent execution security
// Role    : Integration Test Build Utility
// API Doc : N/A
// ============================================================
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import ts from "typescript";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outputRoot = process.argv[2]
  ? resolve(process.argv[2])
  : await mkdtemp(join(tmpdir(), "software-factory-egress-image-"));
if (!outputRoot.startsWith(`${resolve(tmpdir())}${sep}`)) {
  throw new Error("Image context must stay in a temporary directory");
}

const sources = [
  "src/adapters/cli_runner/events.ts",
  "src/adapters/cli_runner/opencode.ts",
  "src/adapters/cli_runner/resource_scope.ts",
  "src/adapters/cli_runner/runtime_profile.ts",
  "src/adapters/cli_runner/sandbox.ts",
  "src/adapters/cli_runner/sandbox_git.ts",
  "src/adapters/cli_runner/types.ts",
  "src/adapters/llm/egress_proxy.ts",
  "src/engine/context_builder.ts",
];

async function compileSource(path) {
  const source = await readFile(resolve(projectRoot, path), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const destination = resolve(outputRoot, "adapter", path.replace(/\.ts$/, ".cjs"));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, compiled, { mode: 0o644 });
}

await mkdir(outputRoot, { recursive: true });
await Promise.all(sources.map(compileSource));
for (const file of ["phase3_egress_agent_check.Dockerfile", "phase3_egress_agent_check_entrypoint.cjs"]) {
  await cp(resolve(projectRoot, "tests/unit", file), resolve(outputRoot, basename(file)));
}
for (const dependency of ["yaml", "zod"]) {
  await cp(resolve(projectRoot, "node_modules", dependency), resolve(outputRoot, "node_modules", dependency), {
    recursive: true,
  });
}
process.stdout.write(`Prepared actual adapter source in ${outputRoot}\n`);
