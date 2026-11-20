import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { normalizeSlackEvent, SlackEventCallbackSchema } from "./events.js";

function envelope(event: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return SlackEventCallbackSchema.parse({
    type: "event_callback",
    team_id: "T1",
    api_app_id: "A1",
    event_id: "Ev1",
    event_time: 1_700_000_001,
    event,
    ...extra,
  });
}

const mention = {
  type: "app_mention",
  user: "U1",
  channel: "C1",
  text: "<@UBOT> hi",
  ts: "1700000000.000002",
  event_ts: "1700000000.000002",
};
const message = { type: "message", user: "U1", channel: "C1", text: "hi", ts: "1700000000.000002" };
const threadReply = { ...message, channel_type: "channel", thread_ts: "1700000000.000001" };

describe("Slack event normalization", () => {
  it("keeps a mention as a mention", () => {
    const event = normalizeSlackEvent(envelope(mention));
    assert.equal(event?.mentioned, true);
    assert.equal(event?.channelType, null);
  });

  it("refuses every event from a channel shared with another organization", () => {
    for (const event of [mention, threadReply, { ...message, channel_type: "im" }])
      assert.equal(
        normalizeSlackEvent(envelope(event, { is_ext_shared_channel: true })),
        undefined,
      );
  });

  it("keeps direct messages and thread replies, and drops other message events", () => {
    const dm = normalizeSlackEvent(envelope({ ...message, channel: "D1", channel_type: "im" }));
    assert.deepEqual([dm?.mentioned, dm?.channelType, dm?.threadTs], [false, "im", null]);
    const reply = normalizeSlackEvent(envelope(threadReply));
    assert.deepEqual([reply?.mentioned, reply?.threadTs], [false, "1700000000.000001"]);
    assert.ok(normalizeSlackEvent(envelope({ ...threadReply, subtype: "file_share" })));

    for (const dropped of [
      { ...message, channel_type: "channel" },
      { ...threadReply, thread_ts: threadReply.ts },
      { ...message, channel_type: "mpim", thread_ts: "1700000000.000001" },
      { ...threadReply, bot_id: "B1" },
      { ...threadReply, subtype: "message_changed" },
      { ...threadReply, subtype: "bot_message" },
    ])
      assert.equal(normalizeSlackEvent(envelope(dropped)), undefined, JSON.stringify(dropped));
  });

  it("keeps a member joining a channel, with who added them, for the channel_inviters filter", () => {
    const join = { type: "message", subtype: "channel_join", user: "UBOT", channel: "C1" };
    const invited = normalizeSlackEvent(
      envelope({ ...join, text: "<@UBOT> has joined", ts: "1700000000.000003", inviter: "U2" }),
    );
    assert.deepEqual(invited?.join, { inviter: "U2" });
    assert.equal(invited?.author.id, "UBOT");
    const selfJoined = normalizeSlackEvent(
      envelope({ ...join, channel_type: "group", text: "", ts: "1700000000.000004" }),
    );
    assert.deepEqual(selfJoined?.join, { inviter: null });
    assert.equal(normalizeSlackEvent(envelope(mention))?.join, undefined);
  });
});
