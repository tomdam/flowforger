/**
 * Office 365 Connector Metadata
 *
 * Defines all Office 365 Outlook operations with their parameters and documentation.
 * Used by the language service for completions and hover docs.
 */

import {
  type ConnectorMetadata,
  param,
  operation,
  connector,
} from '@flowforger/connectors-shared';

export const office365Metadata: ConnectorMetadata = connector(
  'office365',
  'Office 365 Outlook',
  'Microsoft Graph connector for working with emails, calendar events, and contacts.',
  [
    // ============= Email Operations =============
    operation('SendEmail', 'Send an email message (cloud id SendEmailV2; emailMessage/To, Subject, Body, Cc, Bcc, Importance, Attachments).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'SendEmailParams', 'Operation parameters'),
    ], { category: 'Email', examples: [`ctx.connectors.office365.SendEmail('SendNotification', {\n  to: 'user@example.com',\n  subject: 'Hello',\n  body: '<p>Email body</p>',\n  isHtml: true\n});`] }),

    operation('GetEmails', 'Get emails from a folder (cloud id GetEmailsV3; folderPath, top, fetchOnlyUnread, searchQuery, includeAttachments, mailboxAddress).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetEmailsParams', 'Operation parameters'),
    ], { category: 'Email', examples: [`ctx.connectors.office365.GetEmails('GetInbox', {\n  folderPath: 'inbox',\n  top: 10,\n  fetchOnlyUnread: true\n});`] }),

    operation('GetEmail', 'Get a single email by ID (cloud id GetEmailV2; messageId, mailboxAddress, includeAttachments).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetEmailParams', 'Operation parameters'),
    ], { category: 'Email' }),

    operation('ReplyToEmail', 'Reply to an email (cloud id ReplyToV3; messageId, body -> replyParameters/Body, replyAll -> replyParameters/ReplyAll).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'ReplyToEmailParams', 'Operation parameters'),
    ], { category: 'Email' }),

    operation('ForwardEmail', 'Forward an email to recipients (cloud id ForwardEmail_V2; messageId -> message_id, to -> body/ToRecipients, comment -> body/Comment).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'ForwardEmailParams', 'Operation parameters'),
    ], { category: 'Email' }),

    operation('DeleteEmail', 'Delete an email (cloud id DeleteEmail_V2; messageId, mailboxAddress).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'DeleteEmailParams', 'Operation parameters'),
    ], { category: 'Email' }),

    operation('MoveEmail', 'Move an email to a folder (cloud id MoveV2; messageId, destinationId -> folderPath).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'MoveEmailParams', 'Operation parameters'),
    ], { category: 'Email' }),

    operation('MarkAsRead', 'Mark an email as read or unread (cloud id MarkAsRead_V3; messageId, isRead -> body/isRead).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'MarkAsReadParams', 'Operation parameters'),
    ], { category: 'Email' }),

    operation('GetAttachment', 'Get an email attachment (cloud id GetAttachment_V2; messageId, attachmentId).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetAttachmentParams', 'Operation parameters'),
    ], { category: 'Email' }),

    operation('ExportEmail', 'Export an email as MIME content (cloud id ExportEmail_V2; messageId).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'ExportEmailParams', 'Operation parameters'),
    ], { category: 'Email' }),

    operation('GetMailFolders', 'Get mail folders.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetMailFoldersParams', 'Operation parameters'),
    ], { category: 'Email' }),

    operation('Flag', 'Flag or unflag an email (current cloud id Flag_V2; messageId, flagStatus).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'FlagEmailParams', 'Operation parameters'),
    ], { category: 'Email' }),

    // ============= Calendar Operations =============
    operation('CreateEvent', 'Create a calendar event (cloud id V4CalendarPostItem; calendarId -> table, subject/start/end/timeZone/... -> item/*).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'CreateEventParams', 'Operation parameters'),
    ], { category: 'Calendar', examples: [`ctx.connectors.office365.CreateEvent('ScheduleMeeting', {\n  subject: 'Team Meeting',\n  start: '2024-01-15T10:00:00',\n  end: '2024-01-15T11:00:00',\n  timeZone: 'Pacific Standard Time',\n  requiredAttendees: 'user1@example.com, user2@example.com'\n});`] }),

    operation('GetEvents', 'Get calendar events (cloud id V4CalendarGetItems; calendarId -> table, filter/orderBy/top -> $filter/$orderby/$top; a start/end window reads the calendar view).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetEventsParams', 'Operation parameters'),
    ], { category: 'Calendar' }),

    operation('GetEvent', 'Get a single calendar event (cloud id V3CalendarGetItem; calendarId -> table, eventId -> id).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetEventParams', 'Operation parameters'),
    ], { category: 'Calendar' }),

    operation('UpdateEvent', 'Update a calendar event (cloud id V4CalendarPatchItem; calendarId -> table, eventId -> id, fields -> item/*).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'UpdateEventParams', 'Operation parameters'),
    ], { category: 'Calendar' }),

    operation('DeleteEvent', 'Delete a calendar event (cloud id CalendarDeleteItem_V2; calendarId -> calendar, eventId -> event).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'DeleteEventParams', 'Operation parameters'),
    ], { category: 'Calendar' }),

    operation('RespondToEvent', 'Respond to a calendar event invitation (cloud id RespondToEvent_V2; eventId -> event_id, response).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'RespondToEventParams', 'Operation parameters'),
    ], { category: 'Calendar' }),

    operation('GetCalendars', 'Get list of calendars (cloud id CalendarGetTables_V2).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetCalendarsParams', 'Operation parameters'),
    ], { category: 'Calendar' }),

    operation('FindMeetingTimes', 'Find available meeting times (cloud id FindMeetingTimes_V2).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'FindMeetingTimesParams', 'Operation parameters'),
    ], { category: 'Calendar' }),

    // ============= Contact Operations =============
    operation('GetContacts', 'Get contacts (cloud id ContactGetItems_V2; folderId -> folder).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetContactsParams', 'Operation parameters'),
    ], { category: 'Contacts' }),

    operation('GetContact', 'Get a single contact (cloud id ContactGetItem_V2; folderId -> folder, contactId -> id).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetContactParams', 'Operation parameters'),
    ], { category: 'Contacts' }),

    operation('CreateContact', 'Create a contact (cloud id ContactPostItem_V2; folderId -> folder).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'CreateContactParams', 'Operation parameters'),
    ], { category: 'Contacts', examples: [`ctx.connectors.office365.CreateContact('AddContact', {\n  givenName: 'John',\n  surname: 'Doe',\n  emailAddresses: [{ address: 'john@example.com' }],\n  companyName: 'Contoso'\n});`] }),

    operation('UpdateContact', 'Update a contact (cloud id ContactPatchItem_V2; folderId -> folder, contactId -> id).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'UpdateContactParams', 'Operation parameters'),
    ], { category: 'Contacts' }),

    operation('DeleteContact', 'Delete a contact (cloud id ContactDeleteItem_V2; folderId -> folder, contactId -> id).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'DeleteContactParams', 'Operation parameters'),
    ], { category: 'Contacts' }),

    operation('GetContactFolders', 'Get contact folders (cloud id ContactGetTablesV2).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetContactFoldersParams', 'Operation parameters'),
    ], { category: 'Contacts' }),

    // ============= User Operations =============
    operation('GetMyProfile', 'Get current user profile.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetMyProfileParams', 'Operation parameters'),
    ], { category: 'User' }),

    operation('HttpRequest', 'Send a custom HTTP request to Graph API.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'HttpRequestParams', 'Operation parameters'),
    ], { category: 'Advanced' }),
  ],
  {
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/overview',
  }
);

