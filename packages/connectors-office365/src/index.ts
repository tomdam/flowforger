/**
 * Office 365 Connector for FlowForger
 *
 * Implements Office 365 Outlook operations using Microsoft Graph API.
 * Requires a Microsoft Graph API token with appropriate permissions:
 * - Mail.Read, Mail.Send, Mail.ReadWrite for email operations
 * - Calendars.Read, Calendars.ReadWrite for calendar operations
 * - Contacts.Read, Contacts.ReadWrite for contact operations
 */

import type { BaseConnector, RunContext } from '@flowforger/engine';
import { BaseHttpClient, parseStringList, HttpError } from '@flowforger/connectors-shared';

export interface Office365ConnectorOptions {
  /** Microsoft Graph API access token */
  token: string;
  /** Optional: Graph API base URL (defaults to https://graph.microsoft.com/v1.0) */
  baseUrl?: string;
}

export interface EmailRecipient {
  emailAddress: {
    address: string;
    name?: string;
  };
}

export interface EmailAttachment {
  '@odata.type': string;
  name: string;
  contentBytes: string;
  contentType?: string;
}

export interface SendEmailInputs {
  /** Email subject */
  subject: string;
  /** Email body (HTML or text) */
  body: string;
  /** Is the body HTML? Defaults to true */
  isHtml?: boolean;
  /** To recipients - comma-separated emails or array */
  to: string | string[] | EmailRecipient[];
  /** CC recipients - comma-separated emails or array */
  cc?: string | string[] | EmailRecipient[];
  /** BCC recipients - comma-separated emails or array */
  bcc?: string | string[] | EmailRecipient[];
  /** Email importance: low, normal, high */
  importance?: 'low' | 'normal' | 'high';
  /** Reply-to address */
  replyTo?: string;
  /** Attachments */
  attachments?: EmailAttachment[];
  /** From mailbox (for shared mailboxes) */
  from?: string;
}

export interface GetEmailsInputs {
  /** Folder ID or well-known name (inbox, drafts, sentitems, deleteditems) */
  folderPath?: string;
  /** Number of emails to fetch */
  top?: number;
  /** Search query */
  searchQuery?: string;
  /** Filter query (OData) */
  filter?: string;
  /** Order by field */
  orderBy?: string;
  /** Include attachments? */
  includeAttachments?: boolean;
  /** Mailbox address (for shared mailboxes) */
  mailboxAddress?: string;
  /** Fetch only unread messages */
  fetchOnlyUnread?: boolean;
}

export interface CalendarEventInputs {
  /** Event subject/title */
  subject: string;
  /** Event body/description */
  body?: string;
  /** Start date/time (ISO 8601) */
  start: string;
  /** End date/time (ISO 8601) */
  end: string;
  /** Timezone (e.g., 'Pacific Standard Time') */
  timeZone?: string;
  /** Location */
  location?: string;
  /** Required attendees - comma-separated or array */
  requiredAttendees?: string | string[];
  /** Optional attendees - comma-separated or array */
  optionalAttendees?: string | string[];
  /** Is all day event */
  isAllDay?: boolean;
  /** Reminder minutes before */
  reminderMinutes?: number;
  /** Show as: free, tentative, busy, oof, workingElsewhere, unknown */
  showAs?: string;
  /** Sensitivity: normal, personal, private, confidential */
  sensitivity?: string;
  /** Categories */
  categories?: string[];
  /** Calendar ID (defaults to primary calendar) */
  calendarId?: string;
  /** Recurrence pattern */
  recurrence?: unknown;
}

export interface ContactInputs {
  /** First name */
  givenName?: string;
  /** Last name */
  surname?: string;
  /** Display name */
  displayName?: string;
  /** Email addresses */
  emailAddresses?: Array<{ address: string; name?: string }>;
  /** Business phones */
  businessPhones?: string[];
  /** Home phones */
  homePhones?: string[];
  /** Mobile phone */
  mobilePhone?: string;
  /** Company name */
  companyName?: string;
  /** Job title */
  jobTitle?: string;
  /** Department */
  department?: string;
  /** Business address */
  businessAddress?: {
    street?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    countryOrRegion?: string;
  };
  /** Personal notes */
  personalNotes?: string;
}

