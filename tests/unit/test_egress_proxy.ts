// ============================================================
// test_egress_proxy.ts
// Purpose : Verify fail-closed provider routing through the local egress bridge
// Feature : Agent execution security
// Role    : Unit Tests
// API Doc : https://opencode.ai/docs/providers/
// ============================================================
import { expect, it } from "vitest";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOpenCodeEgressConfig,
  EGRESS_BRIDGE_SCRIPT,
  getOpenCodeEgressBaseUrl,
} from "@/adapters/llm/egress_proxy";

async function listenServer(server: ReturnType<typeof createServer>, path?: string): Promise<number | undefined> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    if (path) server.listen(path, resolve);
    else server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return typeof address === "object" && address ? address.port : undefined;
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function requestBridge(port: number, socketPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const childCode = [
      "const http=require('node:http');",
      "const req=http.request({hostname:'127.0.0.1',port:Number(process.argv[1]),",
      "path:'/opencode-go/inference/go/chat/completions?probe=1',method:'POST',",
      "headers:{authorization:'Bearer factory-proxy'}},res=>{let body='';",
      "res.on('data',chunk=>body+=chunk);res.on('end',()=>console.log(body))});",
      "req.end('synthetic-body');",
    ].join("");
    const script = EGRESS_BRIDGE_SCRIPT.replace('"/run/factory/egress.sock"', JSON.stringify(socketPath)).replace(
      'server.listen(18080, "127.0.0.1"',
      `server.listen(${port}, "127.0.0.1"`,
    );
    const child = spawn(process.execPath, [
      "--input-type=commonjs",
      "--eval",
      script,
      "--",
      process.execPath,
      "-e",
      childCode,
      String(port),
    ]);
    let output = "";
    let errorOutput = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (errorOutput += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve(output.trim()) : reject(new Error(errorOutput))));
  });
}

it.skipIf(process.platform !== "linux")(
  "forwards an OpenCode-shaped request through the selected Unix socket",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "factory-egress-"));
    const socketPath = join(directory, "proxy.sock");
    const upstream = createServer((incoming, response) => {
      let body = "";
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk: string) => (body += chunk));
      incoming.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            method: incoming.method,
            url: incoming.url,
            body,
            authorization: incoming.headers.authorization,
          }),
        );
      });
    });
    const portServer = createServer();
    try {
      await listenServer(upstream, socketPath);
      const port = await listenServer(portServer);
      if (!port) throw new Error("Unable to bind egress bridge test port");
      await closeServer(portServer);
      const result = await requestBridge(port, socketPath);
      expect(JSON.parse(result)).toEqual({
        method: "POST",
        url: "/opencode-go/inference/go/chat/completions?probe=1",
        body: "synthetic-body",
        authorization: "Bearer factory-proxy",
      });
    } finally {
      await closeServer(upstream);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("maps only supported provider routes to fixed loopback paths", () => {
  expect(getOpenCodeEgressBaseUrl("opencode-go")).toBe("http://127.0.0.1:18080/opencode-go/inference/go");
  expect(getOpenCodeEgressBaseUrl("ollama-local")).toBe("http://127.0.0.1:18080/ollama-local/v1");
  expect(() => getOpenCodeEgressBaseUrl("unknown-provider")).toThrow(/does not support/);
});

it("builds isolated OpenCode v2 config with a synthetic credential", () => {
  expect(createOpenCodeEgressConfig("opencode-go", "glm-5.3")).toEqual({
    $schema: "https://opencode.ai/config.json",
    providers: {
      "opencode-go": {
        name: "Software Factory Egress",
        package: "@opencode/ai/providers/openai-compatible",
        settings: {
          baseURL: "http://127.0.0.1:18080/opencode-go/inference/go",
          apiKey: "factory-proxy",
        },
        models: { "glm-5.3": { name: "glm-5.3", modelID: "glm-5.3" } },
      },
    },
  });
  expect(() => createOpenCodeEgressConfig("openrouter", "  ")).toThrow(/Invalid model/);
});
