import { spawn as spawnProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import * as vscode from 'vscode';
import type { ReviewEvent, ReviewStore } from './contracts.js';
import { buildReviewBatchPrompt } from './eventPrompt.js';
import { readPrivateJson, writePrivateJson } from './privateFiles.js';
import { stopProcess } from './shell.js';
import type { PullRequestRole } from './worktrees.js';

/** What a PR's background Claude is doing right now. */
export interface ClaudeActivity {
  readonly running: boolean;
  /** Current step in a few words, such as "Reading src/app.ts". */
  readonly step?: string;
  /** The current run's latest steps, while it runs. */
  readonly progress?: ClaudeProgress;
  /** Label of the task running instead of comments, such as "fixing merge conflicts". */
  readonly task?: string;
  /** Threads whose comments the current or last run handles. */
  readonly threads: ReadonlySet<string>;
  readonly error?: string;
  /** Comments sent to Claude that it did not pick up; they wait for a retry. */
  readonly skipped: number;
}

/** One step of a Claude run, shown like a Claude Code transcript line: `verb(target)`, then `detail`. */
export interface ClaudeStep {
  readonly verb: string;
  readonly target?: string;
  /** Claude's sentence before the step while it runs; once done, its exact result, such as "Read 120 lines". */
  readonly detail?: string;
  readonly done: boolean;
  readonly failed?: boolean;
}

/** A run's latest steps, oldest first, and when the run started in epoch milliseconds. */
export interface ClaudeProgress {
  readonly steps: readonly ClaudeStep[];
  readonly startedAt: number;
}

/** How a task ended: an error message, or Claude's last message on success. */
export interface ClaudeTaskResult {
  readonly error?: string;
  readonly reply?: string;
}

/** A one-off job for a PR's Claude conversation, outside the comment queue, such as fixing merge conflicts. */
export interface ClaudeTask {
  /** What the log calls the run, such as "fixing merge conflicts". */
  readonly label: string;
  readonly prompt: string;
  /** Tools Claude may use without asking, beyond Pair Review's own. */
  readonly allowedTools: readonly string[];
}

/** How to start Claude for one PR worktree. */
export interface ClaudeRunnerOptions {
  readonly store: ReviewStore;
  readonly cwd: string;
  readonly dataPath: string;
  readonly role: PullRequestRole;
  /** Claude command and MCP config; with `shell`, Claude starts through the user's login shell so their own `claude` setup applies. */
  readonly resolve: () => Promise<{ readonly executable: string; readonly mcpPath: string; readonly shell?: string }>;
  readonly log: (line: string) => void;
  readonly spawn?: typeof spawnProcess;
  /** The user's own instructions for answering comments, read fresh for each run. */
  readonly instructions?: () => Promise<string>;
  /** Runs before Claude answers comments, such as bringing the worktree to the PR's latest commit; a failure stops the run with its message. */
  readonly prepare?: () => Promise<void>;
  /** Runs after Claude answers comments, with the threads it handled, such as recording its commits; a failure is the run's error. */
  readonly finish?: (threads: ReadonlySet<string>) => Promise<void>;
  /** Folders outside the worktree Claude may read and search, such as the workspace's other repositories. */
  readonly folders?: () => readonly string[];
  /** A conversation the user connected answers the comments, so this runner only runs tasks it is given. */
  readonly answersElsewhere?: boolean;
}

/** How to start this PR's Claude conversation interactively, such as in a terminal. */
export interface ClaudeLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

const reviewerNote = 'This is someone else\'s pull request. You may read other repositories, run commands and make throwaway edits or commits to test an idea, but Pair Review discards them after this run. For implement requests, reply with the proposed change instead of committing it.';
const authorNote = 'When you change files, commit the change with a short message saying what it does. Do not push; the human reviews your commits and pushes them.';
/** How to propose code in a reply, so the review page can show, apply and publish it as on GitHub. */
const suggestionNote = 'To propose new code for the commented lines without editing files, put the complete replacement lines in a fenced block whose language is `suggestion`, as on GitHub. It replaces exactly the commented lines, so include every line that stays. Use suggestion blocks only for a change that stays within the commented lines; show a change that touches other lines or files as a ```diff block per file instead. To offer alternatives, write up to three suggestion blocks, each after a short line naming the option, such as "Option 1: read the limit from config." The human picks one to apply or publish.';
/** On someone else's PR the checkout is the author's: skip its CLAUDE.md, skills, hooks, settings and MCP servers. */
export const untrustedCheckoutFlags = ['--setting-sources', 'user', '--strict-mcp-config'];

/** One resumable background Claude conversation per PR that answers comments as they are sent. */
export class ClaudeRunner implements vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.#changed.event;
  readonly #subscription: { dispose(): void };
  readonly #sent = new Set<string>();
  #activity: ClaudeActivity = { running: false, threads: new Set(), skipped: 0 };
  #child: ReturnType<typeof spawnProcess> | undefined;
  #stopping = false;
  #disposed = false;

  constructor(private readonly options: ClaudeRunnerOptions) {
    this.#subscription = options.store.onChange(() => { this.#next(); });
    this.#next();
  }

  /** Claude's last message in the current or latest run. */
  #reply: string | undefined;

  get activity(): ClaudeActivity {
    return this.#activity;
  }

  /**
   * Run a task in this PR's conversation; resolves with Claude's error or its last message.
   * On someone else's PR, Git hooks stay off, since the PR's author controls the checkout.
   */
  async runTask(task: ClaudeTask): Promise<ClaudeTaskResult> {
    if (this.#disposed || this.#child !== undefined || this.#activity.running) throw new Error('Claude is still working on this PR. Try again when it is done.');
    this.#set({ running: true, step: 'Starting', progress: { steps: [], startedAt: Date.now() }, task: task.label, threads: new Set(), skipped: 0, error: undefined });
    let error: string | undefined;
    try {
      error = await this.#spawn({ prompt: task.prompt, label: task.label, allowedTools: task.allowedTools, mode: this.options.role === 'author' ? 'auto' : 'acceptEdits' });
    } catch (failure: unknown) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    if (this.#stopping) error = 'Stopped.';
    if (error !== undefined) this.options.log(`Failed: ${error}`);
    this.#child = undefined;
    this.#stopping = false;
    this.#set({ running: false, step: undefined, progress: undefined, task: undefined, threads: new Set(), skipped: 0, error });
    this.#next();
    return error !== undefined ? { error } : this.#reply === undefined ? {} : { reply: this.#reply };
  }

  /** How to open this PR's conversation interactively; starts and remembers a new conversation when there is none yet. */
  async launch(): Promise<ClaudeLaunch> {
    const { executable, mcpPath, shell } = await this.options.resolve();
    const { sessionId, resume } = await this.#session();
    if (!resume) await writePrivateJson(this.#sessionPath, { sessionId });
    return this.#command(executable, shell, [...this.#flags(mcpPath, [], 'auto'), ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId])]);
  }

  /** Send comments Claude did not pick up again, and clear the last error. */
  retry(): void {
    this.#sent.clear();
    this.#set({ ...this.#activity, skipped: 0, error: undefined });
    this.#next();
  }

  /** Stop the current run, if any, and resolve once it ended; its comments wait for a retry. */
  async stop(): Promise<void> {
    if (!this.#activity.running) return;
    this.#stopping = true;
    if (this.#child !== undefined) stopProcess(this.#child);
    await new Promise<void>((resolve) => {
      const watch = this.onDidChange(() => { if (!this.#activity.running) { watch.dispose(); resolve(); } });
    });
  }

  dispose(): void {
    this.#disposed = true;
    this.#subscription.dispose();
    if (this.#child !== undefined) stopProcess(this.#child);
    this.#changed.dispose();
  }

  #set(activity: { [K in keyof ClaudeActivity]: ClaudeActivity[K] | undefined }): void {
    const { step, progress, task, error, ...rest } = activity;
    this.#activity = {
      ...rest, ...(step === undefined ? {} : { step }), ...(progress === undefined ? {} : { progress }),
      ...(task === undefined ? {} : { task }), ...(error === undefined ? {} : { error }),
    } as ClaudeActivity;
    if (!this.#disposed) this.#changed.fire();
  }

  #next(): void {
    if (this.#disposed || this.#child !== undefined || this.#activity.running || this.options.answersElsewhere === true) return;
    const pending = this.options.store.pendingEvents;
    const fresh = pending.filter((event) => !this.#sent.has(event.id));
    const skipped = pending.length - fresh.length;
    if (fresh.length === 0) {
      if (skipped !== this.#activity.skipped) this.#set({ ...this.#activity, skipped });
      return;
    }
    void this.#run(fresh);
  }

  async #run(events: readonly ReviewEvent[]): Promise<void> {
    for (const event of events) this.#sent.add(event.id);
    const threads = new Set(events.map((event) => event.threadId));
    this.#set({ running: true, step: 'Starting', progress: { steps: [], startedAt: Date.now() }, threads, skipped: 0, error: undefined });
    let error: string | undefined;
    try {
      await this.options.prepare?.();
      const prompt = buildReviewBatchPrompt(events, this.options.store.threads, await this.options.instructions?.() ?? '');
      error = await this.#spawn({
        prompt: `${this.options.role === 'reviewer' ? reviewerNote : authorNote}\n\n${prompt}\n\n${suggestionNote}`,
        label: `${events.length} comment${events.length === 1 ? '' : 's'}`, allowedTools: [], mode: 'auto',
      });
      await this.options.finish?.(threads);
    } catch (failure: unknown) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    if (this.#stopping) {
      this.options.log('Stopped.');
      error = undefined;
    }
    if (error !== undefined) this.options.log(`Failed: ${error}`);
    this.#child = undefined;
    this.#stopping = false;
    this.#set({ running: false, step: undefined, progress: undefined, threads, skipped: 0, error });
    this.#next();
  }

  get #sessionPath(): string {
    return join(this.options.dataPath, 'claude-session.json');
  }

  /** The saved conversation to resume, or a new conversation's ID. */
  async #session(): Promise<{ readonly sessionId: string; readonly resume: boolean }> {
    const saved = await readPrivateJson(this.#sessionPath).catch(() => undefined) as { sessionId?: unknown } | undefined;
    const resume = typeof saved?.sessionId === 'string' && /^[\da-f-]{36}$/u.test(saved.sessionId) ? saved.sessionId : undefined;
    return { sessionId: resume ?? randomUUID(), resume: resume !== undefined };
  }

  /** Flags every run of this PR's conversation shares: Pair Review's tools, the extra folders, and on someone else's PR no checkout config. */
  #flags(mcpPath: string, allowedTools: readonly string[], mode: 'auto' | 'acceptEdits'): string[] {
    const folders = (this.options.folders?.() ?? []).filter((folder) => folder !== this.options.cwd);
    return [
      '--mcp-config', mcpPath, '--allowedTools', 'mcp__pair-review', ...allowedTools,
      ...(this.options.role === 'reviewer' ? untrustedCheckoutFlags : []),
      '--permission-mode', mode,
      ...(folders.length === 0 ? [] : ['--add-dir', ...folders]),
    ];
  }

  /** Start Claude directly, or through the login shell so the user's own `claude` setup applies. On someone else's PR, Git hooks stay off, since the PR's author controls the checkout. */
  #command(executable: string, shell: string | undefined, args: readonly string[]): ClaudeLaunch {
    const env = this.options.role === 'reviewer' ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null' } : {};
    return shell === undefined
      ? { command: executable, args, cwd: this.options.cwd, env }
      : { command: shell, args: ['-l', '-i', '-c', '"$0" "$@"', executable, ...args], cwd: this.options.cwd, env };
  }

  /** Run Claude once in the PR's conversation; resolves with an error message, or undefined on success. */
  async #spawn(run: { readonly prompt: string; readonly label: string; readonly allowedTools: readonly string[]; readonly mode: 'auto' | 'acceptEdits' }): Promise<string | undefined> {
    const { executable, mcpPath, shell } = await this.options.resolve();
    const sessionPath = this.#sessionPath;
    const { sessionId, resume: resumed } = await this.#session();
    if (this.#disposed || this.#stopping) return 'Stopped.';
    const resume = resumed ? sessionId : undefined;
    const args = [
      '-p', run.prompt, '--output-format', 'stream-json', '--verbose', ...this.#flags(mcpPath, run.allowedTools, run.mode),
      ...(resume === undefined ? ['--session-id', sessionId] : ['--resume', sessionId]),
    ];
    this.#reply = undefined;
    this.options.log(`Starting Claude for ${run.label} (${resume === undefined ? 'new' : 'resumed'} conversation ${sessionId})`);
    const launch = this.#command(executable, shell, args);
    const child = (this.options.spawn ?? spawnProcess)(launch.command, launch.args, { cwd: launch.cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...launch.env } });
    this.#child = child;
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    let result: string | undefined | null = null;
    let saving: Promise<void> = Promise.resolve();
    const steps = new StepLog(this.options.cwd);
    const startedAt = this.#activity.progress?.startedAt ?? Date.now();
    const lines = createInterface({ input: child.stdout! });
    lines.on('line', (line) => {
      const message = parseLine(line);
      if (message === undefined) return;
      if (steps.read(message)) this.#set({ ...this.#activity, progress: { steps: steps.steps, startedAt } });
      if (message.type === 'assistant') {
        for (const block of contentBlocks(message)) {
          if (block.type === 'tool_use' && typeof block.name === 'string') {
            const step = describeTool(block.name, block.input, this.options.cwd);
            this.options.log(`→ ${step}`);
            this.#set({ ...this.#activity, step });
          } else if (block.type === 'thinking') {
            this.#set({ ...this.#activity, step: 'Thinking' });
          } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
            this.options.log(block.text.trim());
            this.#reply = block.text.trim();
            this.#set({ ...this.#activity, step: 'Writing' });
          }
        }
      }
      if (message.type === 'result') {
        result = message.is_error === true ? clean(typeof message.result === 'string' ? message.result : 'Claude reported an error.', 200) : undefined;
        if (result === undefined && resume === undefined) saving = writePrivateJson(sessionPath, { sessionId });
      }
    });
    const code = await new Promise<number | null>((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('close', resolveExit);
    });
    await saving;
    const reason = stderr.trim().split('\n').at(-1);
    const error = result !== null ? result : code === 0 ? undefined
      : `Claude exited with code ${code ?? 'unknown'}${reason ? `: ${clean(reason, 200)}` : ''}`;
    if (resume !== undefined && /no conversation found/iu.test(`${error ?? ''} ${stderr}`)) {
      await writePrivateJson(sessionPath, {});
      return 'The earlier Claude conversation was not found. Retry to start a new one.';
    }
    return error;
  }
}

export type StreamMessage = Record<string, unknown>;

/** Parse one stream-json line; Claude output is untrusted, so anything unexpected is skipped. */
export function parseLine(line: string): StreamMessage | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as StreamMessage : undefined;
  } catch {
    return undefined;
  }
}