// Re-export HttpError for consumers
export { HttpError };

export class Office365Connector extends BaseHttpClient implements BaseConnector {
  constructor(opts: Office365ConnectorOptions) {
    super(
      opts.baseUrl?.replace(/\/$/, '') || 'https://graph.microsoft.com/v1.0',
      opts.token
    );
  }

  async invoke(operation: string, inputs: unknown, ctx: RunContext): Promise<unknown> {
    ctx.log?.({ type: 'office365.invoke', operation, inputs });

    switch (operation) {
      // Email operations
      case 'SendEmailV2':
      case 'SendEmail':
      case 'sendEmail':
        return this.sendEmail(this.transformEmailInputs(inputs as Record<string, unknown>), ctx);

      case 'GetEmailsV2':
      case 'GetEmails':
      case 'getEmails':
        return this.getEmails(inputs as GetEmailsInputs, ctx);

      case 'GetEmailV2':
      case 'GetEmail':
      case 'getEmail':
        return this.getEmail(inputs as { messageId: string; mailboxAddress?: string; includeAttachments?: boolean }, ctx);

      case 'ReplyToEmailV2':
      case 'ReplyToEmail':
      case 'replyToEmail':
        return this.replyToEmail(inputs as { messageId: string; body: string; replyAll?: boolean; mailboxAddress?: string }, ctx);

      case 'ForwardEmailV2':
      case 'ForwardEmail':
      case 'forwardEmail':
        return this.forwardEmail(inputs as { messageId: string; to: string | string[]; comment?: string; mailboxAddress?: string }, ctx);

      case 'DeleteEmailV2':
      case 'DeleteEmail':
      case 'deleteEmail':
        return this.deleteEmail(inputs as { messageId: string; mailboxAddress?: string }, ctx);

      case 'MoveEmailV2':
      case 'MoveEmail':
      case 'moveEmail':
        return this.moveEmail(inputs as { messageId: string; destinationId: string; mailboxAddress?: string }, ctx);

      case 'MarkAsReadV3':
      case 'MarkAsRead':
      case 'markAsRead':
        return this.markAsRead(inputs as { messageId: string; isRead?: boolean; mailboxAddress?: string }, ctx);

      case 'GetAttachmentV2':
      case 'GetAttachment':
      case 'getAttachment':
        return this.getAttachment(inputs as { messageId: string; attachmentId: string; mailboxAddress?: string }, ctx);

      case 'ExportEmailV2':
      case 'ExportEmail':
      case 'exportEmail':
        return this.exportEmail(inputs as { messageId: string; mailboxAddress?: string }, ctx);

      case 'GetMailFolders':
      case 'getMailFolders':
        return this.getMailFolders(inputs as { mailboxAddress?: string }, ctx);

      case 'Flag':
      case 'flagEmail':
        return this.flagEmail(inputs as { messageId: string; flagStatus: 'flagged' | 'complete' | 'notFlagged'; mailboxAddress?: string }, ctx);

      // Calendar operations
      case 'CreateEventV4':
      case 'CreateEvent':
      case 'createEvent':
        return this.createEvent(inputs as CalendarEventInputs, ctx);

      case 'GetEventsV4':
      case 'GetEvents':
      case 'getEvents':
        return this.getEvents(inputs as { calendarId?: string; startDateTime?: string; endDateTime?: string; top?: number; filter?: string; orderBy?: string }, ctx);

      case 'GetEventV4':
      case 'GetEvent':
      case 'getEvent':
        return this.getEvent(inputs as { eventId: string; calendarId?: string }, ctx);

      case 'UpdateEventV4':
      case 'UpdateEvent':
      case 'updateEvent':
        return this.updateEvent(inputs as { eventId: string; calendarId?: string } & Partial<CalendarEventInputs>, ctx);

      case 'DeleteEventV4':
      case 'DeleteEvent':
      case 'deleteEvent':
        return this.deleteEvent(inputs as { eventId: string; calendarId?: string }, ctx);

      case 'RespondToEventV2':
      case 'RespondToEvent':
      case 'respondToEvent':
        return this.respondToEvent(inputs as { eventId: string; response: 'accept' | 'tentativelyAccept' | 'decline'; comment?: string; sendResponse?: boolean }, ctx);

      case 'GetCalendars':
      case 'getCalendars':
        return this.getCalendars(ctx);

      case 'CalendarGetTables':
      case 'getCalendarList':
        return this.getCalendars(ctx);

      case 'FindMeetingTimesV2':
      case 'FindMeetingTimes':
      case 'findMeetingTimes':
        return this.findMeetingTimes(inputs as { attendees?: string | string[]; durationMinutes?: number; startDateTime?: string; endDateTime?: string; maxCandidates?: number }, ctx);

      // Contact operations
      case 'GetContactsV2':
      case 'GetContacts':
      case 'getContacts':
        return this.getContacts(inputs as { top?: number; filter?: string; orderBy?: string; folderId?: string }, ctx);

      case 'GetContactV2':
      case 'GetContact':
      case 'getContact':
        return this.getContact(inputs as { contactId: string; folderId?: string }, ctx);

      case 'CreateContactV2':
      case 'CreateContact':
      case 'createContact':
        return this.createContact(inputs as ContactInputs & { folderId?: string }, ctx);

      case 'UpdateContactV2':
      case 'UpdateContact':
      case 'updateContact':
        return this.updateContact(inputs as { contactId: string; folderId?: string } & ContactInputs, ctx);

      case 'DeleteContactV2':
      case 'DeleteContact':
      case 'deleteContact':
        return this.deleteContact(inputs as { contactId: string; folderId?: string }, ctx);

      case 'GetContactFolders':
      case 'getContactFolders':
        return this.getContactFolders(ctx);

      // User profile
      case 'GetMyProfile':
      case 'getMyProfile':
        return this.getMyProfile(ctx);

      case 'HttpRequest':
      case 'httpRequest':
        return this.httpRequest(inputs as { method: string; uri: string; body?: unknown; headers?: Record<string, string> }, ctx);

      default:
        throw new Error(`Office365Connector: unknown operation '${operation}'`);
    }
  }

