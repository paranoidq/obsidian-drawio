import { describe, it, expect, vi } from 'vitest';
import { MarkdownView, TFile, TFolder } from 'obsidian';
import type { MarkdownPostProcessorContext } from 'obsidian';
import { CodeBlockSvgSource } from '../src/codeblock/CodeBlockSvgSource';
import { buildInitialSvg, extractXmlFromSvg } from '../src/model/dualFormat';
import { EMPTY_DIAGRAM } from '../src/constants';
import { DEFAULT_SETTINGS } from '../src/settings';
import type DrawioPlugin from '../src/main';

const XML = '<mxfile><diagram id="0"><mxGraphModel/></diagram></mxfile>';
const uri = (xml = XML) => 'data:image/svg+xml,' + encodeURIComponent(buildInitialSvg(xml));
const block = (body = '') => '```drawio\n' + body + '\n```';

function setup(body = '', initial = '# Note\n' + block(body) + '\nend', sectionStart: number | null = 1) {
  const note = Object.assign(new TFile(), {
    path: 'Notes/Note.md', basename: 'Note', parent: { path: 'Notes' },
  });
  const files = new Map<string, TFile | TFolder>([
    [note.path, note], ['Notes', Object.assign(new TFolder(), { path: 'Notes' })],
  ]);
  const contents = new Map<string, string>([[note.path, initial]]);
  const vault = {
    getAbstractFileByPath: (path: string) => files.get(path) ?? null,
    createFolder: vi.fn(async (path: string) => {
      files.set(path, Object.assign(new TFolder(), { path }));
    }),
    create: vi.fn(async (path: string, data: string) => {
      if (files.has(path)) throw new Error('file exists');
      const file = Object.assign(new TFile(), { path });
      files.set(path, file);
      contents.set(path, data);
      return file;
    }),
    read: vi.fn(async (file: TFile) => contents.get(file.path)!),
    modify: vi.fn(async (file: TFile, data: string) => { contents.set(file.path, data); }),
    process: vi.fn(async (file: TFile, fn: (doc: string) => string) => {
      const next = fn(contents.get(file.path)!);
      contents.set(file.path, next);
      return next;
    }),
  };
  const workspace = {
    getActiveViewOfType: vi.fn((): unknown => null),
    iterateAllLeaves: vi.fn((_cb: (leaf: { view: unknown }) => void) => {}),
  };
  const plugin = {
    settings: { ...DEFAULT_SETTINGS, newDiagramLocation: 'current-subfolder' },
    app: {
      vault, workspace,
      fileManager: { generateMarkdownLink: (file: TFile) => `[[${file.path}]]` },
    },
  } as unknown as DrawioPlugin;
  const ctx = {
    sourcePath: note.path,
    getSectionInfo: () => sectionStart === null ? null : { lineStart: sectionStart },
  } as unknown as MarkdownPostProcessorContext;
  const source = new CodeBlockSvgSource(plugin, ctx, document.createElement('div'), body);
  return { source, note, contents, files, vault, workspace, plugin };
}

