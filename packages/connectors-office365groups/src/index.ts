/**
 * Office 365 Groups Connector for FlowForger
 *
 * Implements Office 365 Groups operations using Microsoft Graph API.
 * Requires a Microsoft Graph API token with appropriate permissions:
 * - Group.Read.All, Group.ReadWrite.All for group management
 * - GroupMember.Read.All, GroupMember.ReadWrite.All for membership
 * - Calendars.Read, Calendars.ReadWrite for group calendar events
 */

import type { BaseConnector, RunContext } from '@flowforger/engine';
import { BaseHttpClient, parseStringList, HttpError } from '@flowforger/connectors-shared';

export interface Office365GroupsConnectorOptions {
  /** Microsoft Graph API access token */
  token: string;
  /** Optional: Graph API base URL (defaults to https://graph.microsoft.com/v1.0) */
  baseUrl?: string;
}

// Re-export HttpError for consumers
export { HttpError };

export class Office365GroupsConnector extends BaseHttpClient implements BaseConnector {
  constructor(opts: Office365GroupsConnectorOptions) {
    super(
      opts.baseUrl?.replace(/\/$/, '') || 'https://graph.microsoft.com/v1.0',
      opts.token
    );
  }

  async invoke(operation: string, inputs: unknown, ctx: RunContext): Promise<unknown> {
    ctx.log?.({ type: 'office365groups.invoke', operation, inputs });
    const p = (inputs || {}) as Record<string, any>;

    switch (operation) {
      // ---- Group Management ----
      case 'ListGroups': case 'listGroups': case 'ListAllGroups':
        return this.listGroups(p, ctx);
      case 'GetGroup': case 'getGroup':
        return this.getGroup(p, ctx);
      case 'CreateGroup': case 'createGroup':
        return this.createGroup(p, ctx);
      case 'UpdateGroup': case 'updateGroup':
        return this.updateGroup(p, ctx);
      case 'DeleteGroup': case 'deleteGroup':
        return this.deleteGroup(p, ctx);

      // ---- Membership ----
      case 'ListGroupMembers': case 'listMembers':
        return this.listGroupMembers(p, ctx);
      case 'AddMemberToGroup': case 'addMember':
        return this.addMemberToGroup(p, ctx);
      case 'RemoveMemberFromGroup': case 'removeMember':
        return this.removeMemberFromGroup(p, ctx);
      case 'ListGroupOwners': case 'listOwners':
        return this.listGroupOwners(p, ctx);
      case 'AddOwnerToGroup': case 'addOwner':
        return this.addOwnerToGroup(p, ctx);
      case 'RemoveOwnerFromGroup': case 'removeOwner':
        return this.removeOwnerFromGroup(p, ctx);
      case 'IsMemberOfGroup': case 'isMember':
        return this.isMemberOfGroup(p, ctx);

      // ---- Group Calendar Events ----
      case 'ListGroupEvents': case 'listEvents':
        return this.listGroupEvents(p, ctx);
      case 'GetGroupEvent': case 'getEvent':
        return this.getGroupEvent(p, ctx);
      case 'CreateGroupEvent': case 'createEvent':
        return this.createGroupEvent(p, ctx);
      case 'UpdateGroupEvent': case 'updateEvent':
        return this.updateGroupEvent(p, ctx);
      case 'DeleteGroupEvent': case 'deleteEvent':
        return this.deleteGroupEvent(p, ctx);

      // ---- Graph HTTP ----
      case 'HttpRequest': case 'httpRequest':
        return this.httpRequest(p, ctx);

      default:
        throw new Error(`Office365GroupsConnector: unknown operation '${operation}'`);
    }
  }

  // ============= Group Management =============

  private async listGroups(p: Record<string, any>, ctx: RunContext): Promise<unknown> {
    const query: Record<string, string> = {};
    if (p['$filter'] || p['filter']) query['$filter'] = p['$filter'] || p['filter'];
    if (p['$top'] || p['top']) query['$top'] = String(p['$top'] || p['top']);
    if (p['$select'] || p['select']) query['$select'] = p['$select'] || p['select'];
    if (p['$orderby'] || p['orderby']) query['$orderby'] = p['$orderby'] || p['orderby'];

    const result = await this.get<{ value: unknown[] }>('/groups', ctx.log, { query });
    // Cloud connector parity: list operations return the Graph response body
    // (an object with a `value` array), so flows can read outputs()?['body/value'].
    return { ...result, value: result.value ?? [] };
  }

  private async getGroup(p: Record<string, any>, ctx: RunContext): Promise<unknown> {
    const groupId = p['groupId'];
    if (!groupId) throw new Error('Office365GroupsConnector.GetGroup: groupId is required');
    return this.get(`/groups/${encodeURIComponent(groupId)}`, ctx.log);
  }

