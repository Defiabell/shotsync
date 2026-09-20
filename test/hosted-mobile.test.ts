import { describe, expect, it } from 'vitest';
import worker from '../src/hosted';
import type { HostedEnv } from '../src/hosted/types';

const origin = 'https://shotsync.example.com';
// Public install instructions and icons must work without a session or database.
const publicEnv = {
  PUBLIC_ORIGIN: origin,
  get DB() { throw new Error('Public mobile resources must not consume database quota'); },
} as unknown as HostedEnv;
const request = (path: string, method = 'GET') => worker.fetch(new Request(origin + path, { method }), publicEnv);

describe('hosted mobile entry resources', () => {
  it('serves the mobile guide and manifest without accessing D1 or authentication', async () => {
    const guide = await request('/mobile');
    expect(guide.status).toBe(200);
    expect(guide.headers.get('content-type')).toContain('text/html');
    const html = await guide.text();
    expect(html).toContain('id="copy-mobile-url"');
    expect(html).toContain('id="open-gallery"');
    expect(html).not.toMatch(/serviceWorker|localStorage|sessionStorage/);
    const manifestResponse = await request('/manifest.webmanifest');
    expect(manifestResponse.status).toBe(200);
    expect(manifestResponse.headers.get('content-type')).toContain('manifest');
    const manifest = await manifestResponse.json() as { start_url: string; scope: string; display: string; icons: {src: string}[] };
    expect(manifest).toMatchObject({ start_url: '/', scope: '/', display: 'standalone' });
    expect(manifest.icons.map(icon => icon.src)).toEqual(expect.arrayContaining(['/icons/icon-192.png', '/icons/icon-512.png']));
  });

  it('serves real PNG icons at their advertised sizes', async () => {
    for (const [path, size] of [['/icons/icon-192.png', 192], ['/icons/icon-512.png', 512], ['/icons/apple-touch-icon.png', 180]] as const) {
      const response = await request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(Array.from(bytes.slice(0, 8))).toEqual([137,80,78,71,13,10,26,10]);
      const dimensions = new DataView(bytes.buffer, bytes.byteOffset);
      expect(dimensions.getUint32(16)).toBe(size);
      expect(dimensions.getUint32(20)).toBe(size);
    }
  });

  it('keeps the canonical-origin restriction on public mobile resources', async () => {
    const response = await worker.fetch(new Request('https://other.example.com/mobile'), publicEnv);
    expect(response.status).toBe(421);
  });

  it('supports public HEAD requests without response bodies or quota usage', async () => {
    for (const path of ['/mobile', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png']) {
      const response = await request(path, 'HEAD');
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('');
    }
  });
});
