import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Office365GroupsConnector } from '../index.js';
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

describe('Office365GroupsConnector', () => {
  let connector: Office365GroupsConnector;
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
    connector = new Office365GroupsConnector({ token: 'test-token' });
    ctx = makeCtx();
  });

  /* ================================================================ */
  /*  Group Management                                                */
  /* ================================================================ */

  describe('group management', () => {
    it('ListGroups sends GET /groups', async () => {
      await connector.invoke('ListGroups', {}, ctx);
      assert.equal(fetchCalls.length, 1);
      assert.ok(lastCall().url.endsWith('/groups'));
      assert.equal(lastCall().method, 'GET');
    });

    it('ListGroups passes $top and $filter query params', async () => {
      await connector.invoke('ListGroups', { $top: 10, $filter: "displayName eq 'Test'" }, ctx);
      // URLSearchParams encodes '$' as '%24'
      assert.ok(lastCall().url.includes('%24top=10'));
      assert.ok(lastCall().url.includes('%24filter='));
    });

    it('GetGroup sends GET /groups/{id}', async () => {
      await connector.invoke('GetGroup', { groupId: 'grp-1' }, ctx);
      assert.ok(lastCall().url.includes('/groups/grp-1'));
      assert.equal(lastCall().method, 'GET');
    });

    it('CreateGroup sends POST /groups with correct body', async () => {
      fetchResponse = {
        ok: true,
        status: 201,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => JSON.stringify({ id: 'new-group', displayName: 'My Group' }),
      };
      await connector.invoke('CreateGroup', {
        displayName: 'My Group',
        description: 'A test group',
      }, ctx);
      assert.ok(lastCall().url.endsWith('/groups'));
      assert.equal(lastCall().method, 'POST');
      const body = lastCall().body;
      assert.equal(body.displayName, 'My Group');
      assert.equal(body.mailNickname, 'mygroup');
      assert.deepEqual(body.groupTypes, ['Unified']);
      assert.equal(body.mailEnabled, true);
      assert.equal(body.securityEnabled, false);
      assert.equal(body.description, 'A test group');
    });

    it('CreateGroup defaults mailNickname from displayName', async () => {
      fetchResponse = {
        ok: true,
        status: 201,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => JSON.stringify({ id: 'g1' }),
      };
      await connector.invoke('CreateGroup', { displayName: 'Dev Team' }, ctx);
      assert.equal(lastCall().body.mailNickname, 'devteam');
    });

    it('UpdateGroup sends PATCH /groups/{id}', async () => {
      fetchResponse = {
        ok: true,
        status: 204,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => '',
      };
      await connector.invoke('UpdateGroup', { groupId: 'grp-1', displayName: 'Updated Name' }, ctx);
      assert.ok(lastCall().url.includes('/groups/grp-1'));
      assert.equal(lastCall().method, 'PATCH');
    });

    it('DeleteGroup sends DELETE /groups/{id}', async () => {
      fetchResponse = {
        ok: true,
        status: 204,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => '',
      };
      const result = await connector.invoke('DeleteGroup', { groupId: 'grp-1' }, ctx);
      assert.ok(lastCall().url.includes('/groups/grp-1'));
      assert.equal(lastCall().method, 'DELETE');
      assert.deepEqual(result, { success: true });
    });

    it('alias listGroups routes same as ListGroups', async () => {
      await connector.invoke('listGroups', {}, ctx);
      assert.ok(lastCall().url.endsWith('/groups'));
    });

    it('alias ListAllGroups routes same as ListGroups', async () => {
      await connector.invoke('ListAllGroups', {}, ctx);
      assert.ok(lastCall().url.endsWith('/groups'));
    });
  });

  /* ================================================================ */
  /*  Membership                                                      */
  /* ================================================================ */

  describe('membership', () => {
    it('ListGroupMembers sends GET /groups/{id}/members', async () => {
      await connector.invoke('ListGroupMembers', { groupId: 'grp-1' }, ctx);
      assert.ok(lastCall().url.includes('/groups/grp-1/members'));
      assert.equal(lastCall().method, 'GET');
    });

    it('ListGroupMembers passes $top', async () => {
      await connector.invoke('ListGroupMembers', { groupId: 'grp-1', $top: 5 }, ctx);
      // URLSearchParams encodes '$' as '%24'
      assert.ok(lastCall().url.includes('%24top=5'));
    });

    it('ListGroupMembers returns the Graph body with a value array (cloud parity)', async () => {
      const graphBody = {
        '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#directoryObjects',
        value: [{ id: 'usr-1', mail: 'jane@contoso.com' }],
      };
      fetchResponse = {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => graphBody,
        text: async () => JSON.stringify(graphBody),
      };

      const result = await connector.invoke('ListGroupMembers', { groupId: 'grp-1' }, ctx);
      assert.deepEqual(result, graphBody);
    });

    it('AddMemberToGroup sends POST /groups/{id}/members/$ref with @odata.id body', async () => {
      fetchResponse = {
        ok: true,
        status: 204,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => '',
      };
      await connector.invoke('AddMemberToGroup', { groupId: 'grp-1', userId: 'usr-1' }, ctx);
      assert.ok(lastCall().url.includes('/groups/grp-1/members/$ref'));
      assert.equal(lastCall().method, 'POST');
      assert.ok(lastCall().body['@odata.id'].includes('users/usr-1'));
    });

    it('RemoveMemberFromGroup sends DELETE /groups/{id}/members/{uid}/$ref', async () => {
      fetchResponse = {
        ok: true,
        status: 204,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => '',
      };
      const result = await connector.invoke('RemoveMemberFromGroup', { groupId: 'grp-1', userId: 'usr-1' }, ctx);
      assert.ok(lastCall().url.includes('/groups/grp-1/members/usr-1/$ref'));
      assert.equal(lastCall().method, 'DELETE');
      assert.deepEqual(result, { success: true });
    });

    it('ListGroupOwners sends GET /groups/{id}/owners', async () => {
      await connector.invoke('ListGroupOwners', { groupId: 'grp-1' }, ctx);
      assert.ok(lastCall().url.includes('/groups/grp-1/owners'));
      assert.equal(lastCall().method, 'GET');
    });

    it('AddOwnerToGroup sends POST /groups/{id}/owners/$ref', async () => {
      fetchResponse = {
        ok: true,
        status: 204,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => '',
      };
      await connector.invoke('AddOwnerToGroup', { groupId: 'grp-1', userId: 'usr-2' }, ctx);
      assert.ok(lastCall().url.includes('/groups/grp-1/owners/$ref'));
      assert.equal(lastCall().method, 'POST');
      assert.ok(lastCall().body['@odata.id'].includes('users/usr-2'));
    });

    it('RemoveOwnerFromGroup sends DELETE /groups/{id}/owners/{uid}/$ref', async () => {
      fetchResponse = {
        ok: true,
        status: 204,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => '',
      };
      const result = await connector.invoke('RemoveOwnerFromGroup', { groupId: 'grp-1', userId: 'usr-2' }, ctx);
      assert.ok(lastCall().url.includes('/groups/grp-1/owners/usr-2/$ref'));
      assert.equal(lastCall().method, 'DELETE');
      assert.deepEqual(result, { success: true });
    });

    it('IsMemberOfGroup sends POST /me/checkMemberGroups with groupIds body', async () => {
      fetchResponse = {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => JSON.stringify({ value: ['grp-1'] }),
      };
      await connector.invoke('IsMemberOfGroup', { groupId: 'grp-1' }, ctx);
      assert.ok(lastCall().url.includes('/me/checkMemberGroups'));
      assert.equal(lastCall().method, 'POST');
      assert.deepEqual(lastCall().body.groupIds, ['grp-1']);
    });

    it('alias listMembers routes correctly', async () => {
      await connector.invoke('listMembers', { groupId: 'grp-1' }, ctx);
      assert.ok(lastCall().url.includes('/groups/grp-1/members'));
    });
  });

  /* ================================================================ */
  /*  Calendar Events                                                 */
  /* ================================================================ */

  describe('calendar events', () => {
    it('ListGroupEvents sends GET /groups/{id}/events', async () => {
      await connector.invoke('ListGroupEvents', { groupId: 'grp-1' }, ctx);
      assert.ok(lastCall().url.includes('/groups/grp-1/events'));
      assert.equal(lastCall().method, 'GET');
    });

    it('ListGroupEvents uses calendarView when date range provided', async () => {
      await connector.invoke('ListGroupEvents', {
        groupId: 'grp-1',
        startDateTime: '2024-01-01T00:00:00Z',
        endDateTime: '2024-01-31T23:59:59Z',
      }, ctx);
      assert.ok(lastCall().url.includes('/groups/grp-1/calendarView'));
      assert.ok(lastCall().url.includes('startDateTime='));
      assert.ok(lastCall().url.includes('endDateTime='));
    });

    it('GetGroupEvent sends GET /groups/{id}/events/{eventId}', async () => {
      fetchResponse = {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => JSON.stringify({ id: 'evt-1', subject: 'Meeting' }),
      };
      await connector.invoke('GetGroupEvent', { groupId: 'grp-1', eventId: 'evt-1' }, ctx);
      assert.ok(lastCall().url.includes('/groups/grp-1/events/evt-1'));
      assert.equal(lastCall().method, 'GET');
    });

    it('CreateGroupEvent sends POST with correct event body shape', async () => {
      fetchResponse = {
        ok: true,
        status: 201,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => JSON.stringify({ id: 'evt-new' }),
      };
      await connector.invoke('CreateGroupEvent', {
        groupId: 'grp-1',
        subject: 'Team Standup',
        start: '2024-01-15T09:00:00',
        end: '2024-01-15T09:30:00',
        body: '<p>Daily standup</p>',
        location: 'Conference Room A',
      }, ctx);

      assert.ok(lastCall().url.includes('/groups/grp-1/events'));
      assert.equal(lastCall().method, 'POST');

      const body = lastCall().body;
      assert.equal(body.subject, 'Team Standup');
      assert.equal(body.start.dateTime, '2024-01-15T09:00:00');
      assert.equal(body.start.timeZone, 'UTC');
      assert.equal(body.end.dateTime, '2024-01-15T09:30:00');
      assert.equal(body.end.timeZone, 'UTC');
      assert.equal(body.body.contentType, 'HTML');
      assert.equal(body.body.content, '<p>Daily standup</p>');
      assert.equal(body.location.displayName, 'Conference Room A');
    });

    it('CreateGroupEvent defaults timeZone to UTC', async () => {
      fetchResponse = {
        ok: true,
        status: 201,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => JSON.stringify({ id: 'evt-new' }),
      };
      await connector.invoke('CreateGroupEvent', {
        groupId: 'grp-1',
        subject: 'Meeting',
        start: '2024-01-15T09:00:00',
        end: '2024-01-15T10:00:00',
      }, ctx);

      const body = lastCall().body;
      assert.equal(body.start.timeZone, 'UTC');
      assert.equal(body.end.timeZone, 'UTC');
    });

    it('CreateGroupEvent includes required and optional attendees with correct types', async () => {
      fetchResponse = {
        ok: true,
        status: 201,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => JSON.stringify({ id: 'evt-new' }),
      };
      await connector.invoke('CreateGroupEvent', {
        groupId: 'grp-1',
        subject: 'Review',
        start: '2024-01-15T10:00:00',
        end: '2024-01-15T11:00:00',
        requiredAttendees: 'alice@example.com;bob@example.com',
        optionalAttendees: 'carol@example.com',
      }, ctx);

      const attendees = lastCall().body.attendees;
      assert.ok(Array.isArray(attendees));
      assert.equal(attendees.length, 3);

      const required = attendees.filter((a: any) => a.type === 'required');
      const optional = attendees.filter((a: any) => a.type === 'optional');
      assert.equal(required.length, 2);
      assert.equal(optional.length, 1);
      assert.equal(required[0].emailAddress.address, 'alice@example.com');
      assert.equal(required[1].emailAddress.address, 'bob@example.com');
      assert.equal(optional[0].emailAddress.address, 'carol@example.com');
    });

    it('UpdateGroupEvent sends PATCH /groups/{id}/events/{eventId}', async () => {
      fetchResponse = {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => JSON.stringify({ id: 'evt-1' }),
      };
      await connector.invoke('UpdateGroupEvent', {
        groupId: 'grp-1',
        eventId: 'evt-1',
        subject: 'Updated Subject',
      }, ctx);
      assert.ok(lastCall().url.includes('/groups/grp-1/events/evt-1'));
      assert.equal(lastCall().method, 'PATCH');
    });

    it('DeleteGroupEvent sends DELETE /groups/{id}/events/{eventId}', async () => {
      fetchResponse = {
        ok: true,
        status: 204,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => '',
      };
      const result = await connector.invoke('DeleteGroupEvent', { groupId: 'grp-1', eventId: 'evt-1' }, ctx);
      assert.ok(lastCall().url.includes('/groups/grp-1/events/evt-1'));
      assert.equal(lastCall().method, 'DELETE');
      assert.deepEqual(result, { success: true });
    });
  });

  /* ================================================================ */
  /*  Unknown operation                                               */
  /* ================================================================ */

  describe('unknown operation', () => {
    it('throws with "unknown operation" message for unrecognised operation', async () => {
      await assert.rejects(
        () => connector.invoke('DoSomethingRandom', {}, ctx),
        (err: Error) => {
          assert.match(err.message, /unknown operation/);
          return true;
        }
      );
    });
  });
});