export function contentBlocks(message: StreamMessage): readonly Record<string, unknown>[] {
  const inner = message.message;
  const content = typeof inner === 'object' && inner !== null ? (inner as Record<string, unknown>).content : undefined;
  return Array.isArray(content) ? content.filter((block): block is Record<string, unknown> => typeof block === 'object' && block !== null) : [];
}

/** Strip control characters and cap length before showing model-provided text in labels. */
function clean(value: string, maximum = 80): string {
  const single = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim();
  return single.length > maximum ? `${single.slice(0, maximum - 1)}…` : single;
}

const reviewTools: Record<string, string> = {
  acknowledge_review: 'Picked up the comment',
  set_review_working: 'Working on it',
  reply_to_review: 'Writing the reply',
  list_pending_reviews: 'Checking open comments',
};

/** A tool call as a transcript verb and target, plus a short phrase for status lines, such as "Reading src/app.ts". */
export interface ToolStep {
  readonly verb: string;
  readonly target?: string;
  readonly label: string;
}

export function toolStep(name: string, input: unknown, cwd: string): ToolStep {
  const fields = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
  const text = (key: string): string | undefined => typeof fields[key] === 'string' ? fields[key] : undefined;
  const file = (key: string): string => {
    const value = text(key);
    if (value === undefined) return 'a file';
    const inside = relative(cwd, value);
    return clean(inside === '' || inside.startsWith('..') ? value : inside);
  };
  const review = name.startsWith('mcp__pair-review__') ? reviewTools[name.slice('mcp__pair-review__'.length)] : undefined;
  if (review !== undefined) return { verb: review, label: review };
  switch (name) {
    case 'Read': return { verb: 'Read', target: file('file_path'), label: `Reading ${file('file_path')}` };
    case 'Edit': case 'MultiEdit': return { verb: 'Edit', target: file('file_path'), label: `Editing ${file('file_path')}` };
    case 'Write': return { verb: 'Write', target: file('file_path'), label: `Editing ${file('file_path')}` };
    case 'Grep': {
      const pattern = clean(JSON.stringify(text('pattern') ?? ''), 60);
      return { verb: 'Search', target: pattern, label: `Searching for ${pattern}` };
    }
    case 'Glob': return { verb: 'Find', target: clean(text('pattern') ?? 'files', 60), label: `Looking for ${clean(text('pattern') ?? 'files', 60)}` };
    case 'Bash': {
      const command = clean(text('description') ?? text('command') ?? 'a command', 60);
      return { verb: 'Bash', target: command, label: `Running ${command}` };
    }
    case 'WebFetch': case 'WebSearch': return { verb: 'Web', target: clean(text('url') ?? text('query') ?? 'search', 60), label: 'Searching the web' };
    case 'Task': case 'Agent': return { verb: 'Agent', ...(text('description') === undefined ? {} : { target: clean(text('description')!, 60) }), label: 'Delegating to a subagent' };
    case 'TodoWrite': return { verb: 'Plan', label: 'Planning' };
    default: return { verb: clean(name, 40), label: `Using ${clean(name, 40)}` };
  }
}