  private async createGroup(p: Record<string, any>, ctx: RunContext): Promise<unknown> {
    const displayName = p['displayName'];
    if (!displayName) throw new Error('Office365GroupsConnector.CreateGroup: displayName is required');

    const mailNickname = p['mailNickname'] || displayName.replace(/\s+/g, '').toLowerCase();

    const body: Record<string, unknown> = {
      displayName,
      mailNickname,
      groupTypes: p['groupTypes'] || ['Unified'],
      mailEnabled: p['mailEnabled'] !== undefined ? p['mailEnabled'] : true,
      securityEnabled: p['securityEnabled'] !== undefined ? p['securityEnabled'] : false,
    };

    if (p['description']) body['description'] = p['description'];
    if (p['visibility']) body['visibility'] = p['visibility'];

    if (p['owners']) {
      const ownerList = parseStringList(p['owners'] as string | string[]);
      body['owners@odata.bind'] = ownerList.map(
        (id) => `${this.baseUrl}/users/${id}`
      );
    }

    if (p['members']) {
      const memberList = parseStringList(p['members'] as string | string[]);
      body['members@odata.bind'] = memberList.map(
        (id) => `${this.baseUrl}/users/${id}`
      );
    }

    return this.post('/groups', ctx.log, { body });
  }

  private async updateGroup(p: Record<string, any>, ctx: RunContext): Promise<unknown> {
    const groupId = p['groupId'];
    if (!groupId) throw new Error('Office365GroupsConnector.UpdateGroup: groupId is required');

    const { groupId: _id, ...rest } = p;
    return this.patch(`/groups/${encodeURIComponent(groupId)}`, ctx.log, { body: rest });
  }

  private async deleteGroup(p: Record<string, any>, ctx: RunContext): Promise<{ success: true }> {
    const groupId = p['groupId'];
    if (!groupId) throw new Error('Office365GroupsConnector.DeleteGroup: groupId is required');
    await this.delete(`/groups/${encodeURIComponent(groupId)}`, ctx.log);
    return { success: true };
  }

  // ============= Membership =============

  private async listGroupMembers(p: Record<string, any>, ctx: RunContext): Promise<unknown> {
    const groupId = p['groupId'];
    if (!groupId) throw new Error('Office365GroupsConnector.ListGroupMembers: groupId is required');

    const query: Record<string, string> = {};
    if (p['$top'] || p['top']) query['$top'] = String(p['$top'] || p['top']);
    if (p['$select'] || p['select']) query['$select'] = p['$select'] || p['select'];
    if (p['$filter'] || p['filter']) query['$filter'] = p['$filter'] || p['filter'];

    const result = await this.get<{ value: unknown[] }>(
      `/groups/${encodeURIComponent(groupId)}/members`,
      ctx.log,
      { query }
    );
    return { ...result, value: result.value ?? [] };
  }

  private async addMemberToGroup(p: Record<string, any>, ctx: RunContext): Promise<unknown> {
    const groupId = p['groupId'];
    const userId = p['userId'];
    if (!groupId) throw new Error('Office365GroupsConnector.AddMemberToGroup: groupId is required');
    if (!userId) throw new Error('Office365GroupsConnector.AddMemberToGroup: userId is required');

    return this.post(
      `/groups/${encodeURIComponent(groupId)}/members/$ref`,
      ctx.log,
      { body: { '@odata.id': `${this.baseUrl}/users/${userId}` } }
    );
  }

  private async removeMemberFromGroup(p: Record<string, any>, ctx: RunContext): Promise<{ success: true }> {
    const groupId = p['groupId'];
    const userId = p['userId'];
    if (!groupId) throw new Error('Office365GroupsConnector.RemoveMemberFromGroup: groupId is required');
    if (!userId) throw new Error('Office365GroupsConnector.RemoveMemberFromGroup: userId is required');

    await this.delete(
      `/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/$ref`,
      ctx.log
    );
    return { success: true };
  }

  private async listGroupOwners(p: Record<string, any>, ctx: RunContext): Promise<unknown> {
    const groupId = p['groupId'];
    if (!groupId) throw new Error('Office365GroupsConnector.ListGroupOwners: groupId is required');

    const query: Record<string, string> = {};
    if (p['$top'] || p['top']) query['$top'] = String(p['$top'] || p['top']);
    if (p['$select'] || p['select']) query['$select'] = p['$select'] || p['select'];

    const result = await this.get<{ value: unknown[] }>(
      `/groups/${encodeURIComponent(groupId)}/owners`,
      ctx.log,
      { query }
    );
    return { ...result, value: result.value ?? [] };
  }

