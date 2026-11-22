// ============================================================
// phase3_egress_agent_check_entrypoint.cjs
// Purpose : Verify compiled sandbox and OpenCode egress against the Nginx mock
// Feature : Agent execution security
// Role    : Linux Integration Check
// API Doc : https://opencode.ai/docs
// ============================================================
const assert = require("node:assert/strict");
const Module = require("node:module");
const { createServer } = require("node:http");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const checkRoot = "/opt/software-factory-check";
const resolveModule = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request.startsWith("@/")) request = resolve(checkRoot, "src", `${request.slice(2)}.cjs`);
  return resolveModule.call(this, request, parent, isMain, options);
};

const { createOpenCodeInvocation, parseOpenCodeOutput } = require("@/adapters/cli_runner/opencode");
const { loadSandboxRuntimeProfile } = require("@/adapters/cli_runner/runtime_profile");
const { runSandboxed } = require("@/adapters/cli_runner/sandbox");
const { createOpenCodeEgressConfig } = require("@/adapters/llm/egress_proxy");

function collectLibraries(binary) {
  const result = spawnSync("ldd", [binary], { encoding: "utf8" });
  if (result.error) throw result.error;
  const paths = result.stdout.split("\n").flatMap((line) => {
    const path = line.match(/=>\s+(\/\S+)/)?.[1] ?? line.match(/^\s*(\/\S+)\s+\(/)?.[1];
    return path ? [path] : [];
  });
  return paths;
}

async function makeRuntimeProfile(profilePath) {
  const nodePath = realpathSync(process.execPath);
  const opencodePath = realpathSync("/opt/opencode/bin/opencode");
  const mounts = new Map();
  const addFile = (source, target = source) => {
    mounts.set(target, { source: realpathSync(source), target });
  };
  const addDependencies = (binary) => collectLibraries(binary).forEach((path) => addFile(path));
  addFile(nodePath);
  addFile(opencodePath);
  addDependencies(nodePath);
  addDependencies(opencodePath);
  for (const path of ["/etc/group", "/etc/nsswitch.conf", "/etc/passwd"]) addFile(path);
  const profile = {
    version: 1,
    mounts: [{ source: "/opt/opencode", target: "/opt/opencode" }, ...mounts.values()],
    commands: { node: nodePath, opencode: opencodePath },
  };
  writeFileSync(profilePath, JSON.stringify(profile), { mode: 0o600 });
  return loadSandboxRuntimeProfile(profilePath);
}

async function startLoopbackServer() {
  const server = createServer((_request, response) => response.end("outer-loopback"));
  await new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveServer);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to read loopback test port");
  return { server, port: address.port };
}

function closeServer(server) {
  return new Promise((resolveServer, reject) => server.close((error) => (error ? reject(error) : resolveServer())));
}

async function runNode(profile, workspace, scratchDirectory, script, options = {}) {
  return runSandboxed("node", ["-e", script], {
    workspace,
    ignorePaths: [".env*"],
    access: "read_only",
    timeoutMs: 15_000,
    scratchDirectory,
    runtimeProfile: profile,
    ...options,
  });
}

async function checkNetworkIsolation(profile, workspace, scratchDirectory) {
  const loopback = await startLoopbackServer();
  try {
    const reachableProbe = [
      "require('node:http').get(",
      `'http://127.0.0.1:${loopback.port}',r=>{r.resume();`,
      "r.on('end',()=>console.log('reachable'))}).on('error',()=>process.exit(3))",
    ].join("");
    const reachable = await runNode(profile, workspace, scratchDirectory, reachableProbe);
    assert.equal(reachable.exitCode, 0, reachable.stderr);
    assert.match(reachable.stdout, /reachable/);
    const blockedProbe = [
      "require('node:http').get(",
      `'http://127.0.0.1:${loopback.port}',()=>process.exit(4))`,
      ".on('error',()=>console.log('blocked'))",
    ].join("");
    const blocked = await runNode(profile, workspace, scratchDirectory, blockedProbe, { offline: true });
    assert.equal(blocked.exitCode, 0, blocked.stderr);
    assert.match(blocked.stdout, /blocked/);
    process.stdout.write("PASS network reachable in default mode and blocked by offline bwrap\n");
  } finally {
    await closeServer(loopback.server);
  }
}

async function checkSocketExposure(profile, workspace, scratchDirectory) {
  const socketProbe = [
    "const fs=require('node:fs');const paths=fs.readdirSync('/run/factory');",
    "if(paths.length!==1||paths[0]!=='egress.sock'||",
    "!fs.statSync('/run/factory/egress.sock').isSocket())process.exit(2);",
    "console.log('one socket')",
  ].join("");
  const result = await runNode(profile, workspace, scratchDirectory, socketProbe, {
    offline: true,
    egressSocket: "/run/factory/public.sock",
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /one socket/);
  process.stdout.write("PASS child sees only the selected egress socket\n");
}

async function runOpenCode(profile, workspace, scratchDirectory) {
  const configPath = join(scratchDirectory, "opencode.json");
  writeFileSync(configPath, JSON.stringify(createOpenCodeEgressConfig("opencode-go", "glm-5.3")), { mode: 0o600 });
  const request = {
    role: "builder",
    workspace,
    prompt: "Reply with a short synthetic sentence. Do not use tools.",
    provider: "opencode-go",
    model: "glm-5.3",
    access: "read_only",
    timeoutMs: 90_000,
    contextMode: "repo_only",
    scratchDirectory,
    egressConfigPath: configPath,
  };
  const invocation = createOpenCodeInvocation(request);
  assert.equal(invocation.env.OPENCODE_API_KEY, undefined);
  assert.equal(invocation.env.OPENCODE_CONFIG, configPath);
  const result = await runSandboxed(invocation.command, invocation.args, {
    workspace,
    ignorePaths: [".env*"],
    access: "read_only",
    timeoutMs: request.timeoutMs,
    scratchDirectory,
    runtimeProfile: profile,
    offline: true,
    egressSocket: "/run/factory/public.sock",
    env: invocation.env,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.timedOut, false);
  assert.equal(parseOpenCodeOutput(result.stdout).text, "synthetic response");
  process.stdout.write("PASS OpenCode 2.3.2 parsed synthetic response through Nginx\n");
}

async function main() {
  const directory = mkdtempSync(join(tmpdir(), "factory-agent-egress-"));
  const workspace = join(directory, "workspace");
  const scratchDirectory = join(directory, "scratch");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(scratchDirectory, { recursive: true });
  try {
    if (Object.keys(process.env).some((name) => /(?:API_KEY|TOKEN|SECRET)/i.test(name))) {
      throw new Error("Test container unexpectedly received credential environment variables");
    }
    const profile = await makeRuntimeProfile(join(directory, "runtime-profile.yaml"));
    await checkNetworkIsolation(profile, workspace, scratchDirectory);
    await checkSocketExposure(profile, workspace, scratchDirectory);
    await runOpenCode(profile, workspace, scratchDirectory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
