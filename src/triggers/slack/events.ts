import { z } from "zod";

const SlackIdSchema = z.string().min(1).max(255);
const SlackTimestampSchema = z.string().regex(/^\d+\.\d+$/u);
const SlackAttachmentMetadataSchema = z.object({
  id: SlackIdSchema,
  filename: z.string().min(1).max(255),
  contentType: z.string().max(255).nullable(),
  size: z.number().int().nonnegative().nullable(),
});
export const SlackUrlVerificationSchema = z
  .object({
    type: z.literal("url_verification"),
    challenge: z.string().min(1),
    api_app_id: SlackIdSchema.optional(),
  })
  .passthrough();

export const SlackEventCallbackSchema = z
  .object({
    type: z.literal("event_callback"),
    team_id: SlackIdSchema,
    api_app_id: SlackIdSchema,
    event_id: SlackIdSchema,
    event_time: z.number().int().nonnegative(),
    is_ext_shared_channel: z.boolean().optional(),
    event: z.unknown(),
  })
  .passthrough();

const SlackAppMentionSchema = z
  .object({
    type: z.literal("app_mention"),
    user: SlackIdSchema,
    channel: SlackIdSchema,
    text: z.string(),
    ts: SlackTimestampSchema,
    event_ts: SlackTimestampSchema,
    thread_ts: SlackTimestampSchema.optional(),
    bot_id: SlackIdSchema.optional(),
    subtype: z.string().optional(),
    files: z
      .array(
        z
          .object({
            id: SlackIdSchema,
            name: z.string().min(1).max(255).optional(),
            title: z.string().min(1).max(255).optional(),
            mimetype: z.string().max(255).optional(),
            size: z.number().int().nonnegative().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const SlackFileSchema = z
  .object({
    id: SlackIdSchema,
    name: z.string().min(1).max(255).optional(),
    title: z.string().min(1).max(255).optional(),
    mimetype: z.string().max(255).optional(),
    size: z.number().int().nonnegative().optional(),
  })
  .passthrough();

/** A message event (message.channels / message.groups / message.im) posted by a person. */
const SlackMessageSchema = z
  .object({
    type: z.literal("message"),
    subtype: z.enum(["file_share", "thread_broadcast"]).optional(),
    user: SlackIdSchema,
    channel: SlackIdSchema,
    channel_type: z.enum(["channel", "group", "im"]),
    text: z.string(),
    ts: SlackTimestampSchema,
    event_ts: SlackTimestampSchema.optional(),
    thread_ts: SlackTimestampSchema.optional(),
    bot_id: SlackIdSchema.optional(),
    files: z.array(SlackFileSchema).optional(),
  })
  .passthrough();

/** A member joining a channel (message.channels / message.groups); `inviter` is absent if they joined alone. */
const SlackChannelJoinSchema = z
  .object({
    type: z.literal("message"),
    subtype: z.literal("channel_join"),
    user: SlackIdSchema,
    channel: SlackIdSchema,
    channel_type: z.enum(["channel", "group"]).optional(),
    text: z.string().default(""),
    ts: SlackTimestampSchema,
    inviter: SlackIdSchema.optional(),
  })
  .passthrough();

export const NormalizedSlackMentionEventSchema = z.object({
  type: z.literal("mention"),
  id: SlackIdSchema,
  teamId: SlackIdSchema,
  appId: SlackIdSchema,
  channelId: SlackIdSchema,
  messageTs: SlackTimestampSchema,
  threadTs: SlackTimestampSchema.nullable(),
  eventTs: SlackTimestampSchema,
  eventTime: z.number().int().nonnegative(),
  content: z.string(),
  author: z.object({ id: SlackIdSchema, username: z.string().min(1).max(255).optional() }),
  createdAt: z.string(),
  attachments: z.array(SlackAttachmentMetadataSchema).default([]),
  /** False for a message event: a direct message, or a reply in a thread without a mention. */
  mentioned: z.boolean().default(true),
  channelType: z.enum(["channel", "group", "im"]).nullable().default(null),
  /** Set when the event is the author joining the channel; never addressed to the bot. */
  join: z.object({ inviter: SlackIdSchema.nullable() }).optional(),
});

export type NormalizedSlackMentionEvent = z.infer<typeof NormalizedSlackMentionEventSchema>;

export function normalizeSlackEvent(
  envelope: z.infer<typeof SlackEventCallbackSchema>,
): NormalizedSlackMentionEvent | undefined {
  // Channels shared with another organization are refused before anything is stored.
  if (envelope.is_ext_shared_channel === true) return undefined;
  const mention = SlackAppMentionSchema.safeParse(envelope.event);
  if (mention.success) {
    if (mention.data.bot_id !== undefined || mention.data.subtype === "bot_message")
      return undefined;
    return normalized(envelope, mention.data, true, null);
  }
  const join = SlackChannelJoinSchema.safeParse(envelope.event);
  if (join.success)
    return {
      ...normalized(envelope, join.data, false, join.data.channel_type ?? null),
      join: { inviter: join.data.inviter ?? null },
    };
  const message = SlackMessageSchema.safeParse(envelope.event);
  if (!message.success || message.data.bot_id !== undefined) return undefined;
  const { channel_type: channelType, thread_ts: threadTs, ts } = message.data;
  // Outside a direct message only replies inside a thread are candidates to follow.
  if (channelType !== "im" && (threadTs === undefined || threadTs === ts)) return undefined;
  return normalized(envelope, message.data, false, channelType);
}

function normalized(
  envelope: z.infer<typeof SlackEventCallbackSchema>,
  event: {
    user: string;
    channel: string;
    text: string;
    ts: string;
    event_ts?: string | undefined;
    thread_ts?: string | undefined;
    files?: z.infer<typeof SlackFileSchema>[] | undefined;
  },
  mentioned: boolean,
  channelType: "channel" | "group" | "im" | null,
): NormalizedSlackMentionEvent {
  return NormalizedSlackMentionEventSchema.parse({
    type: "mention",
    id: envelope.event_id,
    teamId: envelope.team_id,
    appId: envelope.api_app_id,
    channelId: event.channel,
    messageTs: event.ts,
    threadTs: event.thread_ts ?? null,
    eventTs: event.event_ts ?? event.ts,
    eventTime: envelope.event_time,
    content: event.text,
    author: { id: event.user },
    createdAt: new Date(Number(event.ts) * 1_000).toISOString(),
    attachments: (event.files ?? []).map((file) => ({
      id: file.id,
      filename: file.name ?? file.title ?? file.id,
      contentType: file.mimetype ?? null,
      size: file.size ?? null,
    })),
    mentioned,
    channelType,
  });
}
