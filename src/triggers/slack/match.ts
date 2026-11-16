import type {
  CompiledTriggerConfig as CompiledTrigger,
  TriggerFilter,
} from "../../config/index.js";
import type { NormalizedSlackMentionEvent } from "./events.js";

type MatchedTriggerDefinition = Pick<CompiledTrigger, "name" | "on" | "filters">;

export interface MatchedSlackTrigger {
  event: NormalizedSlackMentionEvent;
  trigger: MatchedTriggerDefinition;
}

export function matchSlackTriggers(
  config: { triggers: readonly MatchedTriggerDefinition[] },
  event: NormalizedSlackMentionEvent,
  botUserId: string,
  connectionId?: string | null,
  followedThread = false,
): MatchedSlackTrigger[] {
  if (event.author.id === botUserId) return [];
  return config.triggers.flatMap((trigger) => {
    return trigger.on === "slack.mention" &&
      matchesFilters(event, trigger.filters, botUserId, connectionId, followedThread)
      ? [{ event, trigger }]
      : [];
  });
}

/**
 * Whether the message is addressed to the bot under this trigger. A mention always is. A message
 * event is only when the trigger opts in: a direct message with `direct_messages`, or a reply in a
 * thread the bot recently worked in with `follow_threads`. A channel reply that mentions the bot is
 * left to its app_mention event, so one message never runs twice.
 */
export function isAddressed(
  event: NormalizedSlackMentionEvent,
  filters: TriggerFilter,
  botUserId: string,
  followedThread: boolean,
): boolean {
  if (event.mentioned) return event.content.includes(`<@${botUserId}>`);
  if (event.channelType === "im") return filters.direct_messages === true;
  return (
    filters.follow_threads === true && followedThread && !event.content.includes(`<@${botUserId}>`)
  );
}

function matchesFilters(
  event: NormalizedSlackMentionEvent,
  filters: TriggerFilter | undefined,
  botUserId: string,
  connectionId: string | null | undefined,
  followedThread: boolean,
): boolean {
  if (filters === undefined || !isAddressed(event, filters, botUserId, followedThread))
    return false;
  if (
    filters.from_users === undefined ||
    (!filters.from_users.includes("*") &&
      !filters.from_users.includes(event.author.id) &&
      (event.author.username === undefined || !filters.from_users.includes(event.author.username)))
  )
    return false;
  if (filters.connectionId !== undefined && filters.connectionId !== connectionId) return false;
  const workspace = readString(filters, "workspace");
  if (workspace !== undefined && workspace !== event.teamId) return false;
  const channels = readStrings(filters, "channels");
  if (channels !== undefined && !channels.includes(event.channelId)) return false;
  const pattern = readString(filters, "pattern") ?? readString(filters, "contains");
  if (pattern === undefined || pattern.length === 0) return true;
  const body = readSlackPromptBody(event, botUserId);
  if (!body.startsWith(pattern)) return false;
  const nextCharacter = body.at(pattern.length);
  return nextCharacter === undefined || /\s/u.test(nextCharacter);
}

export function readSlackPromptBody(event: NormalizedSlackMentionEvent, botUserId: string): string {
  const mention = `<@${botUserId}>`;
  const index = event.content.indexOf(mention);
  return index < 0 ? event.content : event.content.slice(index + mention.length).trimStart();
}

export function readSlackInvocationParserMessage(
  event: NormalizedSlackMentionEvent,
  botUserId: string,
  filters: TriggerFilter | undefined,
): string {
  const body = readSlackPromptBody(event, botUserId);
  const marker = filters === undefined ? undefined : readPatternMarker(filters);
  if (
    marker === undefined ||
    marker.length === 0 ||
    marker.includes("=") ||
    !body.startsWith(marker)
  )
    return body;
  const nextCharacter = body.at(marker.length);
  return nextCharacter === undefined || /\s/u.test(nextCharacter)
    ? body.slice(marker.length).trimStart()
    : body;
}

function readPatternMarker(filters: TriggerFilter): string | undefined {
  return readString(filters, "pattern") ?? readString(filters, "contains");
}

function readString(
  filters: TriggerFilter,
  key: "workspace" | "pattern" | "contains",
): string | undefined {
  const value = filters[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStrings(filters: TriggerFilter, key: "channels"): string[] | undefined {
  const value = filters[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : undefined;
}
