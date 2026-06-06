import { describe, it, expect } from 'vitest';
import { decodeEntities, htmlToText, xmlToText, rtfToText, ooxmlParagraphsToText, ooxmlSlideText } from './markup';

describe('markup/decodeEntities', () => {
  it('decodes named + numeric entities', () => {
    expect(decodeEntities('a&amp;b&lt;c&gt;d&quot;e&#39;f&#x2014;g&nbsp;h')).toBe('a&b<c>d"e\'f—g h');
  });
  it('leaves unknown entities intact', () => {
    expect(decodeEntities('x&bogus;y')).toBe('x&bogus;y');
  });
});

describe('markup/htmlToText', () => {
  it('strips tags, drops script/style, decodes entities, and breaks on block elements', () => {
    const html = '<html><head><style>.x{color:red}</style></head><body><h1>Title</h1><p>Hello &amp; welcome</p><script>alert(1)</script><p>Line two</p></body></html>';
    const out = htmlToText(html);
    expect(out).toContain('Title');
    expect(out).toContain('Hello & welcome');
    expect(out).toContain('Line two');
    expect(out).not.toContain('alert');
    expect(out).not.toContain('color:red');
    expect(out.split('\n').length).toBeGreaterThan(1); // block elements produced line breaks
  });
  it('preserves mailto:/href link targets so emails + hosts reach the anonymizer', () => {
    const html = '<a href="mailto:john.smith@customer.com">contact us</a> and <a href="https://db.prod.internal/">portal</a>';
    const out = htmlToText(html);
    expect(out).toContain('john.smith@customer.com');
    expect(out).toContain('db.prod.internal');
  });
});

describe('markup/xmlToText', () => {
  it('strips tags and decodes entities', () => {
    expect(xmlToText('<root><a>one</a><b>two &amp; three</b></root>')).toBe('one two & three');
  });
});

describe('markup/rtfToText', () => {
  it('strips control words/groups and yields plain text', () => {
    const rtf = '{\\rtf1\\ansi\\deff0 {\\fonttbl{\\f0 Arial;}}\\f0\\fs24 Hello\\par World\\par}';
    const out = rtfToText(rtf);
    expect(out).toContain('Hello');
    expect(out).toContain('World');
    expect(out).not.toContain('rtf1');
    expect(out).not.toContain('fonttbl');
  });
  it('decodes hex escapes', () => {
    expect(rtfToText("{\\rtf1 caf\\'e9}")).toContain('café');
  });
  it('removes nested \\pict image groups without leaking hex residue', () => {
    const rtf = '{\\rtf1 before {\\pict{\\*\\blipuid 1234}\\pngblip 89504e470d0a1a0aff}after}';
    const out = rtfToText(rtf);
    expect(out).toContain('before');
    expect(out).toContain('after');
    expect(out).not.toContain('89504e47'); // image hex must not survive into the text
  });
});

describe('markup/ooxml run extraction', () => {
  it('docx: joins <w:t> runs per <w:p> into lines', () => {
    const xml =
      '<w:document><w:body>' +
      '<w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>world</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Second &amp; line</w:t></w:r></w:p>' +
      '</w:body></w:document>';
    expect(ooxmlParagraphsToText(xml)).toBe('Hello world\nSecond & line');
  });
  it('pptx: extracts each <a:t> run as a line', () => {
    const xml = '<p:sld><p:cSld><p:spTree><a:t>Slide title</a:t><a:t>Bullet one</a:t></p:spTree></p:cSld></p:sld>';
    expect(ooxmlSlideText(xml)).toBe('Slide title\nBullet one');
  });
});
