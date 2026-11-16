import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { compileHubConfig } from "../../config/index.js";
import type { NormalizedSlackMentionEvent } from "./events.js";
import { matchSlackTriggers, readSlackPromptBody } from "./match.js";

describe("Slack trigger matching", () => {
  it("allows exact, case-sensitive Slack usernames as well as user IDs", () => {
    const config = configForUsers(["operator", "U2"]);

    assert.equal(matchSlackTriggers(config, mention({ username: "operator" }), "UBOT").length, 1);
    assert.equal(matchSlackTriggers(config, mention({ username: "Operator" }), "UBOT").length, 0);
    assert.equal(matchSlackTriggers(config, mention({ authorId: "U2" }), "UBOT").length, 1);
  });

  it("allows every human author only when the wildcard is explicit", () => {
    const config = configForUsers(["*"]);

    assert.equal(matchSlackTriggers(config, mention({ authorId: "stranger" }), "UBOT").length, 1);
  });

  it("requires the compiled trigger filters and bot mention", () => {
    const config = compileHubConfig({
      environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
      triggers: [
        {
          name: "slack-run",
          on: "slack.mention",
          max_runtime: "2h",
          filters: {
            workspace: "T1",
            channels: ["C1"],
            from_users: ["U1"],
            pattern: "run",
          },
          steps: [
            {
              id: "run",
              environment: "runner",
              max_runtime: "1h",
              idle_timeout: "5m",
              agent: { provider: "opencode", mode: "default" },
              prompt: [{ text: "Run the request" }],
            },
          ],
        },
      ],
    });
    const event = mention();

    assert.equal(matchSlackTriggers(config, event, "UBOT").length, 1);
    assert.equal(readSlackPromptBody(event, "UBOT"), "run tests");
    assert.equal(
      matchSlackTriggers(config, { ...event, author: { id: "UBOT" } }, "UBOT").length,
      0,
    );
    assert.equal(matchSlackTriggers(config, { ...event, teamId: "T2" }, "UBOT").length, 0);
    assert.equal(matchSlackTriggers(config, { ...event, channelId: "C2" }, "UBOT").length, 0);
    assert.equal(
      matchSlackTriggers(config, { ...event, content: "<@UBOT> please run tests" }, "UBOT").length,
      0,
    );
    assert.equal(matchSlackTriggers(config, { ...event, content: "run tests" }, "UBOT").length, 0);
  });

  it("runs a direct message without a mention only when the trigger opts in", () => {
    const dm: NormalizedSlackMentionEvent = {
      ...mention(),
      channelId: "D1",
      threadTs: null,
      content: "what broke on staging?",
      mentioned: false,
      channelType: "im",
    };
    const allChannels = { channels: ["C1", "D1"] };

    assert.equal(matchSlackTriggers(configForUsers(["U1"], allChannels), dm, "UBOT").length, 0);
    const optedIn = configForUsers(["U1"], { ...allChannels, direct_messages: true });
    assert.equal(matchSlackTriggers(optedIn, dm, "UBOT").length, 1);
    assert.equal(
      matchSlackTriggers(optedIn, { ...dm, author: { id: "stranger" } }, "UBOT").length,
      0,
    );
  });

  it("follows a thread without a mention only where the bot recently worked", () => {
    const reply: NormalizedSlackMentionEvent = {
      ...mention(),
      messageTs: "1700000000.000002",
      content: "and the PDF too",
      mentioned: false,
      channelType: "channel",
    };
    const following = configForUsers(["U1"], { follow_threads: true });

    assert.equal(matchSlackTriggers(configForUsers(["U1"]), reply, "UBOT", null, true).length, 0);
    assert.equal(matchSlackTriggers(following, reply, "UBOT", null, false).length, 0);
    assert.equal(matchSlackTriggers(following, reply, "UBOT", null, true).length, 1);
    assert.equal(
      matchSlackTriggers(following, { ...reply, author: { id: "stranger" } }, "UBOT", null, true)
        .length,
      0,
    );
    // The same message's app_mention event runs it; its message event must not run it again.
    assert.equal(
      matchSlackTriggers(
        following,
        { ...reply, content: "<@UBOT> and the PDF" },
        "UBOT",
        null,
        true,
      ).length,
      0,
    );
  });
});

function configForUsers(
  fromUsers: string[],
  extra: { direct_messages?: boolean; follow_threads?: boolean; channels?: string[] } = {},
) {
  return compileHubConfig({
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
    triggers: [
      {
        name: "slack-run",
        on: "slack.mention",
        max_runtime: "2h",
        filters: { workspace: "T1", channels: ["C1"], from_users: fromUsers, ...extra },
        steps: [
          {
            id: "run",
            environment: "runner",
            max_runtime: "1h",
            idle_timeout: "5m",
            agent: { provider: "opencode", mode: "default" },
            prompt: [{ text: "Run the request" }],
          },
        ],
      },
    ],
  });
}

function mention(
  overrides: { authorId?: string; username?: string } = {},
): NormalizedSlackMentionEvent {
  return {
    type: "mention",
    id: "Ev1",
    teamId: "T1",
    appId: "A1",
    channelId: "C1",
    messageTs: "1700000000.000001",
    threadTs: "1700000000.000001",
    eventTs: "1700000000.000001",
    eventTime: 1_700_000_001,
    content: "hello <@UBOT> run tests",
    author: {
      id: overrides.authorId ?? "U1",
      ...(overrides.username === undefined ? {} : { username: overrides.username }),
    },
    createdAt: new Date(1_700_000_000_000).toISOString(),
    attachments: [],
    mentioned: true,
    channelType: null,
  };
}
