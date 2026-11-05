import { runInNewContext } from 'node:vm';
import type * as vscode from 'vscode';

/** Small event source used by the real composer host through the VS Code alias. */
export class EventEmitter<T> {
  private readonly listeners = new Set<(value: T) => unknown>();
  readonly event: vscode.Event<T> = (listener, thisArgs: unknown, disposables) => {
    const callback = (value: T): unknown => listener.call(thisArgs, value);
    this.listeners.add(callback);
    const disposable = { dispose: (): void => { this.listeners.delete(callback); } };
    disposables?.push(disposable);
    return disposable;
  };

  /** Deliver an event in registration order. */
  fire(value: T): void {
    for (const listener of this.listeners) listener(value);
  }

  /** Release all subscriptions when the host or panel closes. */
  dispose(): void {
    this.listeners.clear();
  }
}

interface BrowserEvent {
  readonly data?: unknown;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly key?: string;
  readonly isComposing?: boolean;
  preventDefault(): void;
}

/** Minimal form control sufficient to execute the production webview script. */
export class FakeElement {
  value = '';
  textContent = '';
  disabled = false;
  hidden = false;
  selectionStart = 0;
  selectionEnd = 0;
  focusCount = 0;
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, ((event: BrowserEvent) => void)[]>();

  /** Remember the handlers registered by the actual composer webview. */
  addEventListener(type: string, listener: (event: BrowserEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  /** Count focus changes so automatic selection updates cannot steal focus. */
  focus(): void {
    this.focusCount += 1;
  }

  /** Retain accessibility state used by the mode buttons. */
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  /** Support the caret preservation performed by slash-mode handling. */
  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  /** Dispatch a browser event without allowing clicks on disabled controls. */
  fire(type: string, event: Partial<BrowserEvent> = {}): void {
    if (this.disabled) return;
    for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault(): void {}, ...event });
  }
}

/** Run the real self-contained webview JavaScript against simple browser controls. */
export class FakeBrowser {
  readonly elements = new Map<string, FakeElement>();
  readonly outgoing: unknown[] = [];
  state: unknown;
  private readonly messages = new EventEmitter<BrowserEvent>();

  constructor(html: string, receive: (value: unknown) => void) {
    for (const match of html.matchAll(/\bid="([^"]+)"/gu)) {
      if (match[1] !== undefined) this.elements.set(match[1], new FakeElement());
    }
    const modes = ['ask', 'implement', 'summarize'].map((mode) => {
      const element = new FakeElement();
      element.dataset['mode'] = mode;
      return element;
    });
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/u.exec(html)?.[1];
    if (script === undefined) throw new Error('The composer did not render its browser script.');
    runInNewContext(script, {
      acquireVsCodeApi: () => ({
        postMessage: (value: unknown): void => {
          this.outgoing.push(value);
          queueMicrotask(() => receive(value));
        },
        setState: (value: unknown): void => { this.state = value; },
      }),
      document: {
        getElementById: (id: string) => this.element(id),
        querySelectorAll: () => modes,
      },
      navigator: { platform: 'MacIntel' },
      window: {
        addEventListener: (type: string, listener: (event: BrowserEvent) => unknown): void => {
          if (type === 'message') this.messages.event(listener);
        },
      },
    });
  }

  /** Return a concrete rendered control, failing clearly for changed markup. */
  element(id: string): FakeElement {
    const element = this.elements.get(id);
    if (element === undefined) throw new Error(`No rendered composer element: ${id}`);
    return element;
  }

  /** Deliver an extension-host message to the production browser handler. */
  receive(data: unknown): void {
    this.messages.fire({ data, preventDefault(): void {} });
  }

  /** Enter text and let the real input handler persist and interpret it. */
  type(text: string): void {
    const input = this.element('feedback');
    if (input.disabled) throw new Error('The composer input is disabled.');
    input.value = text;
    input.setSelectionRange(text.length, text.length);
    input.fire('input');
  }
}