  private async addOwnerToGroup(p: Record<string, any>, ctx: RunContext): Promise<unknown> {
    const groupId = p['groupId'];
    const userId = p['userId'];
    if (!groupId) throw new Error('Office365GroupsConnector.AddOwnerToGroup: groupId is required');
    if (!userId) throw new Error('Office365GroupsConnector.AddOwnerToGroup: userId is required');

    return this.post(
      `/groups/${encodeURIComponent(groupId)}/owners/$ref`,
      ctx.log,
      { body: { '@odata.id': `${this.baseUrl}/users/${userId}` } }
    );
  }

  private async removeOwnerFromGroup(p: Record<string, any>, ctx: RunContext): Promise<{ success: true }> {
    const groupId = p['groupId'];
    const userId = p['userId'];
    if (!groupId) throw new Error('Office365GroupsConnector.RemoveOwnerFromGroup: groupId is required');
    if (!userId) throw new Error('Office365GroupsConnector.RemoveOwnerFromGroup: userId is required');

    await this.delete(
      `/groups/${encodeURIComponent(groupId)}/owners/${encodeURIComponent(userId)}/$ref`,
      ctx.log
    );
    return { success: true };
  }

  private async isMemberOfGroup(p: Record<string, any>, ctx: RunContext): Promise<unknown> {
    const groupId = p['groupId'];
    if (!groupId) throw new Error('Office365GroupsConnector.IsMemberOfGroup: groupId is required');

    return this.post('/me/checkMemberGroups', ctx.log, {
      body: { groupIds: [groupId] },
    });
  }

  // ============= Group Calendar Events =============

  private async listGroupEvents(p: Record<string, any>, ctx: RunContext): Promise<unknown> {
    const groupId = p['groupId'];
    if (!groupId) throw new Error('Office365GroupsConnector.ListGroupEvents: groupId is required');

    const startDateTime: string | undefined = p['startDateTime'];
    const endDateTime: string | undefined = p['endDateTime'];

    const query: Record<string, string> = {};
    if (p['$top'] || p['top']) query['$top'] = String(p['$top'] || p['top']);
    if (p['$filter'] || p['filter']) query['$filter'] = p['$filter'] || p['filter'];
    if (p['$orderby'] || p['orderby']) query['$orderby'] = p['$orderby'] || p['orderby'];

    let path: string;
    if (startDateTime && endDateTime) {
      query['startDateTime'] = startDateTime;
      query['endDateTime'] = endDateTime;
      path = `/groups/${encodeURIComponent(groupId)}/calendarView`;
    } else {
      path = `/groups/${encodeURIComponent(groupId)}/events`;
    }

    const result = await this.get<{ value: unknown[] }>(path, ctx.log, { query });
    return { ...result, value: result.value ?? [] };
  }

  private async getGroupEvent(p: Record<string, any>, ctx: RunContext): Promise<unknown> {
    const groupId = p['groupId'];
    const eventId = p['eventId'];
    if (!groupId) throw new Error('Office365GroupsConnector.GetGroupEvent: groupId is required');
    if (!eventId) throw new Error('Office365GroupsConnector.GetGroupEvent: eventId is required');

    return this.get(
      `/groups/${encodeURIComponent(groupId)}/events/${encodeURIComponent(eventId)}`,
      ctx.log
    );
  }

  private async createGroupEvent(p: Record<string, any>, ctx: RunContext): Promise<unknown> {
    const groupId = p['groupId'];
    if (!groupId) throw new Error('Office365GroupsConnector.CreateGroupEvent: groupId is required');

    const event = this.buildEventPayload(p);
    return this.post(`/groups/${encodeURIComponent(groupId)}/events`, ctx.log, { body: event });
  }

