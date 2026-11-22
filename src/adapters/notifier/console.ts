// ============================================================
// console.ts
// Purpose : Format safe ticket notifications and select configured notifier
// Feature : Phase 2 developer notifications
// Role    : Notifier Adapter
// API Doc : docs/implementation_plan.md, Notifier Adapter
// ============================================================
import { createTelegramNotifier } from "@/adapters/notifier/telegram";
import type { FactoryConfig, ResolvedRepository } from "@/engine/config_schemas";

export type NotificationEvent = {
  state: "needs_approval" | "ai_pr_ready" | "ai_failed";
  repositoryId: string;
  ticketId: string;
  url?: string;
};
export type Notifier = { notify(event: NotificationEvent): Promise<void> };

type ExternalNotificationConfig = { enabled?: boolean; provider?: string };
type NotifierProvider = "console" | "telegram" | "none";

const MAX_LABEL_LENGTH = 128;
const MAX_URL_LENGTH = 2048;
const MAX_MESSAGE_LENGTH = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function isSafeLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_LABEL_LENGTH &&
    !hasControlCharacters(value)
  );
}

function isSafeHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH || hasControlCharacters(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0 && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function isNotificationState(value: unknown): value is NotificationEvent["state"] {
  return value === "needs_approval" || value === "ai_pr_ready" || value === "ai_failed";
}

function isValidOptionalUrl(state: NotificationEvent["state"], value: unknown): value is string | undefined {
  return value === undefined || (state === "ai_pr_ready" && isSafeHttpsUrl(value));
}

function parseNotificationEvent(value: unknown): NotificationEvent {
  if (!isRecord(value)) throw new Error("Notification event is invalid");
  const state = value.state;
  if (!isNotificationState(state) || !isSafeLabel(value.repositoryId) || !isSafeLabel(value.ticketId)) {
    throw new Error("Notification event is invalid");
  }
  const url = value.url;
  if (!isValidOptionalUrl(state, url)) throw new Error("Notification URL is invalid");
  return { state, repositoryId: value.repositoryId, ticketId: value.ticketId, ...(url === undefined ? {} : { url }) };
}

function formatNotificationMessage(value: unknown): string {
  const event = parseNotificationEvent(value);
  let message: string;
  switch (event.state) {
    case "needs_approval":
      message = `Approval needed for ticket ${event.ticketId} in repository ${event.repositoryId}.`;
      break;
    case "ai_pr_ready":
      message = `Draft pull request ready for ticket ${event.ticketId} in repository ${event.repositoryId}.`;
      if (event.url) message += ` ${event.url}`;
      break;
    case "ai_failed":
      message = `Ticket ${event.ticketId} failed in repository ${event.repositoryId}. Inspect the run status for details.`;
      break;
  }
  if (message.length > MAX_MESSAGE_LENGTH) throw new Error("Notification message is too long");
  return message;
}

function hasOnlyExternalKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).every((key) => key === "enabled" || key === "provider");
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isOptionalProvider(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.trim().length > 0);
}

function parseExternalConfig(value: unknown): ExternalNotificationConfig {
  if (!isRecord(value) || !hasOnlyExternalKeys(value)) throw new Error("Notifications configuration is invalid");
  const enabled = value.enabled;
  const provider = value.provider;
  if (!isOptionalBoolean(enabled) || !isOptionalProvider(provider)) {
    throw new Error("Notifications configuration is invalid");
  }
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(provider === undefined ? {} : { provider }),
  };
}

function readExternalConfig(value: unknown): ExternalNotificationConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Notifications configuration is invalid");
  if (value.external === undefined) return undefined;
  return parseExternalConfig(value.external);
}

function parseProvider(value: string): NotifierProvider {
  if (value === "console" || value === "telegram" || value === "none") return value;
  throw new Error("Unsupported notifier provider");
}

function selectProvider(factory: FactoryConfig, external: ExternalNotificationConfig | undefined): NotifierProvider {
  const factoryProvider = parseProvider(factory.adapters?.notifier ?? "console");
  const externalProvider = external?.provider === undefined ? undefined : parseProvider(external.provider);
  if (external?.enabled === false) return factoryProvider === "none" ? "none" : "console";
  return externalProvider ?? factoryProvider;
}

function noOpNotifier(): Notifier {
  return { notify: async () => undefined };
}

export function createConsoleNotifier(write: (message: string) => void = (message) => console.log(message)): Notifier {
  return { notify: async (event) => write(formatNotificationMessage(event)) };
}

export function createNotifier(options: {
  factory: FactoryConfig;
  repository: ResolvedRepository;
  environment?: Readonly<Record<string, string | undefined>>;
  fetcher?: typeof fetch;
  write?: (message: string) => void;
}): Notifier {
  const external = readExternalConfig(options.repository.notifications);
  const provider = selectProvider(options.factory, external);
  if (provider === "none") return noOpNotifier();
  if (provider === "console") return createConsoleNotifier(options.write);

  const environment = options.environment ?? process.env;
  const token = environment.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing required env var: TELEGRAM_BOT_TOKEN");
  const chatId = environment.TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error("Missing required env var: TELEGRAM_CHAT_ID");
  return createTelegramNotifier({ token, chatId, ...(options.fetcher ? { fetcher: options.fetcher } : {}) });
}
