export interface HttpOptions {
  timeout?: number;
  headers?: Record<string, string>;
}

export interface HttpResult<T = unknown> {
  ok: boolean;
  status?: number;
  data?: T;
  error?: string;
}

function formatError(error: any): string {
  if (error?.name === 'AbortError') {
    return 'request timeout';
  }
  return error?.message || 'request failed';
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function httpGet<T = unknown>(url: string, options: HttpOptions = {}): Promise<HttpResult<T>> {
  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: 'GET',
        headers: options.headers
      },
      options.timeout ?? 10000
    );

    const data = await response.json().catch(() => undefined);
    const ok = response.status >= 200 && response.status < 300;
    return {
      ok,
      status: response.status,
      data: data as T,
      error: ok ? undefined : JSON.stringify(data)
    };
  } catch (error: any) {
    return { ok: false, error: formatError(error) };
  }
}

export async function httpPost<T = unknown>(
  url: string,
  data: unknown,
  options: HttpOptions = {}
): Promise<HttpResult<T>> {
  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {})
        },
        body: JSON.stringify(data ?? {})
      },
      options.timeout ?? 15000
    );

    const payload = await response.json().catch(() => undefined);
    const ok = response.status >= 200 && response.status < 300;
    return {
      ok,
      status: response.status,
      data: payload as T,
      error: ok ? undefined : JSON.stringify(payload)
    };
  } catch (error: any) {
    return { ok: false, error: formatError(error) };
  }
}
