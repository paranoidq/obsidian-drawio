import { MarkdownPostProcessorContext, MarkdownView, TFile } from 'obsidian';
import { EMPTY_DIAGRAM } from '../constants';
import type { ExportingSource } from '../model/DrawioSource';
import { buildInitialSvg, decodeDataUri, replaceXmlInSvg } from '../model/dualFormat';
import { uniquePath } from '../model/uniquePath';
import { ensureFolderExists, resolveNewDiagramFolder } from '../file/createDiagram';
import type DrawioPlugin from '../main';
import { locateAllDrawioBlocks, type BlockRange } from './locateBlock';

/** A code block becomes a file-backed SVG on its first save. Until then the
 * note stays untouched; cancelling an empty editor creates no blank file.
 * Subsequent saves update only the image, never put XML back into the note. */
export class CodeBlockSvgSource implements ExportingSource {
  private file: TFile | null = null;
  private note: TFile | null = null;
  private linked = false;
  private xml: string;

  constructor(
    private plugin: DrawioPlugin,
    private ctx: MarkdownPostProcessorContext,
    private el: HTMLElement,
    private originalBody: string,
  ) {
    this.xml = originalBody.trim() || EMPTY_DIAGRAM;
  }

  title(): string { return 'Drawio diagram'; }
  key(): string | null { return this.file?.path ?? null; }
  exportFormat(): 'xmlsvg' { return 'xmlsvg'; }

  async read(): Promise<string> {
    this.sourceNote();
    return this.xml;
  }

  async writeExport(uri: string): Promise<void> {
    const svg = new TextDecoder().decode(decodeDataUri(uri));
    // Retain the XML for reopening this edit target, including after conversion.
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const xml = doc.documentElement.getAttribute('content');
    if (doc.documentElement.tagName.toLowerCase() !== 'svg' || !xml?.trim()) {
      throw new Error('Drawio: the exported SVG has no editable diagram data');
    }
    this.xml = xml;
    await this.persist(svg);
  }

  /** The editor's timeout/teardown fallback must also keep XML out of the note. */
  async write(xml: string): Promise<void> {
    this.xml = xml;
    const current = this.file ? await this.plugin.app.vault.read(this.file) : null;
    const svg = current ? replaceXmlInSvg(current, xml) : buildInitialSvg(xml);
    if (!svg) throw new Error('Drawio: the saved diagram is not a valid SVG');
    await this.persist(svg);
  }

  private sourceNote(): TFile {
    if (!this.note) {
      const note = this.plugin.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
      if (!(note instanceof TFile)) throw new Error('Drawio: source note not found');
      this.note = note;
    }
    return this.note;
  }

  private async persist(svg: string): Promise<void> {
    const note = this.sourceNote();
    const { app } = this.plugin;
    const vault = app.vault;
    if (!this.file) {
      const folder = resolveNewDiagramFolder(this.plugin.settings, note.parent?.path ?? null);
      if (!(await ensureFolderExists(this.plugin, folder))) throw new Error('Drawio: could not create diagram folder');
      const path = uniquePath(`${folder ? `${folder}/` : ''}${note.basename} diagram`, '.drawio.svg',
        (p) => vault.getAbstractFileByPath(p) !== null);
      this.file = await vault.create(path, svg);
    } else {
      await vault.modify(this.file, svg);
    }
    if (this.linked) return;
    const link = app.fileManager.generateMarkdownLink(this.file, note.path);
    const embed = link.startsWith('!') ? link : `!${link}`;
    // Prefer the live editor so unsaved note edits and undo history are kept.
    const activeView = app.workspace.getActiveViewOfType(MarkdownView);
    const editors: MarkdownView[] = [];
    app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView && leaf.view.file === note && leaf.view.getMode() === 'source') {
        editors.push(leaf.view);
      }
    });
    // A floating editor may outlive the active tab. An inactive note can still
    // hold unsaved text, so use its live editor before falling back to the vault.
    const view = activeView?.file === note && activeView.getMode() === 'source' ? activeView : editors[0];
    if (view) {
      const lines = view.editor.getValue().split('\n');
      const range = this.blockRange(lines);
      const prefix = /^[ \t]*/.exec(lines[range.start] ?? '')?.[0] ?? '';
      view.editor.replaceRange(prefix + embed,
        { line: range.start, ch: 0 },
        { line: range.end, ch: (lines[range.end] ?? '').replace(/\r$/, '').length });
    } else {
      // process reads the latest contents atomically, including changes made
      // while the export was running. Never overwrite from a stale snapshot.
      await vault.process(note, (doc) => {
        const lines = doc.split('\n');
        const range = this.blockRange(lines);
        const prefix = /^[ \t]*/.exec(lines[range.start] ?? '')?.[0] ?? '';
        const cr = lines[range.end]?.endsWith('\r') ? '\r' : '';
        lines.splice(range.start, range.end - range.start + 1, prefix + embed + cr);
        return lines.join('\n');
      });
    }
    this.linked = true;
  }

  private blockRange(lines: string[]): BlockRange {
    const matches = locateAllDrawioBlocks(lines, this.originalBody);
    const info = this.ctx.getSectionInfo(this.el);
    const range = (info ? matches.find((m) => m.start === info.lineStart) : undefined)
      ?? (matches.length === 1 ? matches[0] : undefined);
    if (!range) {
      throw new Error(`Drawio: the source block changed or is ambiguous. Your diagram is saved in "${this.file?.path}"; insert its embed manually.`);
    }
    return range;
  }
}