/** Simulated panel exposing only the lifecycle and browser boundary under test. */
export class FakePanel {
  readonly sent: unknown[] = [];
  readonly revealCalls: { readonly column: number | undefined; readonly preserveFocus: boolean | undefined }[] = [];
  readonly viewColumn = 2;
  disposed = false;
  browser: FakeBrowser | undefined;
  private readonly received = new EventEmitter<unknown>();
  private readonly closed = new EventEmitter<void>();
  readonly onDidDispose = this.closed.event;
  visible = true;
  readonly viewStates = new EventEmitter<{ readonly webviewPanel: FakePanel }>();
  readonly onDidChangeViewState = this.viewStates.event;
  readonly webview = {
    html: '',
    asWebviewUri: (uri: vscode.Uri): vscode.Uri => uri,
    onDidReceiveMessage: this.received.event,
    postMessage: async (message: unknown): Promise<boolean> => {
      if (this.disposed) return false;
      this.sent.push(message);
      this.browser?.receive(message);
      return true;
    },
  };

  /** Execute the real browser script only after extension initialization. */
  startBrowser(): FakeBrowser {
    this.browser = new FakeBrowser(this.webview.html, (message) => this.receive(message));
    return this.browser;
  }

  /** Send an untrusted webview message to the real host receiver. */
  receive(message: unknown): void {
    this.received.fire(message);
  }

  /** Record explicit reveals separately from selection-follow updates. */
  reveal(column?: number, preserveFocus?: boolean): void {
    this.revealCalls.push({ column, preserveFocus });
  }

  /** Close once, matching the lifecycle event used by the host. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closed.fire();
    this.closed.dispose();
  }
}

/** URI values needed by real document navigation without accessing the filesystem. */
export class Uri {
  private constructor(
    readonly scheme: string,
    readonly path: string,
    readonly query = '',
    readonly authority = '',
    readonly fragment = '',
  ) {}

  /** Create a project file resource without interpreting path characters as URI syntax. */
  static file(path: string): Uri { return new Uri('file', path); }

  /** Parse externally opened links so tests can verify the exact publication target. */
  static parse(value: string): Uri {
    const url = new URL(value);
    return new Uri(url.protocol.slice(0, -1), url.pathname, url.search.slice(1), url.host, url.hash.slice(1));
  }

  /** Build extension-owned asset URIs without depending on a real extension install. */
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, `${base.path}/${segments.join('/')}`);
  }

  /** Create a readonly preview resource from explicit components. */
  static from(components: { readonly scheme: string; readonly path?: string; readonly query?: string; readonly authority?: string; readonly fragment?: string }): Uri {
    return new Uri(components.scheme, components.path ?? '', components.query, components.authority, components.fragment);
  }

  /** Retain a consistent document identity across document-provider registration. */
  toString(): string {
    return `${this.scheme}://${this.authority}${this.path}${this.query === '' ? '' : `?${this.query}`}${this.fragment === '' ? '' : `#${this.fragment}`}`;
  }

  /** Expose the local path only for file-oriented test assertions. */
  get fsPath(): string { return this.path; }
}

/** Preserve the actual editor range selected by production content matching. */
export class Range {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };

  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
  constructor(start: Range['start'], end: Range['end']);
  constructor(start: number | Range['start'], end: number | Range['end'], endLine?: number, endCharacter?: number) {
    this.start = typeof start === 'number' ? { line: start, character: Number(end) } : start;
    this.end = typeof end === 'number' ? { line: endLine ?? 0, character: endCharacter ?? 0 } : end;
  }

  /** Represent caret-only input consistently with VS Code selection events. */
  get isEmpty(): boolean { return this.start.line === this.end.line && this.start.character === this.end.character; }
}

/** Selection coordinates used by explicit native comment creation. */
export class Selection extends Range {}

