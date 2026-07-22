/**
 * Office 365 Users Connector for FlowForger
 *
 * Implements Office 365 Users operations using Microsoft Graph API.
 * Mirrors the official Power Automate connector documented at
 * https://learn.microsoft.com/en-us/connectors/office365users/
 *
 * Requires a Microsoft Graph API token with the appropriate permissions:
 * - User.Read for MyProfile_V2
 * - User.Read.All / User.ReadBasic.All for UserProfile_V2, Manager_V2, DirectReports_V2, SearchUserV2
 * - User.ReadWrite for UpdateMyProfile, UpdateMyPhoto
 * - People.Read for RelevantPeople
 * - Sites.Read.All for trending documents
 */

import type { BaseConnector, RunContext } from '@flowforger/engine';
import { BaseHttpClient, HttpError } from '@flowforger/connectors-shared';

export interface Office365UsersConnectorOptions {
  /** Microsoft Graph API access token */
  token: string;
  /** Optional: Graph API base URL (defaults to https://graph.microsoft.com/v1.0) */
  baseUrl?: string;
}

/**
 * Default $select fields for INDIVIDUAL user lookups (/me, /users/{id}, /users/{id}/manager).
 * Matches the documented Power Automate default set including extended profile properties.
 */
const DEFAULT_SELECT_FIELDS = [
  'aboutMe', 'accountEnabled', 'birthday', 'businessPhones', 'city', 'companyName',
  'country', 'department', 'displayName', 'givenName', 'hireDate', 'id',
  'interests', 'jobTitle', 'mail', 'mailNickname', 'mobilePhone', 'mySite',
  'officeLocation', 'pastProjects', 'postalCode', 'preferredLanguage', 'preferredName',
  'responsibilities', 'schools', 'skills', 'state', 'streetAddress', 'surname',
  'userPrincipalName', 'userType',
].join(',');

/**
 * $select fields safe for LIST queries (/users, /users/{id}/directReports).
 * Graph rejects extended-profile properties (aboutMe, birthday, hireDate, interests,
 * mySite, pastProjects, preferredName, responsibilities, schools, skills) on list endpoints
 * with a 404 "UnknownError", so we exclude them here.
 */
const LIST_SELECT_FIELDS = [
  'accountEnabled', 'businessPhones', 'city', 'companyName', 'country', 'department',
  'displayName', 'givenName', 'id', 'jobTitle', 'mail', 'mailNickname', 'mobilePhone',
  'officeLocation', 'postalCode', 'preferredLanguage', 'state', 'streetAddress',
  'surname', 'userPrincipalName', 'userType',
].join(',');

export interface SearchUsersInputs {
  /** Search string (applies to: display name, given name, surname, mail, mail nickname and user principal name). */
  searchTerm?: string;
  /** Limit on the number of results to return. Default 1000, minimum 1. */
  top?: number;
  /** If true, returns no profiles when search term is empty; if false, returns all when empty. */
  isSearchTermRequired?: boolean;
}

export interface GetUserProfileInputs {
  /** User principal name or id. */
  id: string;
  /** Comma separated list of fields to select. */
  $select?: string;
}

export interface GetDirectReportsInputs {
  id: string;
  $select?: string;
  $top?: number;
}

export interface GetTrendingDocumentsInputs {
  id?: string;
  $filter?: string;
  extractSensitivityLabel?: boolean;
  fetchSensitivityLabelMetadata?: boolean;
}

export interface UpdateMyProfileInputs {
  aboutMe?: string;
  birthday?: string;
  interests?: string[];
  mySite?: string;
  pastProjects?: string[];
  schools?: string[];
  skills?: string[];
}

export interface UpdateMyPhotoInputs {
  /** Image content as a base64 string or binary. */
  body: string | ArrayBuffer | Uint8Array;
  /** Image content type, e.g. 'image/jpeg'. */
  'Content-Type'?: string;
  contentType?: string;
}

