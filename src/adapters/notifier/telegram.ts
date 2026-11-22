// ============================================================
// telegram.ts
// Purpose : Send minimal ticket notifications through Telegram Bot API
// Feature : Phase 2 developer notifications
// Role    : Notifier Adapter
// API Doc : https://core.telegram.org/bots/api#sendmessage
// ============================================================
import type { NotificationEvent, Notifier } from "@/adapters/notifier/console";

type TelegramNotifierOptions = { token: string; chatId: string; fetcher?: typeof fetch };
type SendMessageOptions = { token: string; chatId: string; text: string; fetcher: typeof fetch };

const MAX_MESSAGE_LENGTH = 4096;
const MAX_URL_LENGTH = 2048;
const TOKEN_PATTERN = /^[A-Za-z0-9:_-]{1,256}$/;
const CHAT_ID_PATTERN = /^[A-Za-z0-9_@-]{1,128}$/;

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
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128 && !hasControlCharacters(value);
}

function isNotificationState(value: unknown): value is NotificationEvent["state"] {
  return value === "needs_approval" || value === "ai_pr_ready" || value === "ai_failed";
}

function isSafeHttpsUrl(value: string): boolean {
  if (value.length === 0 || value.length > MAX_URL_LENGTH || hasControlCharacters(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0 && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function formatMessage(event: NotificationEvent): string {
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
    default:
      throw new Error("Notification event is invalid");
  }
  return message;
}

function isValidNotificationEvent(value: unknown): value is NotificationEvent {
  if (!isRecord(value) || !isNotificationState(value.state)) return false;
  if (!isSafeLabel(value.repositoryId) || !isSafeLabel(value.ticketId)) return false;
  if (value.url === undefined) return true;
  return value.state === "ai_pr_ready" && typeof value.url === "string" && isSafeHttpsUrl(value.url);
}

function parseNotificationEvent(value: unknown): NotificationEvent {
  if (!isValidNotificationEvent(value)) throw new Error("Notification event is invalid");
  return value;
}

function notificationMessage(value: unknown): string {
  const event = parseNotificationEvent(value);
  const message = formatMessage(event);
  if (message.length > MAX_MESSAGE_LENGTH) throw new Error("Notification message is too long");
  return message;
}

function validateCredentials(options: TelegramNotifierOptions): void {
  if (
    typeof options.token !== "string" ||
    typeof options.chatId !== "string" ||
    !TOKEN_PATTERN.test(options.token) ||
    !CHAT_ID_PATTERN.test(options.chatId)
  ) {
    throw new Error("Telegram credentials are invalid");
  }
}

async function sendMessage(options: SendMessageOptions): Promise<void> {
  const url = `https://api.telegram.org/bot${options.token}/sendMessage`;
  let response: Response;
  try {
    response = await options.fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: options.chatId, text: options.text }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Telegram notification request failed", { cause: new Error("Network request failed") });
  }
  if (!response.ok) throw new Error("Telegram notification request failed");

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Telegram returned an invalid response", { cause: new Error("Invalid API response") });
  }
  if (!isRecord(payload) || typeof payload.ok !== "boolean") throw new Error("Telegram returned an invalid response");
  if (!payload.ok) throw new Error("Telegram rejected the notification");
}

export function createTelegramNotifier(options: TelegramNotifierOptions): Notifier {
  validateCredentials(options);
  const fetcher = options.fetcher ?? fetch;
  return {
    notify: async (event) => {
      await sendMessage({ token: options.token, chatId: options.chatId, text: notificationMessage(event), fetcher });
    },
  };
}