/** Carry rendered Markdown and its command trust boundary through real navigation. */
export class MarkdownString {
  isTrusted: boolean | { readonly enabledCommands: readonly string[] } | undefined;
  supportThemeIcons: boolean | undefined;
  supportHtml: boolean | undefined;

  constructor(public value = '') {}

  /** Keep text-only tree tooltips available for assertions. */
  appendText(text: string): MarkdownString { this.value += text; return this; }
}

/** In-memory document preserving unsaved source separately from immutable previews. */
export class FakeTextDocument {
  isDirty = false;
  version = 1;

  constructor(readonly uri: Uri, public text: string, public languageId = 'plaintext', readonly isReadonly = false) {}

  /** Return the current in-memory source, including unsaved editor changes. */
  getText(range?: Range): string {
    return range === undefined ? this.text : this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
  }

  /** Count physical source lines, including an empty last line. */
  get lineCount(): number { return this.text.split('\n').length; }

  /** Return source content needed for full-line native selections. */
  lineAt(line: number): { readonly text: string } { return { text: this.text.split('\n')[line] ?? '' }; }

  /** Convert editor coordinates into offsets for immutable source capture. */
  offsetAt(position: Range['start']): number {
    const lines = this.text.split('\n');
    return lines.slice(0, position.line).reduce((length, line) => length + line.length + 1, 0)
      + Math.min(position.character, lines[position.line]?.length ?? 0);
  }

  /** Convert tracked offsets back to live editor coordinates. */
  positionAt(offset: number): Range['start'] {
    const lines = this.text.slice(0, offset).split('\n');
    return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
  }

  /** Clamp the production selection to real line lengths as the editor would. */
  validateRange(range: Range): Range {
    const lines = this.text.replaceAll('\r\n', '\n').split('\n');
    const startLine = Math.max(0, Math.min(range.start.line, lines.length - 1));
    const endLine = Math.max(startLine, Math.min(range.end.line, lines.length - 1));
    return new Range(startLine, Math.min(range.start.character, lines[startLine]?.length ?? 0), endLine, Math.min(range.end.character, lines[endLine]?.length ?? 0));
  }
}

interface FakeTextEditor {
  readonly document: FakeTextDocument;
  readonly viewColumn?: number;
}

/** Native editor surface for controller tests with observable selection decoration. */
export class FakeInteractiveEditor implements FakeTextEditor {
  selection = new Selection(0, 0, 0, 0);
  readonly decorations: unknown[][] = [];
  readonly revealed: Range[] = [];

  constructor(readonly document: FakeTextDocument, readonly viewColumn = 1) {}

  /** Record persistent review highlights independently of text focus. */
  setDecorations(_decoration: unknown, ranges: unknown[]): void { this.decorations.push(ranges); }

  /** Record navigation without editing source. */
  revealRange(range: Range): void { this.revealed.push(range); }
}

/** Simple lifecycle callback matching native editor disposables. */
export class Disposable {
  constructor(private readonly callback: () => void) {}
  dispose(): void { this.callback(); }
  static from(...items: readonly { dispose(): void }[]): Disposable {
    return new Disposable(() => { for (const item of items) item.dispose(); });
  }
}

/** Theme-aware values remain opaque in controller tests. */
export class ThemeColor { constructor(readonly id: string) {} }
export class ThemeIcon {
  static readonly File = new ThemeIcon('file');
  static readonly Folder = new ThemeIcon('folder');
  constructor(readonly id: string, readonly color?: ThemeColor) {}
}
/** A glob under a folder, kept for watchers in tests. */
export class RelativePattern { constructor(readonly base: string, readonly pattern: string) {} }

/** File watcher whose events tests fire by hand. */
export class FakeFileSystemWatcher {
  readonly created = new EventEmitter<Uri>();
  readonly changed = new EventEmitter<Uri>();
  readonly deleted = new EventEmitter<Uri>();
  readonly onDidCreate = this.created.event;
  readonly onDidChange = this.changed.event;
  readonly onDidDelete = this.deleted.event;
  disposed = false;
  constructor(readonly pattern: RelativePattern) {}
  dispose(): void { this.disposed = true; }
}

