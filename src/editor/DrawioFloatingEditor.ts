import { Notice, setIcon } from 'obsidian';
import type { DrawioSource } from '../model/DrawioSource';
import { DrawioEditor, type DrawioEditorDeps } from './DrawioEditor';
import { OfflineEditorNotInstalledError } from '../model/errors';

interface Bounds { x: number; y: number; width: number; height: number }
const GAP = 8;
const HEADER_HEIGHT = 40;
let nextLayer = 0;

/** A non-modal editor owned by the plugin, independent of the active file or
 * rendered embed. Moving/resizing/minimizing never reparents the iframe: doing
 * so reloads drawio and can discard edits before its next autosave. */
export class DrawioFloatingEditor {
  private panel: HTMLElement | null = null;
  private editor: DrawioEditor | null = null;
  private bounds: Bounds;
  private minimized = false;
  private maximized = false;
  private closed = false;
  private stopInteraction: (() => void) | null = null;
  private readonly win: Window;
  private readonly onResize = () => this.applyBounds();
  private readonly onWindowClose = () => this.close();

  constructor(
    private source: DrawioSource,
    private deps: DrawioEditorDeps,
    private onClose: () => void,
    private doc: Document = activeDocument,
  ) {
    this.win = doc.defaultView ?? activeWindow;
    const width = Math.min(1100, this.win.innerWidth * 0.82);
    const height = this.win.innerHeight * 0.82;
    this.bounds = {
      x: (this.win.innerWidth - width) / 2,
      y: (this.win.innerHeight - height) / 2,
      width, height,
    };
  }

  isFor(source: DrawioSource): boolean {
    const key = source.key?.();
    return source === this.source || (!!key && key === this.source.key?.());
  }

