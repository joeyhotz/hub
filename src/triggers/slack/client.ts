import { z } from "zod";
import { reportFailure } from "../../failures/index.js";

const SlackApiResponseSchema = z
  .object({ ok: z.boolean(), error: z.string().optional() })
  .passthrough();
const SlackFileSchema = z
  .object({
    id: z.string().min(1).max(255),
    name: z.string().min(1).max(255).optional(),
    title: z.string().min(1).max(255).optional(),
    mimetype: z.string().min(1).max(255).optional(),
    size: z.number().int().nonnegative().optional(),
  })
  .passthrough();
const SlackThreadMessageSchema = z
  .object({
    ts: z.string().regex(/^\d+\.\d+$/u),
    text: z.string().default(""),
    user: z.string().min(1).max(255).optional(),
    bot_id: z.string().min(1).max(255).optional(),
    files: z.array(SlackFileSchema).optional(),
    // Apps such as Sentry put the substance of a post in blocks or legacy attachments
    // and leave `text` as a one-line fallback. Each entry is parsed on its own, so one
    // unexpected shape drops only that entry, never the thread.
    blocks: z.array(z.unknown()).optional().catch(undefined),
    attachments: z.array(z.unknown()).optional().catch(undefined),
  })
  .passthrough();
const SlackTextObjectSchema = z.object({ text: z.string() }).passthrough();
const SlackBlockSchema = z
  .object({
    type: z.string(),
    text: SlackTextObjectSchema.optional().catch(undefined),
    fields: z.array(z.unknown()).optional().catch(undefined),
    elements: z.array(z.unknown()).optional().catch(undefined),
  })
  .passthrough();
const SlackLegacyAttachmentSchema = z
  .object({
    fallback: z.string().optional().catch(undefined),
    pretext: z.string().optional().catch(undefined),
    author_name: z.string().optional().catch(undefined),
    title: z.string().optional().catch(undefined),
    title_link: z.string().optional().catch(undefined),
    text: z.string().optional().catch(undefined),
    fields: z.array(z.unknown()).optional().catch(undefined),
    footer: z.string().optional().catch(undefined),
    blocks: z.array(z.unknown()).optional().catch(undefined),
  })
  .passthrough();
const SlackAttachmentFieldSchema = z
  .object({ title: z.string().optional(), value: z.string().optional() })
  .passthrough();
const SlackThreadRepliesSchema = SlackApiResponseSchema.extend({
  messages: z.array(SlackThreadMessageSchema).optional(),
  response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
});
const SlackFileInfoSchema = SlackApiResponseSchema.extend({
  file: z
    .object({
      id: z.string().min(1).max(255),
      url_private_download: z.url(),
    })
    .optional(),
});
const SlackUserInfoSchema = SlackApiResponseSchema.extend({
  user: z
    .object({
      name: z.string().min(1).max(255),
      real_name: z.string().max(255).optional(),
      profile: z
        .object({
          display_name: z.string().max(255).optional(),
          real_name: z.string().max(255).optional(),
        })
        .optional(),
    })
    .optional(),
});
const SlackHistorySchema = SlackApiResponseSchema.extend({
  messages: z
    .array(
      z
        .object({
          ts: z.string().regex(/^\d+\.\d+$/u),
          subtype: z.string().optional(),
          user: z.string().optional(),
          inviter: z.string().min(1).max(255).optional(),
        })
        .passthrough(),
    )
    .optional(),
  response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
});
const SlackConversationInfoSchema = SlackApiResponseSchema.extend({
  channel: z
    .object({ is_im: z.boolean().optional(), is_mpim: z.boolean().optional() })
    .passthrough()
    .optional(),
});
const SLACK_API_TIMEOUT_MS = 10_000;
/** 200 messages a page: a join older than 10,000 top-level messages is reported as unknown. */
const SLACK_JOIN_HISTORY_MAX_PAGES = 50;
const SLACK_THREAD_REPLIES_MAX_PAGES = 10;
const SLACK_THREAD_CONTEXT_LIMIT = 50;
const SLACK_REACTION_TARGET_GONE = ["message_not_found", "channel_not_found"] as const;

export interface SlackAttachmentMetadata {
  id: string;
  filename: string;
  contentType: string | null;
  size: number | null;
}

export interface SlackThreadMessage {
  ts: string;
  createdAt: string;
  content: string;
  author: { id: string };
  attachments: SlackAttachmentMetadata[];
}