export class FileDecoration { constructor(readonly badge?: string, readonly tooltip?: string, readonly color?: ThemeColor) {} }

/** Sidebar entry supporting the metadata created by the real controller. */
export class TreeItem {
  id?: string;
  description?: string;
  contextValue?: string;
  iconPath?: unknown;
  command?: unknown;
  tooltip?: unknown;
  checkboxState?: number;
  resourceUri?: unknown;
  constructor(readonly label: string, readonly collapsibleState: number) {}
}

/** Observe native thread identity and assignment, including unnecessary comment redraws. */
export class FakeCommentThread {
  disposed = false;
  commentsWrites = 0;
  collapsibleState = 0;
  canReply: boolean | { name: string } = true;
  contextValue: string | undefined;
  state: number | undefined;
  label: string | undefined;
  private rendered: readonly vscode.Comment[];

  constructor(readonly uri: Uri, public range: Range, comments: readonly vscode.Comment[]) { this.rendered = comments; }
  get comments(): readonly vscode.Comment[] { return this.rendered; }
  set comments(value: readonly vscode.Comment[]) { this.commentsWrites += 1; this.rendered = value; }
  dispose(): void { this.disposed = true; }
}

/** Native controller recording threads created by the production command handlers. */
export class FakeCommentController {
  readonly threads: FakeCommentThread[] = [];
  options: unknown;
  commentingRangeProvider: unknown;
  createCommentThread(uri: Uri, range: Range, comments: readonly vscode.Comment[]): FakeCommentThread {
    const thread = new FakeCommentThread(uri, range, comments);
    this.threads.push(thread);
    return thread;
  }
  dispose(): void { for (const thread of this.threads) thread.dispose(); }
}

export const comments = {
  controllers: [] as FakeCommentController[],
  createCommentController(): FakeCommentController {
    const controller = new FakeCommentController();
    this.controllers.push(controller);
    return controller;
  },
};

export const CommentMode = { Preview: 0, Editing: 1 } as const;
export const CommentThreadState = { Unresolved: 0, Resolved: 1 } as const;
export const CommentThreadCollapsibleState = { Collapsed: 0, Expanded: 1 } as const;
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;
export const TreeItemCheckboxState = { Unchecked: 0, Checked: 1 } as const;
export const FileType = { File: 1 } as const;
export const FilePermission = { Readonly: 1 } as const;
export const FileChangeType = { Changed: 1 } as const;

/** Named file system failures, matching the real factory methods. */
export class FileSystemError extends Error {
  static FileNotFound(uri?: unknown): FileSystemError { return new FileSystemError(`FileNotFound ${String(uri)}`); }
  static NoPermissions(uri?: unknown): FileSystemError { return new FileSystemError(`NoPermissions ${String(uri)}`); }
  static Unavailable(uri?: unknown): FileSystemError { return new FileSystemError(`Unavailable ${String(uri)}`); }
}
export const OverviewRulerLane = { Center: 2 } as const;
export const DecorationRangeBehavior = { ClosedClosed: 1 } as const;
export const TextEditorRevealType = { InCenterIfOutsideViewport: 2 } as const;
export const TextEditorSelectionChangeKind = { Keyboard: 1, Mouse: 2, Command: 3 } as const;
export class TabInputText {
  constructor(readonly uri: Uri) {}
}
export class TabInputTextDiff {
  constructor(readonly original: Uri, readonly modified: Uri) {}
}
export class TabInputWebview {
  constructor(readonly viewType: string) {}
}