  open(): void {
    if (this.closed) return;
    if (this.panel) { this.focus(); return; }
    const layer = this.doc.querySelector<HTMLElement>('.drawio-floating-layer')
      ?? this.doc.body.createDiv({ cls: 'drawio-floating-layer' });
    const panel = this.panel = layer.createDiv({ cls: 'drawio-floating-editor' });
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', `Drawio: ${this.source.title()}`);
    panel.tabIndex = -1;
    // Raise before the title/resize handler creates its drag shield. A bubbling
    // listener would raise the iframe ABOVE that shield and swallow pointerup.
    panel.addEventListener('pointerdown', () => this.bringToFront(), { capture: true });
    panel.addEventListener('focusin', () => this.bringToFront());
    const header = panel.createDiv({ cls: 'drawio-floating-header' });
    header.tabIndex = 0;
    header.setAttribute('aria-label', 'Move diagram editor');
    header.setAttribute('title', 'Drag to move; double-click to maximize or restore');
    header.createDiv({ cls: 'drawio-floating-title', text: this.source.title() });
    const controls = header.createDiv({ cls: 'drawio-floating-controls' });
    const minimize = this.button(controls, 'Minimize diagram editor', 'minus', () => {
      this.minimized = !this.minimized;
      this.setButton(minimize, this.minimized ? 'Restore diagram editor' : 'Minimize diagram editor', this.minimized ? 'chevron-up' : 'minus');
      this.applyBounds();
    });
    const maximize = this.button(controls, 'Maximize diagram editor', 'maximize', () => this.toggleMaximize());
    const updateMaximize = () => this.setButton(maximize, this.maximized ? 'Restore diagram editor size' : 'Maximize diagram editor', this.maximized ? 'minimize' : 'maximize');
    this.button(controls, 'Close diagram editor', 'x', () => this.close());
    header.addEventListener('pointerdown', (ev) => {
      if ((ev.target as Element).closest('button')) return;
      this.startInteraction(ev, 'move');
    });
    header.addEventListener('dblclick', (ev) => {
      if (!(ev.target as Element).closest('button')) this.toggleMaximize();
    });
    header.addEventListener('keydown', (ev) => {
      if (ev.target !== header || this.maximized) return;
      const delta: Record<string, [number, number]> = {
        ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16],
      };
      const step = delta[ev.key];
      if (!step) return;
      ev.preventDefault();
      this.bounds.x += step[0]; this.bounds.y += step[1];
      this.applyBounds();
    });
    const content = panel.createDiv({ cls: 'drawio-floating-content' });
    const resize = panel.createDiv({ cls: 'drawio-floating-resize' });
    resize.setAttribute('title', 'Drag to resize diagram editor');
    resize.addEventListener('pointerdown', (ev) => this.startInteraction(ev, 'resize'));
    // Keep button labels in sync when maximizing from the title bar as well.
    panel.addEventListener('drawio-window-state', () => {
      updateMaximize();
      this.setButton(minimize, this.minimized ? 'Restore diagram editor' : 'Minimize diagram editor', this.minimized ? 'chevron-up' : 'minus');
    });
    this.win.addEventListener('resize', this.onResize);
    this.win.addEventListener('beforeunload', this.onWindowClose);
    this.applyBounds();
    this.focus();
    this.editor = new DrawioEditor(content, this.source, this.deps, { onExit: () => this.close() });
    void this.editor.mount().catch((err: unknown) => {
      if (this.closed) return;
      console.error('[drawio] failed to open editor:', err);
      new Notice(err instanceof OfflineEditorNotInstalledError ? err.message : 'Drawio: failed to open editor — see console', 8000);
      content.createDiv({ cls: 'drawio-error', text: err instanceof Error ? err.message : String(err) });
    });
  }

  focus(): void {
    this.minimized = false;
    this.applyBounds();
    this.bringToFront();
    this.panel?.focus();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopInteraction?.();
    this.win.removeEventListener('resize', this.onResize);
    this.win.removeEventListener('beforeunload', this.onWindowClose);
    this.editor?.destroy();
    this.editor = null;
    const layer = this.panel?.parentElement;
    this.panel?.remove();
    this.panel = null;
    if (layer && !layer.childElementCount) layer.remove();
    this.onClose();
  }

  private bringToFront(): void {
    // A focus event during a gesture must not overtake its full-window shield.
    if (this.panel && !this.stopInteraction) this.panel.style.zIndex = String(++nextLayer);
  }

  private toggleMaximize(): void {
    this.minimized = false;
    this.maximized = !this.maximized;
    this.applyBounds();
  }

  private displayBounds(): Bounds {
    const maxWidth = Math.max(1, this.win.innerWidth - 2 * GAP);
    const maxHeight = Math.max(1, this.win.innerHeight - 2 * GAP);
    const width = this.maximized && !this.minimized ? maxWidth
      : Math.min(maxWidth, this.minimized ? 380 : Math.max(480, this.bounds.width));
    const height = this.minimized ? Math.min(HEADER_HEIGHT, maxHeight)
      : this.maximized ? maxHeight : Math.min(maxHeight, Math.max(320, this.bounds.height));
    return {
      x: this.maximized && !this.minimized ? GAP : Math.max(GAP, Math.min(this.bounds.x, this.win.innerWidth - width - GAP)),
      y: this.maximized && !this.minimized ? GAP : Math.max(GAP, Math.min(this.bounds.y, this.win.innerHeight - height - GAP)),
      width, height,
    };
  }

  private applyBounds(): void {
    if (!this.panel) return;
    const rect = this.displayBounds();
    Object.assign(this.panel.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    this.panel.classList.toggle('is-minimized', this.minimized);
    this.panel.classList.toggle('is-maximized', this.maximized);
    this.panel.dispatchEvent(new Event('drawio-window-state'));
  }

  private startInteraction(ev: PointerEvent, kind: 'move' | 'resize'): void {
    if (ev.button !== 0 || (this.maximized && !this.minimized) || (kind === 'resize' && this.minimized)) return;
    ev.preventDefault();
    this.stopInteraction?.();
    this.bringToFront();
    const rect = this.displayBounds();
    const startX = ev.clientX, startY = ev.clientY;
    // This transparent shield receives pointer events even over the cross-origin
    // iframe, so dragging never stalls at the edge of drawio's content.
    const shield = this.panel!.parentElement!.createDiv({ cls: 'drawio-floating-shield' });
    shield.style.zIndex = String(++nextLayer);
    shield.style.cursor = kind === 'move' ? 'grabbing' : 'nwse-resize';
    const captureTarget = ev.currentTarget as HTMLElement;
    let stopped = false;
    const move = (event: PointerEvent) => {
      if (event.pointerId !== ev.pointerId) return;
      // Recover even when the release happened outside the window or was lost:
      // never move/resize on the first hover event after the button is released.
      if ((event.buttons & 1) === 0) { stop(); return; }
      if (kind === 'move') {
        this.bounds.x = rect.x + event.clientX - startX;
        this.bounds.y = rect.y + event.clientY - startY;
      } else {
        this.bounds = { ...rect, width: rect.width + event.clientX - startX, height: rect.height + event.clientY - startY };
      }
      this.applyBounds();
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      this.win.removeEventListener('pointermove', move, true);
      this.win.removeEventListener('pointerup', end, true);
      this.win.removeEventListener('pointercancel', end, true);
      this.win.removeEventListener('mouseup', mouseUp, true);
      this.win.removeEventListener('blur', stop);
      this.doc.removeEventListener('visibilitychange', visibilityChange);
      captureTarget.removeEventListener('lostpointercapture', end);
      try {
        if (captureTarget.hasPointerCapture?.(ev.pointerId)) captureTarget.releasePointerCapture(ev.pointerId);
      } catch { /* The browser may already have released a cancelled pointer. */ }
      shield.remove();
      this.stopInteraction = null;
    };
    const end = (event: PointerEvent) => { if (event.pointerId === ev.pointerId) stop(); };
    const mouseUp = (event: MouseEvent) => {
      if (ev.pointerType !== 'touch' && event.button === 0) stop();
    };
    const visibilityChange = () => { if (this.doc.hidden) stop(); };
    // Window capture sees the release before other plugins can stop propagation.
    this.win.addEventListener('pointermove', move, true);
    this.win.addEventListener('pointerup', end, true);
    this.win.addEventListener('pointercancel', end, true);
    this.win.addEventListener('mouseup', mouseUp, true);
    this.win.addEventListener('blur', stop);
    this.doc.addEventListener('visibilitychange', visibilityChange);
    captureTarget.addEventListener('lostpointercapture', end);
    this.stopInteraction = stop;
    try {
      // Keep pointer events in the parent document across the cross-origin iframe
      // and window boundaries. The shield and buttons check cover older hosts.
      captureTarget.setPointerCapture?.(ev.pointerId);
    } catch { /* Synthetic events and inactive pointers cannot be captured. */ }
  }

  private button(parent: HTMLElement, label: string, icon: string, action: () => void): HTMLButtonElement {
    const button = parent.createEl('button', { cls: 'drawio-floating-button' });
    button.type = 'button';
    this.setButton(button, label, icon);
    button.addEventListener('click', action);
    return button;
  }

  private setButton(button: HTMLButtonElement, label: string, icon: string): void {
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
    setIcon(button, icon);
  }
}
