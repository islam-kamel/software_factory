// ============================================================
// egress_proxy.ts
// Purpose : Restrict OpenCode requests to the repository-approved egress socket
// Feature : Agent execution security
// Role    : Network Security Adapter
// API Doc : https://opencode.ai/docs/providers/
// ============================================================
const providerPaths: Record<string, string> = {
  openrouter: "/openrouter/api/v1",
  openai: "/openai/v1",
  "opencode-go": "/opencode-go/inference/go",
  "ollama-local": "/ollama-local/v1",
};

export function getOpenCodeEgressBaseUrl(provider: string): string {
  const path = providerPaths[provider];
  if (!path) throw new Error("Egress proxy does not support this provider");
  return `http://127.0.0.1:18080${path}`;
}

export function createOpenCodeEgressConfig(provider: string, model: string): Record<string, unknown> {
  if (!model.trim() || model.length > 200) throw new Error("Invalid model for egress proxy config");
  const baseURL = getOpenCodeEgressBaseUrl(provider);
  return {
    $schema: "https://opencode.ai/config.json",
    providers: {
      [provider]: {
        name: "Software Factory Egress",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL, apiKey: "factory-proxy" },
        models: { [model]: { name: model, modelID: model } },
      },
    },
  };
}

export const EGRESS_BRIDGE_SCRIPT = `
const http = require("node:http");
const { spawn } = require("node:child_process");
const commandArgs = process.argv.slice(1);
const command = commandArgs.shift();
if (!command) process.exit(2);
const server = http.createServer((request, response) => {
  if (request.method === "CONNECT" || !request.url || !request.url.startsWith("/")) {
    response.writeHead(405).end();
    return;
  }
  const headers = { ...request.headers, host: "factory-egress" };
  delete headers.connection;
  delete headers["proxy-connection"];
  const upstream = http.request({
    socketPath: "/run/factory/egress.sock",
    method: request.method,
    path: request.url,
    headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.once("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end("Egress proxy unavailable");
  });
  request.pipe(upstream);
});
server.once("error", () => process.exit(1));
server.listen(18080, "127.0.0.1", () => {
  const child = spawn(command, commandArgs, { stdio: "inherit", env: process.env });
  child.once("error", () => {
    server.close(() => process.exit(127));
  });
  child.once("close", (code, signal) => {
    server.close(() => {
      if (signal) process.kill(process.pid, signal);
      else process.exitCode = code === null ? 1 : code;
    });
  });
});
`;