/** Event sources deliver real document lifecycle events to controller subscriptions. */
export const editorEvents = {
  opened: new EventEmitter<vscode.TextDocument>(),
  changed: new EventEmitter<vscode.TextDocumentChangeEvent>(),
  selection: new EventEmitter<vscode.TextEditorSelectionChangeEvent>(),
  visible: new EventEmitter<readonly vscode.TextEditor[]>(),
  focus: new EventEmitter<vscode.WindowState>(),
};

/** Integrated terminal surface preserving identity across launcher recreation. */
export class FakeTerminal {
  disposed = false;
  showCalls = 0;
  readonly sendTextCalls: { readonly text: string; readonly shouldExecute: boolean | undefined }[] = [];
  exitStatus: vscode.TerminalExitStatus | undefined;
  readonly name: string;

  constructor(readonly creationOptions: vscode.TerminalOptions) { this.name = creationOptions.name ?? 'Terminal'; }
  show(): void { this.showCalls += 1; }
  sendText(text: string, shouldExecute?: boolean): void { this.sendTextCalls.push({ text, shouldExecute }); }
  dispose(): void { this.disposed = true; }
}

export const terminalEvents = {
  closed: new EventEmitter<vscode.Terminal>(),
  ended: new EventEmitter<vscode.TerminalShellExecutionEndEvent>(),
};

interface FakeContentProvider {
  provideTextDocumentContent(uri: Uri): string | PromiseLike<string>;
}

/** Exercise real navigator provider registration and cached in-memory documents. */
export const workspace = {
  textDocuments: [] as FakeTextDocument[],
  providers: new Map<string, FakeContentProvider>(),
  beforeOpen: undefined as (() => Promise<void>) | undefined,
  configurationValues: new Map<string, unknown>(),
  configurationWorkspaceValues: new Map<string, unknown>(),
  configurationWrites: [] as { readonly key: string; readonly value: unknown; readonly target: number | undefined }[],
  beforeConfigurationUpdate: undefined as (() => Promise<void>) | undefined,
  onDidOpenTextDocument: editorEvents.opened.event,
  onDidChangeTextDocument: editorEvents.changed.event,
  watchers: [] as FakeFileSystemWatcher[],
  createFileSystemWatcher(pattern: RelativePattern): FakeFileSystemWatcher {
    const watcher = new FakeFileSystemWatcher(pattern);
    workspace.watchers.push(watcher);
    return watcher;
  },
  fs: {
    /** Treat loaded source documents as existing local files in native controller tests. */
    async stat(uri: Uri): Promise<void> {
      if (!workspace.textDocuments.some((document) => document.uri.toString() === uri.toString())) throw new Error('Missing file');
    },
  },

  /** Keep effective settings separate from project overrides so inheritance can be verified. */
  getConfiguration(section: string): {
    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    inspect<T>(key: string): { readonly workspaceValue: T | undefined };
    update(key: string, value: unknown, target?: number): Promise<void>;
  } {
    return {
      get: <T>(key: string, defaultValue?: T): T => {
        const full = `${section}.${key}`;
        return (this.configurationWorkspaceValues.has(full)
          ? this.configurationWorkspaceValues.get(full) : this.configurationValues.has(full)
            ? this.configurationValues.get(full) : defaultValue) as T;
      },
      inspect: <T>(key: string): { readonly workspaceValue: T | undefined } => ({
        workspaceValue: this.configurationWorkspaceValues.get(`${section}.${key}`) as T | undefined,
      }),
      update: async (key: string, value: unknown, target?: number): Promise<void> => {
        await this.beforeConfigurationUpdate?.();
        const full = `${section}.${key}`;
        this.configurationWrites.push({ key: full, value: structuredClone(value), target });
        if (value === undefined) this.configurationWorkspaceValues.delete(full);
        else this.configurationWorkspaceValues.set(full, structuredClone(value));
      },
    };
  },

  /** Return unsaved documents first, or obtain exact text from the registered readonly provider. */
  async openTextDocument(uri: Uri): Promise<FakeTextDocument> {
    await this.beforeOpen?.();
    const existing = this.textDocuments.find((document) => document.uri.toString() === uri.toString());
    if (existing !== undefined) return existing;
    const provider = this.providers.get(uri.scheme);
    if (provider === undefined) throw new Error(`No document or content provider for ${uri.toString()}`);
    const document = new FakeTextDocument(uri, await provider.provideTextDocumentContent(uri), 'plaintext', true);
    this.textDocuments.push(document);
    return document;
  },

  /** Keep provider lifecycle observable when the extension is recreated. */
  fileSystems: new Map<string, vscode.FileSystemProvider>(),
  registerFileSystemProvider(scheme: string, provider: vscode.FileSystemProvider): vscode.Disposable {
    this.fileSystems.set(scheme, provider);
    return { dispose: (): void => { this.fileSystems.delete(scheme); } };
  },
  registerTextDocumentContentProvider(scheme: string, provider: FakeContentProvider): vscode.Disposable {
    this.providers.set(scheme, provider);
    return { dispose: (): void => { if (this.providers.get(scheme) === provider) this.providers.delete(scheme); } };
  },
};

