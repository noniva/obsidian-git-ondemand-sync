import { StateEffect, StateField } from '@codemirror/state';

export const Platform = {
  isMobile: false,
  isDesktop: true,
  isIosApp: false,
  isAndroidApp: false,
};

export const setEditorLivePreviewEffect = StateEffect.define<boolean>();
export const editorLivePreviewField = StateField.define<boolean>({
  create: () => true,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setEditorLivePreviewEffect)) {
        return effect.value;
      }
    }
    return value;
  },
});

export interface MockMarkdownFileInfo {
  file: { path: string } | null;
}

export const setEditorInfoEffect = StateEffect.define<MockMarkdownFileInfo>();
export const editorInfoField = StateField.define<MockMarkdownFileInfo>({
  create: () => ({ file: null }),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setEditorInfoEffect)) {
        return effect.value;
      }
    }
    return value;
  },
});

export class Notice {
  message: string;
  timeout?: number;
  messageEl: HTMLElement;
  noticeEl: HTMLElement;
  hidden = false;

  constructor(message: string | DocumentFragment, timeout?: number) {
    this.message = typeof message === 'string' ? message : (message.textContent ?? '');
    this.timeout = timeout;
    if (typeof document !== 'undefined') {
      const el = document.createElement('div');
      if (typeof message === 'string') {
        el.textContent = message;
      } else {
        el.appendChild(message);
      }
      this.messageEl = el;
      this.noticeEl = el;
    } else {
      this.messageEl = {} as HTMLElement;
      this.noticeEl = this.messageEl;
    }
  }

  setMessage(message: string | DocumentFragment): this {
    this.message = typeof message === 'string' ? message : (message.textContent ?? '');
    if (typeof document !== 'undefined') {
      if (typeof message === 'string') {
        this.messageEl.textContent = message;
      } else {
        this.messageEl.replaceChildren(message);
      }
    }
    return this;
  }

  hide(): void {
    this.hidden = true;
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
  private mockData: unknown = null;

  constructor(app?: unknown, manifest?: unknown) {
    this.app = app;
    this.manifest = manifest;
  }

  async loadData(): Promise<unknown> {
    return this.mockData;
  }

  async saveData(data: unknown): Promise<void> {
    this.mockData = data;
  }

  addCommand(_command: unknown): unknown {
    return _command;
  }

  addRibbonIcon(_icon: string, _title: string, _cb: () => unknown): unknown {
    return {};
  }

  addStatusBarItem(): HTMLElement {
    if (typeof document !== 'undefined') {
      return document.createElement('div');
    }
    return { textContent: '' } as unknown as HTMLElement;
  }

  addSettingTab(_tab: unknown): void {}

  registerMarkdownPostProcessor(_processor: unknown): void {}

  registerEditorExtension(_ext: unknown): void {}

  registerEvent(_eventRef: unknown): void {}
}

export class PluginSettingTab {
  app: unknown;
  plugin: Plugin;
  containerEl: HTMLElement & { empty: () => void };

  constructor(app: unknown, plugin: Plugin) {
    this.app = app;
    this.plugin = plugin;
    if (typeof document !== 'undefined') {
      const el = document.createElement('div') as HTMLElement & { empty: () => void };
      el.empty = () => {
        el.replaceChildren();
      };
      this.containerEl = el;
    } else {
      this.containerEl = { empty: () => {} } as unknown as HTMLElement & { empty: () => void };
    }
  }

  display(): void {}
  hide(): void {}
}

class MockTextComponent {
  inputEl: HTMLInputElement;

  constructor(containerEl: HTMLElement) {
    this.inputEl = document.createElement('input');
    this.inputEl.type = 'text';
    containerEl.appendChild(this.inputEl);
  }

  setPlaceholder(placeholder: string): this {
    this.inputEl.placeholder = placeholder;
    return this;
  }

  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }

  getValue(): string {
    return this.inputEl.value;
  }