/** The newest join of a member found in channel history, and the newest message read. */
export interface SlackChannelJoinResult {
  join: { inviter: string | null } | undefined;
  newestTs: string | undefined;
}

export interface SlackThreadReadResult {
  messages: SlackThreadMessage[];
  complete: boolean;
}

export interface SlackBotClient {
  sendMessage(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    threadTs: string;
    content: string;
  }): Promise<void>;
  addReaction(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    messageTs: string;
    name: string;
  }): Promise<void>;
  removeReaction(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    messageTs: string;
    name: string;
  }): Promise<void>;
  /** Slack's agent session status for a thread: `processing` while an agent works. */
  setThreadStatus?(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    threadTs: string;
    status: "processing" | "active";
  }): Promise<void>;
  readThreadMessages?(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    threadTs: string;
    beforeTs: string;
  }): Promise<SlackThreadReadResult>;
  lookupUserName?(input: {
    organizationId: string;
    teamId: string;
    userId: string;
  }): Promise<string | undefined>;
  /** The name Slack shows for a member: display name, else real name, else handle. */
  lookupUserDisplayName?(input: {
    organizationId: string;
    teamId: string;
    userId: string;
  }): Promise<string | undefined>;
  downloadAttachment?(input: {
    organizationId: string;
    teamId: string;
    fileId: string;
  }): Promise<Response>;
  /**
   * Who most recently added `userId` to the channel, from Slack's `channel_join` message.
   * With `oldest`, reads only history after that message timestamp.
   */
  findChannelJoin?(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    userId: string;
    oldest?: string;
  }): Promise<SlackChannelJoinResult>;
  readConversationKind?(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
  }): Promise<"im" | "mpim" | "channel">;
  leaveChannel?(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
  }): Promise<void>;
}

/** Carries Slack's error code, which Hub logs; the message is never logged. */
export class SlackApiError extends Error {
  readonly code: string;

  constructor(error: string | undefined) {
    const code = error ?? "unknown_error";
    super(`Slack API ${code}`);
    this.name = "SlackApiError";
    this.code = code;
  }
}

