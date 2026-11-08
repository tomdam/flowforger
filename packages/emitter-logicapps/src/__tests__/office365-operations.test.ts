import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emitLogicAppsJson } from '../index.js';
import type { FlowIR } from '@flowforger/ir';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Emit a one-action flow and return that action's `inputs` block. */
function emitAction(operation: string, params: Record<string, unknown>) {
  const flow: FlowIR = {
    name: 'TestFlow',
    nodes: [
      { id: 'trg_1', type: 'trigger', kind: 'manual', name: 'manual', inputs: {} },
      {
        id: 'con_1',
        type: 'connector',
        name: 'TheAction',
        connector: 'office365',
        operation,
        params,
      },
    ],
  } as unknown as FlowIR;

  const json: any = emitLogicAppsJson(flow);
  return json.properties.definition.actions.TheAction.inputs;
}

/* ------------------------------------------------------------------ */
/*  operationId mapping                                                */
/* ------------------------------------------------------------------ */

describe('Office 365 Outlook operationId emission', () => {
  // Typed/local name → the id the designer writes today
  // (https://learn.microsoft.com/en-us/connectors/office365/, "Operation ID:" of each action).
  const idCases: Array<[localOperation: string, paOperationId: string]> = [
    // mail
    ['ReplyToEmailV2', 'ReplyToV3'],
    ['ReplyToEmail', 'ReplyToV3'],
    ['ForwardEmailV2', 'ForwardEmail_V2'],
    ['DeleteEmailV2', 'DeleteEmail_V2'],
    ['MoveEmailV2', 'MoveV2'],
    ['MoveEmail', 'MoveV2'],
    ['MarkAsReadV3', 'MarkAsRead_V3'],
    ['GetAttachmentV2', 'GetAttachment_V2'],
    ['ExportEmailV2', 'ExportEmail_V2'],
    ['FlagV2', 'Flag_V2'],
    ['GetEmailsV3', 'GetEmailsV3'],
    // calendar
    ['CreateEventV4', 'V4CalendarPostItem'],
    ['CreateEvent', 'V4CalendarPostItem'],
    ['UpdateEventV4', 'V4CalendarPatchItem'],
    ['UpdateEvent', 'V4CalendarPatchItem'],
    ['GetEventsV4', 'V4CalendarGetItems'],
    ['GetEvents', 'V4CalendarGetItems'],
    ['GetEventV4', 'V3CalendarGetItem'],
    ['GetEvent', 'V3CalendarGetItem'],
    ['DeleteEventV4', 'CalendarDeleteItem_V2'],
    ['DeleteEvent', 'CalendarDeleteItem_V2'],
    ['RespondToEventV2', 'RespondToEvent_V2'],
    ['GetCalendars', 'CalendarGetTables_V2'],
    ['FindMeetingTimesV2', 'FindMeetingTimes_V2'],
    // contacts
    ['GetContactsV2', 'ContactGetItems_V2'],
    ['GetContacts', 'ContactGetItems_V2'],
    ['GetContactV2', 'ContactGetItem_V2'],
    ['GetContact', 'ContactGetItem_V2'],
    ['CreateContactV2', 'ContactPostItem_V2'],
    ['CreateContact', 'ContactPostItem_V2'],
    ['UpdateContactV2', 'ContactPatchItem_V2'],
    ['UpdateContact', 'ContactPatchItem_V2'],
    ['DeleteContactV2', 'ContactDeleteItem_V2'],
    ['DeleteContact', 'ContactDeleteItem_V2'],
    ['GetContactFolders', 'ContactGetTablesV2'],
  ];

  for (const [localOperation, paOperationId] of idCases) {
    it(`emits ${localOperation} as ${paOperationId}`, () => {
      const inputs = emitAction(localOperation, {});
      assert.equal(inputs.host.operationId, paOperationId);
    });
  }

  // Real ids — current and deprecated — must round-trip untouched so a pulled flow re-emits as pulled.
  const identity = [
    'SendEmailV2', 'SendEmail', 'SharedMailboxSendEmailV2',
    'GetEmailsV3', 'GetEmailsV2', 'GetEmails', 'GetEmailV2', 'GetEmail',
    'ReplyToV3', 'ReplyTo', 'ForwardEmail_V2', 'ForwardEmail', 'DeleteEmail_V2', 'DeleteEmail',
    'MoveV2', 'Move', 'MarkAsRead_V3', 'MarkAsRead', 'Flag_V2', 'Flag',
    'GetAttachment_V2', 'GetAttachment', 'ExportEmail_V2', 'ExportEmail',
    'V4CalendarPostItem', 'V4CalendarPatchItem', 'V4CalendarGetItems', 'V3CalendarGetItem',
    'CalendarDeleteItem_V2', 'RespondToEvent_V2', 'RespondToEvent', 'CalendarGetTables_V2', 'CalendarGetTables',
    'GetEventsCalendarViewV3', 'FindMeetingTimes_V2', 'FindMeetingTimes',
    'ContactGetItems_V2', 'ContactGetItem_V2', 'ContactPostItem_V2', 'ContactPatchItem_V2',
    'ContactDeleteItem_V2', 'ContactGetTablesV2', 'HttpRequest',
  ];

  for (const id of identity) {
    it(`leaves the cloud id ${id} untouched`, () => {
      assert.equal(emitAction(id, {}).host.operationId, id);
    });
  }
});

