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
    operation('SendEmail', 'Send an email message.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'SendEmailParams', 'Operation parameters'),
    ], { category: 'Email', examples: [`ctx.connectors.office365.SendEmail('SendNotification', {\n  to: 'user@example.com',\n  subject: 'Hello',\n  body: '<p>Email body</p>',\n  isHtml: true\n});`] }),

    operation('GetEmails', 'Get emails from a folder.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetEmailsParams', 'Operation parameters'),
    ], { category: 'Email', examples: [`ctx.connectors.office365.GetEmails('GetInbox', {\n  folderPath: 'inbox',\n  top: 10,\n  fetchOnlyUnread: true\n});`] }),

    operation('GetEmail', 'Get a single email by ID.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetEmailParams', 'Operation parameters'),
    ], { category: 'Email' }),

    operation('ReplyToEmail', 'Reply to an email.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'ReplyToEmailParams', 'Operation parameters'),
    ], { category: 'Email' }),

    operation('ForwardEmail', 'Forward an email to recipients.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'ForwardEmailParams', 'Operation parameters'),
    ], { category: 'Email' }),

    operation('DeleteEmail', 'Delete an email.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'DeleteEmailParams', 'Operation parameters'),
    ], { category: 'Email' }),

    operation('MoveEmail', 'Move an email to a folder.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'MoveEmailParams', 'Operation parameters'),
    ], { category: 'Email' }),

    operation('MarkAsRead', 'Mark an email as read or unread.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'MarkAsReadParams', 'Operation parameters'),
    ], { category: 'Email' }),

    operation('GetAttachment', 'Get an email attachment.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetAttachmentParams', 'Operation parameters'),
    ], { category: 'Email' }),

    operation('ExportEmail', 'Export an email as MIME content.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'ExportEmailParams', 'Operation parameters'),
    ], { category: 'Email' }),

    operation('GetMailFolders', 'Get mail folders.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetMailFoldersParams', 'Operation parameters'),
    ], { category: 'Email' }),

    operation('Flag', 'Flag or unflag an email.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'FlagEmailParams', 'Operation parameters'),
    ], { category: 'Email' }),

    // ============= Calendar Operations =============
    operation('CreateEvent', 'Create a calendar event.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'CreateEventParams', 'Operation parameters'),
    ], { category: 'Calendar', examples: [`ctx.connectors.office365.CreateEvent('ScheduleMeeting', {\n  subject: 'Team Meeting',\n  start: '2024-01-15T10:00:00',\n  end: '2024-01-15T11:00:00',\n  timeZone: 'Pacific Standard Time',\n  requiredAttendees: 'user1@example.com, user2@example.com'\n});`] }),

    operation('GetEvents', 'Get calendar events.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetEventsParams', 'Operation parameters'),
    ], { category: 'Calendar' }),

    operation('GetEvent', 'Get a single calendar event.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetEventParams', 'Operation parameters'),
    ], { category: 'Calendar' }),

    operation('UpdateEvent', 'Update a calendar event.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'UpdateEventParams', 'Operation parameters'),
    ], { category: 'Calendar' }),

    operation('DeleteEvent', 'Delete a calendar event.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'DeleteEventParams', 'Operation parameters'),
    ], { category: 'Calendar' }),

    operation('RespondToEvent', 'Respond to a calendar event invitation.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'RespondToEventParams', 'Operation parameters'),
    ], { category: 'Calendar' }),

    operation('GetCalendars', 'Get list of calendars.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetCalendarsParams', 'Operation parameters'),
    ], { category: 'Calendar' }),

    operation('FindMeetingTimes', 'Find available meeting times.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'FindMeetingTimesParams', 'Operation parameters'),
    ], { category: 'Calendar' }),

    // ============= Contact Operations =============
    operation('GetContacts', 'Get contacts.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetContactsParams', 'Operation parameters'),
    ], { category: 'Contacts' }),

    operation('GetContact', 'Get a single contact.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'GetContactParams', 'Operation parameters'),
    ], { category: 'Contacts' }),

    operation('CreateContact', 'Create a contact.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'CreateContactParams', 'Operation parameters'),
    ], { category: 'Contacts', examples: [`ctx.connectors.office365.CreateContact('AddContact', {\n  givenName: 'John',\n  surname: 'Doe',\n  emailAddresses: [{ address: 'john@example.com' }],\n  companyName: 'Contoso'\n});`] }),

    operation('UpdateContact', 'Update a contact.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'UpdateContactParams', 'Operation parameters'),
    ], { category: 'Contacts' }),

    operation('DeleteContact', 'Delete a contact.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'DeleteContactParams', 'Operation parameters'),
    ], { category: 'Contacts' }),

    operation('GetContactFolders', 'Get contact folders.', [
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
 */
export const office365Scopes: Record<string, string[]> = {
  // Email - read
  GetEmailsV2: ['Mail.Read'], GetEmails: ['Mail.Read'], getEmails: ['Mail.Read'],
  GetEmailV2: ['Mail.Read'], GetEmail: ['Mail.Read'], getEmail: ['Mail.Read'],
  GetAttachmentV2: ['Mail.Read'], GetAttachment: ['Mail.Read'], getAttachment: ['Mail.Read'],
  ExportEmailV2: ['Mail.Read'], ExportEmail: ['Mail.Read'], exportEmail: ['Mail.Read'],
  GetMailFolders: ['Mail.Read'], getMailFolders: ['Mail.Read'],
  // Email - send
  SendEmailV2: ['Mail.Send'], SendEmail: ['Mail.Send'], sendEmail: ['Mail.Send'],
  ReplyToEmailV2: ['Mail.Send'], ReplyToEmail: ['Mail.Send'], replyToEmail: ['Mail.Send'],
  ForwardEmailV2: ['Mail.Send'], ForwardEmail: ['Mail.Send'], forwardEmail: ['Mail.Send'],
  // Email - read/write
  DeleteEmailV2: ['Mail.ReadWrite'], DeleteEmail: ['Mail.ReadWrite'], deleteEmail: ['Mail.ReadWrite'],
  MoveEmailV2: ['Mail.ReadWrite'], MoveEmail: ['Mail.ReadWrite'], moveEmail: ['Mail.ReadWrite'],
  MarkAsReadV3: ['Mail.ReadWrite'], MarkAsRead: ['Mail.ReadWrite'], markAsRead: ['Mail.ReadWrite'],
  Flag: ['Mail.ReadWrite'], flagEmail: ['Mail.ReadWrite'],
  // Calendar - read
  GetEventsV4: ['Calendars.Read'], GetEvents: ['Calendars.Read'], getEvents: ['Calendars.Read'],
  GetEventV4: ['Calendars.Read'], GetEvent: ['Calendars.Read'], getEvent: ['Calendars.Read'],
  GetCalendars: ['Calendars.Read'], getCalendars: ['Calendars.Read'],
  CalendarGetTables: ['Calendars.Read'], getCalendarList: ['Calendars.Read'],
  FindMeetingTimesV2: ['Calendars.Read'], FindMeetingTimes: ['Calendars.Read'], findMeetingTimes: ['Calendars.Read'],
  // Calendar - read/write
  CreateEventV4: ['Calendars.ReadWrite'], CreateEvent: ['Calendars.ReadWrite'], createEvent: ['Calendars.ReadWrite'],
  UpdateEventV4: ['Calendars.ReadWrite'], UpdateEvent: ['Calendars.ReadWrite'], updateEvent: ['Calendars.ReadWrite'],
  DeleteEventV4: ['Calendars.ReadWrite'], DeleteEvent: ['Calendars.ReadWrite'], deleteEvent: ['Calendars.ReadWrite'],
  RespondToEventV2: ['Calendars.ReadWrite'], RespondToEvent: ['Calendars.ReadWrite'], respondToEvent: ['Calendars.ReadWrite'],
  // Contacts - read
  GetContactsV2: ['Contacts.Read'], GetContacts: ['Contacts.Read'], getContacts: ['Contacts.Read'],
  GetContactV2: ['Contacts.Read'], GetContact: ['Contacts.Read'], getContact: ['Contacts.Read'],
  GetContactFolders: ['Contacts.Read'], getContactFolders: ['Contacts.Read'],
  // Contacts - read/write
  CreateContactV2: ['Contacts.ReadWrite'], CreateContact: ['Contacts.ReadWrite'], createContact: ['Contacts.ReadWrite'],
  UpdateContactV2: ['Contacts.ReadWrite'], UpdateContact: ['Contacts.ReadWrite'], updateContact: ['Contacts.ReadWrite'],
  DeleteContactV2: ['Contacts.ReadWrite'], DeleteContact: ['Contacts.ReadWrite'], deleteContact: ['Contacts.ReadWrite'],
  // User
  GetMyProfile: ['User.Read'], getMyProfile: ['User.Read'],
  // Advanced
  HttpRequest: ['User.Read'], httpRequest: ['User.Read'],
};

export default office365Metadata;