  // ============= Helper Methods =============

  /**
   * Transform Power Automate style email parameters to our expected format.
   * Power Automate uses 'emailMessage/To', 'emailMessage/Subject', etc.
   */
  private transformEmailInputs(inputs: Record<string, unknown>): SendEmailInputs {
    // Check if it's already in the expected format
    if (inputs.to || inputs.subject || inputs.body) {
      return inputs as unknown as SendEmailInputs;
    }

    // Transform Power Automate format
    const result: SendEmailInputs = {
      to: (inputs['emailMessage/To'] || inputs['To'] || '') as string,
      subject: (inputs['emailMessage/Subject'] || inputs['Subject'] || '') as string,
      body: (inputs['emailMessage/Body'] || inputs['Body'] || '') as string,
    };

    // Optional fields
    if (inputs['emailMessage/Cc'] || inputs['Cc']) {
      result.cc = (inputs['emailMessage/Cc'] || inputs['Cc']) as string;
    }
    if (inputs['emailMessage/Bcc'] || inputs['Bcc']) {
      result.bcc = (inputs['emailMessage/Bcc'] || inputs['Bcc']) as string;
    }
    if (inputs['emailMessage/Importance'] || inputs['Importance']) {
      const importance = ((inputs['emailMessage/Importance'] || inputs['Importance']) as string).toLowerCase();
      if (importance === 'low' || importance === 'normal' || importance === 'high') {
        result.importance = importance;
      }
    }
    if (inputs['emailMessage/ReplyTo'] || inputs['ReplyTo']) {
      result.replyTo = (inputs['emailMessage/ReplyTo'] || inputs['ReplyTo']) as string;
    }
    if (inputs['emailMessage/From'] || inputs['From']) {
      result.from = (inputs['emailMessage/From'] || inputs['From']) as string;
    }
    if (inputs['emailMessage/IsHtml'] !== undefined || inputs['IsHtml'] !== undefined) {
      result.isHtml = Boolean(inputs['emailMessage/IsHtml'] ?? inputs['IsHtml']);
    }
    if (inputs['emailMessage/Attachments'] || inputs['Attachments']) {
      result.attachments = (inputs['emailMessage/Attachments'] || inputs['Attachments']) as EmailAttachment[];
    }

    return result;
  }