/* ------------------------------------------------------------------ */
/*  parameter denormalisation                                          */
/* ------------------------------------------------------------------ */

describe('Office 365 Outlook parameter emission', () => {
  it('SendEmailV2 nests the message under emailMessage/*', () => {
    const p = emitAction('SendEmailV2', { to: 'a@x.com', subject: 'S', body: 'B', importance: 'High' }).parameters;
    assert.deepEqual(p, {
      'emailMessage/To': 'a@x.com',
      'emailMessage/Subject': 'S',
      'emailMessage/Body': 'B',
      'emailMessage/Importance': 'High',
    });
  });

  it('SharedMailboxSendEmailV2 nests the message and the sending mailbox under emailMessage/*', () => {
    const p = emitAction('SharedMailboxSendEmailV2', {
      from: 'shared@contoso.com', to: 'a@x.com', subject: 'S', body: 'B',
    }).parameters;
    assert.deepEqual(p, {
      'emailMessage/MailboxAddress': 'shared@contoso.com',
      'emailMessage/To': 'a@x.com',
      'emailMessage/Subject': 'S',
      'emailMessage/Body': 'B',
    });
  });

  it('ReplyToEmailV2 writes replyParameters/* and keeps messageId/mailboxAddress', () => {
    const p = emitAction('ReplyToEmailV2', {
      messageId: 'm1', body: '<p>ok</p>', replyAll: true, cc: 'c@x.com', mailboxAddress: 'shared@contoso.com',
    }).parameters;
    assert.deepEqual(p, {
      messageId: 'm1',
      'replyParameters/Body': '<p>ok</p>',
      'replyParameters/ReplyAll': true,
      'replyParameters/Cc': 'c@x.com',
      mailboxAddress: 'shared@contoso.com',
    });
  });

  it('ReplyToV3 authored with cloud keys passes them through', () => {
    const p = emitAction('ReplyToV3', { messageId: 'm1', 'replyParameters/Body': 'ok' }).parameters;
    assert.deepEqual(p, { messageId: 'm1', 'replyParameters/Body': 'ok' });
  });

  it('ForwardEmailV2 writes message_id, body/ToRecipients and body/Comment', () => {
    const p = emitAction('ForwardEmailV2', { messageId: 'm2', to: 'a@x.com', comment: 'FYI' }).parameters;
    assert.deepEqual(p, { message_id: 'm2', 'body/ToRecipients': 'a@x.com', 'body/Comment': 'FYI' });
  });

  it('MoveEmailV2 writes messageId and folderPath', () => {
    const p = emitAction('MoveEmailV2', { messageId: 'm3', destinationId: 'folder-id' }).parameters;
    assert.deepEqual(p, { messageId: 'm3', folderPath: 'folder-id' });
  });

  it('MarkAsReadV3 writes body/isRead', () => {
    const p = emitAction('MarkAsReadV3', { messageId: 'm4', isRead: false }).parameters;
    assert.deepEqual(p, { messageId: 'm4', 'body/isRead': false });
  });

  it('DeleteEmailV2 / GetAttachmentV2 keep their flat keys', () => {
    assert.deepEqual(emitAction('DeleteEmailV2', { messageId: 'm5' }).parameters, { messageId: 'm5' });
    assert.deepEqual(
      emitAction('GetAttachmentV2', { messageId: 'm5', attachmentId: 'a1' }).parameters,
      { messageId: 'm5', attachmentId: 'a1' }
    );
  });

  it('GetEmailsV2 keeps its flat keys', () => {
    const p = emitAction('GetEmailsV2', { folderPath: 'Inbox', top: 10, fetchOnlyUnread: true }).parameters;
    assert.deepEqual(p, { folderPath: 'Inbox', top: 10, fetchOnlyUnread: true });
  });

  it('CreateEventV4 writes table and item/* keys', () => {
    const p = emitAction('CreateEventV4', {
      calendarId: 'cal-1',
      subject: 'Sync',
      start: '2026-01-15T10:00:00',
      end: '2026-01-15T11:00:00',
      timeZone: 'W. Europe Standard Time',
      location: 'Room 1',
      requiredAttendees: 'a@x.com;b@x.com',
      body: '<p>Agenda</p>',
      reminderMinutes: 15,
      isAllDay: false,
    }).parameters;
    assert.deepEqual(p, {
      table: 'cal-1',
      'item/subject': 'Sync',
      'item/start': '2026-01-15T10:00:00',
      'item/end': '2026-01-15T11:00:00',
      'item/timeZone': 'W. Europe Standard Time',
      'item/location': 'Room 1',
      'item/requiredAttendees': 'a@x.com;b@x.com',
      'item/body': '<p>Agenda</p>',
      'item/reminderMinutesBeforeStart': 15,
      'item/isAllDay': false,
    });
  });

  it('UpdateEventV4 writes table, id and item/* keys', () => {
    const p = emitAction('UpdateEventV4', { calendarId: 'cal-1', eventId: 'ev-1', subject: 'Renamed' }).parameters;
    assert.deepEqual(p, { table: 'cal-1', id: 'ev-1', 'item/subject': 'Renamed' });
  });

  it('V4CalendarPostItem authored with cloud keys passes them through', () => {
    const p = emitAction('V4CalendarPostItem', { table: 'cal-1', 'item/subject': 'S' }).parameters;
    assert.deepEqual(p, { table: 'cal-1', 'item/subject': 'S' });
  });

  it('GetEventsV4 writes table and the OData keys', () => {
    const p = emitAction('GetEventsV4', { calendarId: 'cal-1', top: 3, filter: "subject eq 'x'", orderBy: 'start/dateTime' }).parameters;
    assert.deepEqual(p, { table: 'cal-1', $top: 3, $filter: "subject eq 'x'", $orderby: 'start/dateTime' });
  });

  it('GetEventV4 writes table and id', () => {
    assert.deepEqual(emitAction('GetEventV4', { calendarId: 'cal-1', eventId: 'ev-2' }).parameters, { table: 'cal-1', id: 'ev-2' });
  });

  it('DeleteEventV4 writes calendar and event', () => {
    assert.deepEqual(emitAction('DeleteEventV4', { calendarId: 'cal-1', eventId: 'ev-3' }).parameters, { calendar: 'cal-1', event: 'ev-3' });
  });

  it('RespondToEventV2 writes event_id and keeps response', () => {
    const p = emitAction('RespondToEventV2', { eventId: 'ev-4', response: 'Accept' }).parameters;
    assert.deepEqual(p, { event_id: 'ev-4', response: 'Accept' });
  });

  it('contact operations write folder and id', () => {
    assert.deepEqual(emitAction('GetContactV2', { folderId: 'cf-1', contactId: 'c-1' }).parameters, { folder: 'cf-1', id: 'c-1' });
    assert.deepEqual(emitAction('DeleteContactV2', { folderId: 'cf-1', contactId: 'c-1' }).parameters, { folder: 'cf-1', id: 'c-1' });
    assert.deepEqual(
      emitAction('GetContactsV2', { folderId: 'cf-1', top: 5 }).parameters,
      { folder: 'cf-1', $top: 5 }
    );
  });

  it('an explicitly supplied cloud key wins over its local alias', () => {
    const p = emitAction('MoveEmailV2', { messageId: 'm1', destinationId: 'local', folderPath: 'cloud' }).parameters;
    assert.deepEqual(p, { messageId: 'm1', folderPath: 'cloud' });
  });
});
