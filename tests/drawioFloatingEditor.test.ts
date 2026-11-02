import { afterEach, describe, expect, it, vi } from 'vitest';
import { DrawioFloatingEditor } from '../src/editor/DrawioFloatingEditor';
import type { DrawioEditorDeps } from '../src/editor/DrawioEditor';
import type { DrawioSource, ExportingSource } from '../src/model/DrawioSource';
import DrawioPlugin from '../src/main';

const ORIGIN = 'http://127.0.0.1:1234';
const opened: DrawioFloatingEditor[] = [];
const originalWidth = window.innerWidth, originalHeight = window.innerHeight;

function source(key = 'test.drawio.svg'): DrawioSource {
  return { key: () => key, title: () => 'Test diagram', read: async () => '<mxfile/>', write: vi.fn(async () => {}) };
}

function deps(): DrawioEditorDeps {
  return {
    resolveBaseUrl: async () => ORIGIN + '/index.html',
    isDark: () => false, showLibraries: () => true,
    acquireServer: vi.fn(), releaseServer: vi.fn(),
  };
}

async function flush() { await new Promise((resolve) => window.setTimeout(resolve, 0)); }

async function open(editSource = source(), dependencies = deps()) {
  const closed = vi.fn();
  const editor = new DrawioFloatingEditor(editSource, dependencies, closed);
  opened.push(editor);
  editor.open();
  await flush();
  const panel = document.querySelector<HTMLElement>('.drawio-floating-editor:last-child')!;
  const iframe = panel.querySelector('iframe')!;
  return { editor, panel, iframe, closed, dependencies };
}

function click(panel: HTMLElement, label: string) {
  panel.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click();
}

function pointer(target: EventTarget, type: string, x: number, y: number, id = 1,
  buttons = type === 'pointerup' || type === 'pointercancel' ? 0 : 1) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, buttons, clientX: x, clientY: y });
  Object.defineProperty(event, 'pointerId', { value: id });
  Object.defineProperty(event, 'pointerType', { value: 'mouse' });
  target.dispatchEvent(event);
}

function reply(iframe: HTMLIFrameElement, data: unknown) {
  window.dispatchEvent(new MessageEvent('message', {
    data: JSON.stringify(data), origin: ORIGIN, source: iframe.contentWindow,
  }));
}

afterEach(() => {
  for (const editor of opened.splice(0)) editor.close();
  document.querySelectorAll('.test-file-button').forEach((el) => el.remove());
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight });
  vi.restoreAllMocks();
});

