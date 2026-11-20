import type { ProjectConfigurationStore } from "../../configuration/store.js";
import type { CompiledTriggerConfig } from "../../config/index.js";
import type {
  AttachmentCapabilityRegistry,
  AttachmentDescriptor,
} from "../../attachments/capabilities.js";
import { reportFailure } from "../../failures/index.js";
import { agentFailureNotice, missingBillingUrl } from "../failure-notice.js";
import {
  type TriggerProvider,
  type TriggerProviderMatch,
  type TriggerProviderReactionState,
} from "../index.js";
import type { SlackBotClient, SlackThreadMessage } from "./client.js";
import { NormalizedSlackMentionEventSchema, type NormalizedSlackMentionEvent } from "./events.js";
import {
  type MatchedSlackTrigger,
  matchSlackTriggers,
  readSlackInvocationParserMessage,
  readSlackPromptBody,
} from "./match.js";
import { matchesInputFilters, parseInvocation } from "../invocation.js";

export interface SlackAttachmentLocator {
  id: string;
  filename: string;
  content_type: string | null;
  size: number | null;
}

interface SlackThreadContextLocator {
  status: "deferred";
  channel: { id: string };
  thread: { ts: string };
  before: { ts: string };
}

export interface SlackMergeData {
  slack: {
    event_type: "app_mention" | "message";
    event_id: string;
    event_ts: string;
    event_time: number;
    connection_id: string | null;
    team: { id: string };
    app: { id: string };
    trigger_message: {
      ts: string;
      content: string;
      body: string;
      author: { id: string };
      channel: { id: string };
      thread: { ts: string } | null;
      created_at: string;
      attachments: SlackAttachmentLocator[];
    };
    trigger_thread_context:
      | SlackThreadContextLocator
      | {
          status: "not_applicable";
        };
  };
}

interface SlackMergeMessage {
  ts: string;
  content: string;
  author: { id: string };
  channel: { id: string };
  created_at: string;
  attachments: AttachmentDescriptor[];
}

interface SlackContextPayload {
  status: "available" | "incomplete" | "unavailable" | "not_applicable";
  messages: SlackMergeMessage[];
}

/**
 * Where the mention was posted, so an agent can address that message or its thread, and the
 * files posted with it, which the thread's earlier messages never include.
 */
interface SlackMaterializedTriggerMessage {
  ts: string;
  /** Who posted the message; `name` is their Slack display name, or null when Slack has none. */
  author: { id: string; name: string | null };
  channel: { id: string };
  thread: { ts: string } | null;
  attachments: AttachmentDescriptor[];
}

export interface SlackMaterializedContext {
  slack: {
    trigger_message: SlackMaterializedTriggerMessage;
    thread: SlackContextPayload;
  };
}

export interface SlackTriggerContext {
  provider: "slack";
  target: SlackOutputContext;
  event: SlackMergeData;
}

export interface SlackOutputContext {
  provider: "slack";
  organizationId: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
}

type SlackReactionPhase = "accepted" | "started";

const FOLLOW_THREAD_WINDOW_MS = 24 * 60 * 60 * 1_000;

interface ConversationAccess {
  /** A direct message or group DM. */
  direct: boolean;
  /** Who added the bot to the channel, when Slack recorded it. */
  inviter: string | null;
}

function allowsConversation(
  filters: NonNullable<CompiledTriggerConfig["filters"]>,
  access: ConversationAccess | undefined,
  authorId: string,
): boolean {
  if (access === undefined) return false;
  if (access.direct)
    return (
      filters.direct_message_users === undefined || filters.direct_message_users.includes(authorId)
    );
  return (
    filters.channel_inviters === undefined ||
    (access.inviter !== null && filters.channel_inviters.includes(access.inviter))
  );
}

function slackConversationKey(event: NormalizedSlackMentionEvent): string {
  return JSON.stringify([
    "slack",
    event.teamId,
    event.channelId,
    event.threadTs ?? event.messageTs,
  ]);
}