  private parseRecipients(recipients: string | string[] | EmailRecipient[]): EmailRecipient[] {
    if (!recipients) return [];

    if (Array.isArray(recipients)) {
      return recipients.map((r) => {
        if (typeof r === 'string') {
          return { emailAddress: { address: r.trim() } };
        }
        return r;
      });
    }

    // Use shared utility for string parsing
    return parseStringList(recipients).map(email => ({
      emailAddress: { address: email },
    }));
  }

  private parseAttendees(attendees: string | string[] | undefined, type: 'required' | 'optional'): Array<{ emailAddress: { address: string }; type: string }> {
    return parseStringList(attendees).map(email => ({
      emailAddress: { address: email },
      type,
    }));
  }

  private getUserPath(mailboxAddress?: string): string {
    const mailbox = mailboxAddress || 'me';
    return mailbox === 'me' ? '/me' : `/users/${encodeURIComponent(mailbox)}`;
  }

  // ============= Email Operations =============

  async sendEmail(inputs: SendEmailInputs, ctx: RunContext): Promise<{ success: boolean }> {
    const message: Record<string, unknown> = {
      subject: inputs.subject,
      body: {
        contentType: inputs.isHtml !== false ? 'HTML' : 'Text',
        content: inputs.body,
      },
      toRecipients: this.parseRecipients(inputs.to),
    };

    if (inputs.cc) message.ccRecipients = this.parseRecipients(inputs.cc);
    if (inputs.bcc) message.bccRecipients = this.parseRecipients(inputs.bcc);
    if (inputs.importance) message.importance = inputs.importance;
    if (inputs.replyTo) message.replyTo = this.parseRecipients(inputs.replyTo);

    if (inputs.attachments?.length) {
      message.attachments = inputs.attachments.map(att => ({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: att.name,
        contentBytes: att.contentBytes,
        contentType: att.contentType || 'application/octet-stream',
      }));
    }

    const endpoint = inputs.from
      ? `/users/${encodeURIComponent(inputs.from)}/sendMail`
      : '/me/sendMail';

    await this.post(endpoint, ctx.log, { body: { message, saveToSentItems: true } });
    return { success: true };
  }

  async getEmails(inputs: GetEmailsInputs, ctx: RunContext): Promise<unknown[]> {
    const params: string[] = [];

    params.push(`$top=${inputs.top || 10}`);

    if (inputs.filter) {
      params.push(`$filter=${encodeURIComponent(inputs.filter)}`);
    } else if (inputs.fetchOnlyUnread) {
      params.push(`$filter=${encodeURIComponent('isRead eq false')}`);
    }

    if (inputs.searchQuery) {
      // $search and $orderby cannot be combined in Graph API
      params.push(`$search="${encodeURIComponent(inputs.searchQuery)}"`);
    } else {
      params.push(`$orderby=${encodeURIComponent(inputs.orderBy || 'receivedDateTime desc')}`);
    }

    const queryString = `?${params.join('&')}`;
    const userPath = this.getUserPath(inputs.mailboxAddress);

    let endpoint: string;
    if (inputs.folderPath) {
      const wellKnownFolders = ['inbox', 'drafts', 'sentitems', 'deleteditems', 'junkemail', 'archive'];
      const folder = inputs.folderPath.toLowerCase();
      endpoint = wellKnownFolders.includes(folder)
        ? `${userPath}/mailFolders/${folder}/messages${queryString}`
        : `${userPath}/mailFolders/${encodeURIComponent(inputs.folderPath)}/messages${queryString}`;
    } else {
      endpoint = `${userPath}/messages${queryString}`;
    }

    const result = await this.get<{ value: unknown[] }>(endpoint, ctx.log);
    return result.value || [];
  }

  async getEmail(inputs: { messageId: string; mailboxAddress?: string; includeAttachments?: boolean }, ctx: RunContext): Promise<unknown> {
    const userPath = this.getUserPath(inputs.mailboxAddress);
    let endpoint = `${userPath}/messages/${encodeURIComponent(inputs.messageId)}`;
    if (inputs.includeAttachments) endpoint += '?$expand=attachments';
    return this.get(endpoint, ctx.log);
  }

