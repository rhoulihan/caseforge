// Tests the .msg HTML-body fallback (Change 1: when plain-text body is empty, fall back to
// bodyHtml / html bytes). MsgReader is mocked here so no real .msg fixture is needed.
import { describe, it, expect, vi } from 'vitest';

// This mock returns a MsgData with bodyHtml set but body undefined/empty,
// to exercise the HTML fallback path in msgExtractor.
vi.mock('@kenjiuno/msgreader', () => {
  class FakeMsgReader {
    getFileData() {
      return {
        subject: 'Sizing request',
        body: undefined, // plain-text body absent — Outlook rich-paste scenario
        bodyHtml: '<div>Mongo prod env &ndash; 3 shards (3x3 replica sets). Data size 45.8 TB</div>',
        senderName: 'Alice',
        senderEmail: 'alice@example.com',
        attachments: [],
      };
    }
    getAttachment() {
      return { content: undefined };
    }
  }
  return { default: FakeMsgReader };
});

import MsgReader from '@kenjiuno/msgreader';
import { msgExtractor } from './binary';
import type { TextPrimitive } from './types';

describe('msgExtractor — HTML body fallback (Change 1)', () => {
  it('falls back to bodyHtml when plain body is empty — strips HTML tags and yields text with sizing facts', async () => {
    const prims = await msgExtractor('rich.msg', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]));
    const text = prims.find((p): p is TextPrimitive => p.kind === 'text');
    expect(text).toBeDefined();
    // HTML tags must be stripped; prose content must survive
    expect(text!.text).toContain('3 shards');
    expect(text!.text).toContain('45.8 TB');
    // HTML tags must not appear in the output
    expect(text!.text).not.toContain('<div>');
    expect(text!.text).not.toContain('</div>');
  });

  it('plain-text body still wins when both body and bodyHtml are present', async () => {
    // Override getFileData for this test only to supply BOTH a non-empty plain body AND
    // a different bodyHtml — verifying that plain text takes priority over the HTML fallback.
    const spy = vi.spyOn(
      (MsgReader as unknown as { prototype: { getFileData(): unknown } }).prototype,
      'getFileData',
    ).mockReturnValueOnce({
      subject: 'Sizing request',
      body: 'PLAINTEXT MARKER 3 shards',       // non-empty plain body — must win
      bodyHtml: '<div>HTMLONLY MARKER different content</div>', // HTML present but must lose
      senderName: 'Alice',
      senderEmail: 'alice@example.com',
      attachments: [],
    });

    const prims = await msgExtractor('rich.msg', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]));
    const text = prims.find((p): p is TextPrimitive => p.kind === 'text');
    expect(text).toBeDefined();
    // Plain-text body wins — its marker must appear
    expect(text!.text).toContain('PLAINTEXT MARKER');
    // HTML body must NOT be used — its marker must be absent
    expect(text!.text).not.toContain('HTMLONLY MARKER');

    spy.mockRestore();
  });
});
