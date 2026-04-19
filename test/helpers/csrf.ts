export function extractCsrfToken(html: string): string {
  const match = String(html ?? '').match(/name="csrfToken"\s+value="([a-f0-9]{64})"/i);
  if (!match?.[1]) throw new Error('CSRF token not found in HTML response');
  return match[1];
}

export async function fetchCsrfToken(app: any, path: string, cookie: string): Promise<string> {
  const res = await app.inject({ method: 'GET', url: path, headers: { cookie } });
  if (res.statusCode !== 200) {
    throw new Error(`Unable to fetch CSRF token from ${path}: status ${res.statusCode}`);
  }
  return extractCsrfToken(String(res.body));
}

export function cookieHeaderFromSetCookie(setCookieHeader: string | string[] | undefined): string {
  if (Array.isArray(setCookieHeader)) {
    return setCookieHeader
      .map((c) => String(c ?? '').split(';')[0])
      .filter(Boolean)
      .join('; ');
  }
  const one = String(setCookieHeader ?? '').split(';')[0];
  return one || '';
}
