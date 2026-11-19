export const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || ''
).replace(/\/+$/, '');

export function apiUrl(path: string): string {
  if (!path) return path;
  if (/^https?:\/\//i.test(path)) return path;
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE_URL}${normalized}`;
}

export async function parseApiResponse<T = Record<string, unknown>>(
  res: Response
): Promise<T> {
  const rawText = await res.text();
  const trimmed = rawText.trim();

  if (!trimmed) {
    if (!res.ok) {
      throw new Error(`Server returned empty response (HTTP ${res.status}).`);
    }
    return {} as T;
  }

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    if (trimmed.startsWith('<')) {
      if (res.status === 403) {
        throw new Error(
          'Access denied (HTTP 403). Please reload from your authorized AI Studio preview or deployed app URL.'
        );
      }
      if (res.status === 200 || res.status === 404) {
        throw new Error(
          'API returned HTML instead of JSON. Ensure the Express backend server is running, or set VITE_API_BASE_URL if hosting the frontend separately (e.g., Netlify).'
        );
      }
      throw new Error(
        `Server returned an HTML error page (HTTP ${res.status}). Please retry in a moment.`
      );
    }
    throw new Error(
      `Invalid server response (HTTP ${res.status}): ${trimmed.slice(0, 140)}`
    );
  }
}

export async function downloadFileFromUrl(
  url: string,
  filename: string
): Promise<void> {
  const res = await fetch(apiUrl(url), { credentials: 'same-origin' });
  if (!res.ok) {
    throw new Error(`Download failed (HTTP ${res.status}).`);
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
