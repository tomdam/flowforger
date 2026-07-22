/**
 * Microsoft Teams Connector Metadata
 *
 * Defines all Teams operations with their parameters and documentation.
 * Used by the language service for completions and hover docs.
 */

import {
  type ConnectorMetadata,
  param,
  operation,
  connector,
} from '@flowforger/connectors-shared';

export const teamsMetadata: ConnectorMetadata = connector(
  'teams',
  'Microsoft Teams',
  'Microsoft Graph connector for working with Teams, channels, chats, and messages.',
  [
    // ============= Team Management =============
    operation('CreateATeam', 'Create a new team in Microsoft Teams.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'CreateATeamParams', 'Operation parameters'),
    ], { category: 'Teams', examples: [`ctx.connectors.teams.CreateATeam('NewTeam', {\n  displayName: 'My Team',\n  description: 'A new team',\n  visibility: 'Private'\n});`] }),

    operation('GetTeam', 'Get details for a team.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetTeamParams', 'Operation parameters'),
    ], { category: 'Teams' }),

    operation('AddMemberToTeam', 'Add a member to a team.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'AddMemberToTeamParams', 'Operation parameters'),
    ], { category: 'Teams' }),

    operation('GetAllTeams', 'List all teams you are a member of.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetAllTeamsParams', 'Operation parameters'),
    ], { category: 'Teams' }),

    operation('GetAllAssociatedTeams', 'List all teams you are a direct or shared-channel member of.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetAllAssociatedTeamsParams', 'Operation parameters'),
    ], { category: 'Teams' }),

    // ============= Channel Management =============
    operation('CreateChannel', 'Create a new channel in a team.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'CreateChannelParams', 'Operation parameters'),
    ], { category: 'Channels', examples: [`ctx.connectors.teams.CreateChannel('NewChannel', {\n  groupId: 'team-guid',\n  displayName: 'General Discussion',\n  description: 'A channel for discussions'\n});`] }),

    operation('GetChannel', 'Get details for a channel.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetChannelParams', 'Operation parameters'),
    ], { category: 'Channels' }),

    operation('GetChannelsForGroup', 'List channels for a team.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetChannelsForGroupParams', 'Operation parameters'),
    ], { category: 'Channels' }),

    operation('GetAllChannelsForTeam', 'List all channels for a team including shared channels.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetAllChannelsForTeamParams', 'Operation parameters'),
    ], { category: 'Channels' }),

    operation('AddMemberToChannel', 'Add a member to a channel.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'AddMemberToChannelParams', 'Operation parameters'),
    ], { category: 'Channels' }),

    operation('RemoveMemberFromChannel', 'Remove a member from a channel.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'RemoveMemberFromChannelParams', 'Operation parameters'),
    ], { category: 'Channels' }),

    // ============= Chat Management =============
    operation('CreateChat', 'Create a one-on-one or group chat.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'CreateChatParams', 'Operation parameters'),
    ], { category: 'Chats', examples: [`ctx.connectors.teams.CreateChat('StartChat', {\n  members: 'user1@contoso.com;user2@contoso.com',\n  topic: 'Project Discussion'\n});`] }),

    operation('GetChats', 'List recent chats.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetChatsParams', 'Operation parameters'),
    ], { category: 'Chats' }),

    operation('ListMembers', 'List members of a chat or channel.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'ListMembersParams', 'Operation parameters'),
    ], { category: 'Chats' }),

    // ============= Messaging =============
    operation('PostMessageToConversation', 'Post a message to a channel or chat.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'PostMessageToConversationParams', 'Operation parameters'),
    ], { category: 'Messaging', examples: [`ctx.connectors.teams.PostMessageToConversation('Notify', {\n  poster: 'User',\n  location: 'Channel',\n  'body/recipient/groupId': 'team-guid',\n  'body/recipient/channelId': '19:channel-id@thread.tacv2',\n  'body/messageBody': '<p>Hello!</p>'\n});`] }),

    operation('PostCardToConversation', 'Post an adaptive card to a channel or chat.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'PostCardToConversationParams', 'Operation parameters'),
    ], { category: 'Messaging' }),

    operation('ReplyWithMessageToConversation', 'Reply to a channel message.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'ReplyWithMessageToConversationParams', 'Operation parameters'),
    ], { category: 'Messaging' }),

    operation('ReplyWithCardToConversation', 'Reply to a channel message with an adaptive card.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'ReplyWithCardToConversationParams', 'Operation parameters'),
    ], { category: 'Messaging' }),

    operation('UpdateCardInConversation', 'Update an existing adaptive card.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'UpdateCardInConversationParams', 'Operation parameters'),
    ], { category: 'Messaging' }),

    operation('GetMessageDetails', 'Get details of a message.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetMessageDetailsParams', 'Operation parameters'),
    ], { category: 'Messaging' }),

    operation('GetMessagesFromChannel', 'Get messages from a channel.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetMessagesFromChannelParams', 'Operation parameters'),
    ], { category: 'Messaging' }),

    operation('GetMessagesFromChat', 'Get messages from a chat.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetMessagesFromChatParams', 'Operation parameters'),
    ], { category: 'Messaging' }),

    operation('ListRepliesToMessage', 'List replies to a channel message.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'ListRepliesToMessageParams', 'Operation parameters'),
    ], { category: 'Messaging' }),

    operation('PostFeedNotification', 'Post an activity feed notification.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'PostFeedNotificationParams', 'Operation parameters'),
    ], { category: 'Messaging' }),

    // ============= Tags =============
    operation('CreateTag', 'Create a tag in a team.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'CreateTagParams', 'Operation parameters'),
    ], { category: 'Tags' }),

    operation('GetTags', 'List tags for a team.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetTagsParams', 'Operation parameters'),
    ], { category: 'Tags' }),

    operation('DeleteTag', 'Delete a tag from a team.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'DeleteTagParams', 'Operation parameters'),
    ], { category: 'Tags' }),

    operation('AddMemberToTag', 'Add a user to a tag.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'AddMemberToTagParams', 'Operation parameters'),
    ], { category: 'Tags' }),

    operation('DeleteTagMember', 'Remove a user from a tag.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'DeleteTagMemberParams', 'Operation parameters'),
    ], { category: 'Tags' }),

    operation('GetTagMembers', 'List members of a tag.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetTagMembersParams', 'Operation parameters'),
    ], { category: 'Tags' }),

    // ============= Mentions =============
    operation('AtMentionUser', 'Get an @mention token for a user.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'AtMentionUserParams', 'Operation parameters'),
    ], { category: 'Mentions' }),

    operation('AtMentionTag', 'Get an @mention token for a tag.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'AtMentionTagParams', 'Operation parameters'),
    ], { category: 'Mentions' }),

    // ============= Meeting =============
    operation('CreateTeamsMeeting', 'Create a Teams meeting.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'CreateTeamsMeetingParams', 'Operation parameters'),
    ], { category: 'Meeting', examples: [`ctx.connectors.teams.CreateTeamsMeeting('ScheduleMeeting', {\n  subject: 'Weekly Standup',\n  content: '<p>Weekly sync</p>',\n  timeZone: 'Pacific Standard Time',\n  startDateTime: '2026-04-01T09:00:00',\n  endDateTime: '2026-04-01T09:30:00',\n  requiredAttendees: 'user@contoso.com'\n});`] }),

    // ============= Advanced =============
    operation('HttpRequest', 'Send a raw Microsoft Graph HTTP request.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'HttpRequestParams', 'Operation parameters'),
    ], { category: 'Advanced' }),
  ],
  { docsUrl: 'https://learn.microsoft.com/en-us/connectors/teams/' }
);