  async replyToEmail(inputs: { messageId: string; body: string; replyAll?: boolean; mailboxAddress?: string }, ctx: RunContext): Promise<{ success: boolean }> {
    const userPath = this.getUserPath(inputs.mailboxAddress);
    const action = inputs.replyAll ? 'replyAll' : 'reply';
    const endpoint = `${userPath}/messages/${encodeURIComponent(inputs.messageId)}/${action}`;
    await this.post(endpoint, ctx.log, { body: { comment: inputs.body } });
    return { success: true };
  }

  async forwardEmail(inputs: { messageId: string; to: string | string[]; comment?: string; mailboxAddress?: string }, ctx: RunContext): Promise<{ success: boolean }> {
    const userPath = this.getUserPath(inputs.mailboxAddress);
    const endpoint = `${userPath}/messages/${encodeURIComponent(inputs.messageId)}/forward`;
    await this.post(endpoint, ctx.log, {
      body: {
        comment: inputs.comment || '',
        toRecipients: this.parseRecipients(inputs.to),
      },
    });
    return { success: true };
  }

  async deleteEmail(inputs: { messageId: string; mailboxAddress?: string }, ctx: RunContext): Promise<{ success: boolean }> {
    const userPath = this.getUserPath(inputs.mailboxAddress);
    await this.delete(`${userPath}/messages/${encodeURIComponent(inputs.messageId)}`, ctx.log);
    return { success: true };
  }

  async moveEmail(inputs: { messageId: string; destinationId: string; mailboxAddress?: string }, ctx: RunContext): Promise<unknown> {
    const userPath = this.getUserPath(inputs.mailboxAddress);
    return this.post(`${userPath}/messages/${encodeURIComponent(inputs.messageId)}/move`, ctx.log, {
      body: { destinationId: inputs.destinationId },
    });
  }

  async markAsRead(inputs: { messageId: string; isRead?: boolean; mailboxAddress?: string }, ctx: RunContext): Promise<unknown> {
    const userPath = this.getUserPath(inputs.mailboxAddress);
    return this.patch(`${userPath}/messages/${encodeURIComponent(inputs.messageId)}`, ctx.log, {
      body: { isRead: inputs.isRead !== false },
    });
  }

  async getAttachment(inputs: { messageId: string; attachmentId: string; mailboxAddress?: string }, ctx: RunContext): Promise<unknown> {
    const userPath = this.getUserPath(inputs.mailboxAddress);
    return this.get(`${userPath}/messages/${encodeURIComponent(inputs.messageId)}/attachments/${encodeURIComponent(inputs.attachmentId)}`, ctx.log);
  }

  async exportEmail(inputs: { messageId: string; mailboxAddress?: string }, ctx: RunContext): Promise<unknown> {
    const userPath = this.getUserPath(inputs.mailboxAddress);
    return this.get(`${userPath}/messages/${encodeURIComponent(inputs.messageId)}/$value`, ctx.log, {
      headers: { Accept: 'message/rfc822' },
    });
  }

  async getMailFolders(inputs: { mailboxAddress?: string }, ctx: RunContext): Promise<unknown[]> {
    const userPath = this.getUserPath(inputs.mailboxAddress);
    const result = await this.get<{ value: unknown[] }>(`${userPath}/mailFolders?$top=100`, ctx.log);
    return result.value || [];
  }

  async flagEmail(inputs: { messageId: string; flagStatus: 'flagged' | 'complete' | 'notFlagged'; mailboxAddress?: string }, ctx: RunContext): Promise<unknown> {
    const userPath = this.getUserPath(inputs.mailboxAddress);
    return this.patch(`${userPath}/messages/${encodeURIComponent(inputs.messageId)}`, ctx.log, {
      body: { flag: { flagStatus: inputs.flagStatus } },
    });
  }

  // ============= Calendar Operations =============

