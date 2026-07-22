/**
 * Shared utilities for FlowForger connectors
 *
 * Provides common functionality for HTTP requests, error handling,
 * parameter extraction, and URL building.
 */

// Re-export metadata types and helpers
export {
  type ParameterMetadata,
  type OperationMetadata,
  type ConnectorMetadata,
  type ConnectorRegistry,
  param,
  operation,
  connector,
} from './metadata.js';

// Re-export trigger catalog
export {
  type ConnectorTriggerType,
  type TriggerOperationMetadata,
  type ConnectorTriggerCatalogEntry,
  getTriggerCatalog,
  getConnectorTriggers,
  getTriggerOperation,
  getConnectorNamesWithTriggers,
} from './trigger-catalog.js';

/**
 * Logging context interface - matches the RunContext.log signature
 */
export interface LogFunction {
  (entry: Record<string, unknown>): void;
}

/**
 * Options for HTTP requests
 */
export interface HttpRequestOptions {
  /** Request body (will be JSON stringified unless rawBody is true) */
  body?: unknown;
  /** Additional headers to include */
  headers?: Record<string, string>;
  /** Query parameters */
  query?: Record<string, string | number | boolean | undefined>;
  /** If true, body is sent as-is without JSON.stringify */
  rawBody?: boolean;
}

/**
 * HTTP error with status and response body
 */
export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly response?: unknown
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Base HTTP client for connectors
 *
 * Provides authenticated HTTP requests with consistent error handling,
 * logging, and response parsing.
 */
export class BaseHttpClient {
  constructor(
    protected readonly baseUrl: string,
    protected readonly token: string,
    protected readonly defaultHeaders: Record<string, string> = {}
  ) {}

  /**
   * Make an HTTP request
   */
  protected async request<T = unknown>(
    method: string,
    path: string,
    log?: LogFunction,
    options?: HttpRequestOptions
  ): Promise<T> {
    const url = this.buildUrl(path, options?.query);

    log?.({ type: `${this.constructor.name}.request`, method, url });

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      ...this.defaultHeaders,
      ...options?.headers,
    };

    const fetchOptions: RequestInit = {
      method,
      headers,
    };

    if (options?.body !== undefined && method !== 'GET') {
      fetchOptions.body = options.rawBody
        ? (options.body as string)
        : JSON.stringify(options.body);
    }

    const response = await fetch(url, fetchOptions);
    const data = await this.parseResponse(response);

    if (!response.ok) {
      const errorMessage = this.extractErrorMessage(data, response.status);
      log?.({ type: `${this.constructor.name}.error`, status: response.status, error: data });
      throw new HttpError(errorMessage, response.status, data);
    }

    log?.({ type: `${this.constructor.name}.response`, status: response.status });
    return data as T;
  }

  /**
   * Build URL with query parameters
   */
  protected buildUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    // If path is already a full URL, use it directly
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;

    if (!query) return url;

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        params.append(key, String(value));
      }
    }

    const queryString = params.toString();
    if (!queryString) return url;

    return url.includes('?') ? `${url}&${queryString}` : `${url}?${queryString}`;
  }

  /**
   * Parse response body based on content type
   */
  protected async parseResponse(response: Response): Promise<unknown> {
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    }

    // Return text for other content types
    return response.text();
  }

  /**
   * Extract error message from response data
   */
  protected extractErrorMessage(data: unknown, status: number): string {
    if (data && typeof data === 'object') {
      const obj = data as Record<string, unknown>;
      // Common error response formats
      if (obj.error && typeof obj.error === 'object') {
        const error = obj.error as Record<string, unknown>;
        return String(error.message || error.code || `HTTP ${status}`);
      }
      if (obj.message) return String(obj.message);
      if (obj.error && typeof obj.error === 'string') return obj.error;
    }
    return `HTTP ${status}`;
  }

  // ============= Convenience Methods =============

  protected get<T = unknown>(path: string, log?: LogFunction, options?: Omit<HttpRequestOptions, 'body'>): Promise<T> {
    return this.request<T>('GET', path, log, options);
  }

  protected post<T = unknown>(path: string, log?: LogFunction, options?: HttpRequestOptions): Promise<T> {
    return this.request<T>('POST', path, log, options);
  }

  protected patch<T = unknown>(path: string, log?: LogFunction, options?: HttpRequestOptions): Promise<T> {
    return this.request<T>('PATCH', path, log, options);
  }

  protected put<T = unknown>(path: string, log?: LogFunction, options?: HttpRequestOptions): Promise<T> {
    return this.request<T>('PUT', path, log, options);
  }

  protected delete<T = unknown>(path: string, log?: LogFunction, options?: Omit<HttpRequestOptions, 'body'>): Promise<T> {
    return this.request<T>('DELETE', path, log, options);
  }
}

// ============= Utility Functions =============

/**
 * Extract fields from Power Automate's item/* parameter format
 *
 * Power Automate sends field values as `item/FieldName` keys.
 * This function extracts them into a plain object.
 *
 * @example
 * extractItemFields({ 'item/Title': 'Hello', 'item/Status': 'Active', other: 'value' })
 * // Returns: { Title: 'Hello', Status: 'Active' }
 */
export function extractItemFields(params: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params)) {
    if (key.startsWith('item/')) {
      const fieldName = key.substring(5); // Remove 'item/' prefix
      fields[fieldName] = value;
    }
  }

  return fields;
}

/**
 * Get a parameter value from multiple possible keys (for aliasing)
 *
 * Useful when the same parameter might be named differently in different contexts.
 *
 * @example
 * getParam(inputs, ['entityName', 'entitySetName', 'table'], 'accounts')
 */
export function getParam<T>(
  params: Record<string, unknown>,
  keys: string[],
  defaultValue?: T
): T | undefined {
  for (const key of keys) {
    if (params[key] !== undefined) {
      return params[key] as T;
    }
  }
  return defaultValue;
}

/**
 * Build OData query string from parameters
 *
 * @example
 * buildODataQuery({ filter: "status eq 'active'", top: 10, orderby: 'name' })
 * // Returns: "$filter=status%20eq%20'active'&$top=10&$orderby=name"
 */
export function buildODataQuery(params: {
  filter?: string;
  top?: number;
  skip?: number;
  orderby?: string;
  select?: string;
  expand?: string;
  count?: boolean;
}): string {
  const query: string[] = [];

  if (params.filter) query.push(`$filter=${encodeURIComponent(params.filter)}`);
  if (params.top !== undefined) query.push(`$top=${params.top}`);
  if (params.skip !== undefined) query.push(`$skip=${params.skip}`);
  if (params.orderby) query.push(`$orderby=${encodeURIComponent(params.orderby)}`);
  if (params.select) query.push(`$select=${encodeURIComponent(params.select)}`);
  if (params.expand) query.push(`$expand=${encodeURIComponent(params.expand)}`);
  if (params.count) query.push('$count=true');

  return query.join('&');
}

/**
 * Parse a string that could be comma or semicolon separated, or already an array
 *
 * Useful for email recipients, attendees, etc.
 *
 * @example
 * parseStringList('a@example.com; b@example.com, c@example.com')
 * // Returns: ['a@example.com', 'b@example.com', 'c@example.com']
 */
export function parseStringList(input: string | string[] | undefined): string[] {
  if (!input) return [];
  if (Array.isArray(input)) return input.map(s => s.trim());
  return input.split(/[;,]/).map(s => s.trim()).filter(Boolean);
}

/**
 * Safely encode a URI component, handling undefined/null
 */
export function safeEncode(value: string | undefined | null): string {
  if (value === undefined || value === null) return '';
  return encodeURIComponent(value);
}
