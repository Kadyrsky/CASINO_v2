/** Thin fetch wrapper: JWT in the Authorization header (never in URLs), RFC 7807 errors, idempotency keys. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

let tokenProvider: () => string | null = () => null;
let onUnauthorized: () => void = () => {};

export function configureClient(getToken: () => string | null, unauthorized: () => void) {
  tokenProvider = getToken;
  onUnauthorized = unauthorized;
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

interface RequestOptions {
  /** Sends an Idempotency-Key header; pass a stable key to make retries safe. */
  idempotencyKey?: string;
  query?: Record<string, string | number | undefined | null>;
}

export async function api<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = tokenProvider();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

  let url = path;
  if (opts.query) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
    const s = q.toString();
    if (s) url += `?${s}`;
  }

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection.');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const { code, detail, title, ...extra } = (data ?? {}) as Record<string, unknown>;
    if (res.status === 401 && token) onUnauthorized();
    throw new ApiError(res.status, String(code ?? title ?? res.status), String(detail ?? res.statusText), extra);
  }
  return data as T;
}

export const get = <T>(path: string, query?: RequestOptions['query']) => api<T>('GET', path, undefined, { query });
export const post = <T>(path: string, body?: unknown, idempotencyKey?: string) =>
  api<T>('POST', path, body, { idempotencyKey });
export const put = <T>(path: string, body?: unknown) => api<T>('PUT', path, body);
export const del = <T>(path: string) => api<T>('DELETE', path);
