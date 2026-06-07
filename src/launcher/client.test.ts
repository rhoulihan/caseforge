import { describe, it, expect } from 'vitest';
import { LauncherClient, LauncherError } from './client';
import type { LauncherTransport, LauncherResponse, BinaryResponse } from './transport';
import type { MapEntry } from '../anon/mapping';

function resp(status: number, body: unknown): LauncherResponse {
  return { status, json: async () => body };
}

class MockTransport implements LauncherTransport {
  posts: { path: string; body: unknown }[] = [];
  gets: string[] = [];
  puts: { path: string; bytes: Uint8Array }[] = [];
  binGets: string[] = [];
  dels: string[] = [];
  putImpl: (path: string, bytes: Uint8Array) => Promise<LauncherResponse> = async () => resp(200, { ok: true });
  getBytesImpl: (path: string) => Promise<BinaryResponse> = async () => ({ status: 200, bytes: async () => new Uint8Array() });
  delImpl: (path: string) => Promise<LauncherResponse> = async () => resp(200, { ok: true });
  constructor(
    private readonly postImpl: (path: string, body: unknown) => Promise<LauncherResponse>,
    private readonly getImpl: (path: string) => Promise<LauncherResponse> = async () => resp(200, { status: 'ok' }),
  ) {}
  async post(path: string, body: unknown): Promise<LauncherResponse> {
    this.posts.push({ path, body });
    return this.postImpl(path, body);
  }
  async get(path: string): Promise<LauncherResponse> {
    this.gets.push(path);
    return this.getImpl(path);
  }
  async putBinary(path: string, bytes: Uint8Array): Promise<LauncherResponse> {
    this.puts.push({ path, bytes });
    return this.putImpl(path, bytes);
  }
  async getBytes(path: string): Promise<BinaryResponse> {
    this.binGets.push(path);
    return this.getBytesImpl(path);
  }
  async del(path: string): Promise<LauncherResponse> {
    this.dels.push(path);
    return this.delImpl(path);
  }
}

const ENTRIES: MapEntry[] = [{ phrase: 'Acme Mutual', slug: 'CF_ORG_01' }];

describe('LauncherClient', () => {
  it('anonymize posts the buildMap TSV + text and returns {text,count}', async () => {
    const t = new MockTransport(async () => resp(200, { text: 'hello CF_ORG_01', count: 1 }));
    const client = new LauncherClient(t);
    const out = await client.anonymize(ENTRIES, 'hello Acme Mutual');
    expect(out).toEqual({ text: 'hello CF_ORG_01', count: 1 });
    expect(t.posts[0]!.path).toBe('/anonymize');
    const body = t.posts[0]!.body as { map: string; text: string };
    expect(body.text).toBe('hello Acme Mutual');
    expect(body.map).toContain('CF_ORG_01'); // serialized via buildMap (variant-expanded TSV)
    expect(body.map).toContain('\t');
  });

  it('deanonymize hits /deanonymize', async () => {
    const t = new MockTransport(async () => resp(200, { text: 'hi Acme Mutual', count: 1 }));
    await new LauncherClient(t).deanonymize(ENTRIES, 'hi CF_ORG_01');
    expect(t.posts[0]!.path).toBe('/deanonymize');
  });

  it('throws a typed LauncherError carrying the endpoint error code', async () => {
    const t = new MockTransport(async () => resp(400, { error: 'slug already present', code: 'slug_conflict' }));
    await expect(new LauncherClient(t).anonymize(ENTRIES, 'x')).rejects.toMatchObject({ name: 'LauncherError', code: 'slug_conflict' });
  });

  it('wraps a transport/network failure as LauncherError', async () => {
    const t = new MockTransport(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(new LauncherClient(t).anonymize(ENTRIES, 'x')).rejects.toBeInstanceOf(LauncherError);
  });

  it('rejects a malformed 200 body', async () => {
    const t = new MockTransport(async () => resp(200, { nope: true }));
    await expect(new LauncherClient(t).anonymize(ENTRIES, 'x')).rejects.toThrow(/malformed/);
  });

  it('health is true on {status:ok}, false on non-200 or throw', async () => {
    expect(await new LauncherClient(new MockTransport(async () => resp(200, {}), async () => resp(200, { status: 'ok' }))).health()).toBe(true);
    expect(await new LauncherClient(new MockTransport(async () => resp(200, {}), async () => resp(503, {}))).health()).toBe(false);
    expect(
      await new LauncherClient(
        new MockTransport(
          async () => resp(200, {}),
          async () => {
            throw new Error('down');
          },
        ),
      ).health(),
    ).toBe(false);
  });
});

describe('LauncherClient — archives', () => {
  it('saveArchive PUTs the zip bytes under /archive/{caseId}', async () => {
    const t = new MockTransport(async () => resp(200, {}));
    await new LauncherClient(t).saveArchive('northwind-abc', new Uint8Array([1, 2, 3]));
    expect(t.puts[0]!.path).toBe('/archive/northwind-abc');
    expect([...t.puts[0]!.bytes]).toEqual([1, 2, 3]);
  });

  it('saveArchive throws a typed LauncherError carrying the launcher code', async () => {
    const t = new MockTransport(async () => resp(200, {}));
    t.putImpl = async () => resp(400, { error: 'not a case archive', code: 'bad_archive' });
    await expect(new LauncherClient(t).saveArchive('x', new Uint8Array())).rejects.toMatchObject({ name: 'LauncherError', code: 'bad_archive' });
  });

  it('listArchives returns manifest rows and rejects a non-array body', async () => {
    const rows = [{ caseId: 'a', companyName: 'A', provider: 'claude', status: 'generated', createdAt: '', updatedAt: '', currentVersion: '001' }];
    const ok = new MockTransport(async () => resp(200, {}), async (p) => (p === '/archives' ? resp(200, rows) : resp(200, { status: 'ok' })));
    expect((await new LauncherClient(ok).listArchives())[0]!.caseId).toBe('a');
    const bad = new MockTransport(async () => resp(200, {}), async () => resp(200, { nope: true }));
    await expect(new LauncherClient(bad).listArchives()).rejects.toThrow(/malformed/);
  });

  it('loadArchive returns the raw bytes (and throws on 404)', async () => {
    const t = new MockTransport(async () => resp(200, {}));
    t.getBytesImpl = async () => ({ status: 200, bytes: async () => new Uint8Array([9, 9, 9]) });
    expect([...(await new LauncherClient(t).loadArchive('x'))]).toEqual([9, 9, 9]);
    expect(t.binGets[0]).toBe('/archive/x');
    const missing = new MockTransport(async () => resp(200, {}));
    missing.getBytesImpl = async () => ({ status: 404, bytes: async () => new Uint8Array() });
    await expect(new LauncherClient(missing).loadArchive('missing')).rejects.toBeInstanceOf(LauncherError);
    // a JSON error body on the binary path surfaces its code/message
    const errBody = new MockTransport(async () => resp(200, {}));
    errBody.getBytesImpl = async () => ({ status: 400, bytes: async () => new TextEncoder().encode(JSON.stringify({ error: 'nope', code: 'bad_archive' })) });
    await expect(new LauncherClient(errBody).loadArchive('x')).rejects.toMatchObject({ name: 'LauncherError', code: 'bad_archive' });
  });

  it('deleteArchive DELETEs /archive/{caseId}', async () => {
    const t = new MockTransport(async () => resp(200, {}));
    await new LauncherClient(t).deleteArchive('x');
    expect(t.dels[0]).toBe('/archive/x');
  });
});
