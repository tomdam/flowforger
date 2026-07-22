/**
 * Microsoft Teams Connector for FlowForger
 *
 * Implements Teams operations using Microsoft Graph API.
 * Requires a Microsoft Graph API token with appropriate permissions:
 * - Team.ReadBasic.All, Team.Create, TeamMember.ReadWrite.All for team operations
 * - Channel.ReadBasic.All, Channel.Create for channel operations
 * - Chat.Create, Chat.Read, Chat.ReadWrite for chat operations
 * - ChannelMessage.Read.All, ChannelMessage.Send for messaging
 * - TeamworkTag.ReadWrite for tag operations
 * - Calendars.ReadWrite, OnlineMeetings.ReadWrite for meetings
 */

import type { BaseConnector, RunContext } from '@flowforger/engine';
import { BaseHttpClient, getParam, parseStringList, HttpError } from '@flowforger/connectors-shared';

export interface TeamsConnectorOptions {
  /** Microsoft Graph API access token */
  token: string;
  /** Optional: Graph API base URL (defaults to https://graph.microsoft.com/v1.0) */
  baseUrl?: string;
}

export class TeamsConnector extends BaseHttpClient implements BaseConnector {
  constructor(opts: TeamsConnectorOptions) {
    super(opts.baseUrl || 'https://graph.microsoft.com/v1.0', opts.token);
  }

  async invoke(operation: string, inputs: unknown, ctx: RunContext): Promise<unknown> {
    ctx.log?.({ type: 'teams.invoke', operation, inputs });
    const p = (inputs || {}) as Record<string, unknown>;

    switch (operation) {
      // ---- Team Management ----
      case 'CreateATeam': case 'createATeam':
        return this.createTeam(p, ctx);
      case 'GetTeam': case 'getTeam':
        return this.getTeam(p, ctx);
      case 'AddMemberToTeam': case 'addMemberToTeam':
        return this.addMemberToTeam(p, ctx);
      case 'GetAllTeams': case 'getAllTeams':
        return this.getAllTeams(p, ctx);
      case 'GetAllAssociatedTeams': case 'getAllAssociatedTeams':
        return this.getAllAssociatedTeams(p, ctx);

      // ---- Channel Management ----
      case 'CreateChannel': case 'createChannel':
        return this.createChannel(p, ctx);
      case 'GetChannel': case 'getChannel':
        return this.getChannel(p, ctx);
      case 'GetChannelsForGroup': case 'getChannelsForGroup':
        return this.getChannelsForGroup(p, ctx);
      case 'GetAllChannelsForTeam': case 'getAllChannelsForTeam':
        return this.getAllChannelsForTeam(p, ctx);
      case 'AddMemberToChannel': case 'addMemberToChannel':
        return this.addMemberToChannel(p, ctx);
      case 'RemoveMemberFromChannel': case 'removeMemberFromChannel':
        return this.removeMemberFromChannel(p, ctx);

      // ---- Chat Management ----
      case 'CreateChat': case 'createChat':
        return this.createChat(p, ctx);
      case 'GetChats': case 'getChats':
        return this.getChats(p, ctx);
      case 'ListMembers': case 'listMembers':
        return this.listMembers(p, ctx);

      // ---- Messaging ----
      case 'PostMessageToConversation': case 'postMessageToConversation':
        return this.postMessageToConversation(p, ctx);
      case 'PostCardToConversation': case 'postCardToConversation':
        return this.postCardToConversation(p, ctx);
      case 'ReplyWithMessageToConversation': case 'replyWithMessageToConversation':
        return this.replyWithMessageToConversation(p, ctx);
      case 'ReplyWithCardToConversation': case 'replyWithCardToConversation':
        return this.replyWithCardToConversation(p, ctx);
      case 'UpdateCardInConversation': case 'updateCardInConversation':
        return this.updateCardInConversation(p, ctx);
      case 'GetMessageDetails': case 'getMessageDetails':
        return this.getMessageDetails(p, ctx);
      case 'GetMessagesFromChannel': case 'getMessagesFromChannel':
        return this.getMessagesFromChannel(p, ctx);
      case 'GetMessagesFromChat': case 'getMessagesFromChat':
        return this.getMessagesFromChat(p, ctx);
      case 'ListRepliesToMessage': case 'listRepliesToMessage':
        return this.listRepliesToMessage(p, ctx);
      case 'PostFeedNotification': case 'postFeedNotification':
        return this.postFeedNotification(p, ctx);

      // ---- Tags ----
      case 'CreateTag': case 'createTag':
        return this.createTag(p, ctx);
      case 'GetTags': case 'getTags':
        return this.getTags(p, ctx);
      case 'DeleteTag': case 'deleteTag':
        return this.deleteTag(p, ctx);
      case 'AddMemberToTag': case 'addMemberToTag':
        return this.addMemberToTag(p, ctx);
      case 'DeleteTagMember': case 'deleteTagMember':
        return this.deleteTagMember(p, ctx);
      case 'GetTagMembers': case 'getTagMembers':
        return this.getTagMembers(p, ctx);

      // ---- Mentions ----
      case 'AtMentionUser': case 'atMentionUser':
        return this.atMentionUser(p, ctx);
      case 'AtMentionTag': case 'atMentionTag':
        return this.atMentionTag(p, ctx);

      // ---- Meeting ----
      case 'CreateTeamsMeeting': case 'createTeamsMeeting':
        return this.createTeamsMeeting(p, ctx);

      // ---- Graph HTTP ----
      case 'HttpRequest': case 'httpRequest':
        return this.httpRequest(p, ctx);

      // ---- Webhook (not supported locally) ----
      case 'PostCardAndWaitForResponse': case 'postCardAndWaitForResponse':
      case 'SubscribeUserMessageWithOptions': case 'subscribeUserMessageWithOptions':
        throw new Error(`TeamsConnector: webhook operation '${operation}' is not supported for local execution`);

      default:
        throw new Error(`TeamsConnector: unknown operation '${operation}'`);
    }
  }

