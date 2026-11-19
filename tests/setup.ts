type DomCreateOptions = string | {
  cls?: string | string[];
  text?: string;
  attr?: Record<string, string | number | boolean | null>;
  type?: string;
  href?: string;
  title?: string;
  value?: string;
};

function applyDomCreateOptions(el: HTMLElement, options?: DomCreateOptions): void {
  if (!options) return;
  if (typeof options === 'string') {
    el.className = options;
    return;
  }
  if (options.cls) {
    const classes = Array.isArray(options.cls) ? options.cls : options.cls.split(/\s+/);
    for (const c of classes) {
      if (c) el.classList.add(c);
    }
  }
  if (options.text !== undefined) {
    el.textContent = options.text;
  }
  if (options.attr) {
    for (const [key, val] of Object.entries(options.attr)) {
      if (val === null || val === false) continue;
      el.setAttribute(key, val === true ? '' : String(val));
    }
  }
  if (options.type !== undefined) {
    (el as HTMLInputElement).type = options.type;
  }
  if (options.href !== undefined) {
    (el as HTMLAnchorElement).href = options.href;
  }
  if (options.title !== undefined) {
    el.title = options.title;
  }
  if (options.value !== undefined) {
    (el as HTMLInputElement).value = options.value;
  }
}

if (typeof globalThis.window === 'undefined') {
  (globalThis as Record<string, unknown>).window = globalThis;
}

if (typeof Node !== 'undefined' && !('instanceOf' in Node.prototype)) {
  Object.defineProperty(Node.prototype, 'instanceOf', {
    value: function <T extends Node>(ctor: new (...args: never[]) => T): boolean {
      return this instanceof ctor;
    },
    configurable: true,
    writable: true,
  });
}

if (typeof document !== 'undefined' && typeof HTMLElement !== 'undefined') {
  if (!('createEl' in HTMLElement.prototype)) {
    Object.defineProperty(HTMLElement.prototype, 'createEl', {
      value: function <K extends keyof HTMLElementTagNameMap>(
        this: HTMLElement,
        tag: K,
        options?: DomCreateOptions,
      ): HTMLElementTagNameMap[K] {
        const child = document.createElement(tag);
        applyDomCreateOptions(child, options);
        this.appendChild(child);
        return child;
      },
      configurable: true,
      writable: true,
    });
  }
  if (!('createDiv' in HTMLElement.prototype)) {
    Object.defineProperty(HTMLElement.prototype, 'createDiv', {
      value: function (this: HTMLElement, options?: DomCreateOptions): HTMLDivElement {
        const child = document.createElement('div');
        applyDomCreateOptions(child, options);
        this.appendChild(child);
        return child;
      },
      configurable: true,
      writable: true,
    });
  }
  if (!('createSpan' in HTMLElement.prototype)) {
    Object.defineProperty(HTMLElement.prototype, 'createSpan', {
      value: function (this: HTMLElement, options?: DomCreateOptions): HTMLSpanElement {
        const child = document.createElement('span');
        applyDomCreateOptions(child, options);
        this.appendChild(child);
        return child;
      },
      configurable: true,
      writable: true,
    });
  }

  const g = globalThis as Record<string, unknown>;
  if (typeof g.createEl !== 'function') {
    g.createEl = <K extends keyof HTMLElementTagNameMap>(
      tag: K,
      options?: DomCreateOptions,
    ): HTMLElementTagNameMap[K] => {
      const el = document.createElement(tag);
      applyDomCreateOptions(el, options);
      return el;
    };
  }
  if (typeof g.createDiv !== 'function') {
    g.createDiv = (options?: DomCreateOptions): HTMLDivElement => {
      const el = document.createElement('div');
      applyDomCreateOptions(el, options);
      return el;
    };
  }
  if (typeof g.createSpan !== 'function') {
    g.createSpan = (options?: DomCreateOptions): HTMLSpanElement => {
      const el = document.createElement('span');
      applyDomCreateOptions(el, options);
      return el;
    };
  }
}
