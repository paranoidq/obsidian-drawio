import { describe, it, expect } from 'vitest';
import { locateAllDrawioBlocks, locateDrawioBlock, locateDrawioBlockAtLine } from '../src/codeblock/locateBlock';

const split = (s: string) => s.split('\n');

describe('locateDrawioBlock', () => {
  it.each(['```dio', '~~~dio   '])('recognizes %s for content lookup and cursor-based conversion', (opening) => {
    const lines = ['# t', opening, '<mxfile/>', opening.slice(0, 3), 'end'];
    expect(locateDrawioBlock(lines, '<mxfile/>')).toEqual({ start: 1, end: 3 });
    expect(locateDrawioBlockAtLine(lines, 2)).toEqual({ start: 1, end: 3 });
  });

  it('identifies matching blocks across both aliases without accepting similar language names', () => {
    const lines = ['```drawio', 'A', '```', '```dio', 'A', '```', '```diode', 'A', '```'];
    expect(locateAllDrawioBlocks(lines, 'A')).toEqual([{ start: 0, end: 2 }, { start: 3, end: 5 }]);
  });

  it('locates a single block by body content', () => {
    const doc = ['# t', '```drawio', '<mxfile>A</mxfile>', '```', 'end'].join('\n');
    expect(locateDrawioBlock(split(doc), '<mxfile>A</mxfile>')).toEqual({ start: 1, end: 3 });
  });

  it('returns null when no block matches', () => {
    const doc = ['```drawio', '<mxfile>A</mxfile>', '```'].join('\n');
    expect(locateDrawioBlock(split(doc), '<mxfile>NOPE</mxfile>')).toBeNull();
  });

  it('disambiguates among multiple blocks by content', () => {
    const doc = ['```drawio', 'AAA', '```', '', '```drawio', 'BBB', '```'].join('\n');
    expect(locateDrawioBlock(split(doc), 'BBB')).toEqual({ start: 4, end: 6 });
  });

  it('matches ignoring surrounding whitespace in body', () => {
    const doc = ['```drawio', '  <mxfile>A</mxfile>  ', '```'].join('\n');
    expect(locateDrawioBlock(split(doc), '<mxfile>A</mxfile>')).toEqual({ start: 0, end: 2 });
  });

  it('handles a multi-line body', () => {
    const doc = ['```drawio', '<mxfile>', '  <diagram/>', '</mxfile>', '```'].join('\n');
    const body = '<mxfile>\n  <diagram/>\n</mxfile>';
    expect(locateDrawioBlock(split(doc), body)).toEqual({ start: 0, end: 4 });
  });

  it('supports tilde fences and language with trailing spaces', () => {
    const doc = ['~~~drawio   ', 'XYZ', '~~~'].join('\n');
    expect(locateDrawioBlock(split(doc), 'XYZ')).toEqual({ start: 0, end: 2 });
  });
});
