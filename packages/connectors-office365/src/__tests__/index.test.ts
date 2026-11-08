import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Office365Connector } from '../index.js';
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

describe('Office365Connector', () => {
  let connector: Office365Connector;
  let ctx: RunContext;

  beforeEach(() => {
    fetchCalls = [];
    fetchResponse = {
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: async () => ({ value: [] }),
      text: async () => '{"value":[]}',
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
    connector = new Office365Connector({ token: 'test-token' });
    ctx = makeCtx();
  });

  /* ================================================================ */
  /*  1. Cloud operation ids with the designer's flattened keys       */
  /* ================================================================ */

  describe('cloud ids and designer parameter keys (mail)', () => {
    it('ReplyToV3 reads replyParameters/Body and replyParameters/ReplyAll', async () => {
      await connector.invoke(
        'ReplyToV3',
        { messageId: 'm1', 'replyParameters/Body': '<p>thanks</p>', 'replyParameters/ReplyAll': true },
        ctx
      );
      assert.equal(fetchCalls.length, 1);
      assert.ok(lastCall().url.endsWith('/me/messages/m1/replyAll'), lastCall().url);
      assert.equal(lastCall().method, 'POST');
      assert.equal(lastCall().body.comment, '<p>thanks</p>');
    });

    it('ReplyToV3 without ReplyAll posts to /reply, honouring mailboxAddress', async () => {
      await connector.invoke(
        'ReplyToV3',
        { messageId: 'm1', 'replyParameters/Body': 'ok', mailboxAddress: 'shared@contoso.com' },
        ctx
      );
      assert.ok(lastCall().url.endsWith('/users/shared%40contoso.com/messages/m1/reply'), lastCall().url);
    });

    it('ForwardEmail_V2 reads message_id, body/ToRecipients and body/Comment', async () => {
      await connector.invoke(
        'ForwardEmail_V2',
        { message_id: 'm2', 'body/ToRecipients': 'a@x.com; b@x.com', 'body/Comment': 'FYI' },
        ctx
      );
      assert.ok(lastCall().url.endsWith('/me/messages/m2/forward'), lastCall().url);
      assert.equal(lastCall().body.comment, 'FYI');
      assert.deepEqual(
        lastCall().body.toRecipients.map((r: any) => r.emailAddress.address),
        ['a@x.com', 'b@x.com']
      );
    });

    it('DeleteEmail_V2 deletes the message', async () => {
      await connector.invoke('DeleteEmail_V2', { messageId: 'm3' }, ctx);
      assert.equal(lastCall().method, 'DELETE');
      assert.ok(lastCall().url.endsWith('/me/messages/m3'), lastCall().url);
    });

    it('MoveV2 moves to the folderPath id', async () => {
      await connector.invoke('MoveV2', { messageId: 'm4', folderPath: 'AAMkFolderId==' }, ctx);
      assert.ok(lastCall().url.endsWith('/me/messages/m4/move'), lastCall().url);
      assert.equal(lastCall().body.destinationId, 'AAMkFolderId==');
    });

    it('MarkAsRead_V3 reads body/isRead', async () => {
      await connector.invoke('MarkAsRead_V3', { messageId: 'm5', 'body/isRead': false }, ctx);
      assert.equal(lastCall().method, 'PATCH');
      assert.ok(lastCall().url.endsWith('/me/messages/m5'), lastCall().url);
      assert.equal(lastCall().body.isRead, false);
    });

    it('MarkAsRead_V3 also accepts a flat isRead', async () => {
      await connector.invoke('MarkAsRead_V3', { messageId: 'm5', isRead: true }, ctx);
      assert.equal(lastCall().body.isRead, true);
    });

    it('Flag_V2 reads flagStatus', async () => {
      await connector.invoke('Flag_V2', { messageId: 'm6', flagStatus: 'flagged' }, ctx);
      assert.equal(lastCall().method, 'PATCH');
      assert.deepEqual(lastCall().body, { flag: { flagStatus: 'flagged' } });
    });

    it('GetAttachment_V2 fetches the attachment', async () => {
      await connector.invoke('GetAttachment_V2', { messageId: 'm7', attachmentId: 'a1' }, ctx);
      assert.ok(lastCall().url.endsWith('/me/messages/m7/attachments/a1'), lastCall().url);
    });

    it('ExportEmail_V2 fetches the MIME content', async () => {
      await connector.invoke('ExportEmail_V2', { messageId: 'm8' }, ctx);
      assert.ok(lastCall().url.endsWith('/me/messages/m8/$value'), lastCall().url);
    });

    it('GetEmailsV3 lists the folder with the cloud keys', async () => {
      await connector.invoke(
        'GetEmailsV3',
        { folderPath: 'Inbox', top: 5, fetchOnlyUnread: true, mailboxAddress: 'shared@contoso.com' },
        ctx
      );
      const url = lastCall().url;
      assert.ok(url.includes('/users/shared%40contoso.com/mailFolders/inbox/messages'), url);
      assert.ok(url.includes('$top=5'), url);
      assert.ok(url.includes(encodeURIComponent('isRead eq false')), url);
    });

    it('SharedMailboxSendEmailV2 sends from emailMessage/MailboxAddress', async () => {
      await connector.invoke(
        'SharedMailboxSendEmailV2',
        {
          'emailMessage/MailboxAddress': 'shared@contoso.com',
          'emailMessage/To': 'to@x.com',
          'emailMessage/Subject': 'Hi',
          'emailMessage/Body': '<p>Body</p>',
          'emailMessage/Importance': 'High',
        },
        ctx
      );
      assert.ok(lastCall().url.endsWith('/users/shared%40contoso.com/sendMail'), lastCall().url);
      assert.equal(lastCall().body.message.subject, 'Hi');
      assert.equal(lastCall().body.message.importance, 'high');
      assert.equal(lastCall().body.message.toRecipients[0].emailAddress.address, 'to@x.com');
    });

    it('HttpRequest accepts the cloud Uri/Method/Body keys', async () => {
      await connector.invoke(
        'HttpRequest',
        { Uri: 'https://graph.microsoft.com/v1.0/me/mailFolders', Method: 'GET' },
        ctx
      );
      assert.equal(lastCall().method, 'GET');
      assert.equal(lastCall().url, 'https://graph.microsoft.com/v1.0/me/mailFolders');
    });
  });

  /* ================================================================ */
  /*  2. Calendar                                                     */
  /* ================================================================ */

  describe('cloud ids and designer parameter keys (calendar)', () => {
    it('V4CalendarPostItem reads table and item/* keys', async () => {
      await connector.invoke(
        'V4CalendarPostItem',
        {
          table: 'cal-1',
          'item/subject': 'Sync',
          'item/start': '2026-01-15T10:00:00',
          'item/end': '2026-01-15T11:00:00',
          'item/timeZone': 'W. Europe Standard Time',
          'item/location': 'Room 1',
          'item/requiredAttendees': 'a@x.com;b@x.com',
          'item/reminderMinutesBeforeStart': 15,
        },
        ctx
      );
      assert.equal(lastCall().method, 'POST');
      assert.ok(lastCall().url.endsWith('/me/calendars/cal-1/events'), lastCall().url);
      const ev = lastCall().body;
      assert.equal(ev.subject, 'Sync');
      assert.deepEqual(ev.start, { dateTime: '2026-01-15T10:00:00', timeZone: 'W. Europe Standard Time' });
      assert.equal(ev.location.displayName, 'Room 1');
      assert.equal(ev.attendees.length, 2);
      assert.equal(ev.reminderMinutesBeforeStart, 15);
    });

    it('V4CalendarPatchItem reads table, id and item/* keys', async () => {
      await connector.invoke(
        'V4CalendarPatchItem',
        { table: 'cal-1', id: 'ev-1', 'item/subject': 'Renamed' },
        ctx
      );
      assert.equal(lastCall().method, 'PATCH');
      assert.ok(lastCall().url.endsWith('/me/calendars/cal-1/events/ev-1'), lastCall().url);
      assert.equal(lastCall().body.subject, 'Renamed');
    });

    it('V4CalendarGetItems reads table and the OData keys', async () => {
      await connector.invoke('V4CalendarGetItems', { table: 'cal-1', $top: 3, $filter: "subject eq 'x'" }, ctx);
      const url = lastCall().url;
      assert.ok(url.includes('/me/calendars/cal-1/events'), url);
      assert.ok(url.includes('$top=3'), url);
      assert.ok(url.includes(encodeURIComponent("subject eq 'x'")), url);
    });

    it('GetEventsCalendarViewV3 reads calendarId and the UTC window', async () => {
      await connector.invoke(
        'GetEventsCalendarViewV3',
        { calendarId: 'cal-1', startDateTimeUtc: '2026-01-01T00:00:00', endDateTimeUtc: '2026-02-01T00:00:00' },
        ctx
      );
      const url = lastCall().url;
      assert.ok(url.includes('/me/calendars/cal-1/calendarView'), url);
      assert.ok(url.includes('startDateTime=2026-01-01T00%3A00%3A00'), url);
    });

    it('V3CalendarGetItem reads table and id', async () => {
      await connector.invoke('V3CalendarGetItem', { table: 'cal-1', id: 'ev-2' }, ctx);
      assert.ok(lastCall().url.endsWith('/me/calendars/cal-1/events/ev-2'), lastCall().url);
    });

    it('CalendarDeleteItem_V2 reads calendar and event', async () => {
      await connector.invoke('CalendarDeleteItem_V2', { calendar: 'cal-1', event: 'ev-3' }, ctx);
      assert.equal(lastCall().method, 'DELETE');
      assert.ok(lastCall().url.endsWith('/me/calendars/cal-1/events/ev-3'), lastCall().url);
    });

    it('RespondToEvent_V2 reads event_id, response, Comment and SendResponse', async () => {
      await connector.invoke(
        'RespondToEvent_V2',
        { event_id: 'ev-4', response: 'Accept', Comment: 'See you', SendResponse: false },
        ctx
      );
      assert.ok(lastCall().url.endsWith('/me/calendar/events/ev-4/accept'), lastCall().url);
      assert.deepEqual(lastCall().body, { comment: 'See you', sendResponse: false });
    });

    it('CalendarGetTables_V2 lists calendars', async () => {
      await connector.invoke('CalendarGetTables_V2', {}, ctx);
      assert.ok(lastCall().url.endsWith('/me/calendars'), lastCall().url);
    });

    it('FindMeetingTimes_V2 reads the PascalCase keys', async () => {
      await connector.invoke(
        'FindMeetingTimes_V2',
        { RequiredAttendees: 'a@x.com;b@x.com', MeetingDuration: 45, MaxCandidates: 3 },
        ctx
      );
      assert.ok(lastCall().url.endsWith('/me/findMeetingTimes'), lastCall().url);
      assert.equal(lastCall().body.meetingDuration, 'PT45M');
      assert.equal(lastCall().body.maxCandidates, 3);
      assert.equal(lastCall().body.attendees.length, 2);
    });
  });

  /* ================================================================ */
  /*  3. Contacts                                                     */
  /* ================================================================ */

  describe('cloud ids and designer parameter keys (contacts)', () => {
    it('ContactGetItems_V2 reads folder and OData keys', async () => {
      await connector.invoke('ContactGetItems_V2', { folder: 'cf-1', $top: 2 }, ctx);
      const url = lastCall().url;
      assert.ok(url.includes('/me/contactFolders/cf-1/contacts'), url);
      assert.ok(url.includes('$top=2'), url);
    });

    it('ContactGetItem_V2 reads folder and id', async () => {
      await connector.invoke('ContactGetItem_V2', { folder: 'cf-1', id: 'c-1' }, ctx);
      assert.ok(lastCall().url.endsWith('/me/contactFolders/cf-1/contacts/c-1'), lastCall().url);
    });

    it('ContactPostItem_V2 creates in the folder', async () => {
      await connector.invoke('ContactPostItem_V2', { folder: 'cf-1', givenName: 'Ada', surname: 'L' }, ctx);
      assert.equal(lastCall().method, 'POST');
      assert.ok(lastCall().url.endsWith('/me/contactFolders/cf-1/contacts'), lastCall().url);
      assert.equal(lastCall().body.givenName, 'Ada');
    });

    it('ContactPatchItem_V2 patches folder/id', async () => {
      await connector.invoke('ContactPatchItem_V2', { folder: 'cf-1', id: 'c-2', jobTitle: 'CTO' }, ctx);
      assert.equal(lastCall().method, 'PATCH');
      assert.ok(lastCall().url.endsWith('/me/contactFolders/cf-1/contacts/c-2'), lastCall().url);
      assert.equal(lastCall().body.jobTitle, 'CTO');
    });

    it('ContactDeleteItem_V2 deletes folder/id', async () => {
      await connector.invoke('ContactDeleteItem_V2', { folder: 'cf-1', id: 'c-3' }, ctx);
      assert.equal(lastCall().method, 'DELETE');
      assert.ok(lastCall().url.endsWith('/me/contactFolders/cf-1/contacts/c-3'), lastCall().url);
    });

    it('ContactGetTablesV2 lists contact folders', async () => {
      await connector.invoke('ContactGetTablesV2', {}, ctx);
      assert.ok(lastCall().url.endsWith('/me/contactFolders'), lastCall().url);
    });
  });

  /* ================================================================ */
  /*  4. Existing local names keep working                            */
  /* ================================================================ */

  describe('local aliases', () => {
    it('ReplyToEmailV2 with local keys still replies', async () => {
      await connector.invoke('ReplyToEmailV2', { messageId: 'm1', body: 'ok', replyAll: true }, ctx);
      assert.ok(lastCall().url.endsWith('/me/messages/m1/replyAll'), lastCall().url);
      assert.equal(lastCall().body.comment, 'ok');
    });

    it('MoveEmailV2 with destinationId still moves', async () => {
      await connector.invoke('MoveEmailV2', { messageId: 'm1', destinationId: 'deleteditems' }, ctx);
      assert.equal(lastCall().body.destinationId, 'deleteditems');
    });

    it('CreateEventV4 with local keys still creates', async () => {
      await connector.invoke(
        'CreateEventV4',
        { subject: 'S', start: '2026-01-01T10:00:00', end: '2026-01-01T11:00:00', calendarId: 'cal-9' },
        ctx
      );
      assert.ok(lastCall().url.endsWith('/me/calendars/cal-9/events'), lastCall().url);
      assert.equal(lastCall().body.subject, 'S');
    });

    it('SendEmailV2 with emailMessage/* keys still sends', async () => {
      await connector.invoke(
        'SendEmailV2',
        { 'emailMessage/To': 'a@x.com', 'emailMessage/Subject': 'S', 'emailMessage/Body': 'B' },
        ctx
      );
      assert.ok(lastCall().url.endsWith('/me/sendMail'), lastCall().url);
    });

    it('rejects an unknown operation', async () => {
      await assert.rejects(() => connector.invoke('NoSuchOp', {}, ctx), /unknown operation 'NoSuchOp'/);
    });
  });
});