export interface HttpRequestInputs {
  Uri: string;
  Method: string;
  Body?: unknown;
  ContentType?: string;
  CustomHeader1?: string;
  CustomHeader2?: string;
  CustomHeader3?: string;
  CustomHeader4?: string;
  CustomHeader5?: string;
}

// Re-export HttpError for consumers
export { HttpError };

export class Office365UsersConnector extends BaseHttpClient implements BaseConnector {
  constructor(opts: Office365UsersConnectorOptions) {
    super(
      opts.baseUrl?.replace(/\/$/, '') || 'https://graph.microsoft.com/v1.0',
      opts.token
    );
  }

  async invoke(operation: string, inputs: unknown, ctx: RunContext): Promise<unknown> {
    ctx.log?.({ type: 'office365users.invoke', operation, inputs });
    const p = (inputs || {}) as Record<string, unknown>;

    switch (operation) {
      // ---- Profile (V2 - returns GraphUser_V1 camelCase) ----
      case 'MyProfile_V2':
      case 'MyProfileV2':
      case 'myProfile':
        return this.getMyProfile(p as unknown as { $select?: string }, ctx);

      case 'UserProfile_V2':
      case 'UserProfileV2':
      case 'userProfile':
        return this.getUserProfile(p as unknown as GetUserProfileInputs, ctx);

      case 'Manager_V2':
      case 'ManagerV2':
      case 'manager':
        return this.getManager(p as unknown as GetUserProfileInputs, ctx);

      case 'DirectReports_V2':
      case 'DirectReportsV2':
      case 'directReports':
        return this.getDirectReports(p as unknown as GetDirectReportsInputs, ctx);

      // ---- Profile (V1 deprecated - returns User PascalCase) ----
      case 'MyProfile': {
        const u = await this.getMyProfile(p as unknown as { $select?: string }, ctx);
        return this.toUserPascal(u as Record<string, unknown>);
      }
      case 'UserProfile': {
        const u = await this.getUserProfile(p as unknown as GetUserProfileInputs, ctx);
        return this.toUserPascal(u as Record<string, unknown>);
      }
      case 'Manager': {
        const u = await this.getManager(p as unknown as GetUserProfileInputs, ctx);
        return this.toUserPascal(u as Record<string, unknown>);
      }
      case 'DirectReports': {
        const list = await this.getDirectReports(p as unknown as GetDirectReportsInputs, ctx);
        return this.toUserListPascal(list as { value?: unknown[] });
      }

      // ---- Search (always returns User PascalCase per docs) ----
      case 'SearchUserV2':
      case 'SearchUser_V2':
      case 'SearchUser':
      case 'searchUser': {
        const list = await this.searchUsers(p as unknown as SearchUsersInputs, ctx);
        return this.toUserListPascal(list as { value?: unknown[]; ['@odata.nextLink']?: string });
      }

      // ---- Relevant People ----
      case 'RelevantPeople':
      case 'relevantPeople':
        return this.getRelevantPeople(p as unknown as { userId: string }, ctx);

      // ---- Trending Documents ----
      case 'MyTrendingDocuments':
      case 'myTrendingDocuments':
        return this.getMyTrendingDocuments(p as unknown as GetTrendingDocumentsInputs, ctx);

      case 'TrendingDocuments':
      case 'trendingDocuments':
        return this.getTrendingDocuments(p as unknown as GetTrendingDocumentsInputs & { id: string }, ctx);

      // ---- Photo ----
      case 'UserPhoto_V2':
      case 'UserPhotoV2':
      case 'UserPhoto':
      case 'userPhoto':
        return this.getUserPhoto(p as unknown as { id?: string; userId?: string }, ctx);

      case 'UserPhotoMetadata':
      case 'userPhotoMetadata':
        return this.getUserPhotoMetadata(p as unknown as { userId?: string; id?: string }, ctx);

      // ---- Update ----
      case 'UpdateMyProfile':
      case 'updateMyProfile':
        return this.updateMyProfile(p as unknown as UpdateMyProfileInputs, ctx);

      case 'UpdateMyPhoto':
      case 'updateMyPhoto':
        return this.updateMyPhoto(p as unknown as UpdateMyPhotoInputs, ctx);

      // ---- Generic ----
      case 'HttpRequest':
      case 'httpRequest':
        return this.httpRequest(p as unknown as HttpRequestInputs, ctx);

      default:
        throw new Error(`Office365UsersConnector: unknown operation '${operation}'`);
    }
  }