/** Invoke registered production commands with their original asynchronous return values. */
export const commands = {
  handlers: new Map<string, (...arguments_: unknown[]) => unknown>(),

  /** Register the real command handler without wrapping or changing its promise. */
  registerCommand(id: string, handler: (...arguments_: unknown[]) => unknown): vscode.Disposable {
    this.handlers.set(id, handler);
    return { dispose: (): void => { if (this.handlers.get(id) === handler) this.handlers.delete(id); } };
  },

  /** Await all navigation work returned by the real command handler. */
  async executeCommand<T = unknown>(id: string, ...arguments_: unknown[]): Promise<T> {
    const handler = this.handlers.get(id);
    if (id === 'setContext' && handler === undefined) return undefined as T;
    if (handler === undefined) throw new Error(`No registered command: ${id}`);
    return await handler(...arguments_) as T;
  },
};

/** Record intentional browser navigation without contacting external services. */
export const env = {
  opened: [] as Uri[],
  async openExternal(uri: Uri): Promise<boolean> { this.opened.push(uri); return true; },
  clipboard: {
    writes: [] as string[],
    async writeText(value: string): Promise<void> { this.writes.push(value); },
  },
};

/** Simulate installed language IDs while letting production code choose aliases. */
export const languages = {
  async getLanguages(): Promise<string[]> { return ['plaintext', 'javascript', 'typescript', 'python']; },
  async setTextDocumentLanguage(document: FakeTextDocument, languageId: string): Promise<FakeTextDocument> {
    document.languageId = languageId;
    return document;
  },
};

export const ViewColumn = { Active: -1, Beside: -2, One: 1 } as const;
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;
export const ColorThemeKind = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 } as const;
/** Installed extensions, which tests fill with the contributions they read. */
export const extensions = { all: [] as { readonly extensionPath: string; readonly packageJSON: unknown }[] };
export const ProgressLocation = { Notification: 15 } as const;
interface FakeTreeView {
  title: string;
  description: string;
  message: string;
  readonly provider: vscode.TreeDataProvider<vscode.TreeItem>;
  readonly checkboxes: EventEmitter<{ readonly items: readonly [unknown, number][] }>;
  readonly onDidChangeCheckboxState: vscode.Event<{ readonly items: readonly [unknown, number][] }>;
  readonly dragAndDrop: vscode.TreeDragAndDropController<unknown> | undefined;
  dispose(): void;
}

/** Carry dragged tree rows between the drag and drop handlers. */
export class DataTransferItem {
  constructor(readonly value: unknown) {}
}

