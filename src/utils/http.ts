import { RetryableError, withRetry } from "./retry.js";

export type HttpJsonOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  retries: number;
};

export type HttpJsonResult<T> = {
  data: T;
  status: number;
};

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string
  ) {
    super(message);
  }
}

export async function fetchJson<T>(url: string, options: HttpJsonOptions): Promise<HttpJsonResult<T>> {
  return withRetry(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await fetch(url, {
        method: options.method ?? "GET",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...options.headers
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal
      });

      const text = await response.text();
      if (!response.ok) {
        if ([408, 409, 429, 500, 502, 503, 504].includes(response.status)) {
          throw new RetryableError(`Retryable HTTP ${response.status}: ${text}`);
        }
        throw new HttpError(`HTTP ${response.status}`, response.status, text);
      }

      const data = text ? (JSON.parse(text) as T) : ({} as T);
      return { data, status: response.status };
    } catch (error) {
      if (error instanceof RetryableError || error instanceof HttpError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new RetryableError(`Request timed out after ${options.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }, { retries: options.retries });
}