export function createSlackTriggerProvider(options: {
  configurationStoreForProject: (projectId: string) => ProjectConfigurationStore;
  botUserIdForWorkspace(organizationId: string, teamId: string): Promise<string | undefined>;
  client: SlackBotClient;
  attachments?: AttachmentCapabilityRegistry;
  billingUrlForOrganization?: (organizationId: string) => Promise<string>;
  /** When an agent last started in this conversation, for `follow_threads`. */
  lastAgentStartInConversation?(projectId: string, key: string): Promise<Date | undefined>;
}): TriggerProvider<"slack", SlackTriggerContext, SlackOutputContext, SlackMaterializedContext> {
  // An un-mentioned thread reply is followed only while the bot is active in that thread.
  async function followsThread(
    triggers: readonly Pick<CompiledTriggerConfig, "on" | "filters">[],
    event: NormalizedSlackMentionEvent,
    projectId: string,
  ): Promise<boolean> {
    if (event.mentioned || event.channelType === "im" || event.threadTs === null) return false;
    if (!triggers.some((candidate) => candidate.filters?.follow_threads === true)) return false;
    const started = await options.lastAgentStartInConversation?.(
      projectId,
      slackConversationKey(event),
    );
    return started !== undefined && Date.now() - started.getTime() < FOLLOW_THREAD_WINDOW_MS;
  }

  // The bot's latest join per channel, from history or a join event. Each use re-reads only
  // newer history, so a removal and a re-add by someone else is seen at the next message.
  const botJoins = new Map<string, { inviter: string | null; checkedTs: string }>();
  const conversationKinds = new Map<string, "im" | "mpim" | "channel">();

  async function channelInviter(
    organizationId: string,
    event: NormalizedSlackMentionEvent,
    botUserId: string,
  ): Promise<string | null> {
    if (options.client.findChannelJoin === undefined)
      throw new Error("Slack channel history is unavailable");
    const key = `${event.teamId}:${event.channelId}`;
    const known = botJoins.get(key);
    const found = await options.client.findChannelJoin({
      organizationId,
      teamId: event.teamId,
      channelId: event.channelId,
      userId: botUserId,
      ...(known === undefined ? {} : { oldest: known.checkedTs }),
    });
    const latest = found.join ?? known;
    if (latest === undefined) return null;
    botJoins.set(key, {
      inviter: latest.inviter,
      checkedTs: found.newestTs ?? known?.checkedTs ?? event.messageTs,
    });
    return latest.inviter;
  }

  async function conversationKind(
    organizationId: string,
    event: NormalizedSlackMentionEvent,
  ): Promise<"im" | "mpim" | "channel"> {
    if (event.channelType === "im") return "im";
    if (event.channelType !== null) return "channel";
    const key = `${event.teamId}:${event.channelId}`;
    const known = conversationKinds.get(key);
    if (known !== undefined) return known;
    if (options.client.readConversationKind === undefined)
      throw new Error("Slack conversation info is unavailable");
    const kind = await options.client.readConversationKind({
      organizationId,
      teamId: event.teamId,
      channelId: event.channelId,
    });
    conversationKinds.set(key, kind);
    return kind;
  }

  /** Group DMs count as direct messages. Undefined when Slack could not say, which refuses. */
  async function readConversationAccess(
    organizationId: string,
    event: NormalizedSlackMentionEvent,
    botUserId: string,
  ): Promise<ConversationAccess | undefined> {
    try {
      if ((await conversationKind(organizationId, event)) !== "channel")
        return { direct: true, inviter: null };
      return { direct: false, inviter: await channelInviter(organizationId, event, botUserId) };
    } catch (error) {
      reportFailure(
        error,
        { operation: "slack.conversation.access", component: "triggers", provider: "slack" },
        { diagnostic: { teamId: event.teamId, channelId: event.channelId } },
      );
      return undefined;
    }
  }

  /** Applies `channel_inviters` and `direct_message_users`, reading Slack at most once. */
  async function permittedTriggers(
    matched: MatchedSlackTrigger[],
    organizationId: string,
    event: NormalizedSlackMentionEvent,
    botUserId: string,
  ): Promise<MatchedSlackTrigger[]> {
    let access: Promise<ConversationAccess | undefined> | undefined;
    const permitted = [];
    for (const match of matched) {
      const filters = match.trigger.filters;
      if (filters?.channel_inviters !== undefined || filters?.direct_message_users !== undefined) {
        access ??= readConversationAccess(organizationId, event, botUserId);
        if (!allowsConversation(filters, await access, event.author.id)) continue;
      }
      permitted.push(match);
    }
    return permitted;
  }

  /** Records the bot's own join, and leaves at once when no trigger accepts that inviter. */
  async function handleJoin(
    organizationId: string,
    event: NormalizedSlackMentionEvent,
    botUserId: string,
    triggers: readonly Pick<CompiledTriggerConfig, "on" | "filters">[],
  ): Promise<void> {
    if (event.join === undefined || event.author.id !== botUserId) return;
    const { inviter } = event.join;
    botJoins.set(`${event.teamId}:${event.channelId}`, { inviter, checkedTs: event.messageTs });
    const slackTriggers = triggers.filter((candidate) => candidate.on === "slack.mention");
    const accepted = slackTriggers.some(
      (candidate) =>
        candidate.filters !== undefined &&
        (candidate.filters.channel_inviters === undefined ||
          (inviter !== null && candidate.filters.channel_inviters.includes(inviter))),
    );
    if (accepted || !slackTriggers.some((candidate) => candidate.filters?.channel_inviters)) return;
    try {
      await options.client.leaveChannel?.({
        organizationId,
        teamId: event.teamId,
        channelId: event.channelId,
      });
    } catch (error) {
      reportFailure(
        error,
        { operation: "slack.channel.leave", component: "triggers", provider: "slack" },
        { diagnostic: { teamId: event.teamId, channelId: event.channelId } },
      );
    }
  }

  return {
    name: "slack",
    eventNames: ["slack.mention"],
    async match(trigger) {
      const rawEvent = NormalizedSlackMentionEventSchema.parse(trigger.payload);
      const botUserId = await options.botUserIdForWorkspace(
        trigger.organizationId,
        rawEvent.teamId,
      );
      if (botUserId === undefined) return "configuration_unavailable";
      const stored = await options
        .configurationStoreForProject(trigger.projectId)
        .getRevision(trigger.configurationRevisionId);
      if (stored === undefined) return "configuration_unavailable";
      if (!stored.configuration.triggers.some((candidate) => candidate.on === trigger.source))
        return "no_trigger_for_source";
      if (rawEvent.join !== undefined) {
        await handleJoin(
          trigger.organizationId,
          rawEvent,
          botUserId,
          stored.configuration.triggers,
        );
        return "trigger_filters_rejected";
      }
      const event = needsSlackUsername(stored.configuration.triggers, rawEvent.author.id)
        ? await enrichSlackAuthor(rawEvent, trigger.organizationId, options.client)
        : rawEvent;
      const matchedTriggers = matchSlackTriggers(
        stored.configuration,
        event,
        botUserId,
        trigger.connectionId,
        await followsThread(stored.configuration.triggers, event, trigger.projectId),
      );
      const permitted = await permittedTriggers(
        matchedTriggers,
        trigger.organizationId,
        event,
        botUserId,
      );
      if (permitted.length === 0) return "trigger_filters_rejected";
      const matches: TriggerProviderMatch<SlackTriggerContext, SlackOutputContext>[] = [];

      for (const match of permitted) {
        const compiledTrigger = stored.configuration.triggers.find(
          (candidate) => candidate.name === match.trigger.name,
        );
        if (compiledTrigger === undefined)
          throw new Error(`compiled trigger not found: ${match.trigger.name}`);
        const outputContext: SlackOutputContext = {
          provider: "slack",
          organizationId: trigger.organizationId,
          teamId: rawEvent.teamId,
          channelId: rawEvent.channelId,
          threadTs: rawEvent.threadTs ?? rawEvent.messageTs,
          messageTs: rawEvent.messageTs,
        };
        const triggerContext: SlackTriggerContext = {
          provider: "slack",
          target: outputContext,
          event: buildSlackMergeData(rawEvent, botUserId, trigger.connectionId),
        };
        const invocation = parseInvocation(
          rawEvent.content,
          compiledTrigger.inputs,
          undefined,
          readSlackInvocationParserMessage(rawEvent, botUserId, compiledTrigger.filters),
        );
        if (invocation.status === "accepted") {
          if (!matchesInputFilters(invocation.inputs, compiledTrigger.filters?.inputs)) continue;
        }
        if (invocation.status === "rejected") {
          matches.push({
            conversation: {
              key: slackConversationKey(rawEvent),
              label: "Slack thread",
            },
            triggerName: match.trigger.name,
            triggerContext,
            outputContext,
            configurationRevisionId: stored.revision.id,
            hubConfig: stored.configuration,
            invocation,
          });
          continue;
        }
        matches.push({
          conversation: {
            key: slackConversationKey(rawEvent),
            label: "Slack thread",
          },
          triggerName: match.trigger.name,
          triggerContext,
          outputContext,
          configurationRevisionId: stored.revision.id,
          hubConfig: stored.configuration,
          invocation,
        });
      }
      return matches.length === 0 ? "trigger_filters_rejected" : matches;
    },
    async materializeContext(launch): Promise<SlackMaterializedContext> {
      const locator = launch.triggerContext.event.slack.trigger_thread_context;
      const { ts, author, channel, thread, attachments } =
        launch.triggerContext.event.slack.trigger_message;
      const triggerMessage: SlackMaterializedTriggerMessage = {
        ts,
        author: {
          id: author.id,
          name: await readDisplayName(
            options.client,
            launch.organizationId,
            launch.triggerContext.event.slack.team.id,
            author.id,
          ),
        },
        channel: { id: channel.id },
        thread: thread === null ? null : { ts: thread.ts },
        attachments: await registerAttachments(
          attachments.map((attachment) => ({
            id: attachment.id,
            filename: attachment.filename,
            contentType: attachment.content_type,
            size: attachment.size,
          })),
          launch.providerEventReceiptId,
          launch.organizationId,
          launch.triggerContext.event.slack.team.id,
          launch.triggerContext.event.slack.connection_id,
          launch.executionId,
          options.attachments,
        ),
      };
      if (locator.status === "not_applicable") {
        return {
          slack: {
            trigger_message: triggerMessage,
            thread: { status: "not_applicable", messages: [] },
          },
        };
      }
      if (options.client.readThreadMessages === undefined) {
        return {
          slack: {
            trigger_message: triggerMessage,
            thread: { status: "unavailable", messages: [] },
          },
        };
      }
      let history;
      try {
        history = await options.client.readThreadMessages({
          organizationId: launch.organizationId,
          teamId: launch.triggerContext.event.slack.team.id,
          channelId: locator.channel.id,
          threadTs: locator.thread.ts,
          beforeTs: locator.before.ts,
        });
      } catch (error) {
        reportFailure(
          error,
          { operation: "slack.thread.hydrate", component: "triggers", provider: "slack" },
          {
            diagnostic: {
              teamId: launch.triggerContext.event.slack.team.id,
              channelId: locator.channel.id,
            },
          },
        );
        return {
          slack: {
            trigger_message: triggerMessage,
            thread: { status: "unavailable", messages: [] },
          },
        };
      }
      const messages = await Promise.all(
        history.messages.map(async (message) => ({
          ts: message.ts,
          content: message.content,
          author: message.author,
          channel: { id: locator.channel.id },
          created_at: message.createdAt,
          attachments: await registerAttachments(
            message.attachments,
            launch.providerEventReceiptId,
            launch.organizationId,
            launch.triggerContext.event.slack.team.id,
            launch.triggerContext.event.slack.connection_id,
            launch.executionId,
            options.attachments,
          ),
        })),
      );
      return {
        slack: {
          trigger_message: triggerMessage,
          thread: {
            status: history.complete ? "available" : "incomplete",
            messages,
          },
        },
      };
    },
    async onDispatchAccepted(context, _outputContext, reactionState) {
      if (slackReactionPhase(reactionState) !== undefined) return reactionState;
      await addReactionSafely(options.client, context.target, "eyes");
      return { phase: "accepted" };
    },
    async onAgentExecutionStarted(context, _outputContext, reactionState) {
      if (slackReactionPhase(reactionState) === "started") return reactionState;
      await replaceReaction(options.client, context.target, "eyes", "hourglass_flowing_sand");
      await setThreadStatusSafely(options.client, context.target, "processing");
      return { phase: "started" };
    },
    async onAgentExecutionCompleted(context, _outputContext, _result, reactionState) {
      await setThreadStatusSafely(options.client, context.target, "active");
      await removeReactionForPhase(options.client, context.target, reactionState, "started");
      await addReaction(options.client, context.target, "white_check_mark");
      return null;
    },
    async onAgentExecutionFailed(context, _output, reason, reactionState) {
      await setThreadStatusSafely(options.client, context.target, "active");
      await failWithNotice(
        options.client,
        context.target,
        await agentFailureNotice(
          reason,
          context.target.organizationId,
          options.billingUrlForOrganization ?? missingBillingUrl,
        ),
        reactionState,
      );
      return null;
    },
    async onMachineTerminated(context, reason, reactionState) {
      // Every ending clears the status; only these two also mark the message failed.
      await setThreadStatusSafely(options.client, context.target, "active");
      if (reason === "launch_failed" || reason === "daemon_disconnected") {
        await failWithNotice(
          options.client,
          context.target,
          `Paseo agent failed: ${reason}`,
          reactionState,
        );
        return null;
      }
      return reactionState;
    },
  };
}