export class DataTransfer {
  readonly #items = new Map<string, DataTransferItem>();
  get(mimeType: string): DataTransferItem | undefined { return this.#items.get(mimeType); }
  set(mimeType: string, item: DataTransferItem): void { this.#items.set(mimeType, item); }
}
export const window = {
  activeColorTheme: { kind: ColorThemeKind.Dark as number },
  state: { focused: true },
  panels: [] as FakePanel[],
  errors: [] as string[],
  information: [] as string[],
  visibleTextEditors: [] as FakeTextEditor[],
  activeTextEditor: undefined as FakeInteractiveEditor | undefined,
  terminals: [] as FakeTerminal[],
  onDidCloseTerminal: terminalEvents.closed.event,
  onDidEndTerminalShellExecution: terminalEvents.ended.event,
  createTerminal(options: vscode.TerminalOptions): FakeTerminal {
    const terminal = new FakeTerminal(options);
    this.terminals.push(terminal);
    return terminal;
  },
  trees: [] as FakeTreeView[],
  tabGroups: { all: [] as { readonly viewColumn: number; readonly tabs: { readonly input: unknown }[]; readonly activeTab?: { readonly input: unknown } }[] },
  onDidChangeVisibleTextEditors: editorEvents.visible.event,
  onDidChangeTextEditorSelection: editorEvents.selection.event,
  onDidChangeWindowState: editorEvents.focus.event,
  createTreeView(_id: string, options: { readonly treeDataProvider: vscode.TreeDataProvider<vscode.TreeItem>; readonly dragAndDropController?: vscode.TreeDragAndDropController<unknown> }): FakeTreeView {
    const checkboxes = new EventEmitter<{ readonly items: readonly [unknown, number][] }>();
    const tree = { title: '', description: '', message: '', visible: true, onDidChangeVisibility: new EventEmitter<{ readonly visible: boolean }>().event,
      provider: options.treeDataProvider, checkboxes, onDidChangeCheckboxState: checkboxes.event, dragAndDrop: options.dragAndDropController, dispose(): void {} };
    this.trees.push(tree);
    return tree;
  },
  createTextEditorDecorationType(): Disposable { return new Disposable(() => undefined); },
  fileDecorations: [] as vscode.FileDecorationProvider[],
  registerFileDecorationProvider(provider: vscode.FileDecorationProvider): Disposable {
    this.fileDecorations.push(provider);
    return new Disposable(() => { this.fileDecorations.splice(this.fileDecorations.indexOf(provider), 1); });
  },
  outputs: [] as { readonly name: string; readonly lines: string[]; shown: boolean }[],
  createOutputChannel(name: string): { appendLine(line: string): void; show(): void; dispose(): void } {
    const output = { name, lines: [] as string[], shown: false };
    this.outputs.push(output);
    return { appendLine: (line) => { output.lines.push(line); }, show: () => { output.shown = true; }, dispose: () => undefined };
  },
  shownDocuments: [] as { readonly document: FakeTextDocument; readonly options: vscode.TextDocumentShowOptions | undefined }[],
  statusMessages: [] as string[],
  quickPicks: [] as (readonly vscode.QuickPickItem[])[],
  quickPickIndex: 0 as number | undefined,
  quickPickManyIndexes: undefined as number[] | undefined,
  quickPickIndexes: [] as (number | undefined)[],
  beforeQuickPick: undefined as (() => void | Promise<void>) | undefined,
  beforeShow: undefined as (() => Promise<void>) | undefined,
  createWebviewPanel(): FakePanel {
    const panel = new FakePanel();
    this.panels.push(panel);
    return panel;
  },
  async showErrorMessage(message: string): Promise<void> { this.errors.push(message); },
  async showInformationMessage(message: string): Promise<void> { this.information.push(message); },

  /** Choose or cancel an actual navigation picker without creating synthetic command arguments. */
  async showQuickPick<T extends vscode.QuickPickItem>(itemsOrPromise: readonly T[] | Thenable<readonly T[]>, options?: vscode.QuickPickOptions): Promise<T | T[] | undefined> {
    const items = await itemsOrPromise;
    this.quickPicks.push(items);
    await this.beforeQuickPick?.();
    const index = this.quickPickIndexes.length > 0 ? this.quickPickIndexes.shift() : this.quickPickIndex;
    if (options?.canPickMany === true && this.quickPickManyIndexes !== undefined) return items.filter((_, i) => this.quickPickManyIndexes?.includes(i));
    const selected = index === undefined ? undefined : items[index];
    return selected === undefined ? undefined : options?.canPickMany === true ? [selected] : selected;
  },

  /** Execute actual host work while leaving VS Code's progress presentation opaque. */
  async withProgress<T>(_options: vscode.ProgressOptions, task: () => Promise<T>): Promise<T> { return await task(); },

  /** Record only completed reveals so command completion can be tested accurately. */
  async showTextDocument(document: FakeTextDocument, options?: vscode.TextDocumentShowOptions): Promise<FakeTextEditor> {
    await this.beforeShow?.();
    this.shownDocuments.push({ document, options });
    const editor = this.visibleTextEditors.find((candidate) => candidate.document.uri.toString() === document.uri.toString())
      ?? new FakeInteractiveEditor(document, options?.viewColumn ?? ViewColumn.One);
    if (!this.visibleTextEditors.includes(editor)) this.visibleTextEditors.push(editor);
    return editor;
  },

  /** Retain the user-visible explanation for standalone code proposals. */
  setStatusBarMessage(message: string): vscode.Disposable {
    this.statusMessages.push(message);
    return { dispose(): void {} };
  },
};

/** Workspace storage with actual ordered async updates and snapshot inspection. */
export class FakeMemento implements vscode.Memento {
  private readonly values = new Map<string, unknown>();

  /** Return stored state without inventing defaults. */
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key) ? this.values.get(key) as T : defaultValue;
  }

