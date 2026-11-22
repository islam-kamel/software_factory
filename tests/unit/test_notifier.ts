// ============================================================
// test_notifier.ts
// Purpose : Verify safe console and Telegram notifications
// Feature : Phase 2 developer notifications
// Role    : Unit Test
// API Doc : docs/implementation_plan.md, Notifier Adapter
// ============================================================
import { expect, it } from "vitest";
import type { FactoryConfig, ResolvedRepository } from "@/engine/config_schemas";
import { createConsoleNotifier, createNotifier, type NotificationEvent } from "@/adapters/notifier/console";
import { createTelegramNotifier } from "@/adapters/notifier/telegram";

function makeRepository(notifications?: ResolvedRepository["notifications"]): ResolvedRepository {
  return {
    id: "sample",
    enabled: true,
    visibility: "private",
    local_path: "/tmp/sample",
    use_worktree: true,
    agents: {
      planner: { cli: "codex", provider: "openai", model: "test" },
      builder: { cli: "codex", provider: "openai", model: "test" },
      reviewer: { cli: "codex", provider: "openai", model: "test" },
    },
    ...(notifications === undefined ? {} : { notifications }),
    privacy: { allow_cloud_llm: true },
    tracker: { provider: "local_md" },
  };
}

function makeFactory(notifier?: string): FactoryConfig {
  return {
    version: "1.0",
    ...(notifier === undefined ? {} : { adapters: { notifier } }),
  };
}

function event(state: NotificationEvent["state"], url?: string): NotificationEvent {
  return {
    state,
    repositoryId: "sample",
    ticketId: "17",
    ...(url === undefined ? {} : { url }),
  };
}

function successfulResponse(): Response {
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
}

it("formats all supported states and includes only an optional draft URL", async () => {
  const messages: string[] = [];
  const notifier = createConsoleNotifier((message) => messages.push(message));

  await notifier.notify(event("needs_approval"));
  await notifier.notify(event("ai_pr_ready", "https://github.com/example/repo/pull/17"));
  await notifier.notify(event("ai_failed"));

  expect(messages).toEqual([
    "Approval needed for ticket 17 in repository sample.",
    "Draft pull request ready for ticket 17 in repository sample. https://github.com/example/repo/pull/17",
    "Ticket 17 failed in repository sample. Inspect the run status for details.",
  ]);
});

it("defaults to console, honors none, and uses console when external notifications are disabled", async () => {
  const messages: string[] = [];
  const write = (message: string) => messages.push(message);
  const defaultNotifier = createNotifier({ factory: makeFactory(), repository: makeRepository(), write });
  await defaultNotifier.notify(event("ai_failed"));

  const none = createNotifier({ factory: makeFactory("none"), repository: makeRepository(), write });
  await none.notify(event("ai_failed"));

  const disabled = createNotifier({
    factory: makeFactory("telegram"),
    repository: makeRepository({ external: { enabled: false, provider: "telegram" } }),
    environment: {},
    write,
  });
  await disabled.notify(event("needs_approval"));

  expect(messages).toEqual([
    "Ticket 17 failed in repository sample. Inspect the run status for details.",
    "Approval needed for ticket 17 in repository sample.",
  ]);
});

it("lets an enabled repository provider override the factory selection", async () => {
  let requestedUrl = "";
  const fetcher: typeof fetch = async (input) => {
    requestedUrl = String(input);
    return successfulResponse();
  };
  const notifier = createNotifier({
    factory: makeFactory("console"),
    repository: makeRepository({ external: { enabled: true, provider: "telegram" } }),
    environment: { TELEGRAM_BOT_TOKEN: "12345:abc_DEF", TELEGRAM_CHAT_ID: "987654" },
    fetcher,
    write: () => {
      throw new Error("Console should not be selected");
    },
  });

  await notifier.notify(event("ai_failed"));
  expect(requestedUrl).toBe("https://api.telegram.org/bot12345:abc_DEF/sendMessage");
});

it("requires Telegram environment values by variable name only", () => {
  expect(() =>
    createNotifier({
      factory: makeFactory("telegram"),
      repository: makeRepository(),
      environment: {},
    }),
  ).toThrow("Missing required env var: TELEGRAM_BOT_TOKEN");
  expect(() =>
    createNotifier({
      factory: makeFactory("telegram"),
      repository: makeRepository(),
      environment: { TELEGRAM_BOT_TOKEN: "12345:abc_DEF" },
    }),
  ).toThrow("Missing required env var: TELEGRAM_CHAT_ID");
});

