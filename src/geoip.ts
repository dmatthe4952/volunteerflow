import fs from 'node:fs';
import net from 'node:net';
import maxmind from 'maxmind';

export type GeoIpApproxLocation = {
  lat: number;
  lng: number;
  label: string;
};

type MaxMindReaderLike = {
  get(ip: string): any;
};

function stripPortFromIp(raw: string): string {
  const v = String(raw ?? '').trim();
  if (!v) return '';
  const bracketed = v.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed?.[1]) return bracketed[1];
  if (v.includes(':') && net.isIP(v) === 6) return v;
  const ipv4WithPort = v.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/);
  if (ipv4WithPort?.[1]) return ipv4WithPort[1];
  return v;
}

function isPrivateOrLocalIp(ip: string): boolean {
  if (net.isIP(ip) === 4) {
    const p = ip.split('.').map((x) => Number(x));
    if (p.length !== 4 || p.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true;
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    return false;
  }

  if (net.isIP(ip) === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (normalized.startsWith('fe80')) return true;
    return false;
  }

  return true;
}

function readHeaderIpCandidates(req: any): string[] {
  const h = req?.headers ?? {};
  const direct = [
    typeof h['cf-connecting-ip'] === 'string' ? h['cf-connecting-ip'] : '',
    typeof h['x-real-ip'] === 'string' ? h['x-real-ip'] : ''
  ]
    .map((v) => stripPortFromIp(v))
    .filter(Boolean);

  const xffRaw = typeof h['x-forwarded-for'] === 'string' ? h['x-forwarded-for'] : '';
  const xff = xffRaw
    .split(',')
    .map((v) => stripPortFromIp(v))
    .filter(Boolean);

  const reqIp = stripPortFromIp(String(req?.ip ?? ''));
  const all = [...direct, ...xff, reqIp].filter(Boolean);
  return Array.from(new Set(all));
}

export function extractClientIp(req: any): string | null {
  const candidates = readHeaderIpCandidates(req).filter((v) => net.isIP(v) !== 0);
  if (!candidates.length) return null;

  const firstPublic = candidates.find((ip) => !isPrivateOrLocalIp(ip));
  return firstPublic ?? candidates[0] ?? null;
}

function toShortRegionCode(input: unknown): string {
  const v = String(input ?? '').trim();
  if (!v) return '';
  const up = v.toUpperCase();
  return up.length <= 3 ? up : v;
}

export function lookupGeoIpFromReader(reader: MaxMindReaderLike, ip: string): GeoIpApproxLocation | null {
  const row = reader.get(ip) as any;
  if (!row) return null;

  const lat = Number(row?.location?.latitude);
  const lng = Number(row?.location?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (Math.abs(lat) < 0.000001 && Math.abs(lng) < 0.000001) return null;

  const city = String(row?.city?.names?.en ?? '').trim();
  const region = toShortRegionCode(row?.subdivisions?.[0]?.iso_code || row?.subdivisions?.[0]?.names?.en);
  const country = toShortRegionCode(row?.country?.iso_code);
  const label = city && region ? `${city}, ${region}` : city || region || country || 'your area';

  return { lat, lng, label };
}

export function createGeoIpLookup(params: { dbPath: string; log?: (line: string, err?: unknown) => void }) {
  let readerPromise: Promise<MaxMindReaderLike | null> | null = null;

  async function loadReader(): Promise<MaxMindReaderLike | null> {
    const path = String(params.dbPath ?? '').trim();
    if (!path) return null;
    if (!fs.existsSync(path)) return null;
    try {
      return await maxmind.open(path);
    } catch (err) {
      params.log?.('geolite2 open failed', err);
      return null;
    }
  }

  async function getReader(): Promise<MaxMindReaderLike | null> {
    if (!readerPromise) readerPromise = loadReader();
    return await readerPromise;
  }

  return {
    async lookup(req: any): Promise<GeoIpApproxLocation | null> {
      const ip = extractClientIp(req);
      if (!ip) return null;
      const reader = await getReader();
      if (!reader) return null;
      try {
        return lookupGeoIpFromReader(reader, ip);
      } catch (err) {
        params.log?.('geolite2 lookup failed', err);
        return null;
      }
    }
  };
}
