import { App, TFile } from 'obsidian';
import { DrawioSource } from '../model/DrawioSource';

export class FileSource implements DrawioSource {
  constructor(private app: App, private file: TFile) {}
  title(): string { return this.file.basename; }
  key(): string { return this.file.path; }
  async read(): Promise<string> { return this.app.vault.read(this.file); }
  async write(xml: string): Promise<void> { await this.app.vault.modify(this.file, xml); }
}
