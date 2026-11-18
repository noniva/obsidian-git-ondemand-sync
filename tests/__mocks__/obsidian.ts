export const Platform = {
  isMobile: false,
  isDesktop: true,
  isIosApp: false,
  isAndroidApp: false,
};

export class Notice {
  message: string;
  timeout?: number;

  constructor(message: string, timeout?: number) {
    this.message = message;
    this.timeout = timeout;
  }
}

export class MarkdownRenderChild {
  containerEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    this.containerEl = containerEl;
  }

  onload(): void {}
  onunload(): void {}
}

export class Plugin {
  app: unknown;
  manifest: unknown;

  async loadData(): Promise<unknown> {
    return null;
  }

  async saveData(_data: unknown): Promise<void> {}

  addCommand(_command: unknown): unknown {
    return _command;
  }

  addRibbonIcon(_icon: string, _title: string, _cb: () => unknown): unknown {
    return {};
  }

  addSettingTab(_tab: unknown): void {}

  registerMarkdownPostProcessor(_processor: unknown): void {}

  registerEditorExtension(_ext: unknown): void {}

  registerEvent(_eventRef: unknown): void {}
}

export class PluginSettingTab {
  app: unknown;
  plugin: Plugin;
  containerEl: HTMLElement;

  constructor(app: unknown, plugin: Plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = {} as HTMLElement;
  }

  display(): void {}
  hide(): void {}
}

export class Setting {
  constructor(_containerEl: HTMLElement) {}
  setName(_name: string): this {
    return this;
  }
  setDesc(_desc: string): this {
    return this;
  }
  addText(_cb: (text: unknown) => unknown): this {
    return this;
  }
  addToggle(_cb: (toggle: unknown) => unknown): this {
    return this;
  }
  addButton(_cb: (button: unknown) => unknown): this {
    return this;
  }
}

export class TAbstractFile {
  path = '';
  name = '';
}

export class TFile extends TAbstractFile {
  extension = '';
  basename = '';
}

export class TFolder extends TAbstractFile {}

export class MarkdownView {
  editor: unknown = null;
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
}

export async function requestUrl(_request: unknown): Promise<{
  status: number;
  text: string;
  arrayBuffer: ArrayBuffer;
  json: unknown;
  headers: Record<string, string>;
}> {
  throw new Error('requestUrl mock not implemented');
}