async function readDisplayName(
  client: SlackBotClient,
  organizationId: string,
  teamId: string,
  userId: string,
): Promise<string | null> {
  if (client.lookupUserDisplayName === undefined) return null;
  try {
    return (await client.lookupUserDisplayName({ organizationId, teamId, userId })) ?? null;
  } catch (error) {
    reportFailure(
      error,
      { operation: "slack.user.display_name", component: "triggers", provider: "slack" },
      { diagnostic: { teamId, userId } },
    );
    return null;
  }
}

async function enrichSlackAuthor(
  event: NormalizedSlackMentionEvent,
  organizationId: string,
  client: SlackBotClient,
): Promise<NormalizedSlackMentionEvent> {
  if (client.lookupUserName === undefined) return event;
  try {
    const username = await client.lookupUserName({
      organizationId,
      teamId: event.teamId,
      userId: event.author.id,
    });
    return username === undefined ? event : { ...event, author: { ...event.author, username } };
  } catch (error) {
    reportFailure(
      error,
      { operation: "slack.user.lookup", component: "triggers", provider: "slack" },
      { diagnostic: { teamId: event.teamId, userId: event.author.id } },
    );
    return event;
  }
}

function needsSlackUsername(
  triggers: readonly Pick<CompiledTriggerConfig, "on" | "filters">[],
  authorId: string,
): boolean {
  return triggers.some(
    (candidate) =>
      candidate.on === "slack.mention" &&
      candidate.filters?.from_users !== undefined &&
      !candidate.filters.from_users.includes("*") &&
      !candidate.filters.from_users.includes(authorId),
  );
}

