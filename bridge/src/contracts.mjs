export const EVENT_KINDS = Object.freeze(["FINAL_RESPONSE", "QUESTION", "APPROVAL_REQUEST", "ERROR", "TASK_COMPLETED"]);
export const REPLY_ACTIONS = Object.freeze(["REPLY", "APPROVE_ONCE", "DECLINE"]);
export const REPLY_MODES = Object.freeze(["LIVE_REQUEST", "NEXT_TURN", "NONE"]);
const EVENT_KIND_SET = new Set(EVENT_KINDS);
const REPLY_ACTION_SET = new Set(REPLY_ACTIONS);
const REPLY_MODE_SET = new Set(REPLY_MODES);

const EVENT_ID_PATTERN = /^evt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u;

const EVENT_FIELDS = ["schema", "event_id", "kind", "created_at", "expires_at", "thread", "message", "allowed_actions", "integrity"];
const THREAD_FIELDS = ["id", "turn_id", "title", "project_label", "cwd_label"];
const MESSAGE_FIELDS = ["summary", "markdown_path", "is_replyable"];
const INTEGRITY_FIELDS = ["producer", "content_sha256"];
const REPLY_FIELDS = ["schema", "event_id", "created_at", "action", "text", "telegram"];
const TELEGRAM_FIELDS = ["delivery_ref", "sender_fingerprint"];

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

function isRfc3339Timestamp(value) {
  if (typeof value !== "string") return false;
  const match = RFC3339_PATTERN.exec(value);
  if (match === null) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (offsetHourText !== undefined && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59)) return false;
  return true;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwnFields(value, fields) {
  return isJsonObject(value) && fields.every((field) => Object.hasOwn(value, field));
}

function hasAllowedActions(value) {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || !REPLY_ACTION_SET.has(value[index])) return false;
  }
  return true;
}

export function validateEvent(value) {
  assert(hasOwnFields(value, EVENT_FIELDS), "EVENT_SHAPE");
  assert(value.schema === "hermes-codex-interaction-event/v3", "EVENT_SCHEMA");
  assert(typeof value.event_id === "string" && EVENT_ID_PATTERN.test(value.event_id), "EVENT_ID");
  assert(EVENT_KIND_SET.has(value.kind), "EVENT_KIND");
  assert(isRfc3339Timestamp(value.created_at) && isRfc3339Timestamp(value.expires_at), "EVENT_TIME");
  assert(hasOwnFields(value.thread, THREAD_FIELDS), "EVENT_THREAD");
  assert(isNonEmptyString(value.thread?.id) && isNonEmptyString(value.thread.turn_id) && isNonEmptyString(value.thread.title) && isNonEmptyString(value.thread.project_label) && typeof value.thread.cwd_label === "string", "EVENT_THREAD");
  assert(hasOwnFields(value.message, MESSAGE_FIELDS), "EVENT_MESSAGE");
  assert(typeof value.message?.summary === "string" && [...value.message.summary].length <= 3500 && (value.message.markdown_path === null || value.message.markdown_path === "message.md") && typeof value.message.is_replyable === "boolean", "EVENT_MESSAGE");
  assert(!Object.hasOwn(value.message, "reply_mode") || REPLY_MODE_SET.has(value.message.reply_mode), "EVENT_MESSAGE");
  assert(hasAllowedActions(value.allowed_actions), "EVENT_ACTIONS");
  assert(hasOwnFields(value.integrity, INTEGRITY_FIELDS), "EVENT_INTEGRITY");
  assert(isNonEmptyString(value.integrity?.producer), "EVENT_INTEGRITY");
  assert(typeof value.integrity.content_sha256 === "string" && SHA256_PATTERN.test(value.integrity.content_sha256), "EVENT_HASH");
  return value;
}

export function validateReply(value) {
  assert(hasOwnFields(value, REPLY_FIELDS), "REPLY_SHAPE");
  assert(value.schema === "hermes-codex-interaction-reply/v3", "REPLY_SCHEMA");
  assert(typeof value.event_id === "string" && EVENT_ID_PATTERN.test(value.event_id), "REPLY_EVENT_ID");
  assert(isRfc3339Timestamp(value.created_at), "REPLY_TIME");
  assert(REPLY_ACTION_SET.has(value.action), "REPLY_ACTION");
  assert(value.text === null || typeof value.text === "string", "REPLY_TEXT");
  assert(value.action !== "REPLY" || (typeof value.text === "string" && value.text.trim().length > 0), "REPLY_TEXT");
  assert(hasOwnFields(value.telegram, TELEGRAM_FIELDS), "REPLY_TELEGRAM");
  assert(isNonEmptyString(value.telegram?.delivery_ref), "REPLY_DELIVERY");
  assert(typeof value.telegram.sender_fingerprint === "string" && SHA256_PATTERN.test(value.telegram.sender_fingerprint), "REPLY_SENDER");
  return value;
}
