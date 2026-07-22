import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TeamsConnector } from '../index.js';
import type { RunContext } from '@flowforger/engine';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeCtx(): RunContext {
  return {
    variables: {},
    actions: new Map(),
    now: () => new Date(),
    sleep: async () => {},
    log: () => {},
    secrets: () => undefined,
    connector: () => {
      throw new Error('not needed');
    },
  } as unknown as RunContext;
}

let fetchCalls: Array<{ url: string; method: string; body?: any; headers?: Record<string, string> }> = [];
let fetchResponse: any;

function lastCall() {
  return fetchCalls[fetchCalls.length - 1];
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('TeamsConnector', () => {
  let connector: TeamsConnector;
  let ctx: RunContext;

  beforeEach(() => {
    fetchCalls = [];
    fetchResponse = {
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: async () => ({ value: [] }),
      text: async () => '{}',
    };
    (globalThis as any).fetch = async (url: string, opts: any) => {
      fetchCalls.push({
        url,
        method: opts?.method || 'GET',
        body: opts?.body ? JSON.parse(opts.body) : undefined,
        headers: opts?.headers,
      });
      return fetchResponse;
    };
    connector = new TeamsConnector({ token: 'test-token' });
    ctx = makeCtx();
  });

  /* ================================================================ */
  /*  1. Operation routing                                            */
  /* ================================================================ */

  describe('operation routing', () => {
    it('routes GetAllTeams to GET /me/joinedTeams', async () => {
      await connector.invoke('GetAllTeams', {}, ctx);
      assert.equal(fetchCalls.length, 1);
      assert.ok(lastCall().url.endsWith('/me/joinedTeams'));
      assert.equal(lastCall().method, 'GET');
    });

    it('routes GetTeam to GET /teams/{id}', async () => {
      await connector.invoke('GetTeam', { teamId: 'tid-1' }, ctx);
      assert.ok(lastCall().url.includes('/teams/tid-1'));
      assert.equal(lastCall().method, 'GET');
    });

    it('routes CreateATeam to POST /teams', async () => {
      await connector.invoke('CreateATeam', { displayName: 'MyTeam' }, ctx);
      assert.ok(lastCall().url.endsWith('/teams'));
      assert.equal(lastCall().method, 'POST');
    });

    it('routes CreateChannel to POST /teams/{id}/channels', async () => {
      await connector.invoke('CreateChannel', { groupId: 'g1', displayName: 'General' }, ctx);
      assert.ok(lastCall().url.includes('/teams/g1/channels'));
      assert.equal(lastCall().method, 'POST');
    });

    it('routes CreateChat to POST /chats', async () => {
      await connector.invoke('CreateChat', { members: 'u1;u2' }, ctx);
      assert.ok(lastCall().url.endsWith('/chats'));
      assert.equal(lastCall().method, 'POST');
    });

    it('routes CreateTag to POST /teams/{id}/tags', async () => {
      await connector.invoke('CreateTag', { groupId: 'g1', displayName: 'Tag1', members: 'u1' }, ctx);
      assert.ok(lastCall().url.includes('/teams/g1/tags'));
      assert.equal(lastCall().method, 'POST');
    });

    it('routes CreateTeamsMeeting to POST /me/events', async () => {
      await connector.invoke('CreateTeamsMeeting', { subject: 'Standup' }, ctx);
      assert.ok(lastCall().url.endsWith('/me/events'));
      assert.equal(lastCall().method, 'POST');
    });
  });

  /* ================================================================ */
  /*  2. Unknown operation throws                                     */
  /* ================================================================ */

  describe('unknown operation', () => {
    it('throws for an unrecognised operation name', async () => {
      await assert.rejects(
        () => connector.invoke('DoSomethingRandom', {}, ctx),
        (err: Error) => {
          assert.match(err.message, /unknown operation/);
          return true;
        },
      );
    });
  });

  /* ================================================================ */
  /*  3. Webhook operations throw "not supported for local execution" */
  /* ================================================================ */

  describe('webhook operations', () => {
    for (const op of [
      'PostCardAndWaitForResponse',
      'postCardAndWaitForResponse',
      'SubscribeUserMessageWithOptions',
      'subscribeUserMessageWithOptions',
    ]) {
      it(`throws for webhook operation '${op}'`, async () => {
        await assert.rejects(
          () => connector.invoke(op, {}, ctx),
          (err: Error) => {
            assert.match(err.message, /not supported for local execution/);
            return true;
          },
        );
      });
    }
  });

  /* ================================================================ */
  /*  4. Graph API URL construction                                   */
  /* ================================================================ */

  describe('URL construction', () => {
    it('uses default base URL https://graph.microsoft.com/v1.0', async () => {
      await connector.invoke('GetAllTeams', {}, ctx);
      assert.ok(lastCall().url.startsWith('https://graph.microsoft.com/v1.0/'));
    });

    it('supports custom base URL', async () => {
      const custom = new TeamsConnector({ token: 'tok', baseUrl: 'https://graph.example.com/beta' });
      await custom.invoke('GetAllTeams', {}, ctx);
      assert.ok(lastCall().url.startsWith('https://graph.example.com/beta/'));
    });

    it('encodes special characters in IDs', async () => {
      await connector.invoke('GetTeam', { teamId: 'team with spaces' }, ctx);
      assert.ok(lastCall().url.includes('team%20with%20spaces'));
    });

    it('constructs correct channel path /teams/{gid}/channels/{cid}', async () => {
      await connector.invoke('GetChannel', { groupId: 'g1', channelId: 'c1' }, ctx);
      assert.ok(lastCall().url.includes('/teams/g1/channels/c1'));
    });

    it('constructs correct allChannels path', async () => {
      await connector.invoke('GetAllChannelsForTeam', { groupId: 'g1' }, ctx);
      assert.ok(lastCall().url.includes('/teams/g1/allChannels'));
    });

    it('constructs correct tag members path', async () => {
      await connector.invoke('GetTagMembers', { groupId: 'g1', tagId: 't1' }, ctx);
      assert.ok(lastCall().url.includes('/teams/g1/tags/t1/members'));
    });

    it('constructs correct chat messages path for chat-based message', async () => {
      await connector.invoke('PostMessageToConversation', {
        'body/location': 'Chat with Flow bot',
        'body/recipient/chatId': 'chat-99',
        'body/messageBody': 'Hello',
      }, ctx);
      assert.ok(lastCall().url.includes('/chats/chat-99/messages'));
    });

    it('constructs correct channel messages path for channel-based message', async () => {
      await connector.invoke('PostMessageToConversation', {
        'body/recipient/groupId': 'g1',
        'body/recipient/channelId': 'c1',
        'body/messageBody': 'Hello',
      }, ctx);
      assert.ok(lastCall().url.includes('/teams/g1/channels/c1/messages'));
    });

    it('constructs correct reply path', async () => {
      await connector.invoke('ReplyWithMessageToConversation', {
        groupId: 'g1',
        channelId: 'c1',
        messageId: 'm1',
        messageBody: 'reply',
      }, ctx);
      assert.ok(lastCall().url.includes('/teams/g1/channels/c1/messages/m1/replies'));
    });

    it('constructs correct channel message details path', async () => {
      await connector.invoke('GetMessageDetails', {
        threadType: 'channel',
        groupId: 'g1',
        channelId: 'c1',
        messageId: 'm1',
      }, ctx);
      assert.ok(lastCall().url.includes('/teams/g1/channels/c1/messages/m1'));
    });

    it('constructs correct chat message details path', async () => {
      await connector.invoke('GetMessageDetails', {
        threadType: 'chat',
        chatId: 'chat-1',
        messageId: 'm1',
      }, ctx);
      assert.ok(lastCall().url.includes('/chats/chat-1/messages/m1'));
    });

    it('constructs correct messages from channel path', async () => {
      await connector.invoke('GetMessagesFromChannel', { groupId: 'g1', channelId: 'c1' }, ctx);
      assert.ok(lastCall().url.includes('/teams/g1/channels/c1/messages'));
    });

    it('constructs correct messages from chat path', async () => {
      await connector.invoke('GetMessagesFromChat', { chatId: 'chat-1' }, ctx);
      assert.ok(lastCall().url.includes('/chats/chat-1/messages'));
    });

    it('constructs correct list replies path', async () => {
      await connector.invoke('ListRepliesToMessage', { groupId: 'g1', channelId: 'c1', messageId: 'm1' }, ctx);
      assert.ok(lastCall().url.includes('/teams/g1/channels/c1/messages/m1/replies'));
    });

    it('constructs correct associated teams path', async () => {
      await connector.invoke('GetAllAssociatedTeams', {}, ctx);
      assert.ok(lastCall().url.includes('/me/teamwork/associatedTeams'));
    });

    it('constructs correct user path for AtMentionUser', async () => {
      fetchResponse = {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({ id: 'u1', displayName: 'Alice' }),
        text: async () => JSON.stringify({ id: 'u1', displayName: 'Alice' }),
      };
      await connector.invoke('AtMentionUser', { userId: 'u1' }, ctx);
      assert.ok(lastCall().url.includes('/users/u1'));
    });
  });

  /* ================================================================ */
  /*  5. Request body construction                                    */
  /* ================================================================ */

  describe('request body construction', () => {
    it('CreateATeam sends correct body with template binding', async () => {
      await connector.invoke('CreateATeam', {
        displayName: 'Dev Team',
        description: 'Engineering',
        visibility: 'private',
      }, ctx);

      const body = lastCall().body;
      assert.equal(body.displayName, 'Dev Team');
      assert.equal(body.description, 'Engineering');
      assert.equal(body.visibility, 'private');
      assert.ok(body['template@odata.bind'].includes('standard'));
    });

    it('CreateATeam omits visibility when not provided', async () => {
      await connector.invoke('CreateATeam', { displayName: 'MyTeam' }, ctx);
      const body = lastCall().body;
      assert.equal(body.visibility, undefined);
    });

    it('CreateChannel sends displayName and optional description', async () => {
      await connector.invoke('CreateChannel', {
        groupId: 'g1',
        displayName: 'Dev',
        description: 'Dev channel',
      }, ctx);

      const body = lastCall().body;
      assert.equal(body.displayName, 'Dev');
      assert.equal(body.description, 'Dev channel');
    });

    it('CreateChannel omits description when not provided', async () => {
      await connector.invoke('CreateChannel', { groupId: 'g1', displayName: 'Dev' }, ctx);
      assert.equal(lastCall().body.description, undefined);
    });

    it('AddMemberToTeam sends odata type and user binding', async () => {
      await connector.invoke('AddMemberToTeam', { teamId: 't1', userId: 'u1', owner: true }, ctx);

      const body = lastCall().body;
      assert.equal(body['@odata.type'], '#microsoft.graph.aadUserConversationMember');
      assert.deepEqual(body.roles, ['owner']);
      assert.ok(body['user@odata.bind'].includes("users('u1')"));
    });

    it('AddMemberToTeam sends empty roles when owner is false', async () => {
      await connector.invoke('AddMemberToTeam', { teamId: 't1', userId: 'u1', owner: false }, ctx);
      assert.deepEqual(lastCall().body.roles, []);
    });

    it('CreateChat builds members array with odata bindings', async () => {
      await connector.invoke('CreateChat', { members: 'user1;user2;user3' }, ctx);

      const body = lastCall().body;
      assert.equal(body.chatType, 'group'); // 3 members -> group
      assert.equal(body.members.length, 3);
      assert.ok(body.members[0]['user@odata.bind'].includes("users('user1')"));
    });

    it('CreateChat uses oneOnOne for 2 members', async () => {
      await connector.invoke('CreateChat', { members: 'u1;u2' }, ctx);
      assert.equal(lastCall().body.chatType, 'oneOnOne');
    });

    it('CreateChat includes topic when provided', async () => {
      await connector.invoke('CreateChat', { members: 'u1;u2', topic: 'Planning' }, ctx);
      assert.equal(lastCall().body.topic, 'Planning');
    });

    it('PostMessageToConversation sends html content body', async () => {
      await connector.invoke('PostMessageToConversation', {
        groupId: 'g1',
        channelId: 'c1',
        messageBody: '<p>Hello</p>',
        subject: 'Greetings',
      }, ctx);

      const body = lastCall().body;
      assert.deepEqual(body.body, { contentType: 'html', content: '<p>Hello</p>' });
      assert.equal(body.subject, 'Greetings');
    });

    it('PostCardToConversation sends adaptive card attachment', async () => {
      const card = { type: 'AdaptiveCard', body: [{ type: 'TextBlock', text: 'Hello' }] };
      await connector.invoke('PostCardToConversation', {
        groupId: 'g1',
        channelId: 'c1',
        messageBody: card,
      }, ctx);

      const body = lastCall().body;
      assert.equal(body.attachments.length, 1);
      assert.equal(body.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
      // Card content is JSON stringified
      assert.deepEqual(JSON.parse(body.attachments[0].content), card);
    });

    it('PostCardToConversation parses card from string', async () => {
      const card = { type: 'AdaptiveCard' };
      await connector.invoke('PostCardToConversation', {
        groupId: 'g1',
        channelId: 'c1',
        messageBody: JSON.stringify(card),
      }, ctx);

      const body = lastCall().body;
      assert.equal(body.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
    });

    it('CreateTag sends displayName and member array with userIds', async () => {
      await connector.invoke('CreateTag', {
        groupId: 'g1',
        displayName: 'Devs',
        members: 'u1,u2',
      }, ctx);

      const body = lastCall().body;
      assert.equal(body.displayName, 'Devs');
      assert.deepEqual(body.members, [{ userId: 'u1' }, { userId: 'u2' }]);
    });

    it('CreateTeamsMeeting sends correct event body', async () => {
      await connector.invoke('CreateTeamsMeeting', {
        subject: 'Sprint Review',
        content: '<p>Notes</p>',
        startDateTime: '2026-04-01T10:00:00',
        endDateTime: '2026-04-01T11:00:00',
        timeZone: 'America/New_York',
        requiredAttendees: 'alice@example.com;bob@example.com',
        importance: 'high',
      }, ctx);

      const body = lastCall().body;
      assert.equal(body.subject, 'Sprint Review');
      assert.deepEqual(body.body, { contentType: 'html', content: '<p>Notes</p>' });
      assert.deepEqual(body.start, { dateTime: '2026-04-01T10:00:00', timeZone: 'America/New_York' });
      assert.deepEqual(body.end, { dateTime: '2026-04-01T11:00:00', timeZone: 'America/New_York' });
      assert.equal(body.isOnlineMeeting, true);
      assert.equal(body.onlineMeetingProvider, 'teamsForBusiness');
      assert.equal(body.attendees.length, 2);
      assert.equal(body.attendees[0].emailAddress.address, 'alice@example.com');
      assert.equal(body.attendees[0].type, 'required');
      assert.equal(body.importance, 'high');
    });

    it('CreateTeamsMeeting defaults timeZone to UTC', async () => {
      await connector.invoke('CreateTeamsMeeting', { subject: 'Meeting' }, ctx);
      const body = lastCall().body;
      assert.equal(body.start.timeZone, 'UTC');
      assert.equal(body.end.timeZone, 'UTC');
    });

    it('AddMemberToChannel sends odata binding', async () => {
      await connector.invoke('AddMemberToChannel', {
        groupId: 'g1',
        channelId: 'c1',
        userId: 'u1',
        owner: false,
      }, ctx);

      const body = lastCall().body;
      assert.equal(body['@odata.type'], '#microsoft.graph.aadUserConversationMember');
      assert.deepEqual(body.roles, []);
      assert.ok(body['user@odata.bind'].includes("users('u1')"));
    });

    it('ReplyWithCardToConversation sends card attachment in reply', async () => {
      const card = { type: 'AdaptiveCard' };
      await connector.invoke('ReplyWithCardToConversation', {
        groupId: 'g1',
        channelId: 'c1',
        messageId: 'm1',
        messageBody: card,
      }, ctx);

      const body = lastCall().body;
      assert.equal(body.attachments.length, 1);
      assert.equal(body.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
    });

    it('UpdateCardInConversation uses PATCH for chat path', async () => {
      await connector.invoke('UpdateCardInConversation', {
        chatId: 'chat-1',
        messageId: 'm1',
        messageBody: { type: 'AdaptiveCard' },
      }, ctx);

      assert.equal(lastCall().method, 'PATCH');
      assert.ok(lastCall().url.includes('/chats/chat-1/messages/m1'));
    });

    it('UpdateCardInConversation uses PATCH for channel path', async () => {
      await connector.invoke('UpdateCardInConversation', {
        groupId: 'g1',
        channelId: 'c1',
        messageId: 'm1',
        messageBody: { type: 'AdaptiveCard' },
      }, ctx);

      assert.equal(lastCall().method, 'PATCH');
      assert.ok(lastCall().url.includes('/teams/g1/channels/c1/messages/m1'));
    });

    it('PostFeedNotification sends to team when groupId given', async () => {
      await connector.invoke('PostFeedNotification', {
        groupId: 'g1',
        'body/topicValue': 'Alert',
        'body/recipientId': 'u1',
      }, ctx);

      assert.ok(lastCall().url.includes('/teams/g1/sendActivityNotification'));
      const body = lastCall().body;
      assert.equal(body.topic.value, 'Alert');
      assert.equal(body.recipient.userId, 'u1');
    });

    it('PostFeedNotification sends to chat when chatId given', async () => {
      await connector.invoke('PostFeedNotification', {
        'body/chatId': 'chat-1',
        'body/topicValue': 'Alert',
      }, ctx);

      assert.ok(lastCall().url.includes('/chats/chat-1/sendActivityNotification'));
    });

    it('AddMemberToTag sends userId body', async () => {
      await connector.invoke('AddMemberToTag', {
        groupId: 'g1',
        tagId: 't1',
        userId: 'u1',
      }, ctx);

      assert.deepEqual(lastCall().body, { userId: 'u1' });
    });

    it('DeleteTag sends DELETE request', async () => {
      await connector.invoke('DeleteTag', { groupId: 'g1', tagId: 't1' }, ctx);
      assert.equal(lastCall().method, 'DELETE');
      assert.ok(lastCall().url.includes('/teams/g1/tags/t1'));
    });

    it('RemoveMemberFromChannel sends DELETE request', async () => {
      await connector.invoke('RemoveMemberFromChannel', {
        groupId: 'g1',
        channelId: 'c1',
        membershipId: 'mem-1',
      }, ctx);
      assert.equal(lastCall().method, 'DELETE');
      assert.ok(lastCall().url.includes('/teams/g1/channels/c1/members/mem-1'));
    });

    it('DeleteTagMember sends DELETE request', async () => {
      await connector.invoke('DeleteTagMember', {
        groupId: 'g1',
        tagId: 't1',
        tagMemberId: 'tm1',
      }, ctx);
      assert.equal(lastCall().method, 'DELETE');
      assert.ok(lastCall().url.includes('/teams/g1/tags/t1/members/tm1'));
    });

    it('HttpRequest sends GET by default', async () => {
      await connector.invoke('HttpRequest', { uri: '/me/profile' }, ctx);
      assert.equal(lastCall().method, 'GET');
      assert.ok(lastCall().url.includes('/me/profile'));
    });

    it('HttpRequest sends POST with body', async () => {
      await connector.invoke('HttpRequest', {
        uri: '/me/sendMail',
        method: 'POST',
        body: { message: { subject: 'hi' } },
      }, ctx);
      assert.equal(lastCall().method, 'POST');
      assert.deepEqual(lastCall().body, { message: { subject: 'hi' } });
    });

    it('HttpRequest handles full URL by extracting pathname', async () => {
      await connector.invoke('HttpRequest', {
        uri: 'https://graph.microsoft.com/v1.0/me',
        method: 'GET',
      }, ctx);
      assert.ok(lastCall().url.includes('/me'));
    });
  });

  /* ================================================================ */
  /*  6. Required param validation                                    */
  /* ================================================================ */

  describe('required param validation', () => {
    it('GetTeam throws when teamId is missing', async () => {
      await assert.rejects(
        () => connector.invoke('GetTeam', {}, ctx),
        (err: Error) => {
          assert.match(err.message, /teamId is required/);
          return true;
        },
      );
    });

    it('CreateChannel throws when groupId is missing', async () => {
      await assert.rejects(
        () => connector.invoke('CreateChannel', { displayName: 'Ch' }, ctx),
        (err: Error) => {
          assert.match(err.message, /groupId is required/);
          return true;
        },
      );
    });

    it('CreateChannel throws when displayName is missing', async () => {
      await assert.rejects(
        () => connector.invoke('CreateChannel', { groupId: 'g1' }, ctx),
        (err: Error) => {
          assert.match(err.message, /displayName is required/);
          return true;
        },
      );
    });

    it('CreateChat throws when members is missing', async () => {
      await assert.rejects(
        () => connector.invoke('CreateChat', {}, ctx),
        (err: Error) => {
          assert.match(err.message, /members is required/);
          return true;
        },
      );
    });

    it('AddMemberToTeam throws when teamId is missing', async () => {
      await assert.rejects(
        () => connector.invoke('AddMemberToTeam', { userId: 'u1' }, ctx),
        (err: Error) => {
          assert.match(err.message, /teamId is required/);
          return true;
        },
      );
    });

    it('AddMemberToTeam throws when userId is missing', async () => {
      await assert.rejects(
        () => connector.invoke('AddMemberToTeam', { teamId: 't1' }, ctx),
        (err: Error) => {
          assert.match(err.message, /userId is required/);
          return true;
        },
      );
    });

    it('GetChannel throws when groupId is missing', async () => {
      await assert.rejects(
        () => connector.invoke('GetChannel', { channelId: 'c1' }, ctx),
        (err: Error) => {
          assert.match(err.message, /groupId is required/);
          return true;
        },
      );
    });

    it('GetChannel throws when channelId is missing', async () => {
      await assert.rejects(
        () => connector.invoke('GetChannel', { groupId: 'g1' }, ctx),
        (err: Error) => {
          assert.match(err.message, /channelId is required/);
          return true;
        },
      );
    });

    it('GetChannelsForGroup throws when groupId is missing', async () => {
      await assert.rejects(
        () => connector.invoke('GetChannelsForGroup', {}, ctx),
        (err: Error) => {
          assert.match(err.message, /groupId is required/);
          return true;
        },
      );
    });

    it('GetAllChannelsForTeam throws when groupId is missing', async () => {
      await assert.rejects(
        () => connector.invoke('GetAllChannelsForTeam', {}, ctx),
        (err: Error) => {
          assert.match(err.message, /groupId is required/);
          return true;
        },
      );
    });

    it('AddMemberToChannel throws when groupId is missing', async () => {
      await assert.rejects(
        () => connector.invoke('AddMemberToChannel', { channelId: 'c1', userId: 'u1' }, ctx),
        (err: Error) => {
          assert.match(err.message, /groupId is required/);
          return true;
        },
      );
    });

    it('AddMemberToChannel throws when channelId is missing', async () => {
      await assert.rejects(
        () => connector.invoke('AddMemberToChannel', { groupId: 'g1', userId: 'u1' }, ctx),
        (err: Error) => {
          assert.match(err.message, /channelId is required/);
          return true;
        },
      );
    });

    it('AddMemberToChannel throws when userId is missing', async () => {
      await assert.rejects(
        () => connector.invoke('AddMemberToChannel', { groupId: 'g1', channelId: 'c1' }, ctx),
        (err: Error) => {
          assert.match(err.message, /userId is required/);
          return true;
        },
      );
    });

    it('RemoveMemberFromChannel throws when membershipId is missing', async () => {
      await assert.rejects(
        () => connector.invoke('RemoveMemberFromChannel', { groupId: 'g1', channelId: 'c1' }, ctx),
        (err: Error) => {
          assert.match(err.message, /membershipId is required/);
          return true;
        },
      );
    });

    it('CreateTag throws when groupId is missing', async () => {
      await assert.rejects(
        () => connector.invoke('CreateTag', { displayName: 'T', members: 'u1' }, ctx),
        (err: Error) => {
          assert.match(err.message, /groupId is required/);
          return true;
        },
      );
    });

    it('CreateTag throws when displayName is missing', async () => {
      await assert.rejects(
        () => connector.invoke('CreateTag', { groupId: 'g1', members: 'u1' }, ctx),
        (err: Error) => {
          assert.match(err.message, /displayName is required/);
          return true;
        },
      );
    });

    it('CreateTag throws when members is missing', async () => {
      await assert.rejects(
        () => connector.invoke('CreateTag', { groupId: 'g1', displayName: 'T' }, ctx),
        (err: Error) => {
          assert.match(err.message, /members is required/);
          return true;
        },
      );
    });

    it('DeleteTag throws when tagId is missing', async () => {
      await assert.rejects(
        () => connector.invoke('DeleteTag', { groupId: 'g1' }, ctx),
        (err: Error) => {
          assert.match(err.message, /tagId is required/);
          return true;
        },
      );
    });

    it('AtMentionUser throws when userId is missing', async () => {
      await assert.rejects(
        () => connector.invoke('AtMentionUser', {}, ctx),
        (err: Error) => {
          assert.match(err.message, /userId is required/);
          return true;
        },
      );
    });

    it('AtMentionTag throws when groupId is missing', async () => {
      await assert.rejects(
        () => connector.invoke('AtMentionTag', { tagId: 't1' }, ctx),
        (err: Error) => {
          assert.match(err.message, /groupId is required/);
          return true;
        },
      );
    });

    it('AtMentionTag throws when tagId is missing', async () => {
      await assert.rejects(
        () => connector.invoke('AtMentionTag', { groupId: 'g1' }, ctx),
        (err: Error) => {
          assert.match(err.message, /tagId is required/);
          return true;
        },
      );
    });

    it('CreateTeamsMeeting throws when subject is missing', async () => {
      await assert.rejects(
        () => connector.invoke('CreateTeamsMeeting', {}, ctx),
        (err: Error) => {
          assert.match(err.message, /subject is required/);
          return true;
        },
      );
    });

    it('HttpRequest throws when Uri is missing', async () => {
      await assert.rejects(
        () => connector.invoke('HttpRequest', { method: 'GET' }, ctx),
        (err: Error) => {
          assert.match(err.message, /Uri is required/);
          return true;
        },
      );
    });

    it('ReplyWithMessageToConversation throws when groupId/channelId/messageId missing', async () => {
      await assert.rejects(
        () => connector.invoke('ReplyWithMessageToConversation', {}, ctx),
        (err: Error) => {
          assert.match(err.message, /groupId, channelId, and messageId are required/);
          return true;
        },
      );
    });

    it('ReplyWithCardToConversation throws when required params missing', async () => {
      await assert.rejects(
        () => connector.invoke('ReplyWithCardToConversation', { groupId: 'g1' }, ctx),
        (err: Error) => {
          assert.match(err.message, /groupId, channelId, and messageId are required/);
          return true;
        },
      );
    });

    it('UpdateCardInConversation throws when messageId is missing', async () => {
      await assert.rejects(
        () => connector.invoke('UpdateCardInConversation', { groupId: 'g1', channelId: 'c1' }, ctx),
        (err: Error) => {
          assert.match(err.message, /messageId is required/);
          return true;
        },
      );
    });

    it('UpdateCardInConversation throws when neither chatId nor groupId+channelId', async () => {
      await assert.rejects(
        () => connector.invoke('UpdateCardInConversation', { messageId: 'm1', messageBody: {} }, ctx),
        (err: Error) => {
          assert.match(err.message, /chatId or groupId\+channelId required/);
          return true;
        },
      );
    });

    it('GetMessageDetails throws when messageId is missing', async () => {
      await assert.rejects(
        () => connector.invoke('GetMessageDetails', { threadType: 'chat', chatId: 'c1' }, ctx),
        (err: Error) => {
          assert.match(err.message, /messageId is required/);
          return true;
        },
      );
    });

    it('GetMessagesFromChannel throws when groupId/channelId missing', async () => {
      await assert.rejects(
        () => connector.invoke('GetMessagesFromChannel', { groupId: 'g1' }, ctx),
        (err: Error) => {
          assert.match(err.message, /groupId and channelId are required/);
          return true;
        },
      );
    });

    it('GetMessagesFromChat throws when chatId is missing', async () => {
      await assert.rejects(
        () => connector.invoke('GetMessagesFromChat', {}, ctx),
        (err: Error) => {
          assert.match(err.message, /chatId is required/);
          return true;
        },
      );
    });

    it('ListRepliesToMessage throws when required params missing', async () => {
      await assert.rejects(
        () => connector.invoke('ListRepliesToMessage', { groupId: 'g1' }, ctx),
        (err: Error) => {
          assert.match(err.message, /groupId, channelId, and messageId are required/);
          return true;
        },
      );
    });

    it('PostFeedNotification throws when neither groupId nor chatId', async () => {
      await assert.rejects(
        () => connector.invoke('PostFeedNotification', {}, ctx),
        (err: Error) => {
          assert.match(err.message, /groupId or chatId is required/);
          return true;
        },
      );
    });

    it('GetTagMembers throws when groupId is missing', async () => {
      await assert.rejects(
        () => connector.invoke('GetTagMembers', { tagId: 't1' }, ctx),
        (err: Error) => {
          assert.match(err.message, /groupId is required/);
          return true;
        },
      );
    });

    it('GetTagMembers throws when tagId is missing', async () => {
      await assert.rejects(
        () => connector.invoke('GetTagMembers', { groupId: 'g1' }, ctx),
        (err: Error) => {
          assert.match(err.message, /tagId is required/);
          return true;
        },
      );
    });

    it('ListMembers (channel) throws when groupId/channelId missing', async () => {
      await assert.rejects(
        () => connector.invoke('ListMembers', { threadType: 'channel' }, ctx),
        (err: Error) => {
          assert.match(err.message, /groupId and channelId required/);
          return true;
        },
      );
    });

    it('ListMembers (chat) throws when chatId missing', async () => {
      await assert.rejects(
        () => connector.invoke('ListMembers', { threadType: 'chat' }, ctx),
        (err: Error) => {
          assert.match(err.message, /chatId required/);
          return true;
        },
      );
    });

    it('PostMessageToConversation (chat) throws when chatId missing', async () => {
      await assert.rejects(
        () => connector.invoke('PostMessageToConversation', {
          location: 'Chat with Flow bot',
          messageBody: 'Hi',
        }, ctx),
        (err: Error) => {
          assert.match(err.message, /chatId is required/);
          return true;
        },
      );
    });

    it('PostMessageToConversation (channel) throws when groupId missing', async () => {
      await assert.rejects(
        () => connector.invoke('PostMessageToConversation', {
          'body/recipient/channelId': 'c1',
          messageBody: 'Hi',
        }, ctx),
        (err: Error) => {
          assert.match(err.message, /groupId is required/);
          return true;
        },
      );
    });
  });

  /* ================================================================ */
  /*  7. camelCase aliases work                                       */
  /* ================================================================ */

  describe('camelCase aliases', () => {
    const aliasPairs: [string, string][] = [
      ['GetAllTeams', 'getAllTeams'],
      ['GetTeam', 'getTeam'],
      ['CreateATeam', 'createATeam'],
      ['CreateChannel', 'createChannel'],
      ['GetChannel', 'getChannel'],
      ['GetChannelsForGroup', 'getChannelsForGroup'],
      ['GetAllChannelsForTeam', 'getAllChannelsForTeam'],
      ['AddMemberToTeam', 'addMemberToTeam'],
      ['AddMemberToChannel', 'addMemberToChannel'],
      ['RemoveMemberFromChannel', 'removeMemberFromChannel'],
      ['CreateChat', 'createChat'],
      ['GetChats', 'getChats'],
      ['ListMembers', 'listMembers'],
      ['PostMessageToConversation', 'postMessageToConversation'],
      ['PostCardToConversation', 'postCardToConversation'],
      ['ReplyWithMessageToConversation', 'replyWithMessageToConversation'],
      ['ReplyWithCardToConversation', 'replyWithCardToConversation'],
      ['UpdateCardInConversation', 'updateCardInConversation'],
      ['GetMessageDetails', 'getMessageDetails'],
      ['GetMessagesFromChannel', 'getMessagesFromChannel'],
      ['GetMessagesFromChat', 'getMessagesFromChat'],
      ['ListRepliesToMessage', 'listRepliesToMessage'],
      ['PostFeedNotification', 'postFeedNotification'],
      ['CreateTag', 'createTag'],
      ['GetTags', 'getTags'],
      ['DeleteTag', 'deleteTag'],
      ['AddMemberToTag', 'addMemberToTag'],
      ['DeleteTagMember', 'deleteTagMember'],
      ['GetTagMembers', 'getTagMembers'],
      ['AtMentionUser', 'atMentionUser'],
      ['AtMentionTag', 'atMentionTag'],
      ['CreateTeamsMeeting', 'createTeamsMeeting'],
      ['HttpRequest', 'httpRequest'],
    ];

    for (const [pascal, camel] of aliasPairs) {
      it(`'${camel}' alias does not throw unknown operation`, async () => {
        // We only test that it does NOT throw "unknown operation".
        // The call may throw for missing params, but that is fine.
        try {
          await connector.invoke(camel, {}, ctx);
        } catch (e: any) {
          assert.ok(
            !e.message.includes('unknown operation'),
            `'${camel}' should be a recognised alias but got: ${e.message}`,
          );
        }
      });
    }
  });

  /* ================================================================ */
  /*  8. Key operations - deeper behaviour                            */
  /* ================================================================ */

  describe('key operations - deeper behaviour', () => {
    it('AtMentionUser returns atMentionToken with displayName', async () => {
      fetchResponse = {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({ id: 'uid-123', displayName: 'Alice Smith' }),
        text: async () => JSON.stringify({ id: 'uid-123', displayName: 'Alice Smith' }),
      };

      const result = (await connector.invoke('AtMentionUser', { userId: 'uid-123' }, ctx)) as any;
      assert.equal(result.atMentionToken, '<at id="uid-123">Alice Smith</at>');
      assert.equal(result.id, 'uid-123');
      assert.equal(result.displayName, 'Alice Smith');
    });

    it('AtMentionTag returns atMentionToken with tag displayName', async () => {
      fetchResponse = {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({ id: 'tag-1', displayName: 'Engineering' }),
        text: async () => JSON.stringify({ id: 'tag-1', displayName: 'Engineering' }),
      };

      const result = (await connector.invoke('AtMentionTag', {
        groupId: 'g1',
        tagId: 'tag-1',
      }, ctx)) as any;

      assert.equal(result.atMentionToken, '<at id="tag-1">Engineering</at>');
      assert.equal(result.displayName, 'Engineering');
    });

    it('GetChats builds $filter for chatType', async () => {
      await connector.invoke('GetChats', { chatType: 'oneOnOne' }, ctx);
      assert.ok(lastCall().url.includes('%24filter=chatType'));
    });

    it('GetChats builds topic filter when topic is withTopic', async () => {
      await connector.invoke('GetChats', { topic: 'withTopic' }, ctx);
      assert.ok(lastCall().url.includes('topic+ne+null') || lastCall().url.includes('topic%20ne%20null'));
    });

    it('GetChats does not add filter when chatType is all', async () => {
      await connector.invoke('GetChats', { chatType: 'all' }, ctx);
      assert.ok(!lastCall().url.includes('$filter'));
    });

    it('GetMessagesFromChat passes OData query params', async () => {
      await connector.invoke('GetMessagesFromChat', {
        chatId: 'chat-1',
        '$top': '5',
        '$filter': "from/user/id eq 'u1'",
      }, ctx);
      assert.ok(lastCall().url.includes('%24top=5'));
      assert.ok(lastCall().url.includes('%24filter='));
    });

    it('GetChannelsForGroup passes filter and orderby', async () => {
      await connector.invoke('GetChannelsForGroup', {
        groupId: 'g1',
        '$filter': "displayName eq 'General'",
        '$orderby': 'displayName',
      }, ctx);
      assert.ok(lastCall().url.includes('%24filter='));
      assert.ok(lastCall().url.includes('%24orderby='));
    });

    it('ListMembers routes to channel path for channel threadType', async () => {
      await connector.invoke('ListMembers', {
        threadType: 'channel',
        groupId: 'g1',
        channelId: 'c1',
      }, ctx);
      assert.ok(lastCall().url.includes('/teams/g1/channels/c1/members'));
    });

    it('ListMembers routes to chat path for chat threadType', async () => {
      await connector.invoke('ListMembers', {
        threadType: 'chat',
        chatId: 'chat-1',
      }, ctx);
      assert.ok(lastCall().url.includes('/chats/chat-1/members'));
    });

    it('CreateTeamsMeeting includes recurrence when provided', async () => {
      await connector.invoke('CreateTeamsMeeting', {
        subject: 'Weekly Sync',
        'body/recurrence/pattern/type': 'weekly',
        'body/recurrence/pattern/interval': 1,
        'body/recurrence/pattern/daysOfWeek': 'monday,wednesday',
        'body/recurrence/range/startDate': '2026-04-01',
        'body/recurrence/range/endDate': '2026-06-30',
      }, ctx);

      const body = lastCall().body;
      assert.ok(body.recurrence);
      assert.equal(body.recurrence.pattern.type, 'weekly');
      assert.equal(body.recurrence.pattern.interval, 1);
      assert.deepEqual(body.recurrence.pattern.daysOfWeek, ['monday', 'wednesday']);
      assert.equal(body.recurrence.range.type, 'endDate');
      assert.equal(body.recurrence.range.startDate, '2026-04-01');
      assert.equal(body.recurrence.range.endDate, '2026-06-30');
    });

    it('CreateTeamsMeeting recurrence range defaults to noEnd without endDate', async () => {
      await connector.invoke('CreateTeamsMeeting', {
        subject: 'Daily',
        'body/recurrence/pattern/type': 'daily',
      }, ctx);

      const body = lastCall().body;
      assert.equal(body.recurrence.range.type, 'noEnd');
    });

    it('auth token is passed in Authorization header', async () => {
      await connector.invoke('GetAllTeams', {}, ctx);
      assert.equal(lastCall().headers?.['Authorization'], 'Bearer test-token');
    });

    it('HttpRequest includes custom headers', async () => {
      await connector.invoke('HttpRequest', {
        uri: '/me',
        CustomHeader1: 'X-Custom: myvalue',
      }, ctx);
      assert.equal(fetchCalls.length, 1);
      // The BaseHttpClient parses "Key: Value" from CustomHeader1 and adds it to headers
      assert.equal(lastCall().headers?.['X-Custom'], 'myvalue');
    });
  });
});