  async createEvent(inputs: CalendarEventInputs, ctx: RunContext): Promise<unknown> {
    const event: Record<string, unknown> = {
      subject: inputs.subject,
      start: { dateTime: inputs.start, timeZone: inputs.timeZone || 'UTC' },
      end: { dateTime: inputs.end, timeZone: inputs.timeZone || 'UTC' },
    };

    if (inputs.body) event.body = { contentType: 'HTML', content: inputs.body };
    if (inputs.location) event.location = { displayName: inputs.location };

    const attendees = [
      ...this.parseAttendees(inputs.requiredAttendees, 'required'),
      ...this.parseAttendees(inputs.optionalAttendees, 'optional'),
    ];
    if (attendees.length) event.attendees = attendees;

    if (inputs.isAllDay) event.isAllDay = true;
    if (inputs.reminderMinutes !== undefined) {
      event.reminderMinutesBeforeStart = inputs.reminderMinutes;
      event.isReminderOn = inputs.reminderMinutes > 0;
    }
    if (inputs.showAs) event.showAs = inputs.showAs;
    if (inputs.sensitivity) event.sensitivity = inputs.sensitivity;
    if (inputs.categories) event.categories = inputs.categories;
    if (inputs.recurrence) event.recurrence = inputs.recurrence;

    const endpoint = inputs.calendarId
      ? `/me/calendars/${encodeURIComponent(inputs.calendarId)}/events`
      : '/me/calendar/events';

    return this.post(endpoint, ctx.log, { body: event });
  }

  async getEvents(inputs: { calendarId?: string; startDateTime?: string; endDateTime?: string; top?: number; filter?: string; orderBy?: string }, ctx: RunContext): Promise<unknown[]> {
    const params: string[] = [];

    if (inputs.startDateTime && inputs.endDateTime) {
      params.push(`startDateTime=${encodeURIComponent(inputs.startDateTime)}`);
      params.push(`endDateTime=${encodeURIComponent(inputs.endDateTime)}`);
    }
    if (inputs.top) params.push(`$top=${inputs.top}`);
    if (inputs.filter) params.push(`$filter=${encodeURIComponent(inputs.filter)}`);
    if (inputs.orderBy) params.push(`$orderby=${encodeURIComponent(inputs.orderBy)}`);

    const queryString = params.length ? `?${params.join('&')}` : '';

    const endpoint = inputs.calendarId
      ? `/me/calendars/${encodeURIComponent(inputs.calendarId)}/events${queryString}`
      : inputs.startDateTime && inputs.endDateTime
        ? `/me/calendarView${queryString}`
        : `/me/calendar/events${queryString}`;

    const result = await this.get<{ value: unknown[] }>(endpoint, ctx.log);
    return result.value || [];
  }

  async getEvent(inputs: { eventId: string; calendarId?: string }, ctx: RunContext): Promise<unknown> {
    const endpoint = inputs.calendarId
      ? `/me/calendars/${encodeURIComponent(inputs.calendarId)}/events/${encodeURIComponent(inputs.eventId)}`
      : `/me/calendar/events/${encodeURIComponent(inputs.eventId)}`;
    return this.get(endpoint, ctx.log);
  }

  async updateEvent(inputs: { eventId: string; calendarId?: string } & Partial<CalendarEventInputs>, ctx: RunContext): Promise<unknown> {
    const updates: Record<string, unknown> = {};

    if (inputs.subject) updates.subject = inputs.subject;
    if (inputs.body) updates.body = { contentType: 'HTML', content: inputs.body };
    if (inputs.start) updates.start = { dateTime: inputs.start, timeZone: inputs.timeZone || 'UTC' };
    if (inputs.end) updates.end = { dateTime: inputs.end, timeZone: inputs.timeZone || 'UTC' };
    if (inputs.location) updates.location = { displayName: inputs.location };
    if (inputs.isAllDay !== undefined) updates.isAllDay = inputs.isAllDay;
    if (inputs.reminderMinutes !== undefined) {
      updates.reminderMinutesBeforeStart = inputs.reminderMinutes;
      updates.isReminderOn = inputs.reminderMinutes > 0;
    }
    if (inputs.showAs) updates.showAs = inputs.showAs;
    if (inputs.sensitivity) updates.sensitivity = inputs.sensitivity;
    if (inputs.categories) updates.categories = inputs.categories;

    const attendees = [
      ...this.parseAttendees(inputs.requiredAttendees, 'required'),
      ...this.parseAttendees(inputs.optionalAttendees, 'optional'),
    ];
    if (attendees.length) updates.attendees = attendees;

    const endpoint = inputs.calendarId
      ? `/me/calendars/${encodeURIComponent(inputs.calendarId)}/events/${encodeURIComponent(inputs.eventId)}`
      : `/me/calendar/events/${encodeURIComponent(inputs.eventId)}`;

    return this.patch(endpoint, ctx.log, { body: updates });
  }

