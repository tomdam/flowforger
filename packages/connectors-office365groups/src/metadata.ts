import {
  type ConnectorMetadata,
  param,
  operation,
  connector,
} from '@flowforger/connectors-shared';

export const office365groupsMetadata: ConnectorMetadata = connector(
  'office365groups',
  'Office 365 Groups',
  'Microsoft Graph connector for working with Office 365 Groups, members, and group calendar events.',
  [
    // Group management
    operation('ListGroups', 'List all groups.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'ListGroupsParams', 'Operation parameters'),
    ], { category: 'Groups', examples: [`ctx.connectors.office365groups.ListGroups('GetGroups', {\n  top: 10\n});`] }),

    operation('GetGroup', 'Get a group by ID.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetGroupParams', 'Operation parameters'),
    ], { category: 'Groups' }),

    operation('CreateGroup', 'Create a new Office 365 group.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'CreateGroupParams', 'Operation parameters'),
    ], { category: 'Groups', examples: [`ctx.connectors.office365groups.CreateGroup('NewGroup', {\n  displayName: 'My Group',\n  mailNickname: 'mygroup'\n});`] }),

    operation('UpdateGroup', 'Update a group.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'UpdateGroupParams', 'Operation parameters'),
    ], { category: 'Groups' }),

    operation('DeleteGroup', 'Delete a group.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'DeleteGroupParams', 'Operation parameters'),
    ], { category: 'Groups' }),

    // Membership
    operation('ListGroupMembers', 'List members of a group.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'ListGroupMembersParams', 'Operation parameters'),
    ], { category: 'Members' }),

    operation('AddMemberToGroup', 'Add a member to a group.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'AddMemberParams', 'Operation parameters'),
    ], { category: 'Members' }),

    operation('RemoveMemberFromGroup', 'Remove a member from a group.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'RemoveMemberParams', 'Operation parameters'),
    ], { category: 'Members' }),

    operation('ListGroupOwners', 'List owners of a group.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'ListGroupOwnersParams', 'Operation parameters'),
    ], { category: 'Members' }),

    operation('AddOwnerToGroup', 'Add an owner to a group.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'AddOwnerParams', 'Operation parameters'),
    ], { category: 'Members' }),

    operation('RemoveOwnerFromGroup', 'Remove an owner from a group.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'RemoveOwnerParams', 'Operation parameters'),
    ], { category: 'Members' }),

    operation('IsMemberOfGroup', 'Check if the current user is a member of a group.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'IsMemberParams', 'Operation parameters'),
    ], { category: 'Members' }),

    // Group calendar events
    operation('ListGroupEvents', 'List calendar events for a group.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'ListGroupEventsParams', 'Operation parameters'),
    ], { category: 'Calendar' }),

    operation('GetGroupEvent', 'Get a calendar event by ID.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetGroupEventParams', 'Operation parameters'),
    ], { category: 'Calendar' }),

    operation('CreateGroupEvent', 'Create a calendar event for a group.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'CreateGroupEventParams', 'Operation parameters'),
    ], { category: 'Calendar', examples: [`ctx.connectors.office365groups.CreateGroupEvent('TeamSync', {\n  groupId: '<group-id>',\n  subject: 'Team Sync',\n  start: '2026-04-15T10:00:00',\n  end: '2026-04-15T11:00:00'\n});`] }),

    operation('UpdateGroupEvent', 'Update a calendar event.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'UpdateGroupEventParams', 'Operation parameters'),
    ], { category: 'Calendar' }),

    operation('DeleteGroupEvent', 'Delete a calendar event.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'DeleteGroupEventParams', 'Operation parameters'),
    ], { category: 'Calendar' }),

    // Generic
    operation('HttpRequest', 'Send a custom HTTP request to Graph API.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'HttpRequestParams', 'Operation parameters'),
    ], { category: 'Advanced' }),
  ],
  {
    docsUrl: 'https://learn.microsoft.com/en-us/connectors/office365groups/',
  }
);

export const office365groupsScopes: Record<string, string[]> = {
  // Group management — read
  ListGroups: ['Group.Read.All'], listGroups: ['Group.Read.All'], ListAllGroups: ['Group.Read.All'],
  GetGroup: ['Group.Read.All'], getGroup: ['Group.Read.All'],
  // Group management — write
  CreateGroup: ['Group.ReadWrite.All'], createGroup: ['Group.ReadWrite.All'],
  UpdateGroup: ['Group.ReadWrite.All'], updateGroup: ['Group.ReadWrite.All'],
  DeleteGroup: ['Group.ReadWrite.All'], deleteGroup: ['Group.ReadWrite.All'],
  // Membership — read
  ListGroupMembers: ['GroupMember.Read.All'], listMembers: ['GroupMember.Read.All'],
  ListGroupOwners: ['GroupMember.Read.All'], listOwners: ['GroupMember.Read.All'],
  IsMemberOfGroup: ['User.Read'], isMember: ['User.Read'],
  // Membership — write
  AddMemberToGroup: ['GroupMember.ReadWrite.All'], addMember: ['GroupMember.ReadWrite.All'],
  RemoveMemberFromGroup: ['GroupMember.ReadWrite.All'], removeMember: ['GroupMember.ReadWrite.All'],
  AddOwnerToGroup: ['Group.ReadWrite.All'], addOwner: ['Group.ReadWrite.All'],
  RemoveOwnerFromGroup: ['Group.ReadWrite.All'], removeOwner: ['Group.ReadWrite.All'],
  // Group calendar events — read
  ListGroupEvents: ['Group.Read.All'], listEvents: ['Group.Read.All'],
  GetGroupEvent: ['Group.Read.All'], getEvent: ['Group.Read.All'],
  // Group calendar events — write
  CreateGroupEvent: ['Group.ReadWrite.All'], createEvent: ['Group.ReadWrite.All'],
  UpdateGroupEvent: ['Group.ReadWrite.All'], updateEvent: ['Group.ReadWrite.All'],
  DeleteGroupEvent: ['Group.ReadWrite.All'], deleteEvent: ['Group.ReadWrite.All'],
  // Advanced
  HttpRequest: ['User.Read'], httpRequest: ['User.Read'],
};

export default office365groupsMetadata;
