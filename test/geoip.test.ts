import { describe, expect, test } from 'vitest';
import { extractClientIp, lookupGeoIpFromReader } from '../src/geoip.js';

describe('geoip helpers', () => {
  test('extractClientIp prefers first public forwarded address', () => {
    const ip = extractClientIp({
      headers: {
        'x-forwarded-for': '10.0.0.2, 198.51.100.24, 172.16.0.3'
      },
      ip: '127.0.0.1'
    });
    expect(ip).toBe('198.51.100.24');
  });

  test('extractClientIp falls back to request ip when headers are empty', () => {
    const ip = extractClientIp({
      headers: {},
      ip: '203.0.113.7'
    });
    expect(ip).toBe('203.0.113.7');
  });

  test('lookupGeoIpFromReader maps city + region label and coordinates', () => {
    const fakeReader = {
      get(_ip: string) {
        return {
          location: { latitude: 34.8526, longitude: -82.394 },
          city: { names: { en: 'Greenville' } },
          subdivisions: [{ iso_code: 'SC' }],
          country: { iso_code: 'US' }
        };
      }
    };
    const row = lookupGeoIpFromReader(fakeReader, '198.51.100.24');
    expect(row).toEqual({ lat: 34.8526, lng: -82.394, label: 'Greenville, SC' });
  });

  test('lookupGeoIpFromReader returns null on invalid coordinates', () => {
    const fakeReader = {
      get(_ip: string) {
        return {
          location: { latitude: 0, longitude: 0 },
          city: { names: { en: 'Unknown' } }
        };
      }
    };
    const row = lookupGeoIpFromReader(fakeReader, '198.51.100.24');
    expect(row).toBeNull();
  });
});
