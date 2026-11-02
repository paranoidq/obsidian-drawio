import { describe, it, expect } from 'vitest';
import { buildLoadMessage, buildExportMessage, buildConfigureMessage, parseDrawioEvent } from '../src/editor/embedMessages';

describe('embedMessages', () => {
  it('builds a load message with autosave and theme', () => {
    const msg = JSON.parse(buildLoadMessage('<mxfile/>', { dark: true }));
    expect(msg).toEqual({ action: 'load', xml: '<mxfile/>', autosave: 1, modified: 0, dark: true });
  });

  it('builds an export-svg message', () => {
    const msg = JSON.parse(buildExportMessage('svg'));
    expect(msg).toEqual({ action: 'export', format: 'svg', border: 24 });
  });

  it.each(['svg', 'png', 'xmlsvg', 'xmlpng'] as const)('uses the configured margin for %s', (format) => {
    expect(JSON.parse(buildExportMessage(format, 3, 32))).toEqual({
      action: 'export', format, border: 32,
      ...(format === 'png' || format === 'xmlpng' ? { scale: 3 } : {}),
    });
    expect(JSON.parse(buildExportMessage(format, 2, 0)).border).toBe(0);
  });

  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])('falls back to 24 for invalid margin %s', (border) => {
    expect(JSON.parse(buildExportMessage('svg', 2, border)).border).toBe(24);
  });

  it('builds a configure message that disables compression', () => {
    const msg = JSON.parse(buildConfigureMessage());
    expect(msg).toEqual({ action: 'configure', config: { compressXml: false } });
  });

  it('parses an init event', () => {
    expect(parseDrawioEvent(JSON.stringify({ event: 'init' }))).toEqual({ event: 'init' });
  });

  it('parses a save event with xml', () => {
    const parsed = parseDrawioEvent(JSON.stringify({ event: 'save', xml: '<x/>' }));
    expect(parsed).toEqual({ event: 'save', xml: '<x/>' });
  });

  it('returns null for non-drawio / malformed payloads', () => {
    expect(parseDrawioEvent('not json')).toBeNull();
    expect(parseDrawioEvent(JSON.stringify({ foo: 'bar' }))).toBeNull();
  });
});
