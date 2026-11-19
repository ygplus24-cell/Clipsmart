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
      if (status === 403) {
        throw new Error(
          'Access denied (HTTP 403). Please reload from your authorized AI Studio preview or deployed app URL.'
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