/** Describe a tool call as a short step, such as "Reading src/app.ts". */
export function describeTool(name: string, input: unknown, cwd: string): string {
  return toolStep(name, input, cwd).label;
}

const lineCount = (text: string): number => text === '' ? 0 : text.replace(/\n$/u, '').split('\n').length;
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** A finished tool call's exact result in a few words, or undefined when nothing exact is known. */
function toolResult(name: string, input: Record<string, unknown>, output: string): string | undefined {
  const text = (key: string): string => typeof input[key] === 'string' ? input[key] : '';
  switch (name) {
    case 'Read': return `Read ${plural(output.split('\n').filter((line) => /^\s*\d+[\t→]/u.test(line)).length, 'line')}`;
    case 'Write': return `Wrote ${plural(lineCount(text('content')), 'line')}`;
    case 'Edit': {
      const before = lineCount(text('old_string')), after = lineCount(text('new_string'));
      return before === after ? `Changed ${plural(after, 'line')}` : `Replaced ${plural(before, 'line')} with ${after}`;
    }
    case 'MultiEdit': return Array.isArray(input.edits) ? `Made ${plural(input.edits.length, 'edit')}` : undefined;
    case 'Bash': {
      const last = output.split('\n').map((line) => line.trim()).filter(Boolean).at(-1);
      return last === undefined ? undefined : clean(last, 100);
    }
    default: return undefined;
  }
}