/**
 * Maps Teams operations to their required Microsoft Graph API scopes.
 * Used by the CLI --auth feature to request only the scopes the flow needs.
 */
export const teamsScopes: Record<string, string[]> = {
  // Team management - read
  GetAllTeams: ['Team.ReadBasic.All'], getAllTeams: ['Team.ReadBasic.All'],
  GetAllAssociatedTeams: ['Team.ReadBasic.All'], getAllAssociatedTeams: ['Team.ReadBasic.All'],
  GetTeam: ['Team.ReadBasic.All'], getTeam: ['Team.ReadBasic.All'],
  // Team management - write
  CreateATeam: ['Team.Create'], createATeam: ['Team.Create'],
  AddMemberToTeam: ['TeamMember.ReadWrite.All'], addMemberToTeam: ['TeamMember.ReadWrite.All'],
  // Channel - read
  GetChannelsForGroup: ['Channel.ReadBasic.All'], getChannelsForGroup: ['Channel.ReadBasic.All'],
  GetAllChannelsForTeam: ['Channel.ReadBasic.All'], getAllChannelsForTeam: ['Channel.ReadBasic.All'],
  GetChannel: ['Channel.ReadBasic.All'], getChannel: ['Channel.ReadBasic.All'],
  // Channel - write
  CreateChannel: ['Channel.Create'], createChannel: ['Channel.Create'],
  AddMemberToChannel: ['TeamMember.ReadWrite.All'], addMemberToChannel: ['TeamMember.ReadWrite.All'],
  RemoveMemberFromChannel: ['TeamMember.ReadWrite.All'], removeMemberFromChannel: ['TeamMember.ReadWrite.All'],
  // Chat
  CreateChat: ['Chat.Create'], createChat: ['Chat.Create'],
  GetChats: ['Chat.Read'], getChats: ['Chat.Read'],
  ListMembers: ['ChatMember.Read'], listMembers: ['ChatMember.Read'],
  // Messaging - read
  GetMessagesFromChannel: ['ChannelMessage.Read.All'], getMessagesFromChannel: ['ChannelMessage.Read.All'],
  GetMessagesFromChat: ['Chat.Read'], getMessagesFromChat: ['Chat.Read'],
  GetMessageDetails: ['ChannelMessage.Read.All', 'Chat.Read'], getMessageDetails: ['ChannelMessage.Read.All', 'Chat.Read'],
  ListRepliesToMessage: ['ChannelMessage.Read.All'], listRepliesToMessage: ['ChannelMessage.Read.All'],
  // Messaging - write
  PostMessageToConversation: ['ChannelMessage.Send', 'Chat.ReadWrite'], postMessageToConversation: ['ChannelMessage.Send', 'Chat.ReadWrite'],
  PostCardToConversation: ['ChannelMessage.Send', 'Chat.ReadWrite'], postCardToConversation: ['ChannelMessage.Send', 'Chat.ReadWrite'],
  ReplyWithMessageToConversation: ['ChannelMessage.Send'], replyWithMessageToConversation: ['ChannelMessage.Send'],
  ReplyWithCardToConversation: ['ChannelMessage.Send'], replyWithCardToConversation: ['ChannelMessage.Send'],
  UpdateCardInConversation: ['ChannelMessage.Send', 'Chat.ReadWrite'], updateCardInConversation: ['ChannelMessage.Send', 'Chat.ReadWrite'],
  // Notifications
  PostFeedNotification: ['TeamsActivity.Send'], postFeedNotification: ['TeamsActivity.Send'],
  // Tags
  CreateTag: ['TeamworkTag.ReadWrite'], createTag: ['TeamworkTag.ReadWrite'],
  GetTags: ['TeamworkTag.ReadWrite'], getTags: ['TeamworkTag.ReadWrite'],
  DeleteTag: ['TeamworkTag.ReadWrite'], deleteTag: ['TeamworkTag.ReadWrite'],
  AddMemberToTag: ['TeamworkTag.ReadWrite'], addMemberToTag: ['TeamworkTag.ReadWrite'],
  DeleteTagMember: ['TeamworkTag.ReadWrite'], deleteTagMember: ['TeamworkTag.ReadWrite'],
  GetTagMembers: ['TeamworkTag.ReadWrite'], getTagMembers: ['TeamworkTag.ReadWrite'],
  // Mentions
  AtMentionUser: ['User.Read.All'], atMentionUser: ['User.Read.All'],
  AtMentionTag: ['User.Read.All', 'TeamworkTag.ReadWrite'], atMentionTag: ['User.Read.All', 'TeamworkTag.ReadWrite'],
  // Meeting
  CreateTeamsMeeting: ['Calendars.ReadWrite', 'OnlineMeetings.ReadWrite'], createTeamsMeeting: ['Calendars.ReadWrite', 'OnlineMeetings.ReadWrite'],
  // Webhook
  PostCardAndWaitForResponse: ['ChannelMessage.Send', 'Chat.ReadWrite'], postCardAndWaitForResponse: ['ChannelMessage.Send', 'Chat.ReadWrite'],
  SubscribeUserMessageWithOptions: ['Chat.ReadWrite'], subscribeUserMessageWithOptions: ['Chat.ReadWrite'],
  // Advanced
  HttpRequest: ['User.Read'], httpRequest: ['User.Read'],
};

export default teamsMetadata;