async function removeReactionForPhase(
  client: SlackBotClient,
  target: SlackOutputContext,
  reactionState: TriggerProviderReactionState | undefined,
  fallbackPhase?: SlackReactionPhase,
): Promise<void> {
  const phase = slackReactionPhase(reactionState) ?? fallbackPhase;
  if (phase === "accepted") {
    await removeReactionSafely(client, target, "eyes");
    return;
  }
  if (phase === "started") {
    await removeReactionSafely(client, target, "hourglass_flowing_sand");
    return;
  }
  await removeReactionSafely(client, target, "eyes");
  await removeReactionSafely(client, target, "hourglass_flowing_sand");
}

function slackReactionPhase(
  reactionState: TriggerProviderReactionState | undefined,
): SlackReactionPhase | undefined {
  if (typeof reactionState !== "object" || reactionState === null || Array.isArray(reactionState)) {
    return undefined;
  }
  const phase = reactionState["phase"];
  return phase === "accepted" || phase === "started" ? phase : undefined;
}

function buildSlackMergeData(
  event: NormalizedSlackMentionEvent,
  botUserId: string,
  connectionId: string | null | undefined,
): SlackMergeData {
  return {
    slack: {
      event_type: event.mentioned ? "app_mention" : "message",
      event_id: event.id,
      event_ts: event.eventTs,
      event_time: event.eventTime,
      connection_id: connectionId ?? null,
      team: { id: event.teamId },
      app: { id: event.appId },
      trigger_message: {
        ts: event.messageTs,
        content: event.content,
        body: readSlackPromptBody(event, botUserId),
        author: event.author,
        channel: { id: event.channelId },
        thread: event.threadTs === null ? null : { ts: event.threadTs },
        created_at: event.createdAt,
        attachments: event.attachments.map((attachment) => ({
          id: attachment.id,
          filename: attachment.filename,
          content_type: attachment.contentType,
          size: attachment.size,
        })),
      },
      trigger_thread_context:
        event.threadTs === null
          ? { status: "not_applicable" }
          : {
              status: "deferred",
              channel: { id: event.channelId },
              thread: { ts: event.threadTs },
              before: { ts: event.messageTs },
            },
    },
  };
}