  async deleteEvent(inputs: { eventId: string; calendarId?: string }, ctx: RunContext): Promise<{ success: boolean }> {
    const endpoint = inputs.calendarId
      ? `/me/calendars/${encodeURIComponent(inputs.calendarId)}/events/${encodeURIComponent(inputs.eventId)}`
      : `/me/calendar/events/${encodeURIComponent(inputs.eventId)}`;
    await this.delete(endpoint, ctx.log);
    return { success: true };
  }

  async respondToEvent(inputs: { eventId: string; response: 'accept' | 'tentativelyAccept' | 'decline'; comment?: string; sendResponse?: boolean }, ctx: RunContext): Promise<{ success: boolean }> {
    const endpoint = `/me/calendar/events/${encodeURIComponent(inputs.eventId)}/${inputs.response}`;
    await this.post(endpoint, ctx.log, {
      body: { comment: inputs.comment || '', sendResponse: inputs.sendResponse !== false },
    });
    return { success: true };
  }

  async getCalendars(ctx: RunContext): Promise<unknown[]> {
    const result = await this.get<{ value: unknown[] }>('/me/calendars', ctx.log);
    return result.value || [];
  }

  async findMeetingTimes(inputs: { attendees?: string | string[]; durationMinutes?: number; startDateTime?: string; endDateTime?: string; maxCandidates?: number }, ctx: RunContext): Promise<unknown> {
    const body: Record<string, unknown> = {
      meetingDuration: `PT${inputs.durationMinutes || 30}M`,
      maxCandidates: inputs.maxCandidates || 10,
    };

    if (inputs.attendees) {
      body.attendees = parseStringList(inputs.attendees).map(email => ({
        emailAddress: { address: email },
        type: 'required',
      }));
    }

    if (inputs.startDateTime && inputs.endDateTime) {
      body.timeConstraint = {
        timeslots: [{
          start: { dateTime: inputs.startDateTime, timeZone: 'UTC' },
          end: { dateTime: inputs.endDateTime, timeZone: 'UTC' },
        }],
      };
    }

    return this.post('/me/findMeetingTimes', ctx.log, { body });
  }

  // ============= Contact Operations =============

  async getContacts(inputs: { top?: number; filter?: string; orderBy?: string; folderId?: string }, ctx: RunContext): Promise<unknown[]> {
    const params: string[] = [];
    if (inputs.top) params.push(`$top=${inputs.top}`);
    if (inputs.filter) params.push(`$filter=${encodeURIComponent(inputs.filter)}`);
    if (inputs.orderBy) params.push(`$orderby=${encodeURIComponent(inputs.orderBy)}`);

    const queryString = params.length ? `?${params.join('&')}` : '';
    const endpoint = inputs.folderId
      ? `/me/contactFolders/${encodeURIComponent(inputs.folderId)}/contacts${queryString}`
      : `/me/contacts${queryString}`;

    const result = await this.get<{ value: unknown[] }>(endpoint, ctx.log);
    return result.value || [];
  }

  async getContact(inputs: { contactId: string; folderId?: string }, ctx: RunContext): Promise<unknown> {
    const endpoint = inputs.folderId
      ? `/me/contactFolders/${encodeURIComponent(inputs.folderId)}/contacts/${encodeURIComponent(inputs.contactId)}`
      : `/me/contacts/${encodeURIComponent(inputs.contactId)}`;
    return this.get(endpoint, ctx.log);
  }

