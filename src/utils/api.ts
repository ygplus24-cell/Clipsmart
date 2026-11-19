const rawApiBase = (import.meta.env.VITE_API_BASE_URL || '')
  .trim()
  .replace(/\/+$/, '');

export const API_BASE_URL = rawApiBase.endsWith('/api')
  ? rawApiBase.slice(0, -4)
  : rawApiBase;

export function apiUrl(path: string): string {
  if (!path) return path;
  if (/^https?:\/\//i.test(path)) return path;
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE_URL}${normalized}`;
}

export class ServerWarmupError extends Error {
  constructor(
    message = 'Studio backend server is still starting up. Retrying automatically...'
  ) {
    super(message);
    this.name = 'ServerWarmupError';
  }
}

export function isServerWarmupHtml(html: string): boolean {
  return /<title>\s*Starting Server/i.test(html) || /__aistudio_warmup|warmup/i.test(html);
}

export function parseRawApiText<T = Record<string, unknown>>(
  rawText: string,
  status: number,
  ok = status >= 200 && status < 300
): T {
  const trimmed = rawText.trim();

  if (!trimmed) {
    if (!ok) {
      throw new Error(`Server returned empty response (HTTP ${status}).`);
    }
    return {} as T;
  }

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    if (trimmed.startsWith('<')) {
      if (isServerWarmupHtml(trimmed) || status === 502 || status === 503 || status === 504) {
        throw new ServerWarmupError();
      }
      if (status === 403) {
        throw new Error(
          'Access denied (HTTP 403). Please reload from your authorized AI Studio preview or deployed app URL.'
        );
      }
      if (/accounts\.google\.com|ServiceLogin|Sign in - Google/i.test(trimmed)) {
        throw new Error(
          'Session authentication required to access the backend API. Open the app from your authorized AI Studio preview URL.'
        );
      }
      if (status === 200 || status === 404) {
        throw new Error(
          'API returned HTML instead of JSON. Ensure the Express backend server is running, or set VITE_API_BASE_URL if hosting the frontend separately (e.g., Netlify).'
        );
      }
      throw new Error(
        `Server returned an HTML error page (HTTP ${status}). Please retry in a moment.`
      );
    }
    throw new Error(
      `Invalid server response (HTTP ${status}): ${trimmed.slice(0, 140)}`
    );
  }
}

export async function parseApiResponse<T = Record<string, unknown>>(
  res: Response
): Promise<T> {
  const rawText = await res.text();
  return parseRawApiText<T>(rawText, res.status, res.ok);
}

export async function fetchApiWithWarmupRetry(
  path: string,
  init?: RequestInit,
  maxAttempts = 5,
  delayMs = 1500
): Promise<{ res: Response; rawText: string }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(apiUrl(path), init);
      const rawText = await res.text();
      const trimmed = rawText.trim();
      const isWarmup =
        (trimmed.startsWith('<') && isServerWarmupHtml(trimmed)) ||
        res.status === 502 ||
        res.status === 503 ||
        res.status === 504;

      if (isWarmup && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      return { res, rawText };
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new ServerWarmupError('Could not connect to the Express backend server.');
}

export async function downloadFileFromUrl(
  url: string,
  filename: string
): Promise<void> {
  const res = await fetch(apiUrl(url), { credentials: 'same-origin' });
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (!res.ok) {
    throw new Error(`Download failed (HTTP ${res.status}).`);
  }
  if (contentType.includes('text/html')) {
    throw new Error(
      'API returned HTML instead of a file download. Ensure the Express backend server is running, or set VITE_API_BASE_URL if hosting the frontend separately (e.g., Netlify).'
    );
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
}