  private async updateGroupEvent(p: Record<string, any>, ctx: RunContext): Promise<unknown> {
    const groupId = p['groupId'];
    const eventId = p['eventId'];
    if (!groupId) throw new Error('Office365GroupsConnector.UpdateGroupEvent: groupId is required');
    if (!eventId) throw new Error('Office365GroupsConnector.UpdateGroupEvent: eventId is required');

    const { groupId: _gid, eventId: _eid, ...rest } = p;
    const updates: Record<string, unknown> = {};

    if (rest['subject']) updates['subject'] = rest['subject'];
    if (rest['body']) updates['body'] = { contentType: 'HTML', content: rest['body'] };
    if (rest['start']) updates['start'] = { dateTime: rest['start'], timeZone: rest['timeZone'] || 'UTC' };
    if (rest['end']) updates['end'] = { dateTime: rest['end'], timeZone: rest['timeZone'] || 'UTC' };
    if (rest['location']) updates['location'] = { displayName: rest['location'] };
    if (rest['isAllDay'] !== undefined) updates['isAllDay'] = rest['isAllDay'];
    if (rest['reminderMinutes'] !== undefined) {
      updates['reminderMinutesBeforeStart'] = rest['reminderMinutes'];
      updates['isReminderOn'] = rest['reminderMinutes'] > 0;
    }
    if (rest['showAs']) updates['showAs'] = rest['showAs'];
    if (rest['sensitivity']) updates['sensitivity'] = rest['sensitivity'];
    if (rest['categories']) updates['categories'] = rest['categories'];
    if (rest['recurrence']) updates['recurrence'] = rest['recurrence'];

    const requiredAttendees = parseStringList(rest['requiredAttendees'] as string | string[] | undefined);
    const optionalAttendees = parseStringList(rest['optionalAttendees'] as string | string[] | undefined);
    const attendees = [
      ...requiredAttendees.map((a) => ({ emailAddress: { address: a }, type: 'required' as const })),
      ...optionalAttendees.map((a) => ({ emailAddress: { address: a }, type: 'optional' as const })),
    ];
    if (attendees.length) updates['attendees'] = attendees;

    return this.patch(
      `/groups/${encodeURIComponent(groupId)}/events/${encodeURIComponent(eventId)}`,
      ctx.log,
      { body: updates }
    );
  }

  private async deleteGroupEvent(p: Record<string, any>, ctx: RunContext): Promise<{ success: true }> {
    const groupId = p['groupId'];
    const eventId = p['eventId'];
    if (!groupId) throw new Error('Office365GroupsConnector.DeleteGroupEvent: groupId is required');
    if (!eventId) throw new Error('Office365GroupsConnector.DeleteGroupEvent: eventId is required');

    await this.delete(
      `/groups/${encodeURIComponent(groupId)}/events/${encodeURIComponent(eventId)}`,
      ctx.log
    );
    return { success: true };
  }

  // ============= Graph HTTP =============

  private async httpRequest(p: Record<string, any>, ctx: RunContext): Promise<unknown> {
    const uri = p['Uri'] ?? p['uri'] ?? p['url'];
    const method = (p['Method'] ?? p['method'] ?? 'GET') as string;
    const body = p['Body'] ?? p['body'];
    const contentType = (p['ContentType'] ?? p['contentType'] ?? 'application/json') as string;
    if (!uri) throw new Error('Office365GroupsConnector.HttpRequest: Uri is required');

    const isFullUrl = (uri as string).startsWith('http://') || (uri as string).startsWith('https://');
    const path = isFullUrl ? new URL(uri as string).pathname : (uri as string);

    const headers: Record<string, string> = { 'Content-Type': contentType };
    for (let i = 1; i <= 5; i++) {
      const headerVal = p[`CustomHeader${i}`] ?? p[`customHeader${i}`];
      if (headerVal) {
        const colonIndex = (headerVal as string).indexOf(':');
        if (colonIndex > 0) {
          headers[(headerVal as string).substring(0, colonIndex).trim()] =
            (headerVal as string).substring(colonIndex + 1).trim();
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

  // ============= Event Payload Helper =============

  private buildEventPayload(p: Record<string, any>): Record<string, unknown> {
    const event: Record<string, unknown> = {};

    if (p['subject']) event['subject'] = p['subject'];
    if (p['start']) event['start'] = { dateTime: p['start'], timeZone: p['timeZone'] || 'UTC' };
    if (p['end']) event['end'] = { dateTime: p['end'], timeZone: p['timeZone'] || 'UTC' };
    if (p['body']) event['body'] = { contentType: 'HTML', content: p['body'] };
    if (p['location']) event['location'] = { displayName: p['location'] };

    const requiredAttendees = parseStringList(p['requiredAttendees'] as string | string[] | undefined);
    const optionalAttendees = parseStringList(p['optionalAttendees'] as string | string[] | undefined);
    const attendees = [
      ...requiredAttendees.map((a) => ({ emailAddress: { address: a }, type: 'required' as const })),
      ...optionalAttendees.map((a) => ({ emailAddress: { address: a }, type: 'optional' as const })),
    ];
    if (attendees.length) event['attendees'] = attendees;

    if (p['isAllDay'] !== undefined) event['isAllDay'] = p['isAllDay'];
    if (p['reminderMinutes'] !== undefined) {
      event['reminderMinutesBeforeStart'] = p['reminderMinutes'];
      event['isReminderOn'] = p['reminderMinutes'] > 0;
    }
    if (p['showAs']) event['showAs'] = p['showAs'];
    if (p['sensitivity']) event['sensitivity'] = p['sensitivity'];
    if (p['categories']) event['categories'] = p['categories'];
    if (p['recurrence']) event['recurrence'] = p['recurrence'];

    return event;
  }
}

export default Office365GroupsConnector;

export { office365groupsMetadata, office365groupsScopes } from './metadata.js';