  /** List existing storage entries for the editor's memento contract. */
  keys(): readonly string[] { return [...this.values.keys()]; }

  /** Capture independent JSON state as the workspace persistence boundary would. */
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
}

/** Build the single extension-context field consumed by the real composer. */
export function extensionContext(workspaceState = new FakeMemento()): vscode.ExtensionContext {
  return { workspaceState } as unknown as vscode.ExtensionContext;
}

/** Reset surfaces between tests without mutating application source. */
export function resetFakeWindow(): void {
  for (const panel of window.panels) panel.dispose();
  window.panels.length = 0;
  window.errors.length = 0;
  window.information.length = 0;
  window.visibleTextEditors.length = 0;
  window.activeTextEditor = undefined;
  window.terminals.length = 0;
  window.trees.length = 0;
  window.tabGroups.all.length = 0;
  window.shownDocuments.length = 0;
  window.statusMessages.length = 0;
  window.quickPicks.length = 0;
  window.quickPickIndex = 0;
  window.quickPickManyIndexes = undefined;
  window.quickPickIndexes.length = 0;
  window.beforeQuickPick = undefined;
  window.beforeShow = undefined;
  window.activeColorTheme.kind = ColorThemeKind.Dark;
}

/** Clear only editor navigation state after its production providers are disposed. */
export function resetFakeEditor(): void {
  workspace.textDocuments.length = 0;
  workspace.providers.clear();
  workspace.beforeOpen = undefined;
  workspace.configurationValues.clear();
  workspace.configurationWorkspaceValues.clear();
  workspace.configurationWrites.length = 0;
  workspace.beforeConfigurationUpdate = undefined;
  commands.handlers.clear();
  env.opened.length = 0;
  env.clipboard.writes.length = 0;
  for (const controller of comments.controllers) controller.dispose();
  comments.controllers.length = 0;
  for (const event of Object.values(editorEvents)) event.dispose();
  for (const event of Object.values(terminalEvents)) event.dispose();
}

/** Drain host messages and ordered persistence microtasks without wall-clock sleeps. */
export async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