  // ============= Helpers =============

  private buildSelectQuery(select?: string): string {
    const selectClause = select && select.trim().length > 0 ? select : DEFAULT_SELECT_FIELDS;
    return `?$select=${encodeURIComponent(selectClause)}`;
  }

  private resolveUserId(id: string | undefined): string {
    if (!id) throw new Error('Office365UsersConnector: missing required parameter "id" (User Principal Name or user id)');
    return encodeURIComponent(id);
  }

  /**
   * Convert a Graph user (camelCase) to the Power Automate `User` shape (PascalCase).
   * Used for SearchUserV2 and the deprecated V1 aliases (Manager, MyProfile, UserProfile,
   * DirectReports) which the connector docs document as returning the older `User` type.
   * The V2 lookups (Manager_V2, UserProfile_V2, MyProfile_V2, DirectReports_V2) return
   * `GraphUser_V1` (camelCase) and are NOT transformed.
   *
   * Original camelCase keys are preserved alongside the PascalCase ones so flows that read
   * either shape work.
   */
  private toUserPascal(item: Record<string, unknown>): Record<string, unknown> {
    return {
      Id: item.id,
      AccountEnabled: item.accountEnabled,
      BusinessPhones: item.businessPhones,
      City: item.city,
      CompanyName: item.companyName,
      Country: item.country,
      Department: item.department,
      DisplayName: item.displayName,
      GivenName: item.givenName,
      JobTitle: item.jobTitle,
      Mail: item.mail,
      MailNickname: item.mailNickname,
      OfficeLocation: item.officeLocation,
      PostalCode: item.postalCode,
      Surname: item.surname,
      // Power Automate's `TelephoneNumber` is documented as the user's primary cellular phone.
      TelephoneNumber: item.mobilePhone,
      UserPrincipalName: item.userPrincipalName,
      // Preserve the original Graph properties too for compatibility.
      ...item,
    };
  }

  private toUserListPascal(response: { value?: unknown[]; ['@odata.nextLink']?: string }): { value: unknown[]; ['@odata.nextLink']?: string } {
    const items = Array.isArray(response?.value) ? response.value : [];
    return {
      value: items.map((u) => this.toUserPascal(u as Record<string, unknown>)),
      ...(response?.['@odata.nextLink'] ? { '@odata.nextLink': response['@odata.nextLink'] } : {}),
    };
  }

  // ============= Profile Operations =============

  async getMyProfile(inputs: { $select?: string }, ctx: RunContext): Promise<unknown> {
    const query = this.buildSelectQuery(inputs?.$select);
    return this.get(`/me${query}`, ctx.log);
  }

  async getUserProfile(inputs: GetUserProfileInputs, ctx: RunContext): Promise<unknown> {
    const userId = this.resolveUserId(inputs.id);
    const query = this.buildSelectQuery(inputs.$select);
    return this.get(`/users/${userId}${query}`, ctx.log);
  }

  async getManager(inputs: GetUserProfileInputs, ctx: RunContext): Promise<unknown> {
    const userId = this.resolveUserId(inputs.id);
    const query = this.buildSelectQuery(inputs.$select);
    try {
      return await this.get(`/users/${userId}/manager${query}`, ctx.log);
    } catch (err) {
      // Graph returns 404 when no manager configured — mirror connector's documented error text.
      if (err instanceof HttpError && err.status === 404) {
        throw new HttpError('No manager found for the specified user.', 404, err.response);
      }
      throw err;
    }
  }