describe('DrawioFloatingEditor', () => {
  it('keeps the editor and autosave alive after clicking a workspace file or pressing Escape', async () => {
    const writeExport = vi.fn(async () => {});
    const editSource: ExportingSource = { ...source(), exportFormat: () => 'xmlsvg', writeExport };
    const { panel, iframe, closed } = await open(editSource);
    const contentWindow = iframe.contentWindow;
    const fileButton = document.body.createEl('button', { cls: 'test-file-button' });
    fileButton.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panel.isConnected).toBe(true);
    expect(panel.getAttribute('aria-modal')).toBe('false');
    expect(iframe.contentWindow).toBe(contentWindow);
    expect(closed).not.toHaveBeenCalled();
    reply(iframe, { event: 'autosave', xml: '<updated/>' });
    reply(iframe, { event: 'export', data: 'svg-image' });
    await flush();
    expect(writeExport).toHaveBeenCalledWith('svg-image');
  });

  it('drags by the title bar over the iframe without remounting the editor', async () => {
    const { panel, iframe, dependencies } = await open();
    const beforeX = parseFloat(panel.style.left), beforeY = parseFloat(panel.style.top);
    pointer(panel.querySelector('.drawio-floating-header')!, 'pointerdown', 100, 100);
    expect(document.querySelector('.drawio-floating-shield')).not.toBeNull();
    pointer(document, 'pointermove', 130, 140);
    pointer(document, 'pointerup', 130, 140);
    expect(parseFloat(panel.style.left)).toBeCloseTo(beforeX + 30);
    expect(parseFloat(panel.style.top)).toBeCloseTo(beforeY + 40);
    expect(panel.querySelector('iframe')).toBe(iframe);
    expect(dependencies.acquireServer).toHaveBeenCalledTimes(1);
    expect(dependencies.releaseServer).not.toHaveBeenCalled();
    expect(document.querySelector('.drawio-floating-shield')).toBeNull();
  });

  it('resizes with the bottom-right handle and keeps the same iframe', async () => {
    const { panel, iframe } = await open();
    const width = parseFloat(panel.style.width), height = parseFloat(panel.style.height);
    pointer(panel.querySelector('.drawio-floating-resize')!, 'pointerdown', 200, 200);
    pointer(document, 'pointermove', 230, 225);
    pointer(document, 'pointerup', 230, 225);
    expect(parseFloat(panel.style.width)).toBeCloseTo(width + 30);
    expect(parseFloat(panel.style.height)).toBeCloseTo(height + 25);
    expect(panel.querySelector('iframe')).toBe(iframe);
  });

  it('keeps the title bar reachable when dragging off-screen or the viewport shrinks', async () => {
    const { panel } = await open();
    pointer(panel.querySelector('.drawio-floating-header')!, 'pointerdown', 100, 100);
    pointer(document, 'pointermove', -5000, -5000);
    pointer(document, 'pointerup', -5000, -5000);
    expect(panel.style.left).toBe('8px');
    expect(panel.style.top).toBe('8px');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 250 });
    window.dispatchEvent(new Event('resize'));
    expect(panel.style.width).toBe('384px');
    expect(panel.style.height).toBe('234px');
  });

  it('minimizes and restores without unloading drawio or losing its iframe', async () => {
    const { panel, iframe, editor, dependencies } = await open();
    const height = panel.style.height;
    click(panel, 'Minimize diagram editor');
    expect(panel.classList.contains('is-minimized')).toBe(true);
    expect(panel.style.height).toBe('40px');
    expect(panel.querySelector('iframe')).toBe(iframe);
    editor.focus();
    expect(panel.classList.contains('is-minimized')).toBe(false);
    expect(panel.style.height).toBe(height);
    expect(dependencies.releaseServer).not.toHaveBeenCalled();
  });

  it('maximizes and restores the previous position and size', async () => {
    const { panel, iframe } = await open();
    const bounds = [panel.style.left, panel.style.top, panel.style.width, panel.style.height];
    click(panel, 'Maximize diagram editor');
    expect(panel.style.width).toBe(`${window.innerWidth - 16}px`);
    expect(panel.style.left).toBe('8px');
    panel.querySelector('.drawio-floating-header')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect([panel.style.left, panel.style.top, panel.style.width, panel.style.height]).toEqual(bounds);
    expect(panel.querySelector('iframe')).toBe(iframe);
  });

  it('does not start dragging when pressing a window control', async () => {
    const { panel } = await open();
    pointer(panel.querySelector('button')!, 'pointerdown', 100, 100);
    expect(document.querySelector('.drawio-floating-shield')).toBeNull();
  });

  it.each(['move', 'resize'] as const)('keeps the %s shield above the iframe even after pointerdown bubbles and focus changes', async (kind) => {
    const { panel } = await open();
    const target = panel.querySelector(kind === 'move' ? '.drawio-floating-title' : '.drawio-floating-resize')!;
    pointer(target, 'pointerdown', 100, 100);
    const shield = document.querySelector<HTMLElement>('.drawio-floating-shield')!;
    panel.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(Number(shield.style.zIndex)).toBeGreaterThan(Number(panel.style.zIndex));
    pointer(shield, 'pointerup', 100, 100);
    expect(shield.isConnected).toBe(false);
  });

  it.each(['move', 'resize'] as const)('stops %s before updating geometry if pointerup was missed and the left button is no longer down', async (kind) => {
    const { panel } = await open();
    const target = panel.querySelector(kind === 'move' ? '.drawio-floating-header' : '.drawio-floating-resize')!;
    pointer(target, 'pointerdown', 100, 100);
    pointer(document, 'pointermove', 120, 120);
    const bounds = panel.style.cssText;
    pointer(document, 'pointermove', 180, 160, 1, 0);
    expect(panel.style.cssText).toBe(bounds);
    expect(document.querySelector('.drawio-floating-shield')).toBeNull();
    pointer(document, 'pointermove', 200, 200);
    expect(panel.style.cssText).toBe(bounds);
  });

  it('observes mouse release before a competing handler stops propagation', async () => {
    const { panel } = await open();
    pointer(panel.querySelector('.drawio-floating-header')!, 'pointerdown', 100, 100);
    const shield = document.querySelector<HTMLElement>('.drawio-floating-shield')!;
    shield.addEventListener('pointerup', (event) => event.stopImmediatePropagation());
    pointer(shield, 'pointerup', 120, 120);
    expect(document.querySelector('.drawio-floating-shield')).toBeNull();
  });

  it('captures the pointer, stops on capture loss, and releases capture on ordinary mouseup', async () => {
    const { panel } = await open();
    const header = panel.querySelector<HTMLElement>('.drawio-floating-header')!;
    const capture = vi.fn();
    const release = vi.fn();
    header.setPointerCapture = capture;
    header.hasPointerCapture = () => true;
    header.releasePointerCapture = release;
    pointer(header, 'pointerdown', 100, 100);
    expect(capture).toHaveBeenCalledWith(1);
    pointer(header, 'lostpointercapture', 100, 100);
    expect(document.querySelector('.drawio-floating-shield')).toBeNull();
    pointer(header, 'pointerdown', 100, 100);
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    expect(document.querySelector('.drawio-floating-shield')).toBeNull();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('ends dragging when a pointer is cancelled or the app loses focus', async () => {
    const { panel } = await open();
    const header = panel.querySelector('.drawio-floating-header')!;
    pointer(header, 'pointerdown', 100, 100);
    pointer(document, 'pointercancel', 100, 100);
    expect(document.querySelector('.drawio-floating-shield')).toBeNull();
    pointer(header, 'pointerdown', 100, 100);
    window.dispatchEvent(new Event('blur'));
    const left = panel.style.left;
    pointer(document, 'pointermove', 200, 100);
    expect(panel.style.left).toBe(left);
    expect(document.querySelector('.drawio-floating-shield')).toBeNull();
  });

  it('ignores another pointer during a drag', async () => {
    const { panel } = await open();
    const before = panel.style.left;
    pointer(panel.querySelector('.drawio-floating-header')!, 'pointerdown', 100, 100);
    pointer(document, 'pointermove', 200, 100, 2);
    pointer(document, 'pointerup', 200, 100, 2);
    expect(panel.style.left).toBe(before);
    expect(document.querySelector('.drawio-floating-shield')).not.toBeNull();
    pointer(document, 'pointerup', 100, 100);
  });

  it('closes explicitly and cleans up the editor, drag shield, and event listeners', async () => {
    const { panel, closed, dependencies } = await open();
    const remove = vi.spyOn(window, 'removeEventListener');
    pointer(panel.querySelector('.drawio-floating-header')!, 'pointerdown', 100, 100);
    click(panel, 'Close diagram editor');
    expect(panel.isConnected).toBe(false);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(dependencies.releaseServer).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.drawio-floating-layer')).toBeNull();
    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
  });

  it('closes when drawio sends an explicit exit', async () => {
    const { panel, iframe, closed } = await open();
    reply(iframe, { event: 'exit' });
    expect(panel.isConnected).toBe(false);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('does not mount a late-resolving iframe after the window has closed', async () => {
    let resolve!: (url: string) => void;
    const dependencies = { ...deps(), resolveBaseUrl: () => new Promise<string>((r) => { resolve = r; }) };
    const { editor, panel } = await open(source(), dependencies);
    editor.close();
    resolve(ORIGIN);
    await flush();
    expect(panel.querySelector('iframe')).toBeNull();
    expect(dependencies.acquireServer).not.toHaveBeenCalled();
  });

  it('reuses an open SVG editor when clicking the same file, and closes all windows on plugin unload', async () => {
    const plugin = new DrawioPlugin({} as never, {} as never);
    const dependencies = deps();
    plugin.editorDeps = () => dependencies;
    plugin.openEditor(source());
    await flush();
    const panel = document.querySelector<HTMLElement>('.drawio-floating-editor')!;
    click(panel, 'Minimize diagram editor');
    plugin.openEditor(source());
    expect(document.querySelectorAll('.drawio-floating-editor')).toHaveLength(1);
    expect(panel.classList.contains('is-minimized')).toBe(false);
    plugin.openEditor(source('another.drawio.svg'));
    await flush();
    expect(document.querySelectorAll('.drawio-floating-editor')).toHaveLength(2);
    plugin.onunload();
    expect(document.querySelector('.drawio-floating-layer')).toBeNull();
    expect(dependencies.releaseServer).toHaveBeenCalledTimes(2);
  });
});