/**
 * Maps Office 365 operations to their required Microsoft Graph API scopes.
 * Used by the CLI --auth feature to request only the scopes the flow needs.
 * Operation aliases (e.g., SendEmailV2, SendEmail, sendEmail) all map to the same scopes.
 * The cloud ids the designer writes (ReplyToV3, MoveV2, V4CalendarPostItem, ...) are listed
 * next to the local aliases the emitter maps onto them (see OFFICE365_OPERATION_ALIASES).
 */
export const office365Scopes: Record<string, string[]> = {
  // Email - read
  GetEmailsV3: ['Mail.Read'], GetEmailsV2: ['Mail.Read'], GetEmails: ['Mail.Read'], getEmails: ['Mail.Read'],
  GetEmailV2: ['Mail.Read'], GetEmail: ['Mail.Read'], getEmail: ['Mail.Read'],
  GetAttachment_V2: ['Mail.Read'], GetAttachmentV2: ['Mail.Read'], GetAttachment: ['Mail.Read'], getAttachment: ['Mail.Read'],
  ExportEmail_V2: ['Mail.Read'], ExportEmailV2: ['Mail.Read'], ExportEmail: ['Mail.Read'], exportEmail: ['Mail.Read'],
  GetMailFolders: ['Mail.Read'], getMailFolders: ['Mail.Read'],
  // Email - send
  SendEmailV2: ['Mail.Send'], SendEmail: ['Mail.Send'], sendEmail: ['Mail.Send'],
  SharedMailboxSendEmailV2: ['Mail.Send', 'Mail.Send.Shared'], SharedMailboxSendEmail: ['Mail.Send', 'Mail.Send.Shared'],
  ReplyToV3: ['Mail.Send'], ReplyToV2: ['Mail.Send'], ReplyTo: ['Mail.Send'],
  ReplyToEmailV2: ['Mail.Send'], ReplyToEmail: ['Mail.Send'], replyToEmail: ['Mail.Send'],
  ForwardEmail_V2: ['Mail.Send'], ForwardEmailV2: ['Mail.Send'], ForwardEmail: ['Mail.Send'], forwardEmail: ['Mail.Send'],
  // Email - read/write
  DeleteEmail_V2: ['Mail.ReadWrite'], DeleteEmailV2: ['Mail.ReadWrite'], DeleteEmail: ['Mail.ReadWrite'], deleteEmail: ['Mail.ReadWrite'],
  MoveV2: ['Mail.ReadWrite'], Move: ['Mail.ReadWrite'], MoveEmailV2: ['Mail.ReadWrite'], MoveEmail: ['Mail.ReadWrite'], moveEmail: ['Mail.ReadWrite'],
  MarkAsRead_V3: ['Mail.ReadWrite'], MarkAsRead_V2: ['Mail.ReadWrite'], MarkAsReadV3: ['Mail.ReadWrite'], MarkAsRead: ['Mail.ReadWrite'], markAsRead: ['Mail.ReadWrite'],
  Flag_V2: ['Mail.ReadWrite'], FlagV2: ['Mail.ReadWrite'], Flag: ['Mail.ReadWrite'], flagEmail: ['Mail.ReadWrite'],
  // Calendar - read
  V4CalendarGetItems: ['Calendars.Read'], V3CalendarGetItems: ['Calendars.Read'], V2CalendarGetItems: ['Calendars.Read'], CalendarGetItems: ['Calendars.Read'],
  GetEventsV4: ['Calendars.Read'], GetEvents: ['Calendars.Read'], getEvents: ['Calendars.Read'],
  GetEventsCalendarViewV3: ['Calendars.Read'], GetEventsCalendarViewV2: ['Calendars.Read'], GetEventsCalendarView: ['Calendars.Read'],
  V3CalendarGetItem: ['Calendars.Read'], V2CalendarGetItem: ['Calendars.Read'], CalendarGetItem: ['Calendars.Read'],
  GetEventV4: ['Calendars.Read'], GetEvent: ['Calendars.Read'], getEvent: ['Calendars.Read'],
  CalendarGetTables_V2: ['Calendars.Read'], CalendarGetTables: ['Calendars.Read'],
  GetCalendars: ['Calendars.Read'], getCalendars: ['Calendars.Read'], getCalendarList: ['Calendars.Read'],
  FindMeetingTimes_V2: ['Calendars.Read'], FindMeetingTimesV2: ['Calendars.Read'], FindMeetingTimes: ['Calendars.Read'], findMeetingTimes: ['Calendars.Read'],
  // Calendar - read/write
  V4CalendarPostItem: ['Calendars.ReadWrite'], V3CalendarPostItem: ['Calendars.ReadWrite'], V2CalendarPostItem: ['Calendars.ReadWrite'], CalendarPostItem: ['Calendars.ReadWrite'],
  CreateEventV4: ['Calendars.ReadWrite'], CreateEvent: ['Calendars.ReadWrite'], createEvent: ['Calendars.ReadWrite'],
  V4CalendarPatchItem: ['Calendars.ReadWrite'], V3CalendarPatchItem: ['Calendars.ReadWrite'], V2CalendarPatchItem: ['Calendars.ReadWrite'], CalendarPatchItem: ['Calendars.ReadWrite'],
  UpdateEventV4: ['Calendars.ReadWrite'], UpdateEvent: ['Calendars.ReadWrite'], updateEvent: ['Calendars.ReadWrite'],
  CalendarDeleteItem_V2: ['Calendars.ReadWrite'], CalendarDeleteItem: ['Calendars.ReadWrite'],
  DeleteEventV4: ['Calendars.ReadWrite'], DeleteEvent: ['Calendars.ReadWrite'], deleteEvent: ['Calendars.ReadWrite'],
  RespondToEvent_V2: ['Calendars.ReadWrite'], RespondToEventV2: ['Calendars.ReadWrite'], RespondToEvent: ['Calendars.ReadWrite'], respondToEvent: ['Calendars.ReadWrite'],
  // Contacts - read
  ContactGetItems_V2: ['Contacts.Read'], ContactGetItems: ['Contacts.Read'], GetContactsV2: ['Contacts.Read'], GetContacts: ['Contacts.Read'], getContacts: ['Contacts.Read'],
  ContactGetItem_V2: ['Contacts.Read'], ContactGetItem: ['Contacts.Read'], GetContactV2: ['Contacts.Read'], GetContact: ['Contacts.Read'], getContact: ['Contacts.Read'],
  ContactGetTablesV2: ['Contacts.Read'], ContactGetTables: ['Contacts.Read'], GetContactFolders: ['Contacts.Read'], getContactFolders: ['Contacts.Read'],
  // Contacts - read/write
  ContactPostItem_V2: ['Contacts.ReadWrite'], ContactPostItem: ['Contacts.ReadWrite'], CreateContactV2: ['Contacts.ReadWrite'], CreateContact: ['Contacts.ReadWrite'], createContact: ['Contacts.ReadWrite'],
  ContactPatchItem_V2: ['Contacts.ReadWrite'], ContactPatchItem: ['Contacts.ReadWrite'], UpdateContactV2: ['Contacts.ReadWrite'], UpdateContact: ['Contacts.ReadWrite'], updateContact: ['Contacts.ReadWrite'],
  ContactDeleteItem_V2: ['Contacts.ReadWrite'], ContactDeleteItem: ['Contacts.ReadWrite'], DeleteContactV2: ['Contacts.ReadWrite'], DeleteContact: ['Contacts.ReadWrite'], deleteContact: ['Contacts.ReadWrite'],
  // User
  GetMyProfile: ['User.Read'], getMyProfile: ['User.Read'],
  // Advanced
  HttpRequest: ['User.Read'], httpRequest: ['User.Read'],
};

export default office365Metadata;