it("rejects unsupported providers and malformed notification configuration", () => {
  expect(() => createNotifier({ factory: makeFactory("discord"), repository: makeRepository() })).toThrow(
    /unsupported notifier provider/i,
  );
  expect(() =>
    createNotifier({
      factory: makeFactory(),
      repository: makeRepository({ external: "telegram" }),
    }),
  ).toThrow(/notifications configuration/i);
  expect(() =>
    createNotifier({
      factory: makeFactory(),
      repository: makeRepository({ external: { enabled: "false" } }),
    }),
  ).toThrow(/notifications configuration/i);
});

it("posts a plain text message and validates Telegram's successful response", async () => {
  let request: { url: string; init: RequestInit | undefined } | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    request = { url: String(input), init };
    return successfulResponse();
  };
  const notifier = createTelegramNotifier({ token: "12345:abc_DEF", chatId: "987654", fetcher });

  await notifier.notify(event("ai_pr_ready", "https://github.com/example/repo/pull/17"));

  expect(request).toMatchObject({
    url: "https://api.telegram.org/bot12345:abc_DEF/sendMessage",
    init: {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "987654",
        text: "Draft pull request ready for ticket 17 in repository sample. https://github.com/example/repo/pull/17",
      }),
      signal: expect.any(AbortSignal),
    },
  });
});

it("hides HTTP error bodies and identifiers", async () => {
  const token = "12345:secret_TOKEN";
  const chatId = "private-chat-987";
  const httpFailure = createTelegramNotifier({
    token,
    chatId,
    fetcher: async () => new Response(`token=${token} chat=${chatId}`, { status: 500 }),
  });
  await expect(httpFailure.notify(event("ai_failed"))).rejects.toThrow(/request failed/i);
  await expect(httpFailure.notify(event("ai_failed"))).rejects.not.toThrow(token);
  await expect(httpFailure.notify(event("ai_failed"))).rejects.not.toThrow(chatId);
});

it("hides Telegram API error descriptions", async () => {
  const token = "12345:secret_TOKEN";
  const chatId = "private-chat-987";
  const apiFailure = createTelegramNotifier({
    token,
    chatId,
    fetcher: async () =>
      new Response(JSON.stringify({ ok: false, description: `${token} ${chatId}` }), { status: 200 }),
  });
  await expect(apiFailure.notify(event("ai_failed"))).rejects.toThrow(/rejected/i);
  await expect(apiFailure.notify(event("ai_failed"))).rejects.not.toThrow(token);
  await expect(apiFailure.notify(event("ai_failed"))).rejects.not.toThrow(chatId);
});

it("rejects malformed Telegram responses", async () => {
  const token = "12345:secret_TOKEN";
  const chatId = "private-chat-987";
  const malformed = createTelegramNotifier({ token, chatId, fetcher: async () => new Response("not json") });
  await expect(malformed.notify(event("ai_failed"))).rejects.toThrow(/invalid response/i);
});

it("hides raw network errors", async () => {
  const token = "12345:secret_TOKEN";
  const chatId = "private-chat-987";
  const networkFailure = createTelegramNotifier({
    token,
    chatId,
    fetcher: async () => {
      throw new Error(`fetch failed for token=${token} chat=${chatId}`);
    },
  });
  await expect(networkFailure.notify(event("ai_failed"))).rejects.toThrow(/request failed/i);
  await expect(networkFailure.notify(event("ai_failed"))).rejects.not.toThrow(token);
  await expect(networkFailure.notify(event("ai_failed"))).rejects.not.toThrow(chatId);
});

it("rejects unsafe Telegram credentials and invalid event labels or URLs", async () => {
  const noNetwork: typeof fetch = async () => {
    throw new Error("fetch should not be called");
  };
  expect(() => createTelegramNotifier({ token: "bad/token", chatId: "987654", fetcher: noNetwork })).toThrow(
    /credentials are invalid/i,
  );
  expect(() => createTelegramNotifier({ token: "12345:abc", chatId: "bad chat", fetcher: noNetwork })).toThrow(
    /credentials are invalid/i,
  );

  const notifier = createConsoleNotifier(() => undefined);
  await expect(notifier.notify(event("ai_pr_ready", "http://example.test/pull/1"))).rejects.toThrow(/url is invalid/i);
  await expect(notifier.notify(event("needs_approval", "https://example.test/pull/1"))).rejects.toThrow(/url/i);
  await expect(notifier.notify({ state: "ai_failed", repositoryId: "sample\nsecret", ticketId: "17" })).rejects.toThrow(
    /event is invalid/i,
  );
  await expect(notifier.notify({ state: "ai_failed", repositoryId: "r".repeat(129), ticketId: "17" })).rejects.toThrow(
    /event is invalid/i,
  );
});