export function createSlackBotClient(options: {
  tokenForWorkspace(organizationId: string, teamId: string): Promise<string | undefined>;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}): SlackBotClient {
  const request = options.fetch ?? fetch;

  async function call(
    organizationId: string,
    teamId: string,
    method: string,
    body: Record<string, string>,
    settledErrors: readonly string[] = [],
  ): Promise<void> {
    const token = await options.tokenForWorkspace(organizationId, teamId);
    if (token === undefined) throw new Error("Slack workspace is not connected");
    const response = await request(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? SLACK_API_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Slack API HTTP ${response.status}`);
    const result = SlackApiResponseSchema.parse(await response.json());
    if (!result.ok && !settledErrors.includes(result.error ?? "")) {
      throw new SlackApiError(result.error);
    }
  }

  async function queryJson(
    organizationId: string,
    teamId: string,
    method: string,
    query: Record<string, string>,
  ): Promise<unknown> {
    const token = await options.tokenForWorkspace(organizationId, teamId);
    if (token === undefined) throw new Error("Slack workspace is not connected");
    const url = new URL(`https://slack.com/api/${method}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const response = await request(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? SLACK_API_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Slack API HTTP ${response.status}`);
    return response.json();
  }

  async function readThreadMessages(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    threadTs: string;
    beforeTs: string;
  }): Promise<SlackThreadReadResult> {
    let cursor: string | undefined;
    let root: SlackThreadMessage | undefined;
    let selectedReplies: SlackThreadMessage[] = [];
    const seenCursors = new Set<string>();
    let complete = true;
    let pagesRead = 0;
    while (true) {
      let result: z.infer<typeof SlackThreadRepliesSchema>;
      try {
        result = SlackThreadRepliesSchema.parse(
          await queryJson(input.organizationId, input.teamId, "conversations.replies", {
            channel: input.channelId,
            ts: input.threadTs,
            latest: input.beforeTs,
            inclusive: "false",
            limit: "100",
            ...(cursor === undefined ? {} : { cursor }),
          }),
        );
        if (!result.ok) throw new SlackApiError(result.error);
      } catch (error) {
        if (root === undefined && selectedReplies.length === 0) throw error;
        reportFailure(
          error,
          { operation: "slack.thread.history.page", component: "providers", provider: "slack" },
          { diagnostic: { teamId: input.teamId, channelId: input.channelId, pagesRead } },
        );
        complete = false;
        break;
      }
      const page = (result.messages ?? [])
        .map(normalizeThreadMessage)
        .filter((message) => compareSlackTs(message.ts, input.beforeTs) < 0);
      root ??= page.find((message) => message.ts === input.threadTs);
      selectedReplies = [
        ...selectedReplies,
        ...page.filter((message) => message.ts !== input.threadTs),
      ]
        .sort((left, right) => compareSlackTs(right.ts, left.ts))
        .slice(0, SLACK_THREAD_CONTEXT_LIMIT - 1);
      pagesRead += 1;
      const next = result.response_metadata?.next_cursor;
      cursor = next === undefined || next.length === 0 ? undefined : next;
      if (cursor === undefined) break;
      if (seenCursors.has(cursor)) {
        complete = false;
        break;
      }
      seenCursors.add(cursor);
      if (pagesRead === SLACK_THREAD_REPLIES_MAX_PAGES) {
        complete = false;
        break;
      }
    }

    if (root === undefined) throw new Error("Slack thread root unavailable");
    return {
      messages: [root, ...selectedReplies.sort((left, right) => compareSlackTs(left.ts, right.ts))],
      complete,
    };
  }

  async function downloadAttachment(input: {
    organizationId: string;
    teamId: string;
    fileId: string;
  }): Promise<Response> {
    const token = await options.tokenForWorkspace(input.organizationId, input.teamId);
    if (token === undefined) throw new Error("Slack workspace is not connected");
    const result = SlackFileInfoSchema.parse(
      await queryJson(input.organizationId, input.teamId, "files.info", { file: input.fileId }),
    );
    if (!result.ok || result.file?.id !== input.fileId) {
      throw new Error(`Slack file ${input.fileId} is unavailable`);
    }
    const downloadUrl = new URL(result.file.url_private_download);
    if (
      downloadUrl.protocol !== "https:" ||
      !["files.slack.com", "slack.com"].includes(downloadUrl.hostname)
    ) {
      throw new Error("Slack returned an invalid attachment URL");
    }
    return request(downloadUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? SLACK_API_TIMEOUT_MS),
    });
  }

  async function findChannelJoin(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    userId: string;
    oldest?: string;
  }): Promise<SlackChannelJoinResult> {
    let cursor: string | undefined;
    let newestTs: string | undefined;
    for (let page = 0; page < SLACK_JOIN_HISTORY_MAX_PAGES; page += 1) {
      const result = SlackHistorySchema.parse(
        await queryJson(input.organizationId, input.teamId, "conversations.history", {
          channel: input.channelId,
          limit: "200",
          ...(input.oldest === undefined ? {} : { oldest: input.oldest }),
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      if (!result.ok) throw new SlackApiError(result.error);
      // Slack returns history newest first, so the first join found is the latest.
      const messages = result.messages ?? [];
      newestTs ??= messages[0]?.ts;
      const join = messages.find(
        (message) => message.subtype === "channel_join" && message.user === input.userId,
      );
      if (join !== undefined) return { join: { inviter: join.inviter ?? null }, newestTs };
      cursor = result.response_metadata?.next_cursor || undefined;
      if (cursor === undefined) return { join: undefined, newestTs };
    }
    throw new Error("Slack channel history is too long to find the join");
  }

  async function readConversationKind(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
  }): Promise<"im" | "mpim" | "channel"> {
    const result = SlackConversationInfoSchema.parse(
      await queryJson(input.organizationId, input.teamId, "conversations.info", {
        channel: input.channelId,
      }),
    );
    if (!result.ok) throw new SlackApiError(result.error);
    if (result.channel?.is_im === true) return "im";
    return result.channel?.is_mpim === true ? "mpim" : "channel";
  }

  async function lookupUserName(input: {
    organizationId: string;
    teamId: string;
    userId: string;
  }): Promise<string | undefined> {
    const result = SlackUserInfoSchema.parse(
      await queryJson(input.organizationId, input.teamId, "users.info", { user: input.userId }),
    );
    if (!result.ok) throw new SlackApiError(result.error);
    return result.user?.name;
  }

  async function lookupUserDisplayName(input: {
    organizationId: string;
    teamId: string;
    userId: string;
  }): Promise<string | undefined> {
    const result = SlackUserInfoSchema.parse(
      await queryJson(input.organizationId, input.teamId, "users.info", { user: input.userId }),
    );
    if (!result.ok) throw new SlackApiError(result.error);
    const user = result.user;
    return [
      user?.profile?.display_name,
      user?.profile?.real_name,
      user?.real_name,
      user?.name,
    ].find((name) => name !== undefined && name.trim().length > 0);
  }

  return {
    sendMessage: (input) =>
      call(input.organizationId, input.teamId, "chat.postMessage", {
        channel: input.channelId,
        thread_ts: input.threadTs,
        text: input.content,
      }),
    // A retried delivery finds the reaction already in place, or already gone. When the
    // message or its channel is gone there is nothing left to react to, and retrying
    // cannot succeed.
    addReaction: (input) =>
      call(
        input.organizationId,
        input.teamId,
        "reactions.add",
        { channel: input.channelId, timestamp: input.messageTs, name: input.name },
        ["already_reacted", ...SLACK_REACTION_TARGET_GONE],
      ),
    removeReaction: (input) =>
      call(
        input.organizationId,
        input.teamId,
        "reactions.remove",
        { channel: input.channelId, timestamp: input.messageTs, name: input.name },
        ["no_reaction", ...SLACK_REACTION_TARGET_GONE],
      ),
    setThreadStatus: (input) =>
      call(input.organizationId, input.teamId, "agents.sessions.setStatus", {
        channel_id: input.channelId,
        thread_ts: input.threadTs,
        status: input.status,
      }),
    readThreadMessages,
    lookupUserName,
    lookupUserDisplayName,
    downloadAttachment,
    findChannelJoin,
    readConversationKind,
    leaveChannel: (input) =>
      call(input.organizationId, input.teamId, "conversations.leave", {
        channel: input.channelId,
      }),
  };
}

function normalizeThreadMessage(
  message: z.infer<typeof SlackThreadMessageSchema>,
): SlackThreadMessage {
  return {
    ts: message.ts,
    createdAt: new Date(Number(message.ts) * 1_000).toISOString(),
    content: slackMessageContent(message),
    author: { id: message.user ?? message.bot_id ?? "unknown" },
    attachments: (message.files ?? []).map((file) => ({
      id: file.id,
      filename: file.name ?? file.title ?? file.id,
      contentType: file.mimetype ?? null,
      size: file.size ?? null,
    })),
  };
}

// `text` plus the readable text of section, header and context blocks and of legacy
// attachments. rich_text blocks are skipped: they mirror `text` for typed messages.
function slackMessageContent(message: z.infer<typeof SlackThreadMessageSchema>): string {
  const lines = [
    ...slackBlockLines(message.blocks),
    ...(message.attachments ?? []).flatMap(slackAttachmentLines),
  ];
  const seen = new Set([message.text.trim()]);
  const extra = lines
    .map((line) => line.trim())
    .filter((line) => {
      if (line.length === 0 || seen.has(line)) return false;
      seen.add(line);
      return true;
    });
  return [message.text, ...extra].filter((line) => line.length > 0).join("\n");
}

function slackBlockLines(blocks: unknown[] | undefined): string[] {
  return (blocks ?? []).flatMap((value) => {
    const block = SlackBlockSchema.safeParse(value);
    if (!block.success) return [];
    const { type, text, fields, elements } = block.data;
    if (type === "section") return [text?.text, ...slackTextObjects(fields)].filter(isString);
    if (type === "header") return text === undefined ? [] : [text.text];
    if (type === "context") return [slackTextObjects(elements).join(" ")];
    return [];
  });
}

function slackAttachmentLines(value: unknown): string[] {
  const attachment = SlackLegacyAttachmentSchema.safeParse(value);
  if (!attachment.success) return [];
  const { fallback, pretext, author_name, title, title_link, text, fields, footer, blocks } =
    attachment.data;
  const lines = [
    pretext,
    author_name,
    title !== undefined && title_link !== undefined ? `${title} (${title_link})` : title,
    text,
    ...(fields ?? []).flatMap((field) => {
      const parsed = SlackAttachmentFieldSchema.safeParse(field);
      if (!parsed.success) return [];
      const { title: label, value: fieldValue } = parsed.data;
      return [[label, fieldValue].filter(isString).join(": ")];
    }),
    ...slackBlockLines(blocks),
    footer,
  ].filter(isString);
  return lines.length > 0 || fallback === undefined ? lines : [fallback];
}

function slackTextObjects(values: unknown[] | undefined): string[] {
  return (values ?? []).flatMap((value) => {
    const parsed = SlackTextObjectSchema.safeParse(value);
    return parsed.success ? [parsed.data.text] : [];
  });
}

function isString(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function compareSlackTs(left: string, right: string): number {
  return Number(left) - Number(right);
}