  onChange(cb: (value: string) => unknown): this {
    this.inputEl.addEventListener('input', () => {
      void cb(this.inputEl.value);
    });
    return this;
  }
}

class MockToggleComponent {
  toggleEl: HTMLElement;
  private checkboxEl: HTMLInputElement;

  constructor(containerEl: HTMLElement) {
    this.toggleEl = document.createElement('div');
    this.toggleEl.className = 'checkbox-container';
    this.checkboxEl = document.createElement('input');
    this.checkboxEl.type = 'checkbox';
    this.toggleEl.appendChild(this.checkboxEl);
    containerEl.appendChild(this.toggleEl);
  }

  setValue(on: boolean): this {
    this.checkboxEl.checked = on;
    this.toggleEl.classList.toggle('is-enabled', on);
    return this;
  }

  getValue(): boolean {
    return this.checkboxEl.checked;
  }

  setDisabled(disabled: boolean): this {
    this.checkboxEl.disabled = disabled;
    return this;
  }

  onChange(cb: (value: boolean) => unknown): this {
    this.checkboxEl.addEventListener('change', () => {
      this.toggleEl.classList.toggle('is-enabled', this.checkboxEl.checked);
      void cb(this.checkboxEl.checked);
    });
    return this;
  }
}

class MockButtonComponent {
  buttonEl: HTMLButtonElement;

  constructor(containerEl: HTMLElement) {
    this.buttonEl = document.createElement('button');
    this.buttonEl.type = 'button';
    containerEl.appendChild(this.buttonEl);
  }

  setButtonText(name: string): this {
    this.buttonEl.textContent = name;
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.buttonEl.disabled = disabled;
    return this;
  }

  onClick(cb: () => unknown): this {
    this.buttonEl.addEventListener('click', () => {
      void cb();
    });
    return this;
  }
}

export class Setting {
  settingEl: HTMLElement;
  infoEl: HTMLElement;
  nameEl: HTMLElement;
  descEl: HTMLElement;
  controlEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    if (typeof document === 'undefined') {
      this.settingEl = {} as HTMLElement;
      this.infoEl = {} as HTMLElement;
      this.nameEl = {} as HTMLElement;
      this.descEl = {} as HTMLElement;
      this.controlEl = {} as HTMLElement;
      return;
    }

    this.settingEl = document.createElement('div');
    this.settingEl.className = 'setting-item';
    this.infoEl = document.createElement('div');
    this.infoEl.className = 'setting-item-info';
    this.nameEl = document.createElement('div');
    this.nameEl.className = 'setting-item-name';
    this.descEl = document.createElement('div');
    this.descEl.className = 'setting-item-description';
    this.controlEl = document.createElement('div');
    this.controlEl.className = 'setting-item-control';

    this.infoEl.append(this.nameEl, this.descEl);
    this.settingEl.append(this.infoEl, this.controlEl);
    if (typeof containerEl?.appendChild === 'function') {
      containerEl.appendChild(this.settingEl);
    }
  }

  setName(name: string): this {
    this.nameEl.textContent = name;
    return this;
  }

  setDesc(desc: string): this {
    this.descEl.textContent = desc;
    return this;
  }

  addText(cb: (text: MockTextComponent) => unknown): this {
    if (typeof document !== 'undefined') {
      cb(new MockTextComponent(this.controlEl));
    }
    return this;
  }

  addToggle(cb: (toggle: MockToggleComponent) => unknown): this {
    if (typeof document !== 'undefined') {
      cb(new MockToggleComponent(this.controlEl));
    }
    return this;
  }

  addButton(cb: (button: MockButtonComponent) => unknown): this {
    if (typeof document !== 'undefined') {
      cb(new MockButtonComponent(this.controlEl));
    }
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

export function setIcon(parent: HTMLElement, iconId: string): void {
  if (parent?.dataset) {
    parent.dataset.icon = iconId;
  }
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