async function registerAttachments(
  source: SlackThreadMessage["attachments"],
  providerEventReceiptId: string,
  organizationId: string,
  teamId: string,
  connectionId: string | null,
  executionId: string,
  attachments: AttachmentCapabilityRegistry | undefined,
): Promise<AttachmentDescriptor[]> {
  if (source.length === 0) return [];
  if (attachments === undefined) throw new Error("attachment capability unavailable");
  if (connectionId === null) {
    throw new Error("attachment ownership unavailable");
  }
  const references = await Promise.all(
    source.map((file) =>
      attachments.register({
        providerEventReceiptId,
        organizationId,
        connectionId,
        provider: "slack",
        sourceId: file.id,
        locator: { teamId, fileId: file.id },
        filename: file.filename,
        contentType: file.contentType,
        byteSize: file.size,
      }),
    ),
  );
  return references.map((reference) => attachments.materialize(reference, executionId));
}

async function replaceReaction(
  client: SlackBotClient,
  event: SlackOutputContext,
  from: string,
  to: string,
): Promise<void> {
  await removeReactionSafely(client, event, from);
  await addReactionSafely(client, event, to);
}

/** Status is a courtesy: Slack drops `processing` after an hour, so a failed call never blocks a run. */
async function setThreadStatusSafely(
  client: SlackBotClient,
  event: SlackOutputContext,
  status: "processing" | "active",
): Promise<void> {
  if (client.setThreadStatus === undefined) return;
  try {
    await client.setThreadStatus({
      organizationId: event.organizationId,
      teamId: event.teamId,
      channelId: event.channelId,
      threadTs: event.threadTs,
      status,
    });
  } catch (error) {
    reportFailure(
      error,
      { operation: "slack.thread.status", component: "triggers", provider: "slack" },
      { diagnostic: { teamId: event.teamId, status } },
    );
  }
}