  // ============= Messaging Helpers =============

  private resolveConversationTarget(p: Record<string, unknown>): { path: string; isChannel: boolean } {
    const location = getParam<string>(p, ['location', 'body/location']);
    const groupId = getParam<string>(p, ['body/recipient/groupId', 'groupId']);
    const channelId = getParam<string>(p, ['body/recipient/channelId', 'channelId']);
    const chatId = getParam<string>(p, ['body/recipient/chatId', 'chatId']);

    if (location === 'Chat with Flow bot' || location === 'Group chat') {
      if (!chatId) throw new Error('TeamsConnector: chatId is required for chat messages');
      return { path: `/chats/${encodeURIComponent(chatId)}/messages`, isChannel: false };
    }

    if (!groupId) throw new Error('TeamsConnector: groupId is required for channel messages');
    if (!channelId) throw new Error('TeamsConnector: channelId is required for channel messages');
    return { path: `/teams/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(channelId)}/messages`, isChannel: true };
  }

  private makeAdaptiveCardAttachment(cardBody: unknown): object {
    const cardStr = typeof cardBody === 'string' ? cardBody : JSON.stringify(cardBody);
    return {
      id: Date.now().toString(),
      contentType: 'application/vnd.microsoft.card.adaptive',
      contentUrl: null,
      content: cardStr,
    };
  }

  // ============= Team Management =============

  private async createTeam(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const displayName = getParam<string>(p, ['displayName', 'body/displayName']);
    const description = getParam<string>(p, ['description', 'body/description']) || '';
    const visibility = getParam<string>(p, ['visibility', 'body/visibility']);

    return this.post('/teams', ctx.log, {
      body: {
        'template@odata.bind': "https://graph.microsoft.com/v1.0/teamsTemplates('standard')",
        displayName,
        description,
        ...(visibility && { visibility }),
      },
    });
  }

  private async getTeam(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const teamId = getParam<string>(p, ['teamId', 'groupId', 'body/teamId']);
    if (!teamId) throw new Error('TeamsConnector.GetTeam: teamId is required');
    return this.get(`/teams/${encodeURIComponent(teamId)}`, ctx.log);
  }