  async createContact(inputs: ContactInputs & { folderId?: string }, ctx: RunContext): Promise<unknown> {
    const contact: Record<string, unknown> = {};

    if (inputs.givenName) contact.givenName = inputs.givenName;
    if (inputs.surname) contact.surname = inputs.surname;
    if (inputs.displayName) contact.displayName = inputs.displayName;
    if (inputs.companyName) contact.companyName = inputs.companyName;
    if (inputs.jobTitle) contact.jobTitle = inputs.jobTitle;
    if (inputs.department) contact.department = inputs.department;
    if (inputs.personalNotes) contact.personalNotes = inputs.personalNotes;

    if (inputs.emailAddresses) {
      contact.emailAddresses = inputs.emailAddresses.map(e => ({
        address: e.address,
        name: e.name || e.address,
      }));
    }

    if (inputs.businessPhones) contact.businessPhones = inputs.businessPhones;
    if (inputs.homePhones) contact.homePhones = inputs.homePhones;
    if (inputs.mobilePhone) contact.mobilePhone = inputs.mobilePhone;
    if (inputs.businessAddress) contact.businessAddress = inputs.businessAddress;

    const endpoint = inputs.folderId
      ? `/me/contactFolders/${encodeURIComponent(inputs.folderId)}/contacts`
      : '/me/contacts';

    return this.post(endpoint, ctx.log, { body: contact });
  }

  async updateContact(inputs: { contactId: string; folderId?: string } & ContactInputs, ctx: RunContext): Promise<unknown> {
    const updates: Record<string, unknown> = {};

    if (inputs.givenName !== undefined) updates.givenName = inputs.givenName;
    if (inputs.surname !== undefined) updates.surname = inputs.surname;
    if (inputs.displayName !== undefined) updates.displayName = inputs.displayName;
    if (inputs.companyName !== undefined) updates.companyName = inputs.companyName;
    if (inputs.jobTitle !== undefined) updates.jobTitle = inputs.jobTitle;
    if (inputs.department !== undefined) updates.department = inputs.department;
    if (inputs.personalNotes !== undefined) updates.personalNotes = inputs.personalNotes;

    if (inputs.emailAddresses) {
      updates.emailAddresses = inputs.emailAddresses.map(e => ({
        address: e.address,
        name: e.name || e.address,
      }));
    }

    if (inputs.businessPhones) updates.businessPhones = inputs.businessPhones;
    if (inputs.homePhones) updates.homePhones = inputs.homePhones;
    if (inputs.mobilePhone !== undefined) updates.mobilePhone = inputs.mobilePhone;
    if (inputs.businessAddress) updates.businessAddress = inputs.businessAddress;

    const endpoint = inputs.folderId
      ? `/me/contactFolders/${encodeURIComponent(inputs.folderId)}/contacts/${encodeURIComponent(inputs.contactId)}`
      : `/me/contacts/${encodeURIComponent(inputs.contactId)}`;

    return this.patch(endpoint, ctx.log, { body: updates });
  }

  async deleteContact(inputs: { contactId: string; folderId?: string }, ctx: RunContext): Promise<{ success: boolean }> {
    const endpoint = inputs.folderId
      ? `/me/contactFolders/${encodeURIComponent(inputs.folderId)}/contacts/${encodeURIComponent(inputs.contactId)}`
      : `/me/contacts/${encodeURIComponent(inputs.contactId)}`;
    await this.delete(endpoint, ctx.log);
    return { success: true };
  }

  async getContactFolders(ctx: RunContext): Promise<unknown[]> {
    const result = await this.get<{ value: unknown[] }>('/me/contactFolders', ctx.log);
    return result.value || [];
  }

  // ============= User Profile =============

  async getMyProfile(ctx: RunContext): Promise<unknown> {
    return this.get('/me', ctx.log);
  }

  // ============= Generic HTTP Request =============

  async httpRequest(inputs: { method: string; uri: string; body?: unknown; headers?: Record<string, string> }, ctx: RunContext): Promise<unknown> {
    return this.request(
      inputs.method.toUpperCase(),
      inputs.uri,
      ctx.log,
      { body: inputs.body, headers: inputs.headers }
    );
  }
}

export default Office365Connector;

// Export metadata for language service
export { office365Metadata, office365Scopes } from './metadata.js';