async function failWithNotice(
  client: SlackBotClient,
  event: SlackOutputContext,
  reason: string,
  reactionState?: TriggerProviderReactionState,
): Promise<void> {
  await removeReactionForPhase(client, event, reactionState);
  await addReaction(client, event, "x");
  await client.sendMessage({
    organizationId: event.organizationId,
    teamId: event.teamId,
    channelId: event.channelId,
    threadTs: event.threadTs,
    content: reason,
  });
}

async function addReaction(
  client: SlackBotClient,
  event: SlackOutputContext,
  name: string,
): Promise<void> {
  await client.addReaction({
    organizationId: event.organizationId,
    teamId: event.teamId,
    channelId: event.channelId,
    messageTs: event.messageTs,
    name,
  });
}

async function addReactionSafely(
  client: SlackBotClient,
  event: SlackOutputContext,
  name: string,
): Promise<void> {
  try {
    await client.addReaction({
      organizationId: event.organizationId,
      teamId: event.teamId,
      channelId: event.channelId,
      messageTs: event.messageTs,
      name,
    });
  } catch (error) {
    reportFailure(
      error,
      { operation: "slack.reaction.add", component: "triggers", provider: "slack" },
      { diagnostic: { teamId: event.teamId, reaction: name } },
    );
  }
}

async function removeReactionSafely(
  client: SlackBotClient,
  event: SlackOutputContext,
  name: string,
): Promise<void> {
  try {
    await client.removeReaction({
      organizationId: event.organizationId,
      teamId: event.teamId,
      channelId: event.channelId,
      messageTs: event.messageTs,
      name,
    });
  } catch (error) {
    reportFailure(
      error,
      { operation: "slack.reaction.cleanup", component: "triggers", provider: "slack" },
      { diagnostic: { teamId: event.teamId, reaction: name } },
    );
  }
}