  private async addMemberToTeam(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const teamId = getParam<string>(p, ['teamId', 'groupId', 'body/teamId']);
    const userId = getParam<string>(p, ['userId', 'body/userId']);
    const owner = getParam<boolean>(p, ['owner', 'body/owner']);
    if (!teamId) throw new Error('TeamsConnector.AddMemberToTeam: teamId is required');
    if (!userId) throw new Error('TeamsConnector.AddMemberToTeam: userId is required');

    return this.post(`/teams/${encodeURIComponent(teamId)}/members`, ctx.log, {
      body: {
        '@odata.type': '#microsoft.graph.aadUserConversationMember',
        roles: owner ? ['owner'] : [],
        'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${userId}')`,
      },
    });
  }

  private async getAllTeams(_p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    return this.get('/me/joinedTeams', ctx.log);
  }

  private async getAllAssociatedTeams(_p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    return this.get('/me/teamwork/associatedTeams', ctx.log);
  }

  // ============= Channel Management =============

  private async createChannel(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const groupId = getParam<string>(p, ['groupId', 'body/groupId']);
    const displayName = getParam<string>(p, ['displayName', 'body/displayName']);
    const description = getParam<string>(p, ['description', 'body/description']);
    if (!groupId) throw new Error('TeamsConnector.CreateChannel: groupId is required');
    if (!displayName) throw new Error('TeamsConnector.CreateChannel: displayName is required');

    return this.post(`/teams/${encodeURIComponent(groupId)}/channels`, ctx.log, {
      body: { displayName, ...(description && { description }) },
    });
  }

  private async getChannel(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const groupId = getParam<string>(p, ['groupId', 'body/groupId']);
    const channelId = getParam<string>(p, ['channelId', 'body/channelId']);
    if (!groupId) throw new Error('TeamsConnector.GetChannel: groupId is required');
    if (!channelId) throw new Error('TeamsConnector.GetChannel: channelId is required');
    return this.get(`/teams/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(channelId)}`, ctx.log);
  }

  private async getChannelsForGroup(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const groupId = getParam<string>(p, ['groupId', 'body/groupId']);
    if (!groupId) throw new Error('TeamsConnector.GetChannelsForGroup: groupId is required');
    const query: Record<string, string> = {};
    const filter = getParam<string>(p, ['$filter', 'filter']);
    const orderby = getParam<string>(p, ['$orderby', 'orderby']);
    if (filter) query['$filter'] = filter;
    if (orderby) query['$orderby'] = orderby;
    return this.get(`/teams/${encodeURIComponent(groupId)}/channels`, ctx.log, { query });
  }

  private async getAllChannelsForTeam(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const groupId = getParam<string>(p, ['groupId', 'body/groupId']);
    if (!groupId) throw new Error('TeamsConnector.GetAllChannelsForTeam: groupId is required');
    const query: Record<string, string> = {};
    const filter = getParam<string>(p, ['$filter', 'filter']);
    const orderby = getParam<string>(p, ['$orderby', 'orderby']);
    if (filter) query['$filter'] = filter;
    if (orderby) query['$orderby'] = orderby;
    return this.get(`/teams/${encodeURIComponent(groupId)}/allChannels`, ctx.log, { query });
  }

  private async addMemberToChannel(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const groupId = getParam<string>(p, ['groupId', 'body/groupId']);
    const channelId = getParam<string>(p, ['channelId', 'body/channelId']);
    const userId = getParam<string>(p, ['userId', 'body/userId']);
    const owner = getParam<boolean>(p, ['owner', 'body/owner']);
    if (!groupId) throw new Error('TeamsConnector.AddMemberToChannel: groupId is required');
    if (!channelId) throw new Error('TeamsConnector.AddMemberToChannel: channelId is required');
    if (!userId) throw new Error('TeamsConnector.AddMemberToChannel: userId is required');

    return this.post(`/teams/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(channelId)}/members`, ctx.log, {
      body: {
        '@odata.type': '#microsoft.graph.aadUserConversationMember',
        roles: owner ? ['owner'] : [],
        'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${userId}')`,
      },
    });
  }

  private async removeMemberFromChannel(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const groupId = getParam<string>(p, ['groupId', 'body/groupId']);
    const channelId = getParam<string>(p, ['channelId', 'body/channelId']);
    const membershipId = getParam<string>(p, ['membershipId', 'body/membershipId']);
    if (!groupId) throw new Error('TeamsConnector.RemoveMemberFromChannel: groupId is required');
    if (!channelId) throw new Error('TeamsConnector.RemoveMemberFromChannel: channelId is required');
    if (!membershipId) throw new Error('TeamsConnector.RemoveMemberFromChannel: membershipId is required');
    return this.delete(`/teams/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(channelId)}/members/${encodeURIComponent(membershipId)}`, ctx.log);
  }

  // ============= Chat Management =============

  private async createChat(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const topic = getParam<string>(p, ['topic', 'body/topic']);
    const membersRaw = getParam<string>(p, ['members', 'body/members']);
    if (!membersRaw) throw new Error('TeamsConnector.CreateChat: members is required');

    const memberIds = parseStringList(membersRaw);
    const members = memberIds.map((id) => ({
      '@odata.type': '#microsoft.graph.aadUserConversationMember',
      roles: ['owner'],
      'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${id}')`,
    }));

    return this.post('/chats', ctx.log, {
      body: {
        chatType: memberIds.length > 2 ? 'group' : 'oneOnOne',
        ...(topic && { topic }),
        members,
      },
    });
  }

  private async getChats(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const chatType = getParam<string>(p, ['chatType', 'body/chatType']);
    const topicFilter = getParam<string>(p, ['topic', 'body/topic']);
    const query: Record<string, string> = {};
    if (chatType && chatType !== 'all') query['$filter'] = `chatType eq '${chatType}'`;
    if (topicFilter === 'withTopic') {
      query['$filter'] = query['$filter']
        ? `${query['$filter']} and topic ne null`
        : 'topic ne null';
    }
    return this.get('/me/chats', ctx.log, { query });
  }

  private async listMembers(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const threadType = getParam<string>(p, ['threadType', 'body/threadType']);
    const filter = getParam<string>(p, ['$filter', 'filter']);
    const query: Record<string, string> = {};
    if (filter) query['$filter'] = filter;

    if (threadType === 'channel' || threadType === 'Channel') {
      const groupId = getParam<string>(p, ['groupId', 'body/groupId']);
      const channelId = getParam<string>(p, ['channelId', 'body/channelId']);
      if (!groupId || !channelId) throw new Error('TeamsConnector.ListMembers: groupId and channelId required for channel threads');
      return this.get(`/teams/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(channelId)}/members`, ctx.log, { query });
    }

    const chatId = getParam<string>(p, ['chatId', 'body/chatId']);
    if (!chatId) throw new Error('TeamsConnector.ListMembers: chatId required for chat threads');
    return this.get(`/chats/${encodeURIComponent(chatId)}/members`, ctx.log, { query });
  }

  // ============= Messaging =============

  private async postMessageToConversation(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const { path } = this.resolveConversationTarget(p);
    const messageBody = getParam<string>(p, ['body/messageBody', 'messageBody', 'content']);
    const subject = getParam<string>(p, ['body/messageSubject', 'subject']);

    return this.post(path, ctx.log, {
      body: {
        body: { contentType: 'html', content: messageBody || '' },
        ...(subject && { subject }),
      },
    });
  }

  private async postCardToConversation(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const { path } = this.resolveConversationTarget(p);
    const cardBody = getParam<unknown>(p, ['body/messageBody', 'messageBody']);
    const attachment = this.makeAdaptiveCardAttachment(cardBody);

    return this.post(path, ctx.log, {
      body: {
        body: { contentType: 'html', content: `<attachment id="${(attachment as any).id}"></attachment>` },
        attachments: [attachment],
      },
    });
  }

  private async replyWithMessageToConversation(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const groupId = getParam<string>(p, ['body/recipient/groupId', 'groupId']);
    const channelId = getParam<string>(p, ['body/recipient/channelId', 'channelId']);
    const messageId = getParam<string>(p, ['body/messageId', 'messageId']);
    if (!groupId || !channelId || !messageId) {
      throw new Error('TeamsConnector.ReplyWithMessageToConversation: groupId, channelId, and messageId are required');
    }
    const messageBody = getParam<string>(p, ['body/messageBody', 'messageBody', 'content']);

    return this.post(
      `/teams/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/replies`,
      ctx.log,
      { body: { body: { contentType: 'html', content: messageBody || '' } } },
    );
  }

  private async replyWithCardToConversation(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const groupId = getParam<string>(p, ['body/recipient/groupId', 'groupId']);
    const channelId = getParam<string>(p, ['body/recipient/channelId', 'channelId']);
    const messageId = getParam<string>(p, ['body/messageId', 'messageId']);
    if (!groupId || !channelId || !messageId) {
      throw new Error('TeamsConnector.ReplyWithCardToConversation: groupId, channelId, and messageId are required');
    }
    const cardBody = getParam<unknown>(p, ['body/messageBody', 'messageBody']);
    const attachment = this.makeAdaptiveCardAttachment(cardBody);

    return this.post(
      `/teams/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/replies`,
      ctx.log,
      {
        body: {
          body: { contentType: 'html', content: `<attachment id="${(attachment as any).id}"></attachment>` },
          attachments: [attachment],
        },
      },
    );
  }

  private async updateCardInConversation(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const groupId = getParam<string>(p, ['body/recipient/groupId', 'groupId']);
    const channelId = getParam<string>(p, ['body/recipient/channelId', 'channelId']);
    const chatId = getParam<string>(p, ['body/recipient/chatId', 'chatId']);
    const msgId = getParam<string>(p, ['body/messageId', 'messageId']);
    if (!msgId) throw new Error('TeamsConnector.UpdateCardInConversation: messageId is required');

    const cardBody = getParam<unknown>(p, ['body/messageBody', 'messageBody']);

    let path: string;
    if (chatId) {
      path = `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(msgId)}`;
    } else if (groupId && channelId) {
      path = `/teams/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(msgId)}`;
    } else {
      throw new Error('TeamsConnector.UpdateCardInConversation: chatId or groupId+channelId required');
    }

    const attachment = this.makeAdaptiveCardAttachment(cardBody);
    return this.patch(path, ctx.log, {
      body: {
        body: { contentType: 'html', content: `<attachment id="${(attachment as any).id}"></attachment>` },
        attachments: [attachment],
      },
    });
  }

  private async getMessageDetails(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const threadType = getParam<string>(p, ['threadType', 'body/threadType']);
    const messageId = getParam<string>(p, ['messageId', 'body/messageId']);
    if (!messageId) throw new Error('TeamsConnector.GetMessageDetails: messageId is required');

    if (threadType === 'channel' || threadType === 'Channel') {
      const groupId = getParam<string>(p, ['groupId', 'body/groupId']);
      const channelId = getParam<string>(p, ['channelId', 'body/channelId']);
      if (!groupId || !channelId) throw new Error('TeamsConnector.GetMessageDetails: groupId and channelId required for channel messages');
      return this.get(`/teams/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`, ctx.log);
    }

    const chatId = getParam<string>(p, ['chatId', 'body/chatId']);
    if (!chatId) throw new Error('TeamsConnector.GetMessageDetails: chatId required for chat messages');
    return this.get(`/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`, ctx.log);
  }

  private async getMessagesFromChannel(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const groupId = getParam<string>(p, ['groupId', 'body/groupId']);
    const channelId = getParam<string>(p, ['channelId', 'body/channelId']);
    if (!groupId || !channelId) throw new Error('TeamsConnector.GetMessagesFromChannel: groupId and channelId are required');
    return this.get(`/teams/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(channelId)}/messages`, ctx.log);
  }

  private async getMessagesFromChat(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const chatId = getParam<string>(p, ['chatId', 'body/chatId']);
    if (!chatId) throw new Error('TeamsConnector.GetMessagesFromChat: chatId is required');
    const query: Record<string, string> = {};
    const filter = getParam<string>(p, ['$filter', 'filter']);
    const orderby = getParam<string>(p, ['$orderby', 'orderby']);
    const top = getParam<string>(p, ['$top', 'top']);
    if (filter) query['$filter'] = filter;
    if (orderby) query['$orderby'] = orderby;
    if (top) query['$top'] = top;
    return this.get(`/chats/${encodeURIComponent(chatId)}/messages`, ctx.log, { query });
  }

  private async listRepliesToMessage(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const groupId = getParam<string>(p, ['groupId', 'body/groupId']);
    const channelId = getParam<string>(p, ['channelId', 'body/channelId']);
    const messageId = getParam<string>(p, ['messageId', 'body/messageId']);
    if (!groupId || !channelId || !messageId) {
      throw new Error('TeamsConnector.ListRepliesToMessage: groupId, channelId, and messageId are required');
    }
    const top = getParam<number>(p, ['$top', 'top']);
    const query: Record<string, string | number> = {};
    if (top) query['$top'] = top;
    return this.get(
      `/teams/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/replies`,
      ctx.log, { query },
    );
  }

  private async postFeedNotification(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const notificationType = getParam<string>(p, ['notificationType', 'body/notificationType']);
    const groupId = getParam<string>(p, ['body/groupId', 'groupId']);
    const chatId = getParam<string>(p, ['body/chatId', 'chatId']);
    const recipientId = getParam<string>(p, ['body/recipientId', 'recipientId']);
    const topic = getParam<string>(p, ['body/topicValue', 'topicValue']);

    const body = {
      topic: { source: 'text' as const, value: topic || 'New notification' },
      activityType: notificationType || 'systemDefault',
      previewText: { content: topic || 'New notification' },
      ...(recipientId && { recipient: { '@odata.type': '#microsoft.graph.aadUserNotificationRecipient', userId: recipientId } }),
    };

    if (chatId) {
      return this.post(`/chats/${encodeURIComponent(chatId)}/sendActivityNotification`, ctx.log, { body });
    }
    if (!groupId) throw new Error('TeamsConnector.PostFeedNotification: groupId or chatId is required');
    return this.post(`/teams/${encodeURIComponent(groupId)}/sendActivityNotification`, ctx.log, { body });
  }

  // ============= Tags =============

  private async createTag(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const groupId = getParam<string>(p, ['groupId', 'body/groupId']);
    const displayName = getParam<string>(p, ['displayName', 'body/displayName']);
    const membersRaw = getParam<string>(p, ['members', 'body/members']);
    if (!groupId) throw new Error('TeamsConnector.CreateTag: groupId is required');
    if (!displayName) throw new Error('TeamsConnector.CreateTag: displayName is required');
    if (!membersRaw) throw new Error('TeamsConnector.CreateTag: members is required');

    const members = parseStringList(membersRaw).map((id) => ({ userId: id }));
    return this.post(`/teams/${encodeURIComponent(groupId)}/tags`, ctx.log, {
      body: { displayName, members },
    });
  }

  private async getTags(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const groupId = getParam<string>(p, ['groupId', 'body/groupId']);
    if (!groupId) throw new Error('TeamsConnector.GetTags: groupId is required');
    return this.get(`/teams/${encodeURIComponent(groupId)}/tags`, ctx.log);
  }

  private async deleteTag(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const groupId = getParam<string>(p, ['groupId', 'body/groupId']);
    const tagId = getParam<string>(p, ['tagId', 'body/tagId']);
    if (!groupId) throw new Error('TeamsConnector.DeleteTag: groupId is required');
    if (!tagId) throw new Error('TeamsConnector.DeleteTag: tagId is required');
    return this.delete(`/teams/${encodeURIComponent(groupId)}/tags/${encodeURIComponent(tagId)}`, ctx.log);
  }

  private async addMemberToTag(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const groupId = getParam<string>(p, ['groupId', 'body/groupId']);
    const tagId = getParam<string>(p, ['tagId', 'body/tagId']);
    const userId = getParam<string>(p, ['userId', 'body/userId']);
    if (!groupId) throw new Error('TeamsConnector.AddMemberToTag: groupId is required');
    if (!tagId) throw new Error('TeamsConnector.AddMemberToTag: tagId is required');
    if (!userId) throw new Error('TeamsConnector.AddMemberToTag: userId is required');
    return this.post(`/teams/${encodeURIComponent(groupId)}/tags/${encodeURIComponent(tagId)}/members`, ctx.log, {
      body: { userId },
    });
  }

  private async deleteTagMember(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const groupId = getParam<string>(p, ['groupId', 'body/groupId']);
    const tagId = getParam<string>(p, ['tagId', 'body/tagId']);
    const tagMemberId = getParam<string>(p, ['tagMemberId', 'body/tagMemberId']);
    if (!groupId) throw new Error('TeamsConnector.DeleteTagMember: groupId is required');
    if (!tagId) throw new Error('TeamsConnector.DeleteTagMember: tagId is required');
    if (!tagMemberId) throw new Error('TeamsConnector.DeleteTagMember: tagMemberId is required');
    return this.delete(`/teams/${encodeURIComponent(groupId)}/tags/${encodeURIComponent(tagId)}/members/${encodeURIComponent(tagMemberId)}`, ctx.log);
  }

  private async getTagMembers(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const groupId = getParam<string>(p, ['groupId', 'body/groupId']);
    const tagId = getParam<string>(p, ['tagId', 'body/tagId']);
    if (!groupId) throw new Error('TeamsConnector.GetTagMembers: groupId is required');
    if (!tagId) throw new Error('TeamsConnector.GetTagMembers: tagId is required');
    return this.get(`/teams/${encodeURIComponent(groupId)}/tags/${encodeURIComponent(tagId)}/members`, ctx.log);
  }

  // ============= Mentions =============

  private async atMentionUser(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const userId = getParam<string>(p, ['userId', 'body/userId']);
    if (!userId) throw new Error('TeamsConnector.AtMentionUser: userId is required');
    const user = await this.get<{ id: string; displayName: string }>(`/users/${encodeURIComponent(userId)}`, ctx.log, {
      query: { $select: 'id,displayName' },
    });
    return { atMentionToken: `<at id="${user.id}">${user.displayName}</at>`, id: user.id, displayName: user.displayName };
  }

  private async atMentionTag(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const groupId = getParam<string>(p, ['groupId', 'body/groupId']);
    const tagId = getParam<string>(p, ['tagId', 'body/tagId']);
    if (!groupId) throw new Error('TeamsConnector.AtMentionTag: groupId is required');
    if (!tagId) throw new Error('TeamsConnector.AtMentionTag: tagId is required');
    const tag = await this.get<{ id: string; displayName: string }>(
      `/teams/${encodeURIComponent(groupId)}/tags/${encodeURIComponent(tagId)}`,
      ctx.log, { query: { $select: 'id,displayName' } },
    );
    return { atMentionToken: `<at id="${tag.id}">${tag.displayName}</at>`, id: tag.id, displayName: tag.displayName };
  }

  // ============= Meeting =============

  private async createTeamsMeeting(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const subject = getParam<string>(p, ['subject', 'body/subject']);
    const content = getParam<string>(p, ['content', 'body/content']);
    const timeZone = getParam<string>(p, ['timeZone', 'body/timeZone']);
    const startDateTime = getParam<string>(p, ['dateTime', 'body/start/dateTime', 'startDateTime']);
    const endDateTime = getParam<string>(p, ['body/end/dateTime', 'endDateTime']);
    if (!subject) throw new Error('TeamsConnector.CreateTeamsMeeting: subject is required');

    const requiredAttendeesRaw = getParam<string>(p, ['requiredAttendees', 'body/requiredAttendees']);
    const optionalAttendeesRaw = getParam<string>(p, ['optionalAttendees', 'body/optionalAttendees']);
    const importance = getParam<string>(p, ['importance', 'body/importance']);
    const isAllDay = getParam<boolean>(p, ['isAllDay', 'body/isAllDay']);
    const reminderMinutes = getParam<number>(p, ['reminderMinutesBeforeStart', 'body/reminderMinutesBeforeStart']);
    const isReminderOn = getParam<boolean>(p, ['isReminderOn', 'body/isReminderOn']);
    const showAs = getParam<string>(p, ['showAs', 'body/showAs']);
    const responseRequested = getParam<boolean>(p, ['responseRequested', 'body/responseRequested']);
    const locationName = getParam<string>(p, ['displayName', 'body/location/displayName']);

    const parseAttendees = (raw: string | undefined, type: string) => {
      if (!raw) return [];
      return parseStringList(raw).map((email) => ({
        emailAddress: { address: email.trim() },
        type,
      }));
    };

    const attendees = [
      ...parseAttendees(requiredAttendeesRaw, 'required'),
      ...parseAttendees(optionalAttendeesRaw, 'optional'),
    ];

    const recurrenceType = getParam<string>(p, ['body/recurrence/pattern/type', 'type']);
    let recurrence: any = undefined;
    if (recurrenceType) {
      const interval = getParam<number>(p, ['body/recurrence/pattern/interval', 'interval']);
      const daysOfWeek = getParam<string>(p, ['body/recurrence/pattern/daysOfWeek', 'daysOfWeek']);
      const index = getParam<string>(p, ['body/recurrence/pattern/index', 'index']);
      const startDate = getParam<string>(p, ['body/recurrence/range/startDate', 'startDate']);
      const endDate = getParam<string>(p, ['body/recurrence/range/endDate', 'endDate']);

      recurrence = {
        pattern: {
          type: recurrenceType,
          interval: interval || 1,
          ...(daysOfWeek && { daysOfWeek: parseStringList(daysOfWeek) }),
          ...(index && { index }),
        },
        range: {
          type: endDate ? 'endDate' : 'noEnd',
          startDate: startDate || new Date().toISOString().split('T')[0],
          ...(endDate && { endDate }),
        },
      };
    }

    return this.post('/me/events', ctx.log, {
      body: {
        subject,
        body: { contentType: 'html', content: content || '' },
        start: { dateTime: startDateTime, timeZone: timeZone || 'UTC' },
        end: { dateTime: endDateTime, timeZone: timeZone || 'UTC' },
        isOnlineMeeting: true,
        onlineMeetingProvider: 'teamsForBusiness',
        ...(attendees.length > 0 && { attendees }),
        ...(importance && { importance }),
        ...(isAllDay !== undefined && { isAllDay }),
        ...(reminderMinutes !== undefined && { reminderMinutesBeforeStart: reminderMinutes }),
        ...(isReminderOn !== undefined && { isReminderOn }),
        ...(showAs && { showAs }),
        ...(responseRequested !== undefined && { responseRequested }),
        ...(locationName && { location: { displayName: locationName } }),
        ...(recurrence && { recurrence }),
      },
    });
  }

  // ============= Graph HTTP =============

  private async httpRequest(p: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const uri = getParam<string>(p, ['Uri', 'uri', 'url']);
    const method = getParam<string>(p, ['Method', 'method']) || 'GET';
    const body = getParam<unknown>(p, ['Body', 'body']);
    const contentType = getParam<string>(p, ['ContentType', 'contentType']) || 'application/json';
    if (!uri) throw new Error('TeamsConnector.HttpRequest: Uri is required');

    const isFullUrl = uri.startsWith('http://') || uri.startsWith('https://');
    const path = isFullUrl ? new URL(uri).pathname : uri;

    const headers: Record<string, string> = { 'Content-Type': contentType };
    for (let i = 1; i <= 5; i++) {
      const headerVal = getParam<string>(p, [`CustomHeader${i}`, `customHeader${i}`]);
      if (headerVal) {
        const colonIndex = headerVal.indexOf(':');
        if (colonIndex > 0) {
          headers[headerVal.substring(0, colonIndex).trim()] = headerVal.substring(colonIndex + 1).trim();
        }
      }
    }

    const upperMethod = method.toUpperCase();
    if (upperMethod === 'GET' || upperMethod === 'DELETE') {
      return this.request<unknown>(upperMethod, path, ctx.log, { headers });
    }
    return this.request<unknown>(upperMethod, path, ctx.log, {
      headers,
      body: body as Record<string, unknown> | undefined,
    });
  }
}

export default TeamsConnector;

// Export metadata for language service
export { teamsMetadata, teamsScopes } from './metadata.js';