const resultText = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((part: unknown) => typeof part === 'object' && part !== null && typeof (part as Record<string, unknown>).text === 'string' ? (part as Record<string, string>).text : '').join('\n') : '';

const shownSteps = 3;

/** Follows a run's stream: tool calls become steps, Claude's sentences and tool results their details. */
export class StepLog {
  #tools: { id: unknown; name: string; input: Record<string, unknown>; step: ClaudeStep }[] = [];
  /** "Thinking" or "Writing" after the last tool call. */
  #phase: ClaudeStep | undefined;
  #sentence: string | undefined;

  constructor(private readonly cwd: string) {}

  /** Oldest first, like a transcript: the latest tool calls, then what Claude does now; between calls it is thinking. */
  get steps(): readonly ClaudeStep[] {
    const steps = this.#tools.map((tool) => tool.step);
    const now = this.#phase ?? (steps.length > 0 && steps.every((step) => step.done) ? { verb: 'Thinking', done: false } : undefined);
    return (now === undefined ? steps : [...steps, now]).slice(-shownSteps);
  }

  /** Take one stream message; true when the steps changed. */
  read(message: StreamMessage): boolean {
    let changed = false;
    for (const block of contentBlocks(message)) {
      if (message.type === 'assistant' && block.type === 'tool_use' && typeof block.name === 'string') {
        const input = typeof block.input === 'object' && block.input !== null ? block.input as Record<string, unknown> : {};
        const { verb, target } = toolStep(block.name, input, this.cwd);
        this.#tools.push({ id: block.id, name: block.name, input, step: { verb, ...(target === undefined ? {} : { target }), ...(this.#sentence === undefined ? {} : { detail: this.#sentence }), done: false } });
        this.#tools = this.#tools.slice(-shownSteps * 4);
        this.#phase = undefined;
        this.#sentence = undefined;
        changed = true;
      } else if (message.type === 'assistant' && block.type === 'thinking') {
        this.#phase = { verb: 'Thinking', done: false };
        changed = true;
      } else if (message.type === 'assistant' && block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        this.#sentence = clean(block.text.trim().split(/(?<=[.!?])\s+/u).at(-1) ?? '', 120);
        this.#phase = { verb: 'Writing', detail: this.#sentence, done: false };
        changed = true;
      } else if (message.type === 'user' && block.type === 'tool_result') {
        const tool = this.#tools.find((candidate) => candidate.id === block.tool_use_id && !candidate.step.done);
        if (tool === undefined) continue;
        const output = resultText(block.content);
        const failed = block.is_error === true;
        const lines = output.split('\n').filter((line) => line.trim() !== '');
        const reason = tool.name === 'Bash' ? lines.at(-1) : lines[0];
        const detail = failed ? `Failed: ${clean(reason ?? 'error', 100)}` : toolResult(tool.name, tool.input, output);
        const { verb, target } = tool.step;
        tool.step = { verb, ...(target === undefined ? {} : { target }), ...(detail === undefined ? {} : { detail }), done: true, ...(failed ? { failed } : {}) };
        changed = true;
      }
    }
    return changed;
  }
}
