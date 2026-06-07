// Tests the .msg IMAGE-attachment extraction. MsgReader is mocked here (its own file) so the real-.msg
// body/keyvalue test in binary.test.ts — which uses a genuine cfb fixture — is unaffected.
import { describe, it, expect, vi } from 'vitest';

// Define the fake inside the factory — vi.mock is hoisted above top-level declarations.
vi.mock('@kenjiuno/msgreader', () => {
  interface FakeAtt {
    fileName?: string;
    extension?: string;
    attachMimeTag?: string;
    innerMsgContent?: boolean;
  }
  class FakeMsgReader {
    // default constructor accepts (and ignores) the ArrayBuffer the real MsgReader takes
    getFileData() {
      return {
        subject: 'Perf review',
        body: 'See the attached charts.',
        senderName: 'Pat',
        senderEmail: 'pat@x.com',
        attachments: [
          { fileName: 'chart.png', extension: '.png', attachMimeTag: 'image/png' },
          { fileName: 'screenshot.jpg', extension: '.jpg' }, // mime via extension fallback
          { fileName: 'notes.txt', extension: '.txt' }, // not an image → skipped
          { innerMsgContent: true, fileName: 'forwarded.msg' }, // embedded email → skipped
        ] as FakeAtt[],
      };
    }
    getAttachment(att: FakeAtt) {
      return { fileName: att.fileName, content: new Uint8Array([1, 2, 3, 4]) };
    }
  }
  return { default: FakeMsgReader };
});

import { msgExtractor } from './binary';
import type { ImagePrimitive, TextPrimitive } from './types';

describe('msgExtractor — image attachments', () => {
  it('emits an ImagePrimitive per image attachment (mime by tag or extension), skipping non-images + embedded .msg', async () => {
    const prims = await msgExtractor('mail.msg', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]));
    const images = prims.filter((p): p is ImagePrimitive => p.kind === 'image');
    expect(images).toHaveLength(2); // chart.png + screenshot.jpg only
    expect(images.map((i) => i.source).sort()).toEqual(['mail.msg#att1-chart.png', 'mail.msg#att2-screenshot.jpg']); // index-prefixed → unique
    expect(images.find((i) => i.source.endsWith('chart.png'))!.mime).toBe('image/png');
    expect(images.find((i) => i.source.endsWith('screenshot.jpg'))!.mime).toBe('image/jpeg'); // extension fallback
    // body text still extracted alongside the images
    expect(prims.some((p) => p.kind === 'text' && (p as TextPrimitive).text.includes('attached charts'))).toBe(true);
  });
});
