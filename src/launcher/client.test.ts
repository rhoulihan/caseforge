import { describe, it, expect } from 'vitest';
import { LauncherClient, LauncherError } from './client';
import type { LauncherTransport, LauncherResponse } from './transport';
import type { MapEntry } from '../anon/mapping';

function resp(status: number, body: unknown): LauncherResponse {
  return { status, json: async () => body };
}

class MockTransport implements LauncherTransport {
  posts: { path: string; body: unknown }[] = [];
  gets: string[] = [];
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