  async getDirectReports(inputs: GetDirectReportsInputs, ctx: RunContext): Promise<unknown> {
    const userId = this.resolveUserId(inputs.id);
    const params: string[] = [];
    params.push(`$select=${encodeURIComponent(inputs.$select && inputs.$select.trim().length > 0 ? inputs.$select : LIST_SELECT_FIELDS)}`);
    if (inputs.$top !== undefined) params.push(`$top=${inputs.$top}`);
    return this.get(`/users/${userId}/directReports?${params.join('&')}`, ctx.log);
  }

  // ============= Search =============

  async searchUsers(inputs: SearchUsersInputs, ctx: RunContext): Promise<unknown> {
    const searchTerm = (inputs.searchTerm ?? '').trim();
    const top = inputs.top ?? 1000;
    const isSearchTermRequired = inputs.isSearchTermRequired ?? true;

    if (!searchTerm && isSearchTermRequired) {
      return { value: [] };
    }

    const params: string[] = [];
    params.push(`$top=${top}`);
    params.push(`$select=${encodeURIComponent(LIST_SELECT_FIELDS)}`);

    const headers: Record<string, string> = {};
    if (searchTerm) {
      // Match across displayName/givenName/surname/mail/mailNickname/userPrincipalName.
      // Advanced query operators (multi-field OR with startswith) require ConsistencyLevel: eventual.
      const term = searchTerm.replace(/'/g, "''");
      const filter = [
        `startswith(displayName,'${term}')`,
        `startswith(givenName,'${term}')`,
        `startswith(surname,'${term}')`,
        `startswith(mail,'${term}')`,
        `startswith(mailNickname,'${term}')`,
        `startswith(userPrincipalName,'${term}')`,
      ].join(' or ');
      params.push(`$filter=${encodeURIComponent(filter)}`);
      params.push('$count=true');
      headers['ConsistencyLevel'] = 'eventual';
    }

    return this.get(`/users?${params.join('&')}`, ctx.log, { headers });
  }

  // ============= Relevant People =============

  async getRelevantPeople(inputs: { userId: string }, ctx: RunContext): Promise<unknown> {
    const userId = this.resolveUserId(inputs.userId);
    return this.get(`/users/${userId}/people`, ctx.log);
  }

  // ============= Trending Documents =============

  async getMyTrendingDocuments(inputs: GetTrendingDocumentsInputs, ctx: RunContext): Promise<unknown> {
    const params: string[] = [];
    if (inputs.$filter) params.push(`$filter=${encodeURIComponent(inputs.$filter)}`);
    const query = params.length > 0 ? `?${params.join('&')}` : '';
    return this.get(`/me/insights/trending${query}`, ctx.log);
  }

  async getTrendingDocuments(inputs: GetTrendingDocumentsInputs & { id: string }, ctx: RunContext): Promise<unknown> {
    const userId = this.resolveUserId(inputs.id);
    const params: string[] = [];
    if (inputs.$filter) params.push(`$filter=${encodeURIComponent(inputs.$filter)}`);
    const query = params.length > 0 ? `?${params.join('&')}` : '';
    return this.get(`/users/${userId}/insights/trending${query}`, ctx.log);
  }

  // ============= Photo =============

  /**
   * Fetches user photo bytes. Returns an object with the binary content and content-type so the
   * caller can decide whether to base64-encode or stream it. Default Power Automate behavior is
   * to return the bytes directly.
   */
  async getUserPhoto(inputs: { id?: string; userId?: string }, ctx: RunContext): Promise<{ content: string; contentType: string }> {
    const id = inputs.id ?? inputs.userId;
    const userId = this.resolveUserId(id);
    const url = `${this.baseUrl}/users/${userId}/photo/$value`;
    ctx.log?.({ type: 'Office365UsersConnector.request', method: 'GET', url });

    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.token}` },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      ctx.log?.({ type: 'Office365UsersConnector.error', status: response.status, error: text });
      throw new HttpError(`HTTP ${response.status}`, response.status, text);
    }

    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const base64 = arrayBufferToBase64(buffer);
    ctx.log?.({ type: 'Office365UsersConnector.response', status: response.status, contentType, bytes: buffer.byteLength });
    return { content: base64, contentType };
  }

  async getUserPhotoMetadata(inputs: { userId?: string; id?: string }, ctx: RunContext): Promise<unknown> {
    const id = inputs.userId ?? inputs.id;
    const userId = this.resolveUserId(id);
    try {
      const meta = await this.get<{ width?: number; height?: number; ['@odata.mediaContentType']?: string }>(`/users/${userId}/photo`, ctx.log);
      return {
        HasPhoto: true,
        Width: meta.width ?? 0,
        Height: meta.height ?? 0,
        ContentType: meta['@odata.mediaContentType'] ?? 'image/jpeg',
        ImageFileExtension: extensionFromMime(meta['@odata.mediaContentType']),
      };
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        return { HasPhoto: false, Width: 0, Height: 0, ContentType: '', ImageFileExtension: '' };
      }
      throw err;
    }
  }

  // ============= Update =============

  async updateMyProfile(inputs: UpdateMyProfileInputs, ctx: RunContext): Promise<{ success: boolean }> {
    const updates: Record<string, unknown> = {};
    if (inputs.aboutMe !== undefined) updates.aboutMe = inputs.aboutMe;
    if (inputs.birthday !== undefined) updates.birthday = inputs.birthday;
    if (inputs.interests !== undefined) updates.interests = inputs.interests;
    if (inputs.mySite !== undefined) updates.mySite = inputs.mySite;
    if (inputs.pastProjects !== undefined) updates.pastProjects = inputs.pastProjects;
    if (inputs.schools !== undefined) updates.schools = inputs.schools;
    if (inputs.skills !== undefined) updates.skills = inputs.skills;

    await this.patch('/me', ctx.log, { body: updates });
    return { success: true };
  }

  async updateMyPhoto(inputs: UpdateMyPhotoInputs, ctx: RunContext): Promise<{ success: boolean }> {
    const contentType = inputs['Content-Type'] ?? inputs.contentType ?? 'image/jpeg';
    const url = `${this.baseUrl}/me/photo/$value`;
    ctx.log?.({ type: 'Office365UsersConnector.request', method: 'PUT', url });

    const body: BodyInit = typeof inputs.body === 'string'
      ? base64ToArrayBuffer(inputs.body)
      : inputs.body instanceof Uint8Array
        ? new Blob([new Uint8Array(inputs.body)])
        : (inputs.body as ArrayBuffer);

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': contentType,
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new HttpError(`HTTP ${response.status}`, response.status, text);
    }

    return { success: true };
  }

  // ============= Generic HTTP =============

  async httpRequest(inputs: HttpRequestInputs, ctx: RunContext): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (inputs.ContentType) headers['Content-Type'] = inputs.ContentType;
    for (const customKey of ['CustomHeader1', 'CustomHeader2', 'CustomHeader3', 'CustomHeader4', 'CustomHeader5'] as const) {
      const raw = inputs[customKey];
      if (typeof raw === 'string' && raw.includes(':')) {
        const idx = raw.indexOf(':');
        const name = raw.substring(0, idx).trim();
        const value = raw.substring(idx + 1).trim();
        if (name) headers[name] = value;
      }
    }

    return this.request(
      (inputs.Method || 'GET').toUpperCase(),
      inputs.Uri,
      ctx.log,
      { body: inputs.Body, headers },
    );
  }
}

// ============= Module-private helpers =============

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  // btoa is available in browsers; engine-wrapper runs in browser too.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(base64, 'base64');
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const binary = (globalThis as any).atob(base64) as string;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function extensionFromMime(mime: string | undefined): string {
  switch ((mime || '').toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/gif':
      return '.gif';
    case 'image/bmp':
      return '.bmp';
    default:
      return '';
  }
}

export default Office365UsersConnector;

// Export metadata for language service and scope mapping
export { office365usersMetadata, office365usersScopes } from './metadata.js';