describe('CodeBlockSvgSource', () => {
  it('opens an empty marker without modifying the note or creating a file', async () => {
    const { source, vault } = setup();
    expect(await source.read()).toBe(EMPTY_DIAGRAM);
    expect(source.exportFormat()).toBe('xmlsvg');
    expect(vault.create).not.toHaveBeenCalled();
    expect(vault.process).not.toHaveBeenCalled();
  });

  it.each(['drawio', 'dio'])('creates an editable SVG from a %s block and replaces the whole block', async (language) => {
    const { source, contents, note, vault } = setup('', '# Note\n```' + language + '\n\n```\nend');
    await source.writeExport(uri());
    const path = 'Notes/attachments/Note diagram.drawio.svg';
    expect(vault.createFolder).toHaveBeenCalledWith('Notes/attachments');
    expect(extractXmlFromSvg(contents.get(path)!)).toBe(XML);
    expect(contents.get(note.path)).toBe(`# Note\n![[${path}]]\nend`);
    expect(contents.get(note.path)).not.toContain('```');
  });

  it('preserves existing XML and updates the same file on later autosaves', async () => {
    const { source, contents, vault } = setup(XML);
    expect(await source.read()).toBe(XML);
    await source.writeExport(uri());
    const updated = XML.replace('id="0"', 'id="1"');
    await source.writeExport(uri(updated));
    expect(await source.read()).toBe(updated);
    expect(vault.create).toHaveBeenCalledTimes(1);
    expect(vault.process).toHaveBeenCalledTimes(1);
    expect(extractXmlFromSvg(contents.get('Notes/attachments/Note diagram.drawio.svg')!)).toBe(updated);
  });

  it('numbers duplicate filenames without overwriting a diagram', async () => {
    const { source, files, contents } = setup();
    const path = 'Notes/attachments/Note diagram.drawio.svg';
    files.set(path, Object.assign(new TFile(), { path }));
    contents.set(path, 'existing');
    await source.writeExport(uri());
    expect(contents.get(path)).toBe('existing');
    expect(contents.has('Notes/attachments/Note diagram 2.drawio.svg')).toBe(true);
  });

  it('uses section information to replace the clicked one of identical empty blocks', async () => {
    const doc = block() + '\n\n' + block();
    const { source, contents, note } = setup('', doc, 4);
    await source.writeExport(uri());
    expect(contents.get(note.path)).toBe(block() + '\n\n![[Notes/attachments/Note diagram.drawio.svg]]');
  });

  it('preserves CRLF and final-newline state when replacing the block', async () => {
    for (const ending of ['', '\r\n']) {
      const doc = '# Note\r\n' + block().replace(/\n/g, '\r\n') + ending;
      const { source, contents, note } = setup('', doc);
      await source.writeExport(uri());
      expect(contents.get(note.path)).toBe('# Note\r\n![[Notes/attachments/Note diagram.drawio.svg]]' + ending);
    }
  });

  it('does not overwrite a changed or ambiguous note and keeps the exported diagram recoverable', async () => {
    for (const doc of ['# changed', block() + '\n\n' + block()]) {
      const { source, contents, note } = setup('', doc, null);
      await expect(source.writeExport(uri())).rejects.toThrow(/source block changed or is ambiguous/);
      expect(contents.get(note.path)).toBe(doc);
      expect(extractXmlFromSvg(contents.get('Notes/attachments/Note diagram.drawio.svg')!)).toBe(XML);
    }
  });

  it('keeps the note intact if image creation fails', async () => {
    const { source, contents, note, vault } = setup();
    const before = contents.get(note.path);
    vault.create.mockRejectedValue(new Error('disk full'));
    await expect(source.writeExport(uri())).rejects.toThrow('disk full');
    expect(contents.get(note.path)).toBe(before);
    expect(vault.process).not.toHaveBeenCalled();
  });

  it('keeps XML fallbacks in the SVG file instead of writing XML into the note', async () => {
    const { source, contents, note } = setup();
    await source.write(XML);
    expect(contents.get(note.path)).toBe('# Note\n![[Notes/attachments/Note diagram.drawio.svg]]\nend');
    expect(extractXmlFromSvg(contents.get('Notes/attachments/Note diagram.drawio.svg')!)).toBe(XML);
  });

  it('uses the live editor to preserve unsaved note edits and undo history', async () => {
    const { source, contents, note, workspace, vault } = setup();
    let live = '# Unsaved\n\n' + block() + '\nextra';
    const replaceRange = vi.fn((replacement: string, from: { line: number }, to: { line: number }) => {
      const lines = live.split('\n');
      lines.splice(from.line, to.line - from.line + 1, replacement);
      live = lines.join('\n');
    });
    workspace.getActiveViewOfType.mockReturnValue({
      file: note, getMode: () => 'source',
      editor: { getValue: () => live, replaceRange },
    });
    await source.writeExport(uri());
    expect(live).toBe('# Unsaved\n\n![[Notes/attachments/Note diagram.drawio.svg]]\nextra');
    expect(replaceRange).toHaveBeenCalledTimes(1);
    expect(vault.process).not.toHaveBeenCalled();
    expect(contents.get(note.path)).toContain('```drawio'); // Obsidian saves its editor buffer itself.
  });

  it('rejects a parent path outside the selected note folder', async () => {
    const { source, plugin, vault } = setup();
    plugin.settings.newDiagramSubfolder = '../escape';
    await expect(source.writeExport(uri())).rejects.toThrow(/without . or ../);
    expect(vault.create).not.toHaveBeenCalled();
  });

  it('updates an inactive note editor after switching files without losing unsaved text', async () => {
    const { source, note, workspace, vault } = setup();
    let live = '# Unsaved original note\n' + block() + '\nmore unsaved text';
    const view = Object.assign(new MarkdownView({} as never), {
      file: note, getMode: () => 'source',
      editor: {
        getValue: () => live,
        replaceRange: (text: string, from: { line: number }, to: { line: number }) => {
          const lines = live.split('\n');
          lines.splice(from.line, to.line - from.line + 1, text);
          live = lines.join('\n');
        },
      },
    });
    workspace.iterateAllLeaves.mockImplementation((cb) => cb({ view }));
    await source.writeExport(uri());
    expect(live).toBe('# Unsaved original note\n![[Notes/attachments/Note diagram.drawio.svg]]\nmore unsaved text');
    expect(vault.process).not.toHaveBeenCalled();
  });
});
