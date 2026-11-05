import type { ClaudeStep } from '../claudeRunner.js';
import type { DefinitionPeek } from '../definitions.js';
import { buildGuide, groupReadMarks, stepViewed as isStepViewed, type GuideGroup, type GuideStep, type Severity } from '../prAnalysis.js';
import type { DefinitionTarget, DiffRange, DiffSide, ExtensionMessage, FilePreview, GitHubMessageView, GitHubThreadView, OverviewState, PageMessage, PickedSuggestion, PickTarget } from '../pullRequestOverview.js';
import type { Annotation, CommentKind, GitHubComment, HideReason, MergeMethod, PickerOptions, PullRequestConversation, PullRequestDetails, ReactionContent, ReactionCount, ReviewEvent, TimelineItem } from '../pullRequests.js';
import { fileTree, type FileFolder } from '../fileTree.js';
import { fullyRead, rangeReadIds, readLines, type MarkedRange } from '../readLines.js';
import type { LineRange } from '../reviewedFiles.js';
import type { DiffHunk, DiffLine, FileDiff } from '../unifiedDiff.js';
import { codicons } from '../codicons.js';
import type { FileIcon, FileIcons } from '../fileIcons.js';
import { mediaType, type MediaPreview, type MediaSide } from '../media.js';
import type * as PdfJs from 'pdfjs-dist';

declare function acquireVsCodeApi(): { postMessage(message: PageMessage): void; getState(): unknown; setState(state: Saved): void };

type Layout = 'unified' | 'split';
/** What the file list shows: every file, the PR's commits, or Claude's guide in reading order. */
type View = 'files' | 'guide';
type Intent = 'ask' | 'implement';
interface Composer { path: string; side: DiffSide; start: number; end: number; text: string; target?: 'claude' | 'github' }
interface Saved {
  /** 'guided' is how pages saved before Files and Guide became tabs remember the guide. */
  readonly layout?: Layout | 'guided';
  readonly view?: View;
  /** Width of the definition panel in pixels, when the user resized it. */
  readonly peekWidth?: number | undefined;
  readonly folders?: boolean;
  readonly collapsed?: Record<string, boolean>;
  readonly previewing?: readonly string[];
  readonly composer?: Composer | undefined;
  readonly replies?: Record<string, string>;
  readonly publishing?: Record<string, string>;
  readonly range?: DiffRange;
  readonly whitespace?: boolean;
  readonly filter?: string;
  readonly hideViewed?: boolean;
  readonly hiddenTypes?: readonly string[];
  readonly conversationDraft?: string;
  readonly conversationFolded?: boolean;
  readonly fileTab?: string | undefined;
}
type Thread = (OverviewState['threads'][number] & { readonly source: 'local'; readonly pending?: never; readonly outdated?: never })
  | (GitHubThreadView & { readonly source: 'github' });
type Message = Thread['messages'][number];
type Preview = FilePreview & { readonly path: string };
interface Anchor { readonly key: string; readonly start: number; readonly end: number; readonly source: 'local' | 'github' | 'draft' }
/** Unchanged new-side lines between hunks; `offset` maps them to old-side lines. */
interface Gap { readonly from: number; readonly to: number; readonly offset: number; readonly last?: true }
interface Shown { readonly top: number; readonly bottom: number }
type Row = readonly (DiffLine | undefined)[];
type ReviewerState = PullRequestDetails['reviewers'][number]['state'];
type CheckState = PullRequestDetails['checks'][number]['state'];

const api = acquireVsCodeApi();
const post = (message: PageMessage): void => api.postMessage(message);
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const initial = JSON.parse($('initial').textContent ?? '') as { readonly state: OverviewState; readonly pdfScript?: string };
const saved = (api.getState() ?? {}) as Saved;
const nonce = document.currentScript?.nonce ?? '';
let layout: Layout = saved.layout === 'split' ? 'split' : 'unified';
let view: View = saved.view === 'guide' || (saved.view === undefined && saved.layout === 'guided') ? 'guide' : 'files';
/** The local page's open file tab, an unchanged file shown alone; undefined shows the Changes tab. */
let fileTab = saved.fileTab;
/** The file tab last scrolled into view, so redraws keep the tab row where the user scrolled it. */
let scrolledTab: string | undefined;
let fileIcons: FileIcons | undefined;
/** CSS font families of the icon theme's fonts already added to the page, by font id. */
const iconFonts = new Map<string, string>();
let peekWidth = saved.peekWidth;
let folders = saved.folders === true;
const collapsed = new Map(Object.entries(saved.collapsed ?? {}));
const previewing = new Set(saved.previewing ?? []);
const previews = new Map<string, Preview>();
const medias = new Map<string, MediaPreview>();
/** Rendered PDF pages per file side, kept so redrawing a file box does not render them again. */
const pdfViews = new Map<string, HTMLElement>();
let pdfLibrary: Promise<typeof PdfJs> | undefined;
const frameHeight = new Map<string, number>();
const frameTops = new Map<string, Record<string, number>>();
const frameAnchors = new Map<string, Anchor[]>();
let files: readonly FileDiff[] | undefined;
let viewed = new Set<string>();
let current: OverviewState | undefined;
let readRanges: readonly MarkedRange[] = [];
const openReads = new Set<string>();
const fileKeys = new Map<string, string>();
let composer = saved.composer;
const replies = new Map(Object.entries(saved.replies ?? {}));
/** Local threads being posted on GitHub, with the text the user is editing. */
const publishing = new Map(Object.entries(saved.publishing ?? {}));
/** The commits the Files tab shows, as the extension last confirmed them; `wanted` waits for the PR's commits to arrive. */
let diffRange: DiffRange = { kind: 'all' };
let wantedRange: DiffRange | undefined = saved.range?.kind === 'all' ? undefined : saved.range;
let whitespace = saved.whitespace === true;
/** The diff's new side is the PR's latest version, so lines can take comments and show context. */
let atHead = true;
let fileFilter = saved.filter ?? '';
let hideViewed = saved.hideViewed === true;
const hiddenTypes = new Set(saved.hiddenTypes ?? []);
/** The open menu under a Files toolbar button: the range or the file filter. */
let toolbarMenu: { readonly anchor: string; readonly node: HTMLElement } | undefined;
let conversationDraft = saved.conversationDraft ?? '';
let conversationFolded = saved.conversationFolded === true;
/** Whether the Conversation card shows its older entries; it shows only the latest ones on long PRs. */
let conversationAll = false;
const recentEntries = 6;
/** Comment edits in progress, by comment id. */
const edits = new Map<string, string>();
/** Hidden comments the viewer chose to read anyway. */
const revealed = new Set<string>();
/** Forms showing their Preview tab, and GitHub's rendering of the text each last previewed. */
const previewTabs = new Set<string>();
const renderedPreviews = new Map<string, { readonly text: string; readonly html?: string }>();
/** GitHub suggestions picked to commit together, by comment id. */
const batch = new Map<string, PickedSuggestion>();
/** The commit a Shift-click range starts from in the Commits tab. */
let rangeAnchor: string | undefined;
let emojiFor: string | undefined;
/** The open merge form; its button confirms on the next click, after `openedAt` plus a double-click's time. */
let mergeForm: { readonly auto: boolean; readonly openedAt: number } | undefined;
let mergeMethod: MergeMethod = 'squash';
/** A question that waits for its confirm button in place of what asked it; `redraw` draws that place. */
interface Ask { readonly key: string; readonly question: string; readonly label: string; send(): void; redraw(): void }
let asking: Ask | undefined;
/** The reviewer whose review the dismiss form is open for, and the reason typed so far. */
let dismissing: { readonly login: string; text: string } | undefined;
let reviewersStamp = '';
const sending = new Set<string>();
const threadOpen = new Map<string, boolean>();
/** Threads whose earlier messages the user showed. */
const threadUnfolded = new Set<string>();
/** Threads longer than this show only their latest `unfoldedMessages` until unfolded. */
const foldThreadsAbove = 4;
const unfoldedMessages = 3;
let focusNext: string | undefined;
let sentPending = true;
const contextLines = new Map<string, readonly string[]>();
const expanded = new Map<string, Map<number, Shown>>();
const loading = new Set<string>();
const step = 20;
const peeks: DefinitionPeek[] = [];
let peekAt = -1;
let drag: { path: string; side: DiffSide; from: number; to: number } | undefined;
let busy = false;
let author = true;
/** The description is open for editing, so redraws leave it alone. */
let editingBody = false;
const reviewButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-event]')];
const labels: Record<ReviewerState | CheckState, readonly [string, string, string]> = {
  approved: ['✓', 'ok', 'Approved'], changes: ['✗', 'bad', 'Requested changes'], commented: ['●', 'muted', 'Commented'],
  dismissed: ['○', 'muted', 'Dismissed'], requested: ['○', 'wait', 'Review requested'],
  success: ['✓', 'ok', 'Passed'], failure: ['✗', 'bad', 'Failed'], pending: ['●', 'wait', 'Running'], neutral: ['○', 'muted', 'Skipped'],
};
const methodLabels: Record<MergeMethod, string> = { squash: 'Squash and merge', merge: 'Create a merge commit', rebase: 'Rebase and merge' };
const hideReasons: readonly (readonly [HideReason, string])[] = [['OUTDATED', 'Outdated'], ['RESOLVED', 'Resolved'], ['DUPLICATE', 'Duplicate'], ['OFF_TOPIC', 'Off-topic'],
  ['LOW_QUALITY', 'Low quality'], ['SPAM', 'Spam'], ['ABUSE', 'Abuse']];
const changeLetters: Record<FileDiff['change'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', unchanged: '' };
const severityLabels: Record<Severity | 'unclassified', string> = { critical: 'Critical', significant: 'Significant', routine: 'Routine', trivial: 'Trivial', unclassified: 'Unclassified' };
let guide: GuideGroup[] | undefined;
let guideStamp = '';
const stepKeys = new Map<string, string>();
const verdictText = { changes: ['bad', 'Changes requested by '], approved: ['ok', 'Approved by '], commented: ['muted', 'Commented: '] } as const;

/**
 * Runs inside the HTML preview frame: reports clicks as source lines, and where commented elements sit.
 * The page injects its source text, so it must not use anything from outside its own body.
 */
function frameMain(): void {
  interface FrameAnchor { readonly key: string; readonly start: number; readonly end: number; readonly source: string; node?: Element }
  const lines = (node: Element): [number, number] => {
    const [start = Number.NaN, end = Number.NaN] = ((node as HTMLElement).dataset.lrLines ?? '').split('-').map(Number);
    return [start, end];
  };
  const target = (event: Event): Element | null => (event.target instanceof Element ? event.target.closest('[data-lr-lines]') : null);
  const style = document.createElement('style');
  style.textContent = '[data-lr-hover]{outline:2px dashed #0078d4!important;outline-offset:1px;cursor:pointer!important}'
    + '[data-lr-sel]{outline:2px solid #0078d4!important;outline-offset:1px;background-color:rgba(0,120,215,.12)!important}'
    + '[data-lr-anchor=local]{outline:2px solid rgba(209,134,22,.75)!important;outline-offset:1px}[data-lr-anchor=github]{outline:2px solid rgba(55,148,255,.75)!important;outline-offset:1px}'
    + '[data-lr-focus]{outline-width:3px!important;background-color:rgba(128,128,128,.15)!important}';
  document.head.append(style);
  let hover: Element | null = null;
  let anchors: FrameAnchor[] = [];
  let pending = false;
  const closest = (anchor: FrameAnchor): Element | undefined => {
    let exact: Element | undefined;
    let inner: Element | undefined;
    let size = Infinity;
    let after: Element | undefined;
    let afterStart = Infinity;
    for (const node of document.querySelectorAll('[data-lr-lines]')) {
      const [start, end] = lines(node);
      if (!exact && start === anchor.start && end === anchor.end) exact = node;
      if (start <= anchor.end && anchor.end <= end && end - start <= size) { inner = node; size = end - start; }
      if (start >= anchor.end && start < afterStart) { after = node; afterStart = start; }
    }
    return exact ?? inner ?? after;
  };
  const report = (): void => {
    pending = false;
    const tops: Record<string, number> = {};
    for (const node of document.querySelectorAll('[data-lr-anchor]')) node.removeAttribute('data-lr-anchor');
    for (const anchor of anchors) {
      const node = closest(anchor);
      if (!node) continue;
      anchor.node = node;
      if (anchor.source !== 'draft') node.setAttribute('data-lr-anchor', anchor.source);
      tops[anchor.key] = node.getBoundingClientRect().top + scrollY;
    }
    parent.postMessage({ lrHeight: document.documentElement.scrollHeight, lrAnchors: tops }, '*');
  };
  const schedule = (): void => { if (!pending) { pending = true; setTimeout(report, 30); } };
  new ResizeObserver(schedule).observe(document.documentElement);
  addEventListener('load', schedule);
  addEventListener('mouseover', (event) => {
    const at = target(event);
    hover?.removeAttribute('data-lr-hover');
    hover = at;
    at?.setAttribute('data-lr-hover', '');
  });
  addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const at = target(event);
    if (!at) return;
    const [start, end] = lines(at);
    parent.postMessage({ lrPick: { start, end, extend: event.shiftKey, top: at.getBoundingClientRect().top + scrollY } }, '*');
  }, true);
  addEventListener('submit', (event) => event.preventDefault(), true);
  addEventListener('message', (event) => {
    if (event.source !== parent) return;
    const data = (event.data ?? {}) as { anchors?: unknown; focus?: unknown; select?: unknown };
    if (Array.isArray(data.anchors)) { anchors = data.anchors as FrameAnchor[]; schedule(); }
    if ('focus' in data) {
      for (const node of document.querySelectorAll('[data-lr-focus]')) node.removeAttribute('data-lr-focus');
      anchors.find((item) => item.key === data.focus)?.node?.setAttribute('data-lr-focus', '');
    }
    if (Array.isArray(data.select)) {
      const [from, to] = data.select as number[];
      for (const node of document.querySelectorAll('[data-lr-lines]')) {
        const [start, end] = lines(node);
        if (from !== undefined && to !== undefined && start >= from && end <= to && !node.parentElement?.closest('[data-lr-sel]')) node.setAttribute('data-lr-sel', '');
      }
    }
  });
  parent.postMessage({ lrReady: true }, '*');
}

function save(): void {
  api.setState({ layout, view, peekWidth, folders, collapsed: Object.fromEntries(collapsed), previewing: [...previewing], composer, replies: Object.fromEntries(replies), publishing: Object.fromEntries(publishing),
    range: wantedRange ?? diffRange, whitespace, filter: fileFilter, hideViewed, hiddenTypes: [...hiddenTypes], conversationDraft, conversationFolded, fileTab });
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const elapsed = (since: number): string => {
  const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/** Claude's latest steps like a Claude Code transcript, oldest first: a check on finished ones, Clawd and the run's time on the current one. */
function stepLog(steps: readonly ClaudeStep[], startedAt?: number): HTMLElement {
  const log = el('div', 'step-log');
  const shown = steps.length > 0 ? steps : [{ verb: 'Starting', done: false }];
  shown.forEach((step, index) => {
    const row = el('div', 'step' + (step.done ? ' done' : '') + (step.failed ? ' failed' : ''));
    row.append(step.done ? el('span', 'mark', step.failed ? '✕' : '✓') : el('span', 'clawd'));
    const title = el('span', 'step-call');
    title.append(el('b', '', step.verb), step.target === undefined ? '' : `(${step.target})`);
    row.append(title);
    if (startedAt !== undefined && index === shown.length - 1) {
      const time = el('span', 'time', elapsed(startedAt));
      time.dataset.since = String(startedAt);
      row.append(time);
    }
    if (step.detail) row.append(el('span', 'detail', step.detail));
    log.append(row);
  });
  return log;
}

function button(label: string, onClick: () => void, className?: string): HTMLButtonElement {
  const node = el('button', className ?? '', label);
  node.addEventListener('click', onClick);
  return node;
}

function icon(svg: string): Element {
  const template = document.createElement('template');
  template.innerHTML = svg;
  return template.content.firstElementChild as Element;
}

/** A branch name that copies itself, like GitHub's. */
function branchRef(name: string): HTMLButtonElement {
  return copyRef(name, name, 'branch name');
}

/** A chip showing `text` that copies `value`; `what` names the value in its tooltip and error. */
function copyRef(text: string, value: string, what: string): HTMLButtonElement {
  const ref = el('button', 'ref');
  ref.title = 'Copy ' + what;
  const copy = icon(codicons.copy);
  copy.classList.add('copy');
  const done = icon(codicons.check);
  done.classList.add('done');
  ref.append(text, copy, done);
  ref.addEventListener('click', () => {
    void navigator.clipboard.writeText(value).then(() => {
      ref.classList.add('copied');
      setTimeout(() => ref.classList.remove('copied'), 1500);
    }, () => { $('error').textContent = 'Could not copy the ' + what + '.'; });
  });
  return ref;
}

function closestTo<T extends Element = HTMLElement>(event: Event, selector: string): T | null {
  return event.target instanceof Element ? event.target.closest<T>(selector) : null;
}

function status(key: ReviewerState | CheckState, name: string, url?: string, tools: readonly HTMLElement[] = []): HTMLLIElement {
  const item = el('li', 'row');
  const [icon, tone, label] = labels[key];
  const mark = el('span', tone, icon);
  mark.title = label;
  item.append(mark);
  if (url) {
    const link = el('a', '', name);
    link.href = url;
    item.append(link);
  } else item.append(el('span', '', name));
  item.append(el('span', 'muted', label));
  if (tools.length) {
    const box = el('span', 'reviewer-tools');
    box.append(...tools);
    item.append(box);
  }
  return item;
}

function setBusy(value: boolean): void {
  busy = value;
  for (const review of reviewButtons) review.disabled = value || (author && review.hasAttribute('data-reviewer'));
  const merge = current?.conversation?.merge;
  $<HTMLButtonElement>('merge').disabled = value || current?.details?.mergeable === 'no' || (merge?.state === 'blocked' && !merge.canBypass && !merge.mergeQueue);
  for (const action of document.querySelectorAll<HTMLButtonElement>('[data-pr-action]')) action.disabled = value;
}

/** Send a change to the PR on GitHub; the page stays busy until the extension answers. */
function changePullRequest(message: PageMessage): void {
  $('error').textContent = '';
  setBusy(true);
  post(message);
}

/** One row of a picker; `key` keeps a user and a team with the same name apart. */
interface PickerItem { readonly key: string; readonly text: string; readonly note?: string; readonly color?: string; readonly description?: string }
/** The open reviewer, assignee or label picker; it saves on close when `selected` differs from `initial`. */
interface Picker { readonly what: PickTarget; readonly initial: ReadonlySet<string>; readonly selected: Set<string>; readonly node: HTMLElement; readonly list: HTMLElement }
let picker: Picker | undefined;
let pickerOptions: PickerOptions | undefined;
let pickerError: string | undefined;
const pickerPlaceholders: Record<PickTarget, string> = { reviewers: 'Filter people and teams', assignees: 'Filter people', labels: 'Filter labels', milestone: 'Filter milestones' };

function pickedKeys(what: PickTarget, details: PullRequestDetails): Set<string> {
  if (what === 'milestone') return new Set(details.milestone === undefined ? [] : [String(details.milestone.number)]);
  if (what === 'labels') return new Set(details.labels.map((label) => label.name));
  if (what === 'assignees') return new Set(details.assignees);
  return new Set(details.reviewers.filter((reviewer) => reviewer.state === 'requested').map((reviewer) => reviewer.team === undefined ? 'user:' + reviewer.name : 'team:' + reviewer.team));
}

/** The repository's choices plus whatever the PR already has, so current values stay removable. */
function pickerItems(what: PickTarget, details: PullRequestDetails, options: PickerOptions): PickerItem[] {
  if (what === 'milestone') {
    const all = new Map([...details.milestone === undefined ? [] : [details.milestone], ...options.milestones].map((milestone) => [milestone.number, milestone]));
    return [...all.values()].map((milestone) => ({ key: String(milestone.number), text: milestone.title }));
  }
  if (what === 'labels') {
    const byName = new Map([...details.labels, ...options.labels].map((label) => [label.name, label]));
    return [...byName.values()].map((label) => ({ key: label.name, text: label.name, color: label.color, ...(label.description === undefined ? {} : { description: label.description }) }));
  }
  if (what === 'assignees') return [...new Set([...details.assignees, ...options.users])].map((login) => ({ key: login, text: login }));
  const users = details.reviewers.filter((reviewer) => reviewer.team === undefined);
  const teams = details.reviewers.flatMap((reviewer) => reviewer.team === undefined ? [] : [{ name: reviewer.name, slug: reviewer.team }]);
  const userItems = [...new Set([...users.map((reviewer) => reviewer.name), ...options.users])].map((login): PickerItem => {
    const state = users.find((reviewer) => reviewer.name === login)?.state;
    return { key: 'user:' + login, text: login, ...(state === undefined || state === 'requested' ? {} : { note: labels[state][2] }) };
  });
  const teamItems = [...teams, ...options.teams.filter((team) => !teams.some((entry) => entry.slug === team.slug))]
    .map((team): PickerItem => ({ key: 'team:' + team.slug, text: team.name, note: 'Team' }));
  return [...userItems, ...teamItems];
}

function openPicker(what: PickTarget): void {
  const reopen = picker?.what !== what;
  closePicker(true);
  const details = current?.details;
  if (!reopen || !details?.canEdit || busy) return;
  const search = el('input');
  search.type = 'text';
  search.placeholder = pickerPlaceholders[what];
  search.setAttribute('aria-label', pickerPlaceholders[what]);
  const list = el('div', 'picker-list');
  const node = el('div', 'picker');
  node.append(search, list);
  $('pick-' + what).closest('section')?.append(node);
  $('pick-' + what).setAttribute('aria-pressed', 'true');
  const initial = pickedKeys(what, details);
  picker = { what, initial, selected: new Set(initial), node, list };
  search.addEventListener('input', () => renderPicker(search.value));
  renderPicker('');
  search.focus();
  post({ action: 'picker-options' });
}

function renderPicker(filter = picker?.node.querySelector('input')?.value ?? ''): void {
  const details = current?.details;
  if (!picker || !details) return;
  const { what, initial, selected, list } = picker;
  const query = filter.trim().toLowerCase();
  const items = pickerItems(what, details, pickerOptions ?? { users: [], teams: [], labels: [], milestones: [] })
    .filter((item) => !query || [item.text, item.key.replace(/^(?:user|team):/u, '')].some((text) => text.toLowerCase().includes(query)))
    .sort((a, b) => Number(initial.has(b.key)) - Number(initial.has(a.key)));
  const rows = items.map((item) => {
    const row = el('label', 'picker-row');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = selected.has(item.key);
    box.addEventListener('change', () => {
      if (what === 'milestone') {
        selected.clear();
        if (box.checked) selected.add(item.key);
        renderPicker();
      } else if (box.checked) selected.add(item.key);
      else selected.delete(item.key);
    });
    const mark = icon(codicons.check);
    mark.classList.add('check');
    row.append(box);
    if (item.color === undefined) row.append(mark, el('span', 'text', item.text));
    else {
      const label = el('span', 'picker-label');
      label.style.setProperty('--label', '#' + item.color);
      label.append(mark, el('span', 'dot'), el('span', 'text', item.text));
      if (item.description) {
        label.append(el('span', 'muted picker-description', item.description));
        row.title = item.description;
      }
      row.append(label);
    }
    if (item.note) row.append(el('span', 'muted', item.note));
    return row;
  });
  const note = pickerError ? 'Could not load choices: ' + pickerError : pickerOptions === undefined ? 'Loading…' : items.length ? '' : query ? 'No matches.' : 'Nothing to pick.';
  list.replaceChildren(...rows, ...note ? [el('div', 'muted picker-note', note)] : []);
}

/** Close the open picker and save its selection unless `save` is false or nothing changed. */
function closePicker(save: boolean): void {
  if (!picker) return;
  const { what, initial, selected, node } = picker;
  picker = undefined;
  node.remove();
  $('pick-' + what).removeAttribute('aria-pressed');
  if (!save || (selected.size === initial.size && [...selected].every((key) => initial.has(key)))) return;
  const keys = [...selected];
  const prefixed = (prefix: string): string[] => keys.filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
  changePullRequest(what === 'reviewers' ? { action: 'pick', what, values: prefixed('user:'), teams: prefixed('team:') } : { action: 'pick', what, values: keys, teams: [] });
}

function editBody(): void {
  const details = current?.details;
  if (!details) return;
  editingBody = true;
  const area = el('textarea');
  area.value = details.body;
  area.setAttribute('aria-label', 'Description');
  const cancel = button('Cancel', () => { editingBody = false; if (current) render(current); }, 'quiet');
  const save = button('Save', () => changePullRequest({ action: 'edit-body', body: area.value }), 'primary');
  save.dataset.prAction = '';
  const row = el('div', 'row actions review-actions');
  row.append(cancel, save);
  $('body').replaceChildren(area, row);
  $('edit-body').hidden = true;
  area.focus();
}

/** The merge box: merge controls while open, then the PR's state and what you can still do with it. */
function renderState(details: PullRequestDetails): void {
  const draft = details.open && details.draft;
  $('merge-title').textContent = details.merged ? 'Merged' : !details.open ? 'Closed' : draft ? 'Draft' : 'Merge';
  const conversation = current?.conversation;
  const merge = conversation?.merge;
  const queued = merge?.queuePosition !== undefined;
  $('merge-row').hidden = !details.open || draft || !details.mergeMethods.length || queued;
  $('merge-status').replaceChildren(...details.open && !draft && conversation ? mergeChecklist(details, conversation) : []);
  $('update-row').hidden = !details.open || draft || merge?.state !== 'behind' || !merge.canUpdateBranch;
  $('merge').title = merge?.mergeQueue ? 'Adds the PR to the merge queue.' : '';
  $('auto-row').hidden = merge?.autoMerge === undefined || !details.open;
  if (merge?.autoMerge) {
    $('auto-note').textContent = 'Auto-merge is on: ' + methodLabels[merge.autoMerge.method].toLowerCase() + ' when all requirements are met. Enabled by ' + merge.autoMerge.enabledBy + '.';
    $('auto-merge-off').hidden = !merge.canDisableAutoMerge;
  }
  $('queue-row').hidden = !queued || !details.open;
  $('queue-note').textContent = queued ? 'Queued to merge, position ' + merge.queuePosition + '.' : '';
  if (!details.mergeMethods.includes(mergeMethod)) mergeMethod = details.mergeMethods[0] ?? 'squash';
  if (!details.open || draft || queued) closeMergeForm();
  else drawMergeButtons();
  $('mergeable').textContent = draft ? 'Mark it ready for review before merging.'
    : !details.open ? (details.merged ? '' : 'Closed without merging.')
    : details.mergeable === 'no' ? 'Has conflicts with the base branch.' : details.mergeable === 'unknown' ? 'GitHub is still checking for conflicts.' : '';
  const conflicted = details.open && details.mergeable === 'no' && details.canEdit;
  const question = conflicted && current?.claude.running !== true ? current?.conflictQuestion : undefined;
  $('conflict-row').hidden = !conflicted || question !== undefined;
  $('conflict-ask').hidden = question === undefined;
  const reply = $('conflict-reply');
  if (question !== undefined && reply.dataset.html !== question) {
    reply.dataset.html = question;
    reply.innerHTML = question;
  }
  $<HTMLButtonElement>('fix-conflicts').disabled = current?.claude.running === true;
  const fixing = current?.claude.fixingConflicts;
  const note = $('conflict-note');
  note.className = fixing === undefined ? 'muted' : 'chip claude working';
  const text = fixing ?? 'Claude merges the base branch, resolves the conflicts and pushes.';
  note.replaceChildren(fixing === undefined ? text : el('span', '', text));
  note.title = fixing ?? '';
  const actions: HTMLButtonElement[] = [];
  const add = (label: string, message: PageMessage, className = 'quiet', question?: string): void => {
    const send = (): void => changePullRequest(message);
    const node = button(label, question === undefined ? send : () => askInline({ key: 'state', question, label, send, redraw: () => { if (current?.details) renderState(current.details); } }), className);
    node.dataset.prAction = '';
    actions.push(node);
  };
  const number = current?.number === undefined ? 'this PR' : '#' + current.number;
  if (details.canEdit && details.open && !draft) add('Convert to draft', { action: 'draft', draft: true });
  if (details.canEdit && details.open) add('Close pull request', { action: 'close' }, 'quiet', 'Close ' + number + ' without merging? You can reopen it later.');
  if (details.canEdit && draft) add('Ready for review', { action: 'draft', draft: false }, 'primary');
  if (details.canEdit && !details.open && !details.merged) add('Reopen', { action: 'reopen' });
  if (details.merged && details.branchDeletable && merge?.headDeleted !== true) add('Delete branch', { action: 'delete-branch' }, '', 'Delete the branch ' + (current?.headBranch ?? '') + ' on GitHub?');
  if (!details.open && details.canEdit && merge?.headDeleted === true) add('Restore branch', { action: 'restore-branch' }, '');
  if (details.merged && details.canEdit) add('Revert', { action: 'revert' }, '', 'Open a PR that reverts ' + number + '? GitHub creates a branch with a revert commit.');
  $('state-actions').replaceChildren(...asking?.key === 'state' ? [askRow(asking)] : actions);
}

function verdict(reviewers: PullRequestDetails['reviewers']): readonly [string, string] {
  for (const key of ['changes', 'approved', 'commented'] as const) {
    const names = reviewers.filter((reviewer) => reviewer.state === key).map((reviewer) => reviewer.name);
    if (names.length) return [verdictText[key][0], verdictText[key][1] + names.join(', ')];
  }
  const waiting = reviewers.filter((reviewer) => reviewer.state === 'requested').map((reviewer) => reviewer.name);
  return waiting.length ? ['wait', 'Waiting for ' + waiting.join(', ')] : ['muted', 'No reviews yet'];
}

function allThreads(): Thread[] {
  if (!current) return [];
  return [...current.threads.map((thread) => ({ ...thread, source: 'local' as const })), ...(current.github ?? []).map((thread) => ({ ...thread, source: 'github' as const }))];
}

/** Local threads Claude opened from this GitHub thread; the page shows them inside it. */
function nestedIn(githubId: string): Thread[] {
  return (current?.threads ?? []).filter((thread) => thread.linkedTo === githubId).map((thread) => ({ ...thread, source: 'local' as const }))
    .sort((left, right) => started(left) - started(right));
}

function started(thread: Thread): number {
  return Date.parse(thread.messages[0]?.createdAt ?? '');
}

/** False for a local thread shown inside its GitHub thread. */
function standalone(thread: Thread): boolean {
  return thread.source !== 'local' || thread.linkedTo === undefined || !current?.github?.some((github) => github.id === thread.linkedTo);
}

const reactionEmoji: Record<ReactionContent, string> = { THUMBS_UP: '👍', THUMBS_DOWN: '👎', LAUGH: '😄', HOORAY: '🎉', CONFUSED: '😕', HEART: '❤️', ROCKET: '🚀', EYES: '👀' };
const reactionNames: Record<ReactionContent, string> = { THUMBS_UP: '+1', THUMBS_DOWN: '-1', LAUGH: 'Laugh', HOORAY: 'Hooray', CONFUSED: 'Confused', HEART: 'Heart', ROCKET: 'Rocket', EYES: 'Eyes' };
const reviewVerbs: Record<Extract<TimelineItem, { kind: 'review' }>['state'], string> = {
  approved: 'approved these changes', changes: 'requested changes', commented: 'reviewed', dismissed: 'reviewed, since dismissed', pending: 'started a review',
};
const isWriter = (conversation: PullRequestConversation | undefined): boolean => conversation !== undefined && ['admin', 'maintain', 'write'].includes(conversation.permission);
let mentionsAsked = false;

/** Reaction chips that toggle the viewer's own reaction, and a button that opens the eight GitHub reactions. */
function reactionsRow(subject: string, reactions: readonly ReactionCount[], canReact: boolean, redraw: () => void): HTMLElement {
  const row = el('div', 'reactions');
  for (const reaction of reactions) {
    const chip = button(reactionEmoji[reaction.content] + ' ' + reaction.count, () => react(subject, reaction.content, !reaction.viewerReacted), 'reaction');
    chip.setAttribute('aria-pressed', String(reaction.viewerReacted));
    chip.title = reactionNames[reaction.content];
    chip.disabled = !canReact;
    row.append(chip);
  }
  if (!canReact) return row;
  if (emojiFor === subject) {
    const pop = el('span', 'emoji-pop');
    for (const content of Object.keys(reactionEmoji) as ReactionContent[]) {
      const on = reactions.some((reaction) => reaction.content === content && reaction.viewerReacted);
      const option = button(reactionEmoji[content], () => react(subject, content, !on));
      option.title = reactionNames[content];
      option.setAttribute('aria-pressed', String(on));
      pop.append(option);
    }
    row.append(pop);
  } else {
    const add = button('', () => { emojiFor = subject; redraw(); }, 'reaction add');
    add.append(icon(codicons.reactions));
    add.title = 'Add reaction';
    add.setAttribute('aria-label', 'Add reaction');
    row.append(add);
  }
  return row;
}

function react(subject: string, content: ReactionContent, on: boolean): void {
  emojiFor = undefined;
  $('error').textContent = '';
  post({ action: 'react', id: subject, content, on });
}

/** Where a GitHub comment sits: what kind GitHub calls it, how to redraw it, and where a quote goes. */
interface CommentPlace { readonly kind: CommentKind; redraw(): void; quote(text: string): void }

function quoted(body: string): string {
  return body.trim().split('\n').map((line) => '> ' + line).join('\n') + '\n\n';
}

function toolButton(svg: string, tip: string, onClick: () => void): HTMLButtonElement {
  const node = button('', onClick);
  node.append(icon(svg));
  node.title = tip;
  node.setAttribute('aria-label', tip);
  return node;
}

/** Quote, edit, hide and delete, as far as the viewer may. */
function commentTools(comment: GitHubComment, place: CommentPlace): HTMLElement {
  const tools = el('span', 'msg-tools');
  if (comment.body.trim() && !hiddenComment(comment)) tools.append(toolButton(codicons.quote, 'Quote reply', () => place.quote(quoted(comment.body))));
  if (comment.canEdit && !edits.has(comment.id)) tools.append(toolButton(codicons.edit, 'Edit', () => { edits.set(comment.id, comment.body); focusNext = 'edit:' + comment.id; place.redraw(); }));
  if (comment.canHide && comment.hidden !== undefined) tools.append(toolButton(codicons.eyeClosed, 'Unhide', () => post({ action: 'hide-comment', id: comment.id, hide: false })));
  else if (comment.canHide) {
    const anchor = 'hide-' + place.kind + '-' + comment.id;
    const hide = toolButton(codicons.eyeClosed, 'Hide', () => openHideMenu(anchor, comment.id));
    hide.id = anchor;
    hide.setAttribute('aria-haspopup', 'true');
    const wrap = el('span', 'menu-anchor');
    wrap.append(hide);
    tools.append(wrap);
  }
  if (comment.canDelete) {
    const send = (): void => post(place.kind === 'reviewComment' ? { action: 'github-delete', id: comment.id } : { action: 'delete-issue-comment', id: comment.id });
    const remove = toolButton(codicons.trash, 'Delete on GitHub', () => askInline({ key: 'delete:' + comment.id, question: 'Delete this comment on GitHub? Everyone on the PR loses it.', label: 'Delete', send, redraw: place.redraw }));
    remove.classList.add('delete');
    tools.append(remove);
  }
  return tools;
}

/** The comment's body: folded when hidden, a form while edited, else GitHub's HTML with its reactions. */
function commentBody(comment: GitHubComment, place: CommentPlace): HTMLElement[] {
  if (comment.hidden !== undefined && !revealed.has(comment.id)) {
    const note = el('div', 'hidden-note', 'Hidden as ' + comment.hidden + '.');
    note.append(button('Show', () => { revealed.add(comment.id); place.redraw(); }, 'quiet'));
    return [note];
  }
  const draft = edits.get(comment.id);
  if (draft !== undefined) {
    const key = 'edit:' + comment.id;
    const cancel = (): void => { edits.delete(comment.id); previewTabs.delete(key); place.redraw(); };
    const submit = (): void => {
      const text = edits.get(comment.id) ?? '';
      if (!text.trim() || sending.has(key)) return;
      sending.add(key);
      place.redraw();
      post({ action: 'edit-comment', form: key, kind: place.kind, id: comment.id, text });
    };
    const field = githubField(key, draft, 'Edit comment', (value) => { edits.set(comment.id, value); }, submit, cancel);
    const row = el('div', 'row actions composer-actions');
    const saveButton = button(sending.has(key) ? 'Saving…' : 'Update comment', submit, 'primary');
    saveButton.disabled = sending.has(key);
    row.append(el('span', 'gap'), button('Cancel', cancel, 'quiet'), saveButton);
    return [field, row];
  }
  const nodes: HTMLElement[] = [];
  if (comment.bodyHtml.trim()) {
    const body = el('div', 'msg-text');
    body.innerHTML = comment.bodyHtml;
    nodes.push(body);
  }
  nodes.push(reactionsRow(comment.id, comment.reactions, comment.canReact, place.redraw));
  if (asking?.key === 'delete:' + comment.id) nodes.push(askRow(asking));
  return nodes;
}

/** GitHub's reasons to hide a comment, under its Hide button; picking one hides it. */
function openHideMenu(anchor: string, id: string): void {
  const rows = hideReasons.map(([reason, label]) => menuRow([label], false, (on) => {
    if (!on) return;
    closeToolbarMenu();
    post({ action: 'hide-comment', id, hide: true, reason });
  }, true));
  openToolbarMenu(anchor, [el('div', 'muted picker-note', 'Why hide it?'), ...rows], 'hide-menu');
}

/** Show `next` in place of what asked it, until its confirm button or Cancel. */
function askInline(next: Ask): void {
  const before = asking;
  asking = next;
  before?.redraw();
  next.redraw();
  document.querySelector<HTMLElement>('.ask-row button')?.focus();
}

function stopAsking(): void {
  const before = asking;
  asking = undefined;
  before?.redraw();
}

/** The question on the left, Cancel and the confirm button on the right. */
function askRow(ask: Ask): HTMLElement {
  const row = el('div', 'row ask-row');
  const confirm = button(ask.label, () => { stopAsking(); ask.send(); }, 'primary');
  confirm.dataset.prAction = '';
  confirm.disabled = busy;
  const buttons = el('span', 'ask-buttons');
  buttons.append(button('Cancel', stopAsking, 'quiet'), confirm);
  row.append(el('span', 'muted gap', ask.question), buttons);
  return row;
}

/** A question in a menu under the button `anchor`, for buttons with no row to show it in. */
function askInMenu(anchor: string, question: string, label: string, send: () => void): void {
  closeToolbarMenu();
  const confirm = button(label, () => { closeToolbarMenu(); send(); }, 'primary');
  confirm.disabled = busy;
  const row = el('div', 'row ask-actions');
  row.append(button('Cancel', closeToolbarMenu, 'quiet'), confirm);
  openToolbarMenu(anchor, [el('p', 'ask-text', question), row], 'ask-menu');
}

/** A text box for GitHub with Write and Preview tabs, and @mention completion. */
function githubField(key: string, value: string, placeholder: string, onInput: (value: string) => void, onSubmit: () => void, onCancel: () => void): HTMLElement {
  let text = value;
  const wrap = el('div', 'field');
  const draw = (): void => {
    const showing = previewTabs.has(key);
    const tabs = el('div', 'seg field-tabs');
    for (const [label, on] of [['Write', false], ['Preview', true]] as const) {
      const tab = button(label, () => {
        if (on) previewTabs.add(key);
        else previewTabs.delete(key);
        if (on && text.trim() && renderedPreviews.get(key)?.text !== text) {
          renderedPreviews.set(key, { text });
          post({ action: 'markdown', form: key, text });
        }
        draw();
        if (!on) wrap.querySelector('textarea')?.focus();
      });
      tab.setAttribute('aria-pressed', String(showing === on));
      tabs.append(tab);
    }
    if (showing) {
      const box = el('div', 'md-preview msg-text');
      box.dataset.preview = key;
      const shown = renderedPreviews.get(key);
      if (!text.trim()) box.append(el('span', 'muted', 'Nothing to preview.'));
      else if (shown?.html === undefined) box.append(el('span', 'muted', 'Loading preview…'));
      else box.innerHTML = shown.html;
      wrap.replaceChildren(tabs, box);
    } else {
      const area = textarea(key, text, placeholder, (next) => { text = next; onInput(next); }, onSubmit, onCancel);
      attachMentions(area, wrap);
      wrap.replaceChildren(tabs, area);
    }
  };
  draw();
  return wrap;
}

/** People to @mention: who can be assigned, plus everyone on this PR. */
function mentionCandidates(): string[] {
  const names = new Set(pickerOptions?.users ?? []);
  const state = current;
  for (const item of state?.conversation?.timeline ?? []) if (item.kind !== 'event') names.add(item.author);
  for (const thread of state?.github ?? []) for (const entry of thread.messages) names.add(entry.author);
  for (const reviewer of state?.details?.reviewers ?? []) if (reviewer.team === undefined) names.add(reviewer.name);
  if (state) names.add(state.author);
  names.delete('ghost');
  names.delete(state?.conversation?.viewerLogin ?? '');
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** Complete `@name` from `mentionCandidates` while typing; arrows pick, Enter or Tab inserts, Escape closes. */
function attachMentions(area: HTMLTextAreaElement, wrap: HTMLElement): void {
  let list: HTMLElement | undefined;
  let matches: string[] = [];
  let at = 0;
  const close = (): void => { list?.remove(); list = undefined; };
  const query = (): { start: number; text: string } | undefined => {
    const match = /(?:^|[\s(])@([\w-]*)$/u.exec(area.value.slice(0, area.selectionStart));
    const typed = match?.[1];
    return typed === undefined ? undefined : { start: area.selectionStart - typed.length, text: typed.toLowerCase() };
  };
  const choose = (login: string): void => {
    const typed = query();
    if (!typed) return;
    area.setRangeText(login + ' ', typed.start, area.selectionStart, 'end');
    area.dispatchEvent(new Event('input'));
    close();
    area.focus();
  };
  const show = (): void => {
    const typed = query();
    if (!pickerOptions && !mentionsAsked) { mentionsAsked = true; post({ action: 'picker-options' }); }
    matches = typed === undefined ? [] : mentionCandidates().filter((login) => login.toLowerCase().startsWith(typed.text)).slice(0, 8);
    if (!matches.length) { close(); return; }
    at = Math.min(at, matches.length - 1);
    list ??= el('div', 'mentions');
    list.style.top = area.offsetTop + area.offsetHeight + 2 + 'px';
    list.replaceChildren(...matches.map((login, index) => {
      const option = button('@' + login, () => choose(login));
      option.setAttribute('aria-selected', String(index === at));
      option.addEventListener('mousedown', (event) => event.preventDefault());
      return option;
    }));
    wrap.append(list);
  };
  area.addEventListener('input', (event) => { if (event.isTrusted) { at = 0; show(); } });
  area.addEventListener('keydown', (event) => {
    if (!list) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      at = (at + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length;
      show();
    } else if ((event.key === 'Enter' && !event.metaKey && !event.ctrlKey) || event.key === 'Tab') {
      const login = matches[at];
      if (login === undefined) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      choose(login);
    } else if (event.key === 'Escape') {
      event.stopImmediatePropagation();
      close();
    }
  }, { capture: true });
  area.addEventListener('blur', () => { setTimeout(close, 150); });
}

/** Avatars that loaded, held so redraws reuse the decoded picture instead of fetching and blinking. */
const loadedAvatars = new Map<string, HTMLImageElement>();
const failedAvatars = new Set<string>();

/** An avatar image, or initials when the picture is missing or does not load. */
function personAvatar(url: string, name: string | undefined, title: string): HTMLElement {
  const fallback = (): HTMLElement => {
    const letters = name === undefined ? '' : initials(name);
    const node = el('span', 'avatar' + (letters ? ' initials' : ''), letters);
    if (!letters) node.append(icon(codicons.account));
    node.title = title;
    return node;
  };
  if (!url || failedAvatars.has(url)) return fallback();
  const loaded = loadedAvatars.get(url);
  const image = loaded ? loaded.cloneNode() as HTMLImageElement : el('img', 'avatar');
  if (!loaded) {
    image.addEventListener('load', () => { loadedAvatars.set(url, image); }, { once: true });
    image.addEventListener('error', () => { failedAvatars.add(url); image.replaceWith(fallback()); }, { once: true });
    image.src = url;
  }
  image.alt = title;
  image.title = title;
  return image;
}

let conversationStamp = '';

/** The Conversation card: comments, reviews, pushes and events, oldest first, and a box for a new comment. */
function renderConversation(state: OverviewState, force = false): void {
  const stamp = JSON.stringify([asking?.key, conversationFolded, conversationAll, state.conversation, state.conversationError, !!state.details, [...edits], [...revealed], emojiFor, [...previewTabs], [...sending].filter((key) => key === 'conversation' || key.startsWith('edit:'))]);
  if (!force && stamp === conversationStamp) return;
  conversationStamp = stamp;
  const timeline = $('timeline');
  const data = state.conversation;
  const place = (item: Extract<TimelineItem, { kind: 'comment' | 'review' }>): CommentPlace => ({
    kind: item.kind === 'review' ? 'review' : 'issue',
    redraw: () => { if (current) renderConversation(current, true); },
    quote: (text) => {
      conversationDraft = (conversationDraft.trim() ? conversationDraft.replace(/\s*$/u, '\n\n') : '') + text;
      previewTabs.delete('conversation');
      focusNext = 'conversation';
      save();
      if (current) renderConversation(current, true);
    },
  });
  keepView(() => {
    if (!data) {
      timeline.replaceChildren(el('div', 'muted', state.conversationError ? 'Could not load the conversation: ' + state.conversationError : 'Loading conversation…'));
      $('conversation-form').replaceChildren();
      return;
    }
    const nodes: HTMLElement[] = [];
    let commits: Extract<TimelineItem, { kind: 'commit' }>[] = [];
    const flush = (): void => { if (commits.length) nodes.push(commitGroup(commits)); commits = []; };
    for (const item of data.timeline) {
      if (item.kind === 'commit') { commits.push(item); continue; }
      if (item.kind === 'review' && (item.state === 'pending' || (!item.bodyHtml.trim() && item.state === 'commented'))) continue;
      flush();
      if (item.kind === 'event') nodes.push(eventItem(item));
      else nodes.push(commentItem(item, place(item)));
    }
    flush();
    $('conversation').classList.toggle('folded', conversationFolded);
    $('fold-conversation').setAttribute('aria-expanded', String(!conversationFolded));
    $('conversation-count').textContent = nodes.length ? String(nodes.length) : '';
    const hidden = conversationAll ? 0 : Math.max(0, nodes.length - recentEntries - 1);
    const more = button('Show ' + hidden + ' earlier entries', () => { conversationAll = true; if (current) renderConversation(current, true); }, 'quiet');
    more.classList.add('timeline-more');
    timeline.replaceChildren(...nodes.length ? hidden ? [more, ...nodes.slice(hidden)] : nodes : [el('div', 'muted', 'No comments yet.')]);
    renderConversationForm();
  }, $('conversation'));
}

function renderConversationForm(): void {
  const key = 'conversation';
  const submit = (): void => {
    if (!conversationDraft.trim() || sending.has(key)) return;
    sending.add(key);
    $('error').textContent = '';
    if (current) renderConversation(current, true);
    post({ action: 'conversation-comment', form: key, text: conversationDraft });
  };
  const field = githubField(key, conversationDraft, 'Add a comment', (value) => { conversationDraft = value; save(); }, submit, () => undefined);
  const row = el('div', 'row composer-actions');
  const send = button(sending.has(key) ? 'Sending…' : 'Comment', submit, 'primary');
  send.disabled = sending.has(key);
  row.append(el('span', 'gap'), send);
  $('conversation-form').replaceChildren(field, row);
}

function commentItem(item: Extract<TimelineItem, { kind: 'comment' | 'review' }>, place: CommentPlace): HTMLElement {
  const node = el('div', 'timeline-item comment');
  node.id = 'comment-' + item.id;
  const main = el('div', 'msg-main');
  const head = el('div', 'msg-head');
  const verb = item.kind === 'review' ? reviewVerbs[item.state] : 'commented';
  head.append(el('b', '', item.author), el('span', 'verb', verb), ...timeLabel(item.createdAt), ...item.edited ? [el('span', 'edited', '· edited')] : [], commentTools(item, place));
  main.append(head, ...commentBody(item, place));
  node.append(personAvatar(item.avatarUrl, item.authorName ?? item.author, item.author), main);
  return node;
}

function eventItem(item: Extract<TimelineItem, { kind: 'event' }>): HTMLElement {
  const node = el('div', 'timeline-item event');
  const line = el('div');
  line.append(el('b', '', item.actor), ' ' + item.text + ' · ', ...timeLabel(item.createdAt));
  node.append(personAvatar(item.avatarUrl, item.actor, item.actor), line);
  return node;
}

/** Consecutive pushes as one entry, with a button per commit that shows only its changes. */
function commitGroup(commits: readonly Extract<TimelineItem, { kind: 'commit' }>[]): HTMLElement {
  const node = el('div', 'timeline-item commits');
  const mark = el('span', 'avatar');
  mark.append(icon(codicons.gitCommit));
  const authors = [...new Set(commits.map((commit) => commit.author))];
  const main = el('div');
  const last = commits.at(-1);
  main.append(el('b', '', authors.join(', ')), ' added ' + commits.length + (commits.length === 1 ? ' commit · ' : ' commits · '), ...last ? timeLabel(last.createdAt) : []);
  const list = el('div', 'commit-list');
  for (const commit of commits) list.append(commitRow(commit));
  main.append(list);
  node.append(mark, main);
  return node;
}

const checkMarks: Record<NonNullable<Extract<TimelineItem, { kind: 'commit' }>['checks']>, readonly [string, string]> = { success: ['✓', 'ok'], failure: ['✗', 'bad'], pending: ['●', 'wait'] };

function commitRow(commit: Extract<TimelineItem, { kind: 'commit' }>): HTMLElement {
  const row = el('div', 'commit-row');
  row.title = commitTitle(commit);
  const hash = button(commit.oid.slice(0, 7), () => { showCommits(commit.oid, commit.oid); }, 'ref');
  hash.title = 'Show this commit\'s changes';
  row.append(hash, el('span', 'text', commit.headline), ...checkMark(commit));
  return row;
}

function commitTitle(commit: Extract<TimelineItem, { kind: 'commit' }>): string {
  return commit.message ? commit.headline + '\n\n' + commit.message : commit.headline;
}

function checkMark(commit: Extract<TimelineItem, { kind: 'commit' }>): HTMLElement[] {
  if (!commit.checks) return [];
  const [mark, tone] = checkMarks[commit.checks];
  return [el('span', tone, mark)];
}

/** Files, added and removed lines: always three cells, empty when GitHub could not count them. */
function commitStats(commit: Extract<TimelineItem, { kind: 'commit' }>): HTMLElement[] {
  const lines = commit.additions !== undefined && commit.deletions !== undefined;
  return [
    el('span', 'muted num', commit.files === undefined ? '' : commit.files + (commit.files === 1 ? ' file' : ' files')),
    el('span', 'ok num', lines ? '+' + commit.additions : ''),
    el('span', 'bad num', lines ? '−' + commit.deletions : ''),
  ];
}

function commitsOf(state = current): Extract<TimelineItem, { kind: 'commit' }>[] {
  return (state?.conversation?.timeline ?? []).filter((item): item is Extract<TimelineItem, { kind: 'commit' }> => item.kind === 'commit');
}

/** The PR's commits on GitHub, then the worktree's commits GitHub does not have yet, for the range menu and the Files tab. */
function rangeCommits(): Extract<TimelineItem, { kind: 'commit' }>[] {
  const local = (current?.unpushed ?? []).map(({ oid, subject, author, createdAt, files, additions, deletions }) =>
    ({ kind: 'commit' as const, id: oid, oid, headline: subject, message: '', author, avatarUrl: '', createdAt, files, additions, deletions }));
  return [...commitsOf(), ...local];
}

function isUnpushed(oid: string): boolean {
  return current?.unpushed?.some((commit) => commit.oid === oid) === true;
}

/** Show every commit GitHub does not have yet in the Files tab. */
function showUnpushed(): void {
  const first = current?.unpushed?.[0];
  const last = current?.unpushed?.at(-1);
  if (first && last) showCommits(first.oid, last.oid);
}

/** Show the changes of commits `from` to `to` in the Files tab. */
function showCommits(from: string, to: string): void {
  if (from === to) rangeAnchor = from;
  requestFiles({ kind: 'commits', from, to }, whitespace);
  setView('files');
  $('files-bar').scrollIntoView({ block: 'start' });
}

function requestFiles(next: DiffRange, hideWhitespace: boolean): void {
  wantedRange = undefined;
  $('error').textContent = '';
  if ((next.kind !== 'all' || hideWhitespace) && view === 'guide') setView('files');
  post({ action: 'files', range: next, whitespace: hideWhitespace });
}

function sameRange(a: DiffRange, b: DiffRange): boolean {
  return a.kind === b.kind && (a.kind !== 'commits' || (b.kind === 'commits' && a.from === b.from && a.to === b.to));
}

/** What the Files tab shows, for the range button. */
function rangeLabel(shown: DiffRange): string {
  if (shown.kind === 'all') return 'All changes';
  if (shown.kind === 'since') return 'Since your last review';
  if (shown.from !== shown.to) return rangeCount(shown) + ' commits';
  return shown.from.slice(0, 7) + ' ' + (commitHeadline(shown.from) ?? '');
}

/** A commit's title from the PR's commits, or from Claude's local commits before they are pushed. */
function commitHeadline(oid: string): string | undefined {
  return rangeCommits().find((commit) => commit.oid === oid)?.headline
    ?? current?.threads.flatMap((thread) => thread.commits ?? []).find((commit) => commit.oid === oid)?.subject;
}

function rangeCount(shown: Extract<DiffRange, { kind: 'commits' }>): number {
  const commits = rangeCommits();
  return commits.findIndex((commit) => commit.oid === shown.to) - commits.findIndex((commit) => commit.oid === shown.from) + 1;
}

/** What the Files tab shows, for the note above the files: hashes as code, the headline in bold. */
/** The note's first line: the commit's copyable hash and full title, or what the range covers. */
function rangeTitle(shown: DiffRange): (Node | string)[] {
  if (shown.kind === 'all') return ['All changes'];
  if (shown.kind === 'since') return ['Changes since your last review'];
  if (shown.from !== shown.to) return [rangeCount(shown) + ' commits,', commitRef(shown.from), 'to', commitRef(shown.to)];
  const commit = rangeCommits().find((each) => each.oid === shown.from);
  const headline = commitHeadline(shown.from);
  return [commitRef(shown.from), ...headline === undefined ? [] : [el('span', 'headline', headline)], ...commit ? checkMark(commit) : []];
}

function commitRef(oid: string): HTMLButtonElement {
  return copyRef(oid.slice(0, 7), oid, 'commit SHA');
}

/** The note's second line: who made the shown commits and when, and what they change as shown. */
function rangeFacts(shown: DiffRange): (Node | string)[] {
  const commits = rangeCommits();
  const index = (oid: string): number => commits.findIndex((commit) => commit.oid === oid);
  const picked = shown.kind === 'commits' ? commits.slice(index(shown.from), index(shown.to) + 1) : [];
  const facts: (Node | string)[] = [];
  const authors = [...new Set(picked.map((commit) => commit.author))];
  if (authors.length) facts.push(el('b', '', authors.join(', ')), picked.length === 1 ? ' committed ' : ' committed these ');
  const last = picked.at(-1);
  if (last) facts.push(...timeLabel(last.createdAt), ' · ');
  if (files) {
    const added = files.reduce((sum, file) => sum + file.additions, 0);
    const removed = files.reduce((sum, file) => sum + file.deletions, 0);
    facts.push(el('span', 'stat-add', '+' + added), ' ', el('span', 'stat-del', '−' + removed), ' in ' + files.length + (files.length === 1 ? ' file' : ' files'));
  }
  if (facts.at(-1) === ' · ') facts.pop();
  return facts;
}

function hashChip(oid: string): HTMLElement {
  return el('span', 'ref', oid.slice(0, 7));
}

/** The range button, whitespace toggle and the note above the files while they show part of the PR. */
function renderRangeControls(): void {
  const label = rangeLabel(diffRange);
  const range = $('range');
  range.title = label;
  range.querySelector('.range-text')?.replaceChildren(...diffRange.kind === 'commits' && diffRange.from === diffRange.to ? [hashChip(diffRange.from), ' ' + label.slice(8)] : [label]);
  range.classList.toggle('on', diffRange.kind !== 'all');
  $('whitespace').setAttribute('aria-pressed', String(whitespace));
  const note = $('range-note');
  note.hidden = diffRange.kind === 'all';
  if (!note.hidden) {
    const why = atHead ? 'Read marks and comments on the base need all changes.' : 'Comments and read marks need all changes.';
    const title = el('div', 'range-title');
    title.append(...rangeTitle(diffRange));
    const facts = el('div', 'muted range-facts');
    facts.append(...rangeFacts(diffRange));
    const text = el('div', 'gap');
    text.append(title, facts);
    const all = button('Show all changes', () => requestFiles({ kind: 'all' }, whitespace), 'small');
    all.title = why;
    note.replaceChildren(icon(codicons.gitCommit), text, all);
  }
}

/** A checkable row of a toolbar menu; `radio` rows close the menu when picked. */
function menuRow(content: (Node | string)[], checked: boolean, change: (on: boolean) => void, radio = false): HTMLElement {
  const label = el('label', 'picker-row');
  const box = el('input');
  box.type = radio ? 'radio' : 'checkbox';
  box.name = radio ? 'menu' : '';
  box.checked = checked;
  box.addEventListener('change', () => { change(box.checked); });
  const mark = icon(codicons.check);
  mark.classList.add('check');
  const text = el('span', 'text');
  text.append(...content);
  label.append(box, mark, text);
  return label;
}

/** Open a menu under the toolbar button `anchor`, or close it when it is already open. */
function openToolbarMenu(anchor: string, rows: HTMLElement[], className = ''): void {
  const again = toolbarMenu?.anchor === anchor;
  closeToolbarMenu();
  if (again) return;
  const node = el('div', ('picker toolbar-menu ' + className).trim());
  const list = el('div', 'picker-list');
  list.append(...rows);
  node.append(list);
  $(anchor).after(node);
  $(anchor).setAttribute('aria-expanded', 'true');
  toolbarMenu = { anchor, node };
  (node.querySelector<HTMLElement>('input:checked, [aria-checked=true]') ?? node.querySelector<HTMLElement>('input, button'))?.focus();
}

function closeToolbarMenu(): void {
  if (!toolbarMenu) return;
  toolbarMenu.node.remove();
  $(toolbarMenu.anchor).setAttribute('aria-expanded', 'false');
  toolbarMenu = undefined;
}

/** The range menu: all changes, since your last review, or commits; click a commit for its changes, Shift-click another for the commits between. */
function openRangeMenu(): void {
  const commits = rangeCommits();
  const index = (oid: string): number => commits.findIndex((commit) => commit.oid === oid);
  const [low, high] = diffRange.kind === 'commits' ? [index(diffRange.from), index(diffRange.to)] : [-1, -1];
  const pick = (next: DiffRange): void => { closeToolbarMenu(); requestFiles(next, whitespace); };
  const rows = [rangeRow([el('span', 'text', 'All changes'), el('span', 'muted', commits.length === 1 ? '1 commit' : commits.length + ' commits')], diffRange.kind === 'all', () => pick({ kind: 'all' }))];
  if (current?.conversation?.lastReviewedCommit) rows.push(rangeRow([el('span', 'text', 'Since your last review')], diffRange.kind === 'since', () => pick({ kind: 'since' })));
  const unpushed = current?.unpushed ?? [];
  const [firstLocal, lastLocal] = [unpushed[0], unpushed.at(-1)];
  if (firstLocal && lastLocal) {
    const range: DiffRange = { kind: 'commits', from: firstLocal.oid, to: lastLocal.oid };
    rows.push(rangeRow([el('span', 'text', 'Not pushed'), el('span', 'muted', unpushed.length === 1 ? '1 commit' : unpushed.length + ' commits')], sameRange(diffRange, range), () => pick(range)));
  }
  commits.forEach((commit, at) => {
    const local = isUnpushed(commit.oid);
    const row = rangeRow([hashChip(commit.oid), el('span', 'text', commit.headline), ...cell(local ? [el('span', 'chip', 'Not pushed')] : checkMark(commit)), ...commitStats(commit), el('span', 'muted', commit.author), ...cell(timeLabel(commit.createdAt))],
      low >= 0 && at >= low && at <= high, (shift) => {
        const anchor = shift && rangeAnchor !== undefined ? index(rangeAnchor) : -1;
        if (anchor < 0) { rangeAnchor = commit.oid; pick({ kind: 'commits', from: commit.oid, to: commit.oid }); return; }
        const [from, to] = anchor <= at ? [commits[anchor], commit] : [commit, commits[anchor]];
        if (from && to) pick({ kind: 'commits', from: from.oid, to: to.oid });
      });
    row.title = commitTitle(commit);
    row.classList.add('commit');
    if (local) row.classList.add('unpushed');
    rows.push(row);
  });
  const hint = el('div', 'muted menu-hint', commits.length > 1 ? 'Shift-click a second commit to see the commits between.' : current?.conversation ? '' : 'Loading commits…');
  openToolbarMenu('range', hint.textContent ? [...rows, hint] : rows, 'range-menu');
}

/** One grid cell: the node, or an empty one so the columns stay in place. */
function cell(nodes: HTMLElement[]): HTMLElement[] {
  return nodes.length ? nodes : [el('span')];
}

function rangeRow(content: Node[], checked: boolean, choose: (shift: boolean) => void): HTMLElement {
  const row = el('button', 'picker-row range-row');
  row.setAttribute('role', 'menuitemcheckbox');
  row.setAttribute('aria-checked', String(checked));
  const mark = icon(codicons.check);
  mark.classList.add('check');
  row.append(mark, ...content);
  row.addEventListener('click', (event) => { choose(event.shiftKey); });
  return row;
}

/** Whether lines on `side` can take comments, read marks and threads in the shown range. */
function linesFit(side: DiffSide): boolean {
  return atHead && (side === 'new' || diffRange.kind === 'all');
}

function fileType(path: string): string {
  const name = path.split('/').at(-1) ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : 'No extension';
}

/** Files the filter box, the type menu and Hide viewed leave on the page. */
function filteredFiles(list: readonly FileDiff[]): readonly FileDiff[] {
  const query = fileFilter.trim().toLowerCase();
  return list.filter((file) => (!query || file.path.toLowerCase().includes(query) || (file.oldPath?.toLowerCase().includes(query) ?? false))
    && !hiddenTypes.has(fileType(file.path)) && !(hideViewed && viewed.has(file.path)));
}

function filtersOn(): boolean {
  return fileFilter.trim() !== '' || hiddenTypes.size > 0 || hideViewed;
}

function applyFilters(): void {
  save();
  renderFiles();
  $('filter-menu').setAttribute('aria-pressed', String(filtersOn()));
  $('filter-clear').hidden = fileFilter === '';
}

function openFilterMenu(): void {
  const types = [...new Set((files ?? []).map((file) => fileType(file.path)))].sort();
  const rows = types.map((type) => menuRow([type, el('span', 'muted', String((files ?? []).filter((file) => fileType(file.path) === type).length))], !hiddenTypes.has(type),
    (on) => { if (on) hiddenTypes.delete(type); else hiddenTypes.add(type); applyFilters(); }));
  rows.push(menuRow(['Hide viewed files'], hideViewed, (on) => { hideViewed = on; applyFilters(); }));
  const reset = button('Clear filters', () => { clearFilters(); closeToolbarMenu(); }, 'small');
  reset.disabled = !filtersOn();
  const foot = el('div', 'menu-foot');
  foot.append(reset);
  openToolbarMenu('filter-menu', [...rows, foot]);
}

function clearFilters(): void {
  fileFilter = '';
  $<HTMLInputElement>('file-filter').value = '';
  hiddenTypes.clear();
  hideViewed = false;
  applyFilters();
}

/** Default merge commit wording, as the repository's settings tell GitHub to fill it in. */
function mergeDefaults(method: MergeMethod): { readonly headline: string; readonly body: string } {
  const state = current;
  const details = state?.details;
  const defaults = state?.conversation?.commitDefaults;
  if (!state || !details || !defaults) return { headline: '', body: '' };
  const suffix = state.number === undefined ? '' : ' (#' + state.number + ')';
  const commits = commitsOf(state);
  if (method === 'squash') {
    const [only] = commits.length === 1 ? commits : [];
    const headline = (defaults.squashTitle === 'COMMIT_OR_PR_TITLE' && only ? only.headline : details.title) + suffix;
    const body = defaults.squashBody === 'PR_BODY' ? details.body : defaults.squashBody === 'BLANK' ? ''
      : commits.map((commit) => '* ' + commit.headline + (commit.message.trim() ? '\n\n' + commit.message.trim() : '')).join('\n\n');
    return { headline, body };
  }
  const owner = details.headRepository?.split('/')[0] ?? new URL(state.url).pathname.split('/')[1] ?? '';
  const headline = defaults.mergeTitle === 'PR_TITLE' ? details.title + suffix : 'Merge pull request #' + (state.number ?? '') + ' from ' + owner + ':' + state.headBranch;
  const body = defaults.mergeBody === 'PR_TITLE' ? details.title : defaults.mergeBody === 'PR_BODY' ? details.body : '';
  return { headline, body };
}

/** Open the commit fields above the merge row; the clicked button turns into its own confirm button. */
function openMergeForm(auto: boolean): void {
  mergeForm = { auto, openedAt: Date.now() };
  const { headline, body } = mergeDefaults(mergeMethod);
  const title = $<HTMLInputElement>('merge-headline');
  $<HTMLTextAreaElement>('merge-body').value = body;
  title.value = headline;
  $('merge-form').hidden = mergeMethod === 'rebase';
  $<HTMLInputElement>('merge-delete').checked = false;
  drawMergeButtons();
  (mergeMethod === 'rebase' ? $(auto ? 'auto-merge' : 'merge') : title).focus();
}

function closeMergeForm(): void {
  mergeForm = undefined;
  $('merge-form').hidden = true;
  drawMergeButtons();
}

/** The merge row's buttons, as the open form and GitHub's merge state allow. */
function drawMergeButtons(): void {
  const merge = current?.conversation?.merge;
  const form = mergeForm;
  const mergeButton = $('merge');
  mergeButton.textContent = form?.auto === false ? 'Confirm ' + methodLabels[mergeMethod].toLowerCase() : merge?.mergeQueue ? 'Merge when ready' : 'Merge';
  mergeButton.classList.toggle('primary', form?.auto === false);
  mergeButton.hidden = form?.auto === true;
  const auto = $('auto-merge');
  auto.textContent = form?.auto ? 'Confirm auto-merge' : 'Enable auto-merge';
  auto.className = form?.auto ? 'primary' : 'quiet';
  auto.hidden = form ? !form.auto : !merge?.canEnableAutoMerge || merge.autoMerge !== undefined || merge.state === 'clean' || merge.mergeQueue;
  $('merge-cancel').hidden = !form;
  $('merge-delete-label').hidden = form?.auto !== false || current?.details?.branchDeletable !== true;
  $('method-text').textContent = methodLabels[mergeMethod];
}

/** Open the merge form on the first click and merge on the second; a double-click's second click does nothing. */
function clickMerge(auto: boolean): void {
  if (mergeForm?.auto !== auto) { openMergeForm(auto); return; }
  if (Date.now() - mergeForm.openedAt < 400) return;
  const message = mergeMethod === 'rebase' ? {} : { headline: $<HTMLInputElement>('merge-headline').value, body: $<HTMLTextAreaElement>('merge-body').value };
  if (auto) changePullRequest({ action: 'auto-merge', method: mergeMethod, ...message });
  else changePullRequest({ action: 'merge', method: mergeMethod, ...message, deleteBranch: $<HTMLInputElement>('merge-delete').checked && current?.details?.branchDeletable === true });
}

function openMethodMenu(): void {
  const methods = current?.details?.mergeMethods ?? [];
  openToolbarMenu('method', methods.map((method) => menuRow([methodLabels[method]], method === mergeMethod, (on) => {
    if (!on) return;
    mergeMethod = method;
    closeToolbarMenu();
    if (mergeForm) openMergeForm(mergeForm.auto);
    else drawMergeButtons();
  }, true)), 'method-menu');
}

function openUpdateMenu(): void {
  const update = (method: 'merge' | 'rebase'): void => { closeToolbarMenu(); changePullRequest({ action: 'update-branch', method }); };
  openToolbarMenu('update-branch', [
    menuRow(['Update with merge commit'], false, (on) => { if (on) update('merge'); }, true),
    menuRow([el('span', '', 'Update with rebase'), el('span', 'muted', 'Rewrites commits')], false, (on) => { if (on) update('rebase'); }, true),
  ], 'update-menu');
}

/** Swap the title for a text field with Cancel and Save. */
function editTitle(): void {
  const input = el('input');
  input.type = 'text';
  input.maxLength = 256;
  input.value = current?.details?.title ?? current?.title ?? '';
  input.setAttribute('aria-label', 'Title');
  const submit = (): void => {
    if (!input.value.trim()) { input.focus(); return; }
    changePullRequest({ action: 'edit-title', title: input.value });
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); submit(); } else if (event.key === 'Escape') closeTitleForm();
  });
  const saveButton = button('Save', submit, 'primary');
  saveButton.dataset.prAction = '';
  const form = el('span', 'title-form');
  form.id = 'title-form';
  form.append(input, button('Cancel', closeTitleForm, 'quiet'), saveButton);
  $('title').hidden = true;
  $('edit-title').hidden = true;
  $('title').after(form);
  input.focus();
  input.select();
}

function closeTitleForm(): void {
  document.getElementById('title-form')?.remove();
  $('title').hidden = false;
  $('edit-title').hidden = current?.details?.canEdit !== true;
}

/** GitHub's merge box checklist: reviews, checks and branch protection. */
function mergeChecklist(details: PullRequestDetails, conversation: PullRequestConversation): HTMLLIElement[] {
  const rows: HTMLLIElement[] = [];
  const add = (tone: string, mark: string, text: string): void => {
    const row = el('li');
    row.append(el('span', tone, mark), el('span', '', text));
    rows.push(row);
  };
  const { merge } = conversation;
  if (merge.reviewDecision === 'approved') add('ok', '✓', 'Approved');
  else if (merge.reviewDecision === 'changes') add('bad', '✗', 'Changes requested');
  else if (merge.reviewDecision === 'required') add('wait', '●', 'Review required');
  const required = new Set(conversation.checks.filter((check) => check.required).map((check) => check.name));
  const failing = details.checks.filter((check) => check.state === 'failure');
  const running = details.checks.filter((check) => check.state === 'pending');
  if (failing.length) add('bad', '✗', failing.length + (failing.length === 1 ? ' failing check' : ' failing checks') + (failing.some((check) => required.has(check.name)) ? ', some required' : ''));
  else if (running.length) add('wait', '●', running.length + (running.length === 1 ? ' check running' : ' checks running'));
  else if (details.checks.length) add('ok', '✓', 'All checks passed');
  if (merge.state === 'blocked') add('bad', '✗', 'Merging is blocked' + (merge.canBypass ? '. You may merge anyway, bypassing the rules.' : '.'));
  return rows;
}

/** Commit and Add to batch for a GitHub suggestion the viewer can push. */
function suggestionRow(thread: Extract<Thread, { source: 'github' }>, entry: GitHubMessageView): HTMLElement | undefined {
  const details = current?.details;
  if (!entry.suggestion || thread.outdated || thread.side !== 'new' || !details?.canEdit || !details.open || hiddenComment(entry)) return undefined;
  const row = el('div', 'row suggest-row');
  const picked = batch.has(entry.id);
  const toggle = button(picked ? 'Remove from batch' : 'Add to batch', () => {
    if (picked) batch.delete(entry.id);
    else batch.set(entry.id, { thread: thread.id, comment: entry.id });
    renderBatch();
    renderFiles([thread.path]);
  });
  const commit = button('Commit suggestion', () => changePullRequest({ action: 'commit-suggestions', picked: [{ thread: thread.id, comment: entry.id }] }), 'primary');
  commit.dataset.prAction = '';
  commit.disabled = busy;
  commit.title = 'Commits the change to the PR branch and pushes it.';
  row.append(el('span', 'gap'), toggle, commit);
  return row;
}

function hiddenComment(entry: { readonly id: string; readonly hidden?: string }): boolean {
  return entry.hidden !== undefined && !revealed.has(entry.id);
}

function renderBatch(): void {
  const node = $<HTMLButtonElement>('commit-batch');
  node.hidden = batch.size === 0;
  node.textContent = 'Commit ' + batch.size + (batch.size === 1 ? ' suggestion' : ' suggestions');
}

/** One GitHub annotation from a check, under the line it points at. */
function annotationBox(note: Annotation & { readonly check: string }): HTMLElement {
  const box = el('div', 'annotation-box ' + note.level);
  box.append(icon(note.level === 'failure' ? codicons.error : note.level === 'warning' ? codicons.warning : codicons.info));
  const text = el('div');
  text.append(el('b', '', (note.title || note.check) + ' '), el('span', 'muted', note.title ? note.check : ''), el('div', '', note.message));
  box.append(text);
  return box;
}

function annotationsOf(path: string): (Annotation & { readonly check: string })[] {
  if (!atHead) return [];
  return (current?.conversation?.checks ?? []).flatMap((check) => check.annotations.filter((note) => note.path === path).map((note) => ({ ...note, check: check.name })));
}

const shortcuts = 'j / k next or previous file · n / p next or previous comment · v toggle Viewed · t filter files · ? this list';

/** j/k move between files, n/p between comments, v ticks Viewed on the file at the top, t filters files. */
function onShortcut(event: KeyboardEvent): void {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)) return;
  const top = $('files-bar').getBoundingClientRect().bottom + 4;
  const step = (selector: string, forward: boolean): void => {
    const nodes = [...document.querySelectorAll<HTMLElement>(selector)];
    const index = nodes.findIndex((node) => node.getBoundingClientRect().top > top + 1);
    const next = forward ? nodes[index < 0 ? nodes.length : index] : nodes[(index < 0 ? nodes.length : index) - 2];
    const fallback = forward ? undefined : nodes[0];
    (next ?? fallback)?.scrollIntoView({ block: 'start' });
  };
  if (event.key === 'j' || event.key === 'k') step('#files .file', event.key === 'j');
  else if (event.key === 'n' || event.key === 'p') {
    const nodes = [...document.querySelectorAll<HTMLElement>('#files details.thread')];
    const middle = window.innerHeight / 2;
    const index = nodes.findIndex((node) => node.getBoundingClientRect().top > middle + 1);
    const next = event.key === 'n' ? nodes[index < 0 ? nodes.length : index] : nodes[(index < 0 ? nodes.length : index) - 2] ?? nodes[0];
    next?.scrollIntoView({ block: 'center' });
  } else if (event.key === 'v') {
    const box = [...document.querySelectorAll<HTMLElement>('#files .file')].find((node) => node.getBoundingClientRect().bottom > top);
    box?.querySelector<HTMLInputElement>('label.viewed input')?.click();
  } else if (event.key === 't') { event.preventDefault(); $('file-filter').focus(); }
  else if (event.key === '?') showNotice({ text: shortcuts });
  else return;
}

function baseButton(): HTMLElement {
  const edit = toolButton(codicons.edit, 'Change base branch', openBaseMenu);
  edit.id = 'change-base';
  edit.classList.add('icon-button');
  edit.dataset.prAction = '';
  edit.setAttribute('aria-haspopup', 'true');
  const anchor = el('span', 'menu-anchor');
  anchor.append(edit);
  return anchor;
}

/** The reviewers and their tools, with the dismiss form under the reviewer it is open for; redrawn only when they change, so the form keeps its focus. */
function renderReviewers(state: OverviewState, force = false): void {
  const { details, conversation } = state;
  const stamp = JSON.stringify([details?.reviewers, details?.canEdit, details?.open, conversation?.reviewIds, conversation?.viewerLogin, conversation?.permission, dismissing?.login]);
  if (!force && stamp === reviewersStamp) return;
  reviewersStamp = stamp;
  const reviewers = $('reviewers');
  reviewers.replaceChildren();
  if (!details) return;
  for (const reviewer of details.reviewers) {
    const tools: HTMLElement[] = [];
    if (details.canEdit && details.open && reviewer.team === undefined && reviewer.state !== 'requested' && reviewer.name !== conversation?.viewerLogin) {
      const again = toolButton(codicons.sync, 'Re-request review', () => changePullRequest({ action: 'rerequest', login: reviewer.name }));
      again.dataset.prAction = '';
      tools.push(again);
    }
    if (isWriter(conversation) && details.open && (reviewer.state === 'approved' || reviewer.state === 'changes') && conversation?.reviewIds[reviewer.name] !== undefined) {
      const dismiss = toolButton(codicons.close, 'Dismiss review', () => {
        dismissing = { login: reviewer.name, text: '' };
        renderReviewers(state, true);
        $('reviewers').querySelector('textarea')?.focus();
      });
      dismiss.dataset.prAction = '';
      tools.push(dismiss);
    }
    reviewers.append(status(reviewer.state, reviewer.name, undefined, tools));
    if (dismissing?.login === reviewer.name) reviewers.append(dismissForm(dismissing));
  }
  if (!details.reviewers.length) reviewers.append(el('li', 'muted', 'No reviewers yet.'));
}

function dismissForm(form: { readonly login: string; text: string }): HTMLElement {
  const close = (): void => { dismissing = undefined; if (current) renderReviewers(current, true); };
  const submit = (): void => {
    if (!form.text.trim()) { area.focus(); return; }
    changePullRequest({ action: 'dismiss-review', login: form.login, text: form.text });
  };
  const area = textarea('dismiss', form.text, 'Why dismiss it? Everyone on the PR sees this.', (value) => { form.text = value; }, submit, close);
  const send = button('Dismiss review', submit, 'primary');
  send.dataset.prAction = '';
  const row = el('div', 'row ask-row');
  row.append(el('span', 'gap'), button('Cancel', close, 'quiet'), send);
  const item = el('li', 'dismiss-form');
  item.append(area, row);
  return item;
}

/** The base branch menu: a filter over the branches the PR could merge into; GitHub's list arrives after it opens. */
function openBaseMenu(): void {
  if (busy) return;
  const search = el('input');
  search.type = 'text';
  search.placeholder = 'Filter branches';
  search.setAttribute('aria-label', 'Filter branches');
  search.addEventListener('input', () => renderBaseMenu());
  openToolbarMenu('change-base', [search, el('div', 'muted picker-note', 'Loading…')], 'base-menu');
  if (toolbarMenu?.anchor !== 'change-base') return;
  search.focus();
  baseBranches = undefined;
  post({ action: 'branches' });
}

let baseBranches: readonly string[] | string | undefined;

function renderBaseMenu(): void {
  const list = toolbarMenu?.anchor === 'change-base' ? toolbarMenu.node.querySelector('.picker-list') : null;
  const search = list?.querySelector('input');
  if (!list || !search) return;
  const query = search.value.trim().toLowerCase();
  const names = typeof baseBranches === 'string' || baseBranches === undefined ? [] : baseBranches.filter((name) => name.toLowerCase().includes(query));
  const rows = names.slice(0, 200).map((name) => menuRow([name], false, (on) => {
    if (on) askInMenu('change-base', 'Change the base branch to ' + name + '? The diff and checks follow.', 'Change base', () => changePullRequest({ action: 'change-base', branch: name }));
  }, true));
  const note = typeof baseBranches === 'string' ? 'Could not load branches: ' + baseBranches : baseBranches === undefined ? 'Loading…' : names.length ? '' : query ? 'No matches.' : 'No other branches.';
  list.replaceChildren(search, ...rows, ...note ? [el('div', 'muted picker-note', note)] : []);
}

function render(state: OverviewState): void {
  current = state;
  $('number').replaceChildren(...state.number === undefined ? [] : [copyRef('#' + state.number, state.url, 'link to the pull request')]);
  $('title').textContent = state.heading ?? state.title;
  const canChangeBase = state.details?.canEdit === true && state.details.open;
  const byline = JSON.stringify([state.author, state.headBranch, state.baseBranch, canChangeBase]);
  if ($('byline').dataset.stamp !== byline) {
    $('byline').dataset.stamp = byline;
    if (toolbarMenu?.anchor === 'change-base') closeToolbarMenu();
    if (state.local) $('byline').replaceChildren('Uncommitted changes on', branchRef(state.headBranch));
    else $('byline').replaceChildren(state.author + ' wants to merge', branchRef(state.headBranch), 'into', branchRef(state.baseBranch), ...canChangeBase ? [baseButton()] : []);
  }
  $('facts').replaceChildren(...pullRequestFacts(state));
  const { details } = state;
  const body = $('body');
  if (!details) body.replaceChildren(el('span', 'muted', state.detailsError ? 'Could not load from GitHub: ' + state.detailsError : 'Loading from GitHub…'));
  else if (!editingBody && details.bodyHtml.trim()) body.innerHTML = details.bodyHtml;
  else if (!editingBody) body.replaceChildren(el('span', 'muted', 'No description.'));
  renderReviewers(state);
  const checks = $('checks');
  checks.replaceChildren();
  if (details) {
    const extras = new Map((state.conversation?.checks ?? []).map((check) => [check.name, check]));
    for (const check of details.checks) {
      const extra = extras.get(check.name);
      const tools: HTMLElement[] = [];
      if (extra?.required) tools.push(el('span', 'file-chip', 'Required'));
      const runId = extra?.runId;
      if (check.state === 'failure' && runId !== undefined && isWriter(state.conversation)) {
        const rerun = toolButton(codicons.sync, 'Re-run failed jobs', () => changePullRequest({ action: 'rerun', run: runId }));
        rerun.dataset.prAction = '';
        tools.push(rerun);
      }
      checks.append(status(check.state, check.name, check.url, tools));
    }
    if (!details.checks.length) checks.append(el('li', 'muted', 'No checks.'));
  }
  for (const id of ['pick-reviewers', 'pick-assignees', 'pick-labels', 'pick-milestone']) $(id).hidden = !details?.canEdit;
  $('edit-title').hidden = !details?.canEdit || document.getElementById('title-form') !== null;
  $('milestone').replaceChildren(...details ? [details.milestone ? el('span', '', details.milestone.title) : el('span', 'muted', 'No milestone.')] : []);
  const linked = state.conversation?.linkedIssues ?? [];
  $('development').hidden = linked.length === 0;
  $('linked-issues').replaceChildren(...linked.map((issue) => {
    const item = el('li', 'row');
    const link = el('a', '', '#' + issue.number + ' ' + issue.title);
    link.href = issue.url;
    item.append(el('span', issue.open ? 'ok' : 'muted', issue.open ? '○' : '✓'), link);
    item.title = issue.open ? 'Open; merging this PR closes it' : 'Closed';
    return item;
  }));
  const awaiting = state.conversation?.awaitingApproval.length ?? 0;
  $('awaiting').hidden = awaiting === 0;
  $('awaiting-note').textContent = awaiting + (awaiting === 1 ? ' workflow waits' : ' workflows wait') + ' for approval to run.';
  const descriptionReactions = $('description-reactions');
  const description = state.conversation?.description;
  const drawReactions = (): void => {
    if (description) descriptionReactions.replaceChildren(reactionsRow(description.id, description.reactions, description.canReact, drawReactions));
    else descriptionReactions.replaceChildren();
  };
  drawReactions();
  renderConversation(state);
  renderRangeControls();
  renderBatch();
  if (wantedRange !== undefined && (state.conversation || state.conversationError)) {
    const next = wantedRange;
    wantedRange = undefined;
    if (state.conversation && !sameRange(next, diffRange)) requestFiles(next, whitespace);
  }
  $('edit-body').hidden = !details?.canEdit || editingBody;
  $('assignees').replaceChildren(...details?.assignees.length ? details.assignees.map((name) => el('li', '', name)) : details ? [el('li', 'muted', 'Nobody assigned.')] : []);
  $('labels').replaceChildren(...details?.labels.length ? details.labels.map((label) => {
    const chip = el('span', 'label', label.name);
    chip.style.setProperty('--label', '#' + label.color);
    return chip;
  }) : details ? [el('span', 'muted', 'No labels.')] : []);
  const reviewed = $('reviewed');
  reviewed.replaceChildren();
  if (state.reviewed) {
    const wrap = el('div', 'bar');
    const fill = el('span');
    fill.style.width = (state.reviewed.total ? 100 * state.reviewed.done / state.reviewed.total : 0) + '%';
    wrap.append(fill);
    reviewed.append(wrap, el('span', '', state.reviewed.done + '/' + state.reviewed.total + ' viewed'));
  }
  const claude = $('claude');
  const terminal = $('terminal');
  const progress = state.claude.running ? state.claude.progress : undefined;
  claude.after(terminal);
  if (progress === undefined) claude.textContent = state.claude.text;
  else claude.replaceChildren(stepLog(progress.steps, progress.startedAt), terminal);
  claude.className = progress !== undefined ? 'claude-box' : state.claude.running ? 'chip claude working' : 'chip';
  $('retry').hidden = !state.claude.retry;
  terminal.className = state.claude.running ? 'small' : 'quiet';
  terminal.textContent = state.claude.running ? 'Stop and open in terminal' : 'Open in terminal';
  terminal.dataset.tip = state.claude.running ? 'Stops Claude\'s background run, then continues its conversation in a terminal' : 'Continue this PR\'s Claude conversation in a terminal';
  if (state.local) {
    terminal.textContent = 'Connect Claude';
    terminal.dataset.tip = 'Start or attach the Claude Code session that gets your comments';
  }
  const unpushed = state.unpushed?.length ?? 0;
  const push = $('push');
  push.hidden = !unpushed || !details?.canEdit;
  push.textContent = 'Push ' + unpushed + (unpushed === 1 ? ' commit' : ' commits');
  $('show-unpushed').hidden = !unpushed;
  renderThreadList();
  author = !details || details.viewerIsAuthor;
  setBusy(busy);
  for (const review of document.querySelectorAll<HTMLButtonElement>('[data-reviewer]')) review.hidden = author;
  document.querySelector<HTMLButtonElement>('[data-event="comment"]')?.classList.toggle('primary', author);
  $('review-note').textContent = author ? 'This is your PR, so you can only comment.' : '';
  const pendingCount = details?.pendingComments;
  $('discard-review').hidden = pendingCount === undefined;
  $('pending-note').textContent = pendingCount !== undefined
    ? 'Your pending review has ' + pendingCount + ' comment' + (pendingCount === 1 ? '' : 's') + '. Only you see ' + (pendingCount === 1 ? 'it' : 'them') + ' until you submit.'
    : '';
  const badge = $('verdict');
  badge.hidden = !details;
  if (details) {
    const [tone, label] = verdict(details.reviewers);
    badge.className = 'verdict ' + tone;
    badge.textContent = label;
  }
  $('review-box').hidden = !details?.open;
  $('merge-box').hidden = !details;
  if (details) {
    renderState(details);
  }
  const next = new Set(state.viewed);
  for (const path of next) if (!viewed.has(path)) collapsed.set(path, true);
  for (const path of viewed) if (!next.has(path)) collapsed.set(path, false);
  viewed = next;
  save();
  readRanges = state.read;
  const { analysis } = state;
  const analyze = $<HTMLButtonElement>('analyze');
  analyze.textContent = analysis.running ? 'Stop' : analysis.result ? 'Rebuild guide' : 'Build guide';
  const analysisStatus = $('analysis-status');
  analysisStatus.textContent = analysis.running ? 'Guide · ' + (analysis.step ?? 'Working') : analysis.error ? 'Guide failed' : '';
  analysisStatus.title = analysis.error ?? '';
  analysisStatus.className = analysis.running ? 'chip claude working' : analysis.error ? 'chip bad' : '';
  analysisStatus.hidden = !analysis.running && !analysis.error;
  const stamp = JSON.stringify([analysis.result?.createdAt, analysis.stale, analysis.result ? null : [analysis.running, analysis.error]]);
  if (stamp !== guideStamp) {
    guideStamp = stamp;
    guide = undefined;
    if (view === 'guide') { renderFiles(); return; }
  }
  renderFiles('state');
}

function code(line: DiffLine, side: '' | 'add' | 'del'): HTMLTableCellElement {
  const cell = el('td', 'code' + (side ? ' ' + side : ''));
  cell.innerHTML = line.html;
  if (line.kind !== 'del' && line.newLine !== undefined) cell.dataset.line = String(line.newLine);
  return cell;
}

function num(value: number | undefined, path: string, side: DiffSide): HTMLTableCellElement {
  const cell = el('td', 'num', value === undefined ? '' : String(value));
  if (value !== undefined && linesFit(side)) {
    cell.classList.add('pick');
    cell.dataset.path = path;
    cell.dataset.side = side;
    cell.title = 'Comment on this line. Drag or Shift-click to select a range.';
    cell.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      drag = { path, side, from: value, to: value };
      paintDrag();
    });
    cell.addEventListener('mouseenter', () => {
      if (drag && drag.path === path && drag.side === side && drag.to !== value) { drag.to = value; paintDrag(); }
    });
  }
  return cell;
}

function paintDrag(): void {
  for (const cell of document.querySelectorAll('.drag-sel')) cell.classList.remove('drag-sel');
  if (!drag) return;
  const low = Math.min(drag.from, drag.to);
  const high = Math.max(drag.from, drag.to);
  for (const cell of document.querySelectorAll<HTMLElement>('td.num.pick')) {
    const line = Number(cell.textContent);
    if (cell.dataset.path !== drag.path || cell.dataset.side !== drag.side || line < low || line > high) continue;
    cell.classList.add('drag-sel');
    const codeCell = layout === 'split' ? cell.nextElementSibling : cell.parentElement?.lastElementChild;
    codeCell?.classList.add('drag-sel');
  }
}

document.addEventListener('mouseup', (event) => {
  if (!drag) return;
  const { path, side, from, to } = drag;
  drag = undefined;
  paintDrag();
  if (from === to) pick(path, side, from, event.shiftKey);
  else {
    pick(path, side, Math.min(from, to), false).end = Math.max(from, to);
    save();
    renderFiles([path]);
  }
});

function pick(path: string, side: DiffSide, line: number, extend: boolean): Composer {
  const before = composer?.path;
  if (extend && composer?.path === path && composer.side === side) {
    composer.start = Math.min(composer.start, line);
    composer.end = Math.max(composer.end, line);
  } else {
    composer = { path, side, start: line, end: line, text: composer?.text ?? '', target: composer?.target ?? 'claude' };
  }
  focusNext = 'composer';
  save();
  renderFiles([before, path]);
  return composer;
}

function range(start: number, end: number): string {
  return start === end ? 'Line ' + start : 'Lines ' + start + '–' + end;
}

function textarea(key: string, value: string, placeholder: string, onInput: (value: string) => void, onSubmit: () => void, onCancel: () => void): HTMLTextAreaElement {
  const area = el('textarea');
  area.value = value;
  area.placeholder = placeholder;
  area.dataset.draft = key;
  area.setAttribute('aria-label', placeholder);
  area.addEventListener('input', () => onInput(area.value));
  area.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); onSubmit(); } else if (event.key === 'Escape') onCancel();
  });
  return area;
}

function composerBox(draft: Composer): HTMLElement {
  const github = draft.target === 'github' && !current?.local;
  const box = el('div', 'thread draft' + (github ? ' github' : ''));
  const head = el('div', 'strip');
  const toggle = el('span', 'seg');
  toggle.hidden = current?.local === true;
  toggle.setAttribute('role', 'group');
  toggle.setAttribute('aria-label', 'Who sees this comment');
  for (const [value, label] of [['claude', 'Local'], ['github', 'On GitHub']] as const) {
    const on = draft.target === value || (!draft.target && value === 'claude');
    const option = button(label, () => { draft.target = value; focusNext = 'composer'; save(); renderFiles([draft.path]); });
    option.setAttribute('aria-pressed', String(on));
    toggle.append(option);
  }
  const lines = el('span', 'muted', (draft.side === 'old' ? 'Base · ' : '') + range(draft.start, draft.end));
  head.append(el('span', 'source', 'New comment'), toggle, lines);
  box.append(head);
  const cancel = (): void => { composer = undefined; save(); renderFiles([draft.path]); };
  const send = (pending: boolean, intent: Intent = 'ask'): void => {
    if (!draft.text.trim() || sending.has('composer')) return;
    sending.add('composer');
    sentPending = pending;
    $('error').textContent = '';
    renderFiles([draft.path]);
    const where = { form: 'composer', path: draft.path, side: draft.side, startLine: draft.start, endLine: draft.end, text: draft.text } as const;
    post(github ? { action: 'github-comment', pending, ...where } : { action: 'comment', intent, ...where });
  };
  const submit = (): void => send(true);
  const selection: LineRange = { path: draft.path, side: draft.side, startLine: draft.start, endLine: draft.end };
  const file = files?.find((item) => item.path === selection.path);
  const covered = file ? selectedReadIds(file, selection) : undefined;
  const read = el('label', 'check');
  const readBox = el('input');
  readBox.type = 'checkbox';
  readBox.checked = covered !== undefined;
  read.title = 'Collapse these lines. When every change in the file is read, the file is marked Viewed.';
  read.append(readBox, 'Viewed');
  readBox.addEventListener('change', () => {
    if (readBox.checked) {
      const done = !!file && !viewed.has(file.path) && fullyRead(file, [...readRanges, selection]);
      readRanges = [...readRanges, { id: 'pending', ...selection }];
      if (done) markViewed(selection.path, true);
      post({ action: 'read', ...selection, viewed: done });
    } else if (covered) unmarkRead(covered);
    if (readBox.checked && !draft.text.trim()) composer = undefined;
    save();
    renderFiles([selection.path]);
  });
  const cancelLink = button('Cancel', cancel, 'quiet');
  const needText: HTMLButtonElement[] = [];
  const onDraft = (value: string): void => { draft.text = value; save(); for (const each of needText) each.disabled = sending.has('composer') || !value.trim(); };
  const area = github ? githubField('composer', draft.text, 'Comment on GitHub', onDraft, submit, cancel) : textarea('composer', draft.text, 'Ask Claude about these lines', onDraft, submit, cancel);
  const busySending = sending.has('composer');
  const row = el('div', 'row actions composer-actions');
  if (github) {
    const review = button(busySending && sentPending ? 'Sending…' : 'Add to review', () => send(true), 'primary');
    review.disabled = busySending;
    review.title = 'Goes into your pending review. Nobody sees it until you submit the review.';
    const reviewing = current?.details?.pendingComments !== undefined;
    const now = button(busySending && !sentPending ? 'Sending…' : 'Post now', () => send(false));
    now.disabled = busySending || reviewing;
    now.title = reviewing ? 'You have a review in progress, so GitHub adds new comments to it. Submit the review to publish them.' : 'Posts on GitHub right away.';
    row.append(...reviewing ? [el('span', 'hint', 'Your review is in progress, so comments go into it.')] : [], el('span', 'gap'), cancelLink, now, review);
  } else {
    const implement = button('Implement', () => send(true, 'implement'));
    implement.title = 'Claude changes the code';
    const ask = button(busySending ? 'Sending…' : 'Ask Claude', submit, 'claude');
    ask.title = 'Claude answers without editing';
    needText.push(implement, ask);
    onDraft(draft.text);
    row.append(el('span', 'gap'), cancelLink, implement, ask);
  }
  const original = draft.side === 'new' ? selectedText(draft.path, draft.start, draft.end) : undefined;
  if (original !== undefined) {
    const suggest = button('Suggest change', () => {
      draft.text = (draft.text.trim() ? draft.text.replace(/\s*$/u, '\n\n') : '') + '```suggestion\n' + original + '\n```\n';
      focusNext = 'composer';
      save();
      renderFiles([draft.path]);
    }, 'quiet small');
    suggest.title = 'Start a suggestion from these lines. On GitHub it becomes a change the author can commit.';
    lines.before(suggest);
  }
  if (diffRange.kind === 'all') head.append(read);
  box.append(area, row);
  return box;
}

/** "just now", "5m ago", "3h ago", "2d ago", then the date. */
function relativeTime(iso: string): string {
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + 'm ago';
  if (minutes < 24 * 60) return Math.floor(minutes / 60) + 'h ago';
  if (minutes < 30 * 24 * 60) return Math.floor(minutes / (24 * 60)) + 'd ago';
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "Opened 3d ago · Updated 2h ago · +312 −48 in 14 files", leaving out what GitHub did not send. */
function pullRequestFacts(state: OverviewState): (string | Node)[] {
  const parts: (string | Node)[][] = [];
  if (state.createdAt) parts.push(['Opened ', ...timeLabel(state.createdAt)]);
  if (state.updatedAt) parts.push(['Updated ', ...timeLabel(state.updatedAt)]);
  if (state.changes) {
    const { additions, deletions, files } = state.changes;
    parts.push([el('span', 'stat-add', '+' + additions), ' ', el('span', 'stat-del', '−' + deletions), ' in ' + files + (files === 1 ? ' file' : ' files')]);
  }
  return parts.flatMap((part, index) => index === 0 ? part : [' · ', ...part]);
}

function timeLabel(iso: string): HTMLElement[] {
  if (Number.isNaN(Date.parse(iso))) return [];
  const node = el('time', 'when', relativeTime(iso));
  node.dateTime = iso;
  node.title = new Date(iso).toLocaleString();
  return [node];
}

setInterval(() => { for (const node of document.querySelectorAll<HTMLTimeElement>('time.when')) node.textContent = relativeTime(node.dateTime); }, 60_000);

function avatar(entry: Message, author: string): HTMLElement {
  if (!('avatarUrl' in entry) && entry.author === 'claude') {
    const node = el('span', 'avatar clawd-avatar');
    node.title = author;
    node.append(el('span', 'clawd-pose'));
    return node;
  }
  const url = 'avatarUrl' in entry ? entry.avatarUrl : current?.details?.viewerAvatarUrl ?? '';
  const name = 'avatarUrl' in entry ? entry.authorName ?? entry.author : entry.author === 'human' ? current?.details?.viewerName : undefined;
  return personAvatar(url, name, author);
}

/** Up to two letters for a person without a picture: first and last word of a name, or the start of a single-word login. */
function initials(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const first = words[0];
  if (first === undefined) return '';
  const last = words.length > 1 ? words.at(-1) : undefined;
  return ((first[0] ?? '') + (last?.[0] ?? '')).toUpperCase();
}

/** Avatar on the left, text beside it. GitHub messages name their author; local ones are You or Claude, which the avatar already says. */
function message(entry: Message, thread?: Thread): HTMLElement {
  const author = 'avatarUrl' in entry ? entry.author : entry.author === 'claude' ? 'Claude' : 'You';
  const item = el('div', 'msg');
  const main = el('div', 'msg-main');
  item.append(avatar(entry, author), main);
  if ('avatarUrl' in entry && thread?.source === 'github') {
    const place: CommentPlace = {
      kind: 'reviewComment',
      redraw: () => { renderFiles([thread.path]); },
      quote: (text) => {
        const reply = replies.get(thread.id) ?? '';
        replies.set(thread.id, (reply.trim() ? reply.replace(/\s*$/u, '\n\n') : '') + text);
        focusNext = 'reply:' + thread.id;
        save();
        renderFiles([thread.path]);
      },
    };
    const comment = { ...entry, bodyHtml: entry.html };
    const head = el('div', 'msg-head');
    head.append(el('b', '', author), ...timeLabel(entry.createdAt), ...entry.edited ? [el('span', 'edited', '· edited')] : []);
    const meta = el('span', 'msg-meta');
    if (entry.pending) meta.append(el('span', 'chip pending', 'Pending'));
    meta.append(commentTools(comment, place));
    head.append(meta);
    main.append(head, ...commentBody(comment, place));
    const suggest = suggestionRow(thread, entry);
    if (suggest) main.append(suggest);
    return item;
  }
  if (!('avatarUrl' in entry)) {
    const meta = el('span', 'msg-meta');
    meta.append(...timeLabel(entry.createdAt));
    if (meta.childElementCount > 0) main.append(meta);
  }
  const body = el('div', 'msg-text');
  body.innerHTML = entry.html;
  main.append(body);
  return item;
}

/** Who can see a thread: Local stays with you and Claude, On GitHub is on the PR, Guide is Claude's note from its guide. */
const kindMarks: Record<'github' | 'local' | 'analysis', string> = { github: codicons.github, local: codicons.vm, analysis: codicons.map };
const kindLabels: Record<'github' | 'local' | 'analysis', string> = { github: 'On GitHub', local: 'Local', analysis: 'Guide' };

function kindLabel(kind: 'github' | 'local' | 'analysis'): HTMLElement {
  const label = el('span', 'source');
  label.append(icon(kindMarks[kind]), kindLabels[kind]);
  return label;
}

/** Collapsing a thread from its stuck header would leave the page far below it; keep the header where it was on screen. */
function keepInView(box: HTMLElement, summary: HTMLElement): void {
  const before = summary.getBoundingClientRect().top;
  if (box.getBoundingClientRect().top >= before) return;
  box.addEventListener('toggle', () => { window.scrollBy(0, box.getBoundingClientRect().top - before); }, { once: true });
}

function strip<K extends keyof HTMLElementTagNameMap>(tag: K, kind: 'github' | 'local' | 'analysis', note: string, status: readonly string[], right: string, title?: string): HTMLElementTagNameMap[K] {
  const node = el(tag, 'strip');
  const name = kindLabel(kind);
  name.title = note;
  node.append(name, ...(title === undefined ? [] : [el('span', 'title', title)]), el('span', 'gap'), ...(status.length ? [el('span', 'pill state', status.join(' · '))] : []), el('span', 'muted', right));
  return node;
}

function threadBox(thread: Thread): HTMLElement {
  const github = thread.source === 'github';
  const fromAnalysis = thread.source === 'local' && thread.origin === 'analysis';
  const box = el('details', 'thread ' + thread.source + (thread.pending ? ' pending' : '') + (fromAnalysis ? ' analysis' : ''));
  box.id = 'thread-' + thread.id;
  box.open = threadOpen.get(thread.id) ?? !thread.resolved;
  box.addEventListener('toggle', () => { if (box.open === !thread.resolved) threadOpen.delete(thread.id); else threadOpen.set(thread.id, box.open); });
  const status = github ? thread.status.split(' · ').filter((part) => part !== 'Open' && part !== 'Pending')
    : thread.status.split(' · ').filter((part) => !fromAnalysis || part !== 'Answered');
  const summary = strip('summary', github ? 'github' : fromAnalysis ? 'analysis' : 'local',
    github ? (thread.pending ? 'Only you see it until you submit your review.' : 'Everyone on the PR sees it.') : fromAnalysis ? 'From Claude\'s guide. Reply to ask about it.' : 'Only you and Claude see it.',
    status, (thread.side === 'old' ? 'Base · ' : '') + range(thread.startLine, thread.endLine), thread.source === 'local' ? thread.title : undefined);
  summary.addEventListener('click', () => { if (box.open) keepInView(box, summary); });
  box.append(summary);
  const folded = thread.messages.length > foldThreadsAbove ? thread.messages.length - unfoldedMessages : 0;
  const foldedItems: HTMLElement[] = [];
  const nested = github ? nestedIn(thread.id) : [];
  const startedBy = (time: string): Thread[] => nested.splice(0, nested.filter((local) => started(local) <= Date.parse(time)).length);
  thread.messages.forEach((entry, index) => {
    box.append(...startedBy(entry.createdAt).map(threadBox));
    const item = message(entry, thread);
    if (index < folded) {
      item.hidden = !threadUnfolded.has(thread.id);
      foldedItems.push(item);
    }
    if (index === 0 && folded > 0) {
      const label = (): string => `${threadUnfolded.has(thread.id) ? 'Hide' : 'Show'} ${folded} earlier ${folded === 1 ? 'message' : 'messages'}`;
      const toggle = button(label(), () => {
        if (!threadUnfolded.delete(thread.id)) threadUnfolded.add(thread.id);
        for (const each of foldedItems) each.hidden = !threadUnfolded.has(thread.id);
        toggle.textContent = label();
      }, 'quiet unfold');
      box.append(toggle);
    }
    const suggestions = 'suggestions' in entry ? entry.suggestions : undefined;
    if (thread.source === 'local' && thread.side === 'new' && suggestions?.length) item.querySelector('.msg-main')?.append(suggestionCard(thread, index, suggestions));
    box.append(item);
  });
  if (thread.source === 'local' && thread.commits) box.append(claudeCommits(thread.commits));
  box.append(...nested.map(threadBox));
  const working = thread.source === 'local' ? thread.working : undefined;
  if (working) {
    const live = el('div', 'claude-live');
    live.dataset.thread = thread.id;
    const progress = thread.source === 'local' ? thread.progress : undefined;
    live.append(progress === undefined ? stepLog([{ verb: working, done: false }]) : stepLog(progress.steps, progress.startedAt));
    box.append(live);
  }
  const key = 'reply:' + thread.id;
  const actions = el('div', 'row actions composer-actions');
  const reply = replies.get(thread.id);
  if (reply !== undefined && !thread.resolved) {
    const cancel = (): void => { replies.delete(thread.id); save(); renderFiles([thread.path]); };
    const send = (message: PageMessage): void => {
      sending.add(key);
      $('error').textContent = '';
      renderFiles([thread.path]);
      post(message);
    };
    const submit = (intent: Intent = 'ask'): void => {
      const text = replies.get(thread.id) ?? '';
      if (!text.trim() || sending.has(key)) return;
      send(github ? { action: 'github-reply', form: key, id: thread.id, text } : { action: 'reply', form: key, id: thread.id, text, intent });
    };
    const askClaude = (intent: Intent): void => {
      if (sending.has(key)) return;
      send({ action: 'github-ask', form: key, id: thread.id, text: replies.get(thread.id) ?? '', intent });
    };
    const needText: HTMLButtonElement[] = [];
    const onReply = (value: string): void => { replies.set(thread.id, value); save(); for (const each of needText) each.disabled = sending.has(key) || !value.trim(); };
    box.append(github ? githubField(key, reply, 'Reply on GitHub, or tell Claude what to do', onReply, () => submit(), cancel)
      : textarea(key, reply, 'Reply to Claude', onReply, () => submit(), cancel));
    const busySending = sending.has(key);
    const primary = button(busySending ? 'Sending…' : !github ? 'Ask Claude' : thread.pending ? 'Add to pending review' : 'Post on GitHub', () => submit(), github ? 'primary' : 'claude');
    primary.disabled = busySending;
    actions.append(el('span', 'gap'), button('Cancel', cancel, 'quiet'));
    if (github) {
      const ask = button('Ask Claude', () => askClaude('ask'));
      ask.title = 'Only Claude sees it. Claude answers in a local thread without editing';
      const implement = button('Implement', () => askClaude('implement'));
      implement.title = 'Only Claude sees it. Claude changes the code';
      for (const each of [ask, implement]) { each.disabled = busySending; actions.append(each); }
    } else {
      primary.title = 'Claude answers without editing';
      const implement = button('Implement', () => submit('implement'));
      implement.title = 'Claude changes the code';
      needText.push(implement, primary);
      onReply(reply);
      actions.append(implement);
    }
    actions.append(primary);
    box.append(actions);
    return box;
  }
  const draft = thread.source === 'local' ? publishing.get(thread.id) : undefined;
  if (thread.source === 'local' && draft !== undefined && !thread.url) {
    box.append(publishBox(thread, draft));
    return box;
  }
  actions.append(el('span', 'gap'), ...current?.local ? [] : [thread.url
    ? button('Open on GitHub ↗', () => post({ action: 'github', id: thread.id }), 'quiet')
    : thread.source === 'local' ? toGitHubButton(thread) : button('Publish to GitHub…', () => post({ action: 'publish', id: thread.id }), 'quiet')]);
  actions.append(button(thread.resolved ? 'Reopen' : 'Resolve', () => post({ action: github ? 'github-resolve' : 'resolve', id: thread.id, resolved: !thread.resolved })));
  if (!thread.resolved) actions.append(button('Reply', () => { replies.set(thread.id, ''); focusNext = key; save(); renderFiles([thread.path]); }));
  box.append(actions);
  return box;
}

/** Reply in the GitHub thread this local thread sits in, else open the box that posts it on the diff. */
function toGitHubButton(thread: Thread & { readonly source: 'local' }): HTMLButtonElement {
  const parent = current?.github?.find((github) => github.id === thread.linkedTo);
  if (thread.linkedTo !== undefined) {
    return button('Reply on GitHub…', () => {
      if (parent === undefined || parent.resolved) { post({ action: 'publish', id: thread.id }); return; }
      if (!replies.get(parent.id)?.trim()) replies.set(parent.id, thread.draft ?? '');
      focusNext = 'reply:' + parent.id;
      save();
      renderFiles([parent.path]);
    }, 'quiet');
  }
  return button('Publish to GitHub…', () => { publishing.set(thread.id, thread.draft ?? ''); focusNext = 'publish:' + thread.id; save(); renderFiles([thread.path]); }, 'quiet');
}

/** Edit a local thread's comment and post it on the PR diff, now or into the pending review. */
function publishBox(thread: Thread & { readonly source: 'local' }, draft: string): DocumentFragment {
  const key = 'publish:' + thread.id;
  const cancel = (): void => { publishing.delete(thread.id); previewTabs.delete(key); save(); renderFiles([thread.path]); };
  const send = (pending: boolean): void => {
    const text = publishing.get(thread.id) ?? '';
    if (!text.trim() || sending.has(key)) return;
    sending.add(key);
    sentPending = pending;
    $('error').textContent = '';
    renderFiles([thread.path]);
    post({ action: 'github-publish', form: key, id: thread.id, text, pending });
  };
  const field = githubField(key, draft, 'Comment on GitHub', (value) => { publishing.set(thread.id, value); save(); }, () => send(true), cancel);
  const busySending = sending.has(key);
  const review = button(busySending && sentPending ? 'Sending…' : 'Add to pending review', () => send(true), 'primary');
  review.disabled = busySending;
  review.title = 'Goes into your pending review. Nobody sees it until you submit the review.';
  const reviewing = current?.details?.pendingComments !== undefined;
  const now = button(busySending && !sentPending ? 'Sending…' : 'Post now', () => send(false));
  now.disabled = busySending || reviewing;
  now.title = reviewing ? 'You have a review in progress, so GitHub adds new comments to it. Submit the review to publish them.' : 'Posts on GitHub right away.';
  const row = el('div', 'row actions composer-actions');
  row.append(...reviewing ? [el('span', 'hint', 'Your review is in progress, so comments go into it.')] : [], el('span', 'gap'), button('Cancel', cancel, 'quiet'), now, review);
  const fragment = document.createDocumentFragment();
  fragment.append(field, row);
  return fragment;
}

/** Commits whose changes are unfolded in their Local thread. */
const openCommits = new Set<string>();
/** Each unfolded commit's changes, `loading` while the extension reads them, or why it could not. */
const commitDiffs = new Map<string, readonly FileDiff[] | 'loading' | { readonly error: string }>();

/** Redraw the files whose Local threads list a commit. */
function renderCommitThreads(oid: string): void {
  renderFiles((current?.threads ?? []).filter((thread) => thread.commits?.some((commit) => commit.oid === oid)).map((thread) => thread.path));
}

/** The commits Claude made in a local thread; each folds open to its changes, and its hash shows them in the Files tab. Commits GitHub does not list yet are marked as not pushed. */
function claudeCommits(commits: readonly { readonly oid: string; readonly subject: string }[]): HTMLElement {
  const list = el('div', 'commit-list thread-commits');
  for (const commit of commits) {
    const open = openCommits.has(commit.oid);
    const row = el('div', 'commit-row');
    const chevron = chevronMark(!open);
    chevron.title = open ? 'Hide the changes' : 'Show the changes here';
    chevron.addEventListener('click', () => {
      if (open) openCommits.delete(commit.oid);
      else {
        openCommits.add(commit.oid);
        if (!Array.isArray(commitDiffs.get(commit.oid))) { commitDiffs.set(commit.oid, 'loading'); post({ action: 'commit-diff', oid: commit.oid }); }
      }
      renderCommitThreads(commit.oid);
    });
    const hash = button(commit.oid.slice(0, 7), () => { showCommits(commit.oid, commit.oid); }, 'ref');
    hash.title = 'Show this commit in the Files tab';
    row.append(chevron, hash, el('span', 'text', commit.subject), ...isUnpushed(commit.oid) ? [el('span', 'chip', 'Not pushed')] : []);
    list.append(row);
    if (open) list.append(commitPreview(commitDiffs.get(commit.oid)));
  }
  return list;
}

/** A commit's changes as a read-only unified diff, file by file. */
function commitPreview(diff: readonly FileDiff[] | 'loading' | { readonly error: string } | undefined): HTMLElement {
  const box = el('div', 'commit-preview');
  if (diff === undefined || diff === 'loading') { box.append(el('div', 'note muted', 'Loading changes…')); return box; }
  if (!Array.isArray(diff)) { box.append(el('div', 'note bad', 'Could not read the changes: ' + (diff as { readonly error: string }).error)); return box; }
  for (const file of diff as readonly FileDiff[]) {
    const card = el('div');
    const head = el('div', 'preview-file');
    head.append(el('span', 'name', file.oldPath ? file.oldPath + ' → ' + file.path : file.path), el('span', 'stat-add', '+' + file.additions), el('span', 'stat-del', '−' + file.deletions));
    card.append(head);
    box.append(card);
    if (file.binary || !file.hunks.length) { card.append(el('div', 'note muted', file.binary ? 'Binary file not shown.' : 'No content changes.')); continue; }
    const table = el('table');
    const columns = el('colgroup');
    for (const name of ['num', 'num', '']) columns.append(el('col', name));
    table.append(columns);
    for (const hunk of file.hunks) {
      const header = el('tr', 'hunk');
      const cell = el('td', 'muted', hunk.header);
      cell.colSpan = 3;
      header.append(cell);
      table.append(header);
      for (const line of hunk.lines) {
        const row = el('tr', line.kind === 'context' ? '' : line.kind);
        const code = el('td', 'code');
        code.innerHTML = line.html;
        row.append(el('td', 'num', line.oldLine === undefined ? '' : String(line.oldLine)), el('td', 'num', line.newLine === undefined ? '' : String(line.newLine)), code);
        table.append(row);
      }
    }
    card.append(table);
  }
  return box;
}

/** Option picked on each message's suggestions, by thread id and message index. */
const pickedOptions = new Map<string, number>();

/** A message's suggestions as a small diff against the commented lines; several suggestions are options to switch between. */
function suggestionCard(thread: Extract<Thread, { source: 'local' }>, index: number, suggestions: readonly (readonly string[])[]): HTMLElement {
  const key = thread.id + ':' + index;
  const picked = Math.min(pickedOptions.get(key) ?? (thread.applied?.message === index ? thread.applied.option : 0), suggestions.length - 1);
  const card = el('div', 'suggestion');
  const head = el('div', 'row suggestion-head');
  head.append(el('span', 'muted', suggestions.length > 1 ? suggestions.length + ' suggested options' : 'Suggested change'));
  if (suggestions.length > 1) {
    const tabs = el('span', 'seg');
    suggestions.forEach((_, option) => {
      const tab = button('Option ' + (option + 1), () => { pickedOptions.set(key, option); renderFiles([thread.path]); });
      tab.setAttribute('aria-pressed', String(option === picked));
      tabs.append(tab);
    });
    head.append(tabs);
  }
  const lines = el('pre', 'suggestion-diff');
  const line = (kind: 'add' | 'del', html: string): HTMLElement => {
    const row = el('div', kind);
    row.innerHTML = html;
    row.prepend(el('span', 'sign', kind === 'add' ? '+' : '-'));
    return row;
  };
  for (const html of thread.original ?? []) lines.append(line('del', html));
  for (const html of suggestions[picked] ?? []) lines.append(line('add', html));
  const actions = el('div', 'row actions');
  const where = { id: thread.id, message: index, option: picked };
  const publish = button('Publish suggestion', () => post({ action: 'publish-suggestion', ...where }));
  publish.title = 'Adds it to your pending review as a GitHub suggestion the author can commit.';
  const canPush = current?.details?.canEdit === true;
  const apply = button(canPush ? 'Commit suggestion' : 'Apply', () => post({ action: 'apply-suggestion', ...where }), 'primary');
  apply.title = current?.local ? 'Changes the file. Nothing is committed.' : !canPush ? 'Changes the file in the PR worktree. Nothing is committed, since you cannot push to this PR.'
    : current?.unpushed?.length ? 'Commits the change after the unpushed commits. Push them together.' : 'Commits the change to the PR branch and pushes it.';
  publish.hidden = current?.local === true;
  const done = thread.applied?.message === index ? thread.applied : undefined;
  if (done === undefined) actions.append(el('span', 'gap'), publish, apply);
  else if (done.done === 'pushed') actions.append(el('span', 'muted gap', 'Option ' + (done.option + 1) + ' committed and pushed.'));
  else if (done.done === 'committed') actions.append(el('span', 'muted gap', 'Option ' + (done.option + 1) + ' committed, not pushed yet.'));
  else actions.append(el('span', 'muted gap', 'Option ' + (done.option + 1) + (current?.local ? ' applied, not committed.' : ' applied to the worktree, not committed.')), button('Discard', () => post({ action: 'discard-suggestion', id: thread.id })), publish);
  card.append(head, lines, actions);
  return card;
}

/** The selected lines as plain text, for a suggestion to start from. */
function selectedText(path: string, start: number, end: number): string | undefined {
  const full = contextLines.get(path);
  const fromDiff = new Map((files?.find((file) => file.path === path)?.hunks ?? []).flatMap((hunk) => hunk.lines)
    .flatMap((line) => line.kind !== 'del' && line.newLine !== undefined ? [[line.newLine, line.html] as const] : []));
  const lines: string[] = [];
  for (let number = start; number <= end; number += 1) {
    const html = full?.[number - 1] ?? fromDiff.get(number);
    if (html === undefined) return undefined;
    const holder = el('div');
    holder.innerHTML = html;
    lines.push(holder.textContent ?? '');
  }
  return lines.join('\n');
}

function inline(content: HTMLElement, width: number): HTMLTableRowElement {
  const row = el('tr', 'inline');
  const cell = el('td');
  cell.colSpan = width;
  cell.append(content);
  row.append(cell);
  return row;
}

function jump(thread: Thread): void {
  if (!files?.some((file) => file.path === thread.path)) {
    post({ action: thread.source === 'github' ? 'github' : 'thread', id: thread.id });
    return;
  }
  if (view === 'guide' && !document.getElementById('thread-' + thread.id)) { setView('files'); }
  if (tabOf(thread.path) !== fileTab) { fileTab = tabOf(thread.path); save(); renderFiles(); }
  if (collapsed.get(thread.path) || folderOf(thread.path).some((folder) => collapsed.get('folder:' + folder))) {
    collapsed.set(thread.path, false);
    openFolders(thread.path);
    save();
    renderFiles();
  }
  const target = document.getElementById('thread-' + thread.id) as HTMLDetailsElement | null;
  if (!target) return;
  const outer = target.parentElement?.closest<HTMLDetailsElement>('details.thread');
  if (outer) { outer.open = true; threadOpen.set(outer.id.slice('thread-'.length), true); }
  target.open = true;
  threadOpen.set(thread.id, true);
  target.scrollIntoView({ block: 'center' });
}

/** Hunk lines side by side: removed lines next to the added lines that replace them. */
function pairs(hunk: DiffHunk): Row[] {
  const out: Row[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = (): void => {
    for (let index = 0; index < Math.max(dels.length, adds.length); index++) out.push([dels[index], adds[index]]);
    dels = [];
    adds = [];
  };
  for (const line of hunk.lines) {
    if (line.kind === 'del') dels.push(line);
    else if (line.kind === 'add') adds.push(line);
    else { flush(); out.push([line, line]); }
  }
  flush();
  return out;
}

function hunkRange(hunk: DiffHunk): { oldBefore: number; newBefore: number; oldEnd: number; newEnd: number } | undefined {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(hunk.header);
  if (!match) return undefined;
  const oldStart = Number(match[1]);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  return {
    oldBefore: oldCount ? oldStart - 1 : oldStart, newBefore: newCount ? newStart - 1 : newStart,
    oldEnd: oldCount ? oldStart + oldCount - 1 : oldStart, newEnd: newCount ? newStart + newCount - 1 : newStart,
  };
}

/** Unchanged lines around each hunk, as new-side line ranges; the last one runs to the end of the file. */
function gapsOf(file: FileDiff): Gap[] {
  const lines = contextLines.get(file.path);
  const out: Gap[] = [];
  let newEnd = 0;
  let oldEnd = 0;
  for (const hunk of file.hunks) {
    const span = hunkRange(hunk);
    if (!span) return [];
    out.push({ from: newEnd + 1, to: span.newBefore, offset: span.oldBefore - span.newBefore });
    newEnd = span.newEnd;
    oldEnd = span.oldEnd;
  }
  out.push({ from: newEnd + 1, to: lines ? lines.length : Infinity, offset: oldEnd - newEnd, last: true });
  return out;
}

function expansion(path: string, index: number): Shown {
  return expanded.get(path)?.get(index) ?? { top: 0, bottom: 0 };
}

function expand(file: FileDiff, key: string, index: number, top: number, bottom: number): void {
  const shown = expansion(key, index);
  const byFile = expanded.get(key) ?? new Map<number, Shown>();
  expanded.set(key, byFile);
  byFile.set(index, { top: shown.top + top, bottom: shown.bottom + bottom });
  loadContext(file);
  renderFiles([file.path]);
}

function previewKind(file: FileDiff): 'markdown' | 'html' | 'media' | undefined {
  if (mediaType(file.path) !== undefined) return 'media';
  if (file.binary || file.change === 'deleted') return undefined;
  return /\.(md|markdown)$/iu.test(file.path) ? 'markdown' : /\.html?$/iu.test(file.path) ? 'html' : undefined;
}

/** Images and PDFs have no readable diff, so they always show as a preview; SVG keeps its Diff and Preview switch. */
function previewOnly(file: FileDiff): boolean {
  return previewKind(file) === 'media' && (file.binary || mediaType(file.path) === 'application/pdf');
}

function loadMedia(file: FileDiff): void {
  const key = 'media:' + file.path;
  if (!medias.has(file.path) && !loading.has(key)) {
    loading.add(key);
    post({ action: 'media', path: file.path });
  }
}

/** The file before and after the PR, side by side: images as pictures, PDFs as pages. */
function mediaNode(file: FileDiff): HTMLElement {
  const data = medias.get(file.path);
  if (!data) { loadMedia(file); return el('div', 'note muted', 'Loading preview…'); }
  const wrap = el('div', 'media');
  for (const [label, side] of [['Before', data.old], ['After', data.new]] as const) {
    if (!side) continue;
    const pane = el('figure', 'media-side');
    const caption = el('figcaption', 'muted', label);
    pane.append(caption);
    if ('tooBig' in side) pane.append(el('div', 'note muted', 'Too large to preview.'));
    else if (side.mime === 'application/pdf') pane.append(pdfView(file.path + '\0' + label, side));
    else {
      const image = el('img');
      image.alt = label + ': ' + file.path;
      image.addEventListener('load', () => { caption.textContent = label + ' · ' + image.naturalWidth + ' × ' + image.naturalHeight; }, { once: true });
      image.src = 'data:' + side.mime + ';base64,' + side.data;
      pane.append(image);
    }
    wrap.append(pane);
  }
  return wrap;
}

/** Load pdf.js once, on the first PDF the page shows. */
function loadPdfLibrary(): Promise<typeof PdfJs> {
  const source = initial.pdfScript;
  if (!source) return Promise.reject(new Error('PDF preview is not available here.'));
  pdfLibrary ??= new Promise((resolve, reject) => {
    const tag = el('script');
    tag.nonce = nonce;
    tag.src = source;
    tag.addEventListener('load', () => { resolve((window as unknown as { pdfjsLib: typeof PdfJs }).pdfjsLib); });
    tag.addEventListener('error', () => { reject(new Error('Could not load the PDF viewer.')); });
    document.head.append(tag);
  });
  return pdfLibrary;
}

/** Pages shown per PDF; longer files say how many more there are. */
const maxPdfPages = 10;

function pdfView(key: string, side: Extract<MediaSide, { data: string }>): HTMLElement {
  const known = pdfViews.get(key);
  if (known) return known;
  const pages = el('div', 'pdf-pages');
  pages.append(el('div', 'note muted', 'Rendering PDF…'));
  pdfViews.set(key, pages);
  void (async () => {
    const library = await loadPdfLibrary();
    const bytes = Uint8Array.from(atob(side.data), (char) => char.charCodeAt(0));
    const pdf = await library.getDocument({ data: bytes, isEvalSupported: false }).promise;
    const shown: HTMLElement[] = [];
    for (let number = 1; number <= Math.min(pdf.numPages, maxPdfPages); number += 1) {
      const page = await pdf.getPage(number);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = el('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const context = canvas.getContext('2d');
      if (!context) continue;
      await page.render({ canvasContext: context, viewport }).promise;
      shown.push(canvas);
    }
    if (pdf.numPages > maxPdfPages) shown.push(el('div', 'note muted', (pdf.numPages - maxPdfPages) + ' more pages. Open the file to see them.'));
    pages.replaceChildren(...shown);
  })().catch((error: unknown) => {
    pages.replaceChildren(el('div', 'note bad', 'Could not show this PDF: ' + (error instanceof Error ? error.message : String(error))));
  });
  return pages;
}

function loadPreview(file: FileDiff): void {
  const key = 'preview:' + file.path;
  if (!previews.has(file.path) && !loading.has(key)) {
    loading.add(key);
    post({ action: 'preview', path: file.path });
  }
}

function previewNode(file: FileDiff, threads: readonly Thread[], placed: Set<string>): HTMLElement {
  const data = previews.get(file.path);
  if (!data) { loadPreview(file); return el('div', 'note muted', 'Loading preview…'); }
  const draft = composer?.path === file.path && composer.side === 'new' ? composer : undefined;
  if (data.kind === 'html') {
    const wrap = el('div', 'preview');
    const frame = el('iframe', 'html-preview');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.title = 'Preview of ' + file.path;
    frame.dataset.path = file.path;
    frame.srcdoc = data.html.replace('<!--' + data.marker + '-->', '<script nonce="' + nonce + '">(' + frameMain.toString() + ')();</' + 'script>');
    frame.style.height = (frameHeight.get(file.path) ?? 600) + 'px';
    const margin = el('div', 'html-margin');
    margin.dataset.path = file.path;
    const anchors: Anchor[] = [];
    const attach = (card: HTMLElement, anchor: Anchor): void => {
      card.dataset.anchor = anchor.key;
      anchors.push(anchor);
      margin.append(card);
      card.addEventListener('mouseenter', () => frame.contentWindow?.postMessage({ focus: anchor.key }, '*'));
      card.addEventListener('mouseleave', () => frame.contentWindow?.postMessage({ focus: null }, '*'));
    };
    for (const thread of threads) {
      if (placed.has(thread.id) || thread.outdated || thread.side !== 'new') continue;
      placed.add(thread.id);
      attach(threadBox(thread), { key: thread.id, start: thread.startLine, end: thread.endLine, source: thread.source });
    }
    if (draft) attach(composerBox(draft), { key: 'composer', start: draft.start, end: draft.end, source: 'draft' });
    frameAnchors.set(file.path, anchors);
    const split = el('div', 'html-split');
    split.append(frame, margin);
    wrap.append(el('div', 'note muted', 'Click an element to comment on its source lines, Shift-click to extend. Scripts in the file are off, and linked stylesheets and relative images do not load.'), split);
    return wrap;
  }
  const wrap = el('div', 'preview md');
  for (const block of data.blocks) {
    const node = el('div', 'md-block');
    node.innerHTML = block.html;
    node.title = range(block.startLine, block.endLine) + '. Click to comment, Shift-click to extend.';
    if (draft && draft.start <= block.endLine && draft.end >= block.startLine) node.classList.add('sel');
    node.addEventListener('click', (event) => {
      if (closestTo(event, 'a')) return;
      if (event.shiftKey && draft) {
        draft.start = Math.min(draft.start, block.startLine);
        draft.end = Math.max(draft.end, block.endLine);
        focusNext = 'composer';
      } else pick(file.path, 'new', block.startLine, false).end = block.endLine;
      save();
      renderFiles([file.path]);
    });
    wrap.append(node);
    for (const thread of threads) {
      if (placed.has(thread.id) || thread.outdated || thread.side !== 'new' || block.startLine > thread.endLine || thread.endLine > block.endLine) continue;
      placed.add(thread.id);
      wrap.append(threadBox(thread));
    }
    if (draft && block.startLine <= draft.end && draft.end <= block.endLine) wrap.append(composerBox(draft));
  }
  return wrap;
}

/** Messages from an HTML preview frame; the frame runs the previewed file, so nothing it sends is trusted. */
function frameMessage(frame: HTMLIFrameElement, raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) return;
  const path = frame.dataset.path ?? '';
  const data = raw as { lrReady?: unknown; lrHeight?: unknown; lrAnchors?: unknown; lrPick?: { start?: unknown; end?: unknown; extend?: unknown; top?: unknown } };
  const { start, end, extend, top } = typeof data.lrPick === 'object' && data.lrPick !== null ? data.lrPick : {};
  const draft = composer?.path === path && composer.side === 'new' ? composer : undefined;
  if (data.lrReady) {
    const anchors = (frameAnchors.get(path) ?? []).map(({ key, start: from, end: to, source }) => ({ key, start: from, end: to, source }));
    frame.contentWindow?.postMessage({ anchors, select: draft ? [draft.start, draft.end] : null }, '*');
  } else if (typeof data.lrHeight === 'number' && Number.isFinite(data.lrHeight)) {
    const height = Math.min(Math.max(data.lrHeight, 100), 20000);
    frameHeight.set(path, height);
    frame.style.height = height + 'px';
    if (data.lrAnchors && typeof data.lrAnchors === 'object') {
      const tops = data.lrAnchors as Record<string, number>;
      frameTops.set(path, tops);
      layoutMargin(frame, tops);
    }
  } else if (typeof start === 'number' && typeof end === 'number' && Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > 0 && start <= end) {
    const tops = { ...frameTops.get(path) };
    if (typeof top === 'number' && Number.isFinite(top)) {
      const previous = tops['composer'];
      tops['composer'] = extend && previous !== undefined && Number.isFinite(previous) ? Math.min(previous, top) : top;
    }
    frameTops.set(path, tops);
    if (extend && draft) {
      draft.start = Math.min(draft.start, start);
      draft.end = Math.max(draft.end, end);
      focusNext = 'composer';
    } else pick(path, 'new', start, false).end = end;
    save();
    renderFiles([path]);
  }
}

/** Line each margin card up with its element, pushing cards down so they never overlap. */
function layoutMargin(frame: HTMLIFrameElement, tops: Record<string, number>): void {
  const margin = frame.nextElementSibling;
  if (!(margin instanceof HTMLElement) || !margin.classList.contains('html-margin')) return;
  const wanted = (card: HTMLElement): number | undefined => {
    const top = tops[card.dataset.anchor ?? ''];
    return top !== undefined && Number.isFinite(top) ? top : undefined;
  };
  const cards = ([...margin.children] as HTMLElement[]).sort((a, b) => (wanted(a) ?? Infinity) - (wanted(b) ?? Infinity));
  let next = 0;
  for (const card of cards) {
    const top = Math.max(wanted(card) ?? next, next);
    card.style.top = top + 'px';
    next = top + card.offsetHeight + 8;
  }
  margin.style.minHeight = next + 'px';
}

function loadContext(file: FileDiff): void {
  if (!contextLines.has(file.path) && !loading.has(file.path)) {
    loading.add(file.path);
    post({ action: 'context', path: file.path });
  }
}

function fullFile(file: FileDiff): boolean {
  return contextLines.has(file.path) && gapsOf(file).every((gap, index) => {
    const shown = expansion(file.path, index);
    return shown.top + shown.bottom >= gap.to - gap.from + 1;
  });
}

/** Show a file as viewed right away; the extension's next state confirms it. */
function markViewed(path: string, on: boolean): void {
  if (on) viewed.add(path);
  else viewed.delete(path);
  collapsed.set(path, on);
  save();
}

function unmarkRead(ids: readonly string[]): void {
  readRanges = readRanges.filter((marked) => marked.id === undefined || !ids.includes(marked.id));
  post({ action: 'unread', ids });
}

/** What a file's box shows from extension state, so a state update redraws only the files it changed. */
function fileKey(path: string, threads: readonly Thread[]): string {
  return JSON.stringify([viewed.has(path), collapsed.get(path) === true, readRanges.filter((marked) => marked.path === path), threads,
    composer?.path === path ? [author, current?.details?.pendingComments] : null]);
}

/** Ids of the read ranges covering every selected diff line, or undefined when some selected line is unread. */
function selectedReadIds(file: FileDiff, selection: LineRange): string[] | undefined {
  return rangeReadIds(file, readRanges, selection);
}

/** `expandKey` names where shown context lines are kept; a guide step passes its own so its slice does not share the file's. */
function table(file: FileDiff, threads: readonly Thread[], placed: Set<string>, draft: Composer | null | undefined = composer?.path === file.path ? composer : undefined, expandKey = file.path): HTMLTableElement {
  const node = el('table');
  const columns = el('colgroup');
  // An unchanged file has the same lines on both sides, so it shows them once with one line number.
  const single = file.change === 'unchanged';
  const split = layout === 'split' && !single;
  const widths = split ? ['num', '', 'num', ''] : single ? ['num', ''] : ['num', 'num', ''];
  for (const name of widths) columns.append(el('col', name));
  node.append(columns);
  const notes = annotationsOf(file.path);
  const shownNotes = new Set<Annotation>();
  const add = (row: HTMLTableRowElement, covers: readonly (readonly [DiffSide, number | undefined])[], hidden = false): void => {
    if (!hidden) node.append(row);
    for (const [side, line] of covers) {
      if (line === undefined) continue;
      if (draft?.side === side && draft.start <= line && line <= draft.end) {
        const cells = [...row.children].slice(split && side === 'new' ? 2 : 0, split && side === 'old' ? 2 : undefined);
        for (const cell of cells) cell.classList.add('sel');
        cells[0]?.classList.add('sel-start');
      }
      for (const thread of threads) {
        if (placed.has(thread.id) || thread.outdated || thread.side !== side || thread.endLine !== line || !linesFit(side)) continue;
        placed.add(thread.id);
        node.append(inline(threadBox(thread), widths.length));
      }
      if (side === 'new' && !hidden) {
        for (const note of notes) {
          if (note.endLine !== line || shownNotes.has(note)) continue;
          shownNotes.add(note);
          const row = inline(annotationBox(note), widths.length);
          row.classList.add('annotation');
          node.append(row);
        }
      }
      if (draft?.side === side && draft.end === line) node.append(inline(composerBox(draft), widths.length));
    }
  };
  const lineRow = (line: DiffLine, hidden = false): void => {
    const row = el('tr', line.kind);
    row.append(...single ? [] : [num(line.oldLine, file.path, 'old')], num(line.newLine, file.path, 'new'), code(line, ''));
    add(row, [['old', line.oldLine], ['new', line.newLine]], hidden);
  };
  const pairRow = (left: DiffLine | undefined, right: DiffLine | undefined, hidden = false): void => {
    const row = el('tr');
    const same = left === right;
    if (left) row.append(num(left.oldLine, file.path, 'old'), code(left, same ? '' : 'del'));
    else row.append(el('td', 'num empty'), el('td', 'code empty'));
    if (right) row.append(num(right.newLine, file.path, 'new'), code(right, same ? '' : 'add'));
    else row.append(el('td', 'num empty'), el('td', 'code empty'));
    add(row, [['old', left?.oldLine], ['new', right?.newLine]], hidden);
  };
  const contextRow = (newLine: number, offset: number): void => {
    const html = contextLines.get(file.path)?.[newLine - 1];
    if (html === undefined) return;
    const line: DiffLine = { kind: 'context', oldLine: newLine + offset, newLine, html };
    if (split) pairRow(line, line);
    else lineRow(line);
  };
  const gaps = gapsOf(file);
  const read = readLines(file, readRanges);
  const readRow = (lines: readonly DiffLine[], key: string, open: boolean): HTMLTableRowElement => {
    const row = el('tr', 'read-run');
    const cell = el('td');
    cell.colSpan = widths.length;
    row.append(cell);
    const label = el('span', 'read-label', '✓ ' + lines.length + (lines.length === 1 ? ' line read' : ' lines read'));
    label.prepend(chevronMark(!open));
    label.title = open ? 'Hide these lines' : 'Show these lines';
    label.addEventListener('click', () => {
      if (open) openReads.delete(key);
      else openReads.add(key);
      renderFiles([file.path]);
    });
    const ids = [...new Set(lines.flatMap((line) => read.get(line) ?? []))];
    cell.append(label, button('Unmark', () => { unmarkRead(ids); renderFiles([file.path]); }));
    return row;
  };
  const expander = (gap: Gap, index: number, header?: string): void => {
    const size = gap.to - gap.from + 1;
    const shown = expansion(expandKey, index);
    const hidden = size - shown.top - shown.bottom;
    const row = el('tr', 'hunk');
    const cell = el('td');
    cell.colSpan = widths.length;
    row.append(cell);
    if (hidden > 0 && atHead) {
      const tools = el('span', 'expand');
      const tool = (label: string, title: string, onClick: () => void): void => {
        const node = button(label, onClick);
        node.title = title;
        tools.append(node);
      };
      if (hidden <= step && !gap.last) tool('↕', 'Show ' + hidden + ' hidden lines', () => expand(file, expandKey, index, hidden, 0));
      else {
        if (index > 0) tool('↓', 'Show ' + step + ' more lines below', () => expand(file, expandKey, index, step, 0));
        if (!gap.last) tool('↑', 'Show ' + step + ' more lines above', () => expand(file, expandKey, index, 0, step));
      }
      cell.append(tools);
    }
    if (header && shown.bottom === 0) cell.append(el('span', '', header));
    else if (hidden > 0) cell.append(el('span', '', Number.isFinite(hidden) ? hidden + ' more lines' : 'Rest of the file'));
    if (hidden > 0 || (header && size <= 0)) node.append(row);
  };
  const gapRows = (gap: Gap, index: number, header?: string): void => {
    const size = gap.to - gap.from + 1;
    const shown = expansion(expandKey, index);
    if (size <= 0) {
      if (header) expander({ from: 1, to: 0, offset: 0 }, index, header);
      return;
    }
    if (!contextLines.has(file.path) || !atHead) { expander(gap, index, header); return; }
    const top = Math.min(shown.top, size);
    const bottom = Math.min(shown.bottom, size - top);
    for (let line = gap.from; line < gap.from + top; line++) contextRow(line, gap.offset);
    expander(gap, index, header);
    for (let line = gap.to - bottom + 1; line <= gap.to; line++) contextRow(line, gap.offset);
  };
  const draw = (row: Row, hidden: boolean): void => {
    if (split) pairRow(row[0], row[1], hidden);
    else if (row[0]) lineRow(row[0], hidden);
  };
  const isRead = (row: Row): boolean => row.every((line) => !line || read.has(line));
  file.hunks.forEach((hunk, index) => {
    const gap = gaps[index];
    // An unchanged file is one hunk of every line, so it has no header or gaps to show.
    if (file.change !== 'unchanged' && gap) gapRows(gap, index, hunk.header);
    else if (file.change !== 'unchanged') {
      const header = el('tr', 'hunk');
      const cell = el('td', '', hunk.header);
      cell.colSpan = widths.length;
      header.append(cell);
      node.append(header);
    }
    const rows: Row[] = split ? pairs(hunk) : hunk.lines.map((line) => [line]);
    for (let at = 0; at < rows.length;) {
      const row = rows[at];
      if (row && !isRead(row)) { draw(row, false); at += 1; continue; }
      let end = at;
      while (end < rows.length && isRead(rows[end] ?? [])) end += 1;
      const run = rows.slice(at, end);
      const lines = [...new Set(run.flat().filter((line): line is DiffLine => line !== undefined))];
      const key = file.path + ':' + (lines[0]?.oldLine ?? '') + ':' + (lines[0]?.newLine ?? '');
      const open = openReads.has(key);
      node.append(readRow(lines, key, open));
      for (const hiddenRow of run) draw(hiddenRow, !open);
      at = end;
    }
  });
  const last = gaps[file.hunks.length];
  if (last && file.change !== 'added' && file.change !== 'deleted' && file.change !== 'unchanged') gapRows(last, file.hunks.length);
  return node;
}

/** The fold arrow: points down when open, right when collapsed. */
function chevronMark(collapsed: boolean): HTMLElement {
  return el('span', collapsed ? 'chevron closed' : 'chevron');
}

/** Sets a button's hover tip and its accessible name together. */
function setTip(button: HTMLElement, tip: string): void {
  button.dataset.tip = tip;
  button.setAttribute('aria-label', tip);
}

/** Redraw the file list; given paths, or 'state' for files whose state changed, redraw only those boxes when the rest are on the page. */
function renderFiles(only?: readonly (string | undefined)[] | 'state'): void {
  for (const name of ['unified', 'split'] as const) $(name).setAttribute('aria-pressed', String(layout === name));
  for (const name of ['files', 'guide'] as const) $('view-' + name).setAttribute('aria-selected', String(view === name && fileTab === undefined));
  showGuideTab();
  renderRangeControls();
  const folderButton = $('folders');
  folderButton.toggleAttribute('disabled', view === 'guide');
  setTip(folderButton, view === 'guide' ? 'Folders are off in the guide' : 'Group files by folder');
  folderButton.setAttribute('aria-pressed', String(folders));
  folderButton.setAttribute('aria-pressed', String(folders));
  if (!files) return;
  if (view === 'guide') { keepView(() => renderGuide(only)); return; }
  renderFileTabs();
  const tabs = tabFiles();
  const tabbed = tabs.find((file) => file.path === fileTab);
  const allFiles = tabbed ? [tabbed] : files.filter((file) => !tabs.includes(file));
  const shownFiles = tabbed ? allFiles : filteredFiles(allFiles);
  const container = $('files');
  const threadsByFile = new Map<string, Thread[]>();
  for (const thread of allThreads()) {
    const list = threadsByFile.get(thread.path) ?? [];
    threadsByFile.set(thread.path, list);
    list.push(thread);
  }
  $('files-title').textContent = (shownFiles.length < allFiles.length ? shownFiles.length + ' of ' + allFiles.length + ' files · ' : '') + shownFiles.filter((file) => viewed.has(file.path)).length + '/' + shownFiles.length + ' viewed';
  const tree = fileTree(shownFiles);
  const visible = !folders ? shownFiles : shownFiles.filter((file) => !folderOf(file.path).some((folder) => collapsed.get('folder:' + folder) === true));
  const boxes = new Map([...container.querySelectorAll<HTMLElement>('.file[data-path]')].map((node) => [node.dataset.path, node]));
  const threadsOf = (path: string): Thread[] => threadsByFile.get(path) ?? [];
  const changed = only === 'state' ? visible.map((file) => file.path).filter((path) => fileKeys.get(path) !== fileKey(path, threadsOf(path))) : only;
  const targets = changed && boxes.size === visible.length ? [...new Set(changed.filter((path): path is string => path !== undefined))] : undefined;
  const draw = (file: FileDiff): HTMLElement => {
    fileKeys.set(file.path, fileKey(file.path, threadsOf(file.path)));
    return fileBox(file, threadsOf(file.path));
  };
  keepView(() => {
    if (targets?.every((path) => boxes.has(path))) {
      for (const path of targets) {
        const file = shownFiles.find((item) => item.path === path);
        if (file) boxes.get(path)?.replaceWith(draw(file));
      }
    } else {
      container.replaceChildren();
      fileKeys.clear();
      if (!shownFiles.length) container.append(el('p', 'muted', allFiles.length ? 'No files match the filter.' : current?.local ? 'No uncommitted changes. Pick a file in the Local view to review it.' : diffRange.kind === 'all' ? 'No changes against the base branch.' : 'No changes in ' + rangeLabel(diffRange) + '.'));
      const append = (parent: HTMLElement, folder: FileFolder<FileDiff>, depth: number): void => {
        for (const child of folder.folders) {
          const isCollapsed = collapsed.get('folder:' + child.path) === true;
          const head = el('div', 'folder-head');
          head.dataset.folder = child.path;
          head.append(el('span', 'name', child.name), el('span', 'muted progress'));
          const { node, rail } = railNode(head, depth, isCollapsed, () => { collapsed.set('folder:' + child.path, !isCollapsed); save(); renderFiles(); });
          put(parent, depth, node);
          if (!isCollapsed) append(rail, child, depth + 1);
        }
        for (const file of folder.files) put(parent, depth, draw(file));
      };
      const put = (parent: HTMLElement, depth: number, child: HTMLElement): void => { parent.append(depth === 0 ? child : railItem(child)); };
      if (folders) append(container, tree, 0);
      else for (const file of shownFiles) container.append(draw(file));
    }
    if (folders) updateFolderProgress(tree);
    for (const frame of container.querySelectorAll<HTMLIFrameElement>('iframe.html-preview')) layoutMargin(frame, frameTops.get(frame.dataset.path ?? '') ?? {});
  });
}

/** Unchanged files the local page shows in their own tabs. */
function tabFiles(): readonly FileDiff[] {
  return current?.local && files ? files.filter((file) => file.change === 'unchanged') : [];
}

/** The tab that shows `path`: its own when it is an opened unchanged file, else Changes. */
function tabOf(path: string): string | undefined {
  return tabFiles().some((file) => file.path === path) ? path : undefined;
}

/** One tab per opened unchanged file after Changes, closable while the file has no comments. */
function renderFileTabs(): void {
  const tabs = tabFiles();
  if (fileTab !== undefined && !tabs.some((file) => file.path === fileTab)) fileTab = undefined;
  $('view-files').setAttribute('aria-selected', String(view === 'files' && fileTab === undefined));
  for (const id of ['whitespace', 'filter-box', 'filter-menu']) $(id).classList.toggle('off-view', fileTab !== undefined);
  const list = $('view-files').parentElement;
  if (!list) return;
  const left = list.scrollLeft;
  for (const old of list.querySelectorAll('.file-tab')) old.remove();
  for (const file of tabs) {
    const name = file.path.split('/').pop() ?? file.path;
    const tab = button(name, () => { fileTab = file.path; save(); renderFiles(); });
    const icon = fileIcons?.byPath[file.path];
    if (icon) tab.prepend(iconNode(icon));
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(fileTab === file.path));
    tab.title = file.path;
    const wrap = el('span', 'file-tab');
    wrap.append(tab);
    if (!allThreads().some((thread) => thread.path === file.path)) {
      const close = button('', () => post({ action: 'close-file', path: file.path }), 'icon-button tab-close');
      close.innerHTML = codicons.close;
      setTip(close, 'Close ' + name);
      wrap.append(close);
    }
    list.append(wrap);
  }
  list.scrollLeft = left;
  if (scrolledTab !== fileTab) {
    scrolledTab = fileTab;
    list.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

/** A theme file icon: a glyph of an icon font, added to the page on first use, or an image. */
function iconNode(icon: FileIcon): HTMLElement {
  if ('image' in icon) {
    const image = el('img', 'file-icon');
    image.src = icon.image;
    image.alt = '';
    return image;
  }
  let family = iconFonts.get(icon.font);
  const data = fileIcons?.fonts[icon.font];
  if (family === undefined && data !== undefined) {
    family = 'file-icons-' + iconFonts.size;
    iconFonts.set(icon.font, family);
    document.head.append(el('style', '', '@font-face{font-family:"' + family + '";src:url("' + data + '")}'));
  }
  const glyph = el('span', 'file-icon', icon.char);
  glyph.setAttribute('aria-hidden', 'true');
  if (family) glyph.style.fontFamily = '"' + family + '"';
  if (icon.color) glyph.style.color = icon.color;
  return glyph;
}

/** Folders a path sits in, outermost first: every prefix, so compacted folder rows match too. */
function folderOf(path: string): string[] {
  const parts = path.split('/').slice(0, -1);
  return parts.map((_part, index) => parts.slice(0, index + 1).join('/'));
}

function updateFolderProgress(tree: FileFolder<FileDiff>): void {
  const count = (folder: FileFolder<FileDiff>): { done: number; total: number } => folder.folders.map(count).reduce(
    (sum, next) => ({ done: sum.done + next.done, total: sum.total + next.total }),
    { done: folder.files.filter((file) => viewed.has(file.path)).length, total: folder.files.length },
  );
  const walk = (folder: FileFolder<FileDiff>): void => {
    for (const child of folder.folders) {
      const { done, total } = count(child);
      const progress = document.querySelector('[data-folder="' + CSS.escape(child.path) + '"] .progress');
      if (progress) progress.textContent = done + '/' + total + ' viewed';
      walk(child);
    }
  };
  walk(tree);
}

/** Open the folders around a file so its box is on the page. */
function openFolders(path: string): void {
  for (const folder of folderOf(path)) collapsed.delete('folder:' + folder);
}

/** Redraw the file list, or `container`, without losing the scroll position or the draft being typed. */
function keepView(draw: () => void, container = $('files')): void {
  const scroll = window.scrollY;
  const active = document.activeElement;
  const focus = active instanceof HTMLTextAreaElement && active.dataset.draft ? { key: active.dataset.draft, start: active.selectionStart, end: active.selectionEnd } : undefined;
  draw();
  if (focus) {
    const area = container.querySelector<HTMLTextAreaElement>('[data-draft="' + CSS.escape(focus.key) + '"]');
    if (area) { area.focus({ preventScroll: true }); area.setSelectionRange(focus.start, focus.end); }
  }
  window.scrollTo(0, scroll);
  if (focusNext) {
    const area = container.querySelector<HTMLTextAreaElement>('[data-draft="' + CSS.escape(focusNext) + '"]');
    focusNext = undefined;
    area?.focus();
  }
}

/** Where a step's or group's open state is saved; tied to the analysis so a new one starts fresh. */
function guideState(kind: 'step' | 'group', key: string): string {
  return kind + ':' + (current?.analysis.result?.createdAt ?? '') + ':' + key;
}

/** A step's change blocks with up to three unchanged lines around each, without reaching into other changes. */
function sliceOf(step: GuideStep): FileDiff | undefined {
  const file = files?.find((item) => item.path === step.path);
  if (!file) return undefined;
  const spans: { hunk: number; from: number; to: number }[] = [];
  for (const block of step.blocks) {
    const lines = file.hunks[block.hunk]?.lines ?? [];
    let from = block.first;
    let to = block.last;
    while (from > 0 && block.first - from < 3 && lines[from - 1]?.kind === 'context') from -= 1;
    while (to < lines.length - 1 && to - block.last < 3 && lines[to + 1]?.kind === 'context') to += 1;
    const previous = spans.at(-1);
    if (previous && previous.hunk === block.hunk && from <= previous.to + 1) previous.to = Math.max(previous.to, to);
    else spans.push({ hunk: block.hunk, from, to });
  }
  return { ...file, hunks: spans.flatMap(({ hunk, from, to }) => { const source = file.hunks[hunk]; return source ? [subHunk(source, from, to)] : []; }) };
}

/** Lines `from` to `to` of a hunk, with a header that numbers them as git would. */
function subHunk(source: DiffHunk, from: number, to: number): DiffHunk {
  const lines = source.lines.slice(from, to + 1);
  const span = hunkRange(source);
  if (!span) {
    const numbers = lines.map((line) => line.newLine ?? line.oldLine).filter((value): value is number => value !== undefined);
    return { header: range(numbers[0] ?? 0, numbers.at(-1) ?? 0), lines };
  }
  const before = source.lines.slice(0, from);
  const oldBefore = span.oldBefore + before.filter((line) => line.kind !== 'add').length;
  const newBefore = span.newBefore + before.filter((line) => line.kind !== 'del').length;
  const oldCount = lines.filter((line) => line.kind !== 'add').length;
  const newCount = lines.filter((line) => line.kind !== 'del').length;
  return { header: '@@ -' + (oldCount ? oldBefore + 1 : oldBefore) + ',' + oldCount + ' +' + (newCount ? newBefore + 1 : newBefore) + ',' + newCount + ' @@', lines };
}

function hasLine(slice: FileDiff, side: DiffSide, line: number): boolean {
  const key = side === 'old' ? 'oldLine' : 'newLine';
  return slice.hunks.some((hunk) => hunk.lines.some((item) => item[key] === line));
}

function stepViewed(step: GuideStep): boolean {
  return isStepViewed(step, files?.find((item) => item.path === step.path), readRanges, viewed.has(step.path));
}

function stepCollapsed(step: GuideStep): boolean {
  return collapsed.get(guideState('step', step.key)) ?? stepViewed(step);
}

function groupCollapsed(group: GuideGroup): boolean {
  return collapsed.get(guideState('group', group.key)) ?? group.severity === 'trivial';
}

/** Which step shows each thread and the draft: a note's own step, otherwise the first step whose lines include it. */
function guideOwners(groups: readonly GuideGroup[], slices: ReadonlyMap<string, FileDiff>): { threads: Map<string, Thread[]>; notes: Map<string, Thread>; draft?: string } {
  const threads = new Map<string, Thread[]>();
  const notes = new Map<string, Thread>();
  const all = allThreads().filter(standalone);
  const steps = groups.flatMap((group) => group.steps);
  for (const step of steps) {
    const note = step.threadId === undefined ? undefined : all.find((thread) => thread.source === 'local' && thread.id === step.threadId);
    if (note) notes.set(step.key, note);
  }
  const noted = new Set([...notes.values()].map((thread) => thread.id));
  const owner = (path: string, side: DiffSide, line: number): string | undefined => steps.find((step) => {
    const slice = slices.get(step.key);
    return step.path === path && slice !== undefined && hasLine(slice, side, line);
  })?.key;
  for (const thread of all) {
    if (noted.has(thread.id) || thread.outdated) continue;
    const key = owner(thread.path, thread.side, thread.endLine);
    if (key !== undefined) threads.set(key, [...threads.get(key) ?? [], thread]);
  }
  const draft = composer ? owner(composer.path, composer.side, composer.end) : undefined;
  return draft === undefined ? { threads, notes } : { threads, notes, draft };
}

function guideIntro(): HTMLElement {
  const analysis = current?.analysis;
  const card = el('section', 'card guide-intro');
  card.append(el('h3', '', 'Guide'), el('p', '', 'Claude reads the changes, groups them by severity, puts them in reading order and explains each step. '
    + 'Each note is a thread you can reply to. Every change lands in exactly one step, so once every step is Viewed, the whole PR is.'));
  const row = el('div', 'row');
  const start = button(analysis?.running ? 'Stop' : 'Build guide', () => post({ action: analysis?.running ? 'analysis-stop' : 'analyze' }), analysis?.running ? '' : 'primary');
  row.append(start);
  if (analysis?.running && analysis.progress === undefined) row.append(el('span', 'chip claude working', 'Guide · ' + (analysis.step ?? 'Working')));
  else if (analysis?.running) row.append(el('span', 'muted', 'Building the guide'));
  else if (analysis?.error) row.append(el('span', 'bad', 'Guide failed: ' + analysis.error));
  else row.append(el('span', 'muted', 'Runs Claude read-only on this PR. Large PRs take a few minutes.'));
  card.append(row);
  if (analysis?.running && analysis.progress !== undefined) card.append(stepLog(analysis.progress.steps, analysis.progress.startedAt));
  return card;
}

function guideSummary(overview: string, stale: boolean): HTMLElement {
  const card = el('section', 'card guide-intro');
  card.append(el('h3', '', 'Guide'));
  if (overview) card.append(el('p', 'text', overview));
  if (stale) card.append(el('p', 'wait', 'Made for an older commit. Steps whose code changed since then moved to Unclassified. Rebuild the guide to update.'));
  card.append(el('p', 'muted', 'Every change is in exactly one step. Viewed on every step marks the whole PR viewed.'));
  return card;
}

type ThreadKind = 'github' | 'local' | 'analysis';
const threadKinds: readonly ThreadKind[] = ['github', 'local', 'analysis'];

function threadKind(thread: Thread): ThreadKind {
  return thread.source === 'github' ? 'github' : thread.origin === 'analysis' ? 'analysis' : 'local';
}

/** The Threads card: one foldable group per kind, one line per thread. Guide starts folded because its notes already sit in the diff. */
function renderThreadList(): void {
  const threads = allThreads();
  $('threads-title').textContent = 'Threads (' + threads.length + ')';
  const list = $('threads');
  list.replaceChildren();
  if (threads.length === 0) list.append(el('li', 'muted', current?.local || current?.github || current?.githubError ? 'No comments yet.' : 'No local comments yet. Loading GitHub comments…'));
  if (current?.githubError) list.append(el('li', 'bad', 'Could not load GitHub comments: ' + current.githubError));
  for (const kind of threadKinds) {
    const members = threads.filter((thread) => threadKind(thread) === kind && standalone(thread));
    if (!members.length) continue;
    const key = 'threads:' + kind;
    const isCollapsed = collapsed.get(key) ?? kind === 'analysis';
    const group = el('li', 'thread-group ' + kind);
    const head = el('div', 'thread-group-head');
    head.append(chevronMark(isCollapsed), kindLabel(kind), el('span', 'muted', String(members.length)));
    head.addEventListener('click', () => { collapsed.set(key, !isCollapsed); save(); renderThreadList(); });
    group.append(head);
    if (!isCollapsed) {
      const rows = el('ul');
      for (const thread of members) {
        rows.append(threadRow(thread, kind));
        if (thread.source === 'github') for (const local of nestedIn(thread.id)) rows.append(threadRow(local, threadKind(local), true));
      }
      group.append(rows);
    }
    list.append(group);
  }
}

/** Plain text with `backtick` spans shown as code. */
function inlineCode(text: string): Node[] {
  return text.split('`').map((part, index) => index % 2 === 1 ? el('code', '', part) : document.createTextNode(part));
}

/** One thread as a row: where on the left, the text in a column that lines up, status on the right only when it adds something. */
function threadRow(thread: Thread, kind: ThreadKind, nested = false): HTMLElement {
  const item = el('li', 'card-thread ' + kind + (nested ? ' nested' : ''));
  item.title = thread.location + '\n' + thread.text;
  item.addEventListener('click', () => jump(thread));
  const text = el('span', 'text');
  text.append(...inlineCode((thread.source === 'local' ? thread.title : undefined) ?? thread.text));
  const status = kind === 'analysis' ? '' : thread.status;
  const working = thread.source === 'local' ? thread.working : undefined;
  const [name = '', line = ''] = (thread.location.split('/').pop() ?? '').split(/(?=:\d+$)/u);
  const where = el('span', 'where');
  where.append(el('span', 'name', name), line);
  const state = el('span', 'state', working ? '' : status);
  if (working) state.append(el('span', 'chip claude working', working));
  item.append(where, text, state);
  if (thread.url) {
    const link = el('a', 'open', '↗');
    link.title = 'Open on GitHub';
    link.addEventListener('click', (event) => { event.stopPropagation(); post({ action: 'github', id: thread.id }); });
    item.append(link);
  }
  return item;
}

function groupHead(group: GuideGroup): HTMLElement {
  const head = el('div', 'guide-group sev-' + group.severity);
  head.dataset.group = group.key;
  const label = el('label', 'viewed');
  label.title = 'Mark every step in this section read.';
  label.addEventListener('click', (event) => { event.stopPropagation(); });
  const check = el('input');
  check.type = 'checkbox';
  check.checked = group.steps.every(stepViewed);
  check.addEventListener('change', () => { setGroupViewed(group, check.checked); });
  label.append(check, 'Viewed');
  head.append(el('span', 'sev', severityLabels[group.severity]), el('span', 'title', group.title), el('span', 'muted progress'), label);
  return head;
}

/** Tick or untick every step of a guide section, showing it right away; the extension's next state confirms it. */
function setGroupViewed(group: GuideGroup, on: boolean): void {
  if (!files) return;
  const paths = [...new Set(group.steps.map((step) => step.path))];
  if (on) {
    const marks = groupReadMarks(group, files, readRanges, viewed);
    readRanges = [...readRanges, ...marks.read.map((marked) => ({ id: 'pending', ...marked }))];
    marks.read.forEach((marked) => post({ action: 'read', ...marked, viewed: false }));
    for (const path of marks.viewed) { markViewed(path, true); post({ action: 'viewed', path, viewed: true }); }
  } else {
    const ids = group.steps.flatMap((step) => {
      const file = files?.find((item) => item.path === step.path);
      return file ? step.blocks.flatMap((block) => selectedReadIds(file, block.range) ?? []) : [];
    });
    if (ids.length) unmarkRead([...new Set(ids)]);
    for (const path of paths) if (viewed.has(path)) { markViewed(path, false); post({ action: 'viewed', path, viewed: false }); }
  }
  for (const step of group.steps) collapsed.delete(guideState('step', step.key));
  save();
  renderFiles();
}

/** A foldable level of the file list: its head, then its children beside a rail that folds them when clicked, like a threaded discussion. */
function railNode(head: HTMLElement, depth: number, isCollapsed: boolean, toggle: () => void): { node: HTMLElement; rail: HTMLElement } {
  const node = el('section', 'tree-node');
  node.style.setProperty('--depth', String(depth));
  head.classList.add('node-head');
  head.prepend(foldToggle(isCollapsed));
  head.addEventListener('click', toggle);
  const rail = el('div', 'fold-rail');
  rail.style.setProperty('--depth', String(depth + 1));
  const line = el('div', 'fold-line');
  line.title = 'Fold';
  line.addEventListener('click', toggle);
  rail.append(line);
  node.append(head);
  if (!isCollapsed) node.append(rail);
  return { node, rail };
}

/** A child hanging off a rail, joined to it by a curved elbow. */
function railItem(child: HTMLElement): HTMLElement {
  const item = el('div', 'rail-item');
  item.append(child);
  return item;
}

function foldToggle(isCollapsed: boolean): HTMLElement {
  const button = el('span', 'fold-toggle');
  button.title = isCollapsed ? 'Unfold' : 'Fold';
  button.innerHTML = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5"/><path d="M5 8h6' + (isCollapsed ? 'M8 5v6' : '') + '"/></svg>';
  return button;
}

function updateGuideProgress(groups: readonly GuideGroup[]): void {
  const steps = groups.flatMap((group) => group.steps);
  $('files-title').textContent = steps.filter(stepViewed).length + '/' + steps.length + ' steps viewed';
  for (const group of groups) {
    const head = document.querySelector('[data-group="' + CSS.escape(group.key) + '"]');
    const progress = head?.querySelector('.progress');
    if (progress) progress.textContent = group.steps.filter(stepViewed).length + '/' + group.steps.length + ' viewed';
    const check = head?.querySelector<HTMLInputElement>('label.viewed input');
    if (check) check.checked = group.steps.every(stepViewed);
  }
}

/** The guided layout: Claude's steps by severity, each a slice of the diff with its note and a Viewed checkbox. */
function renderGuide(only?: readonly (string | undefined)[] | 'state'): void {
  const container = $('files');
  const result = current?.analysis.result;
  if (!files || !result) {
    $('files-title').textContent = '';
    container.replaceChildren(guideIntro());
    return;
  }
  const shownFiles = files;
  guide ??= buildGuide(result, shownFiles);
  const groups = guide;
  const slices = new Map(groups.flatMap((group) => group.steps).flatMap((step) => {
    const slice = sliceOf(step);
    return slice ? [[step.key, slice] as const] : [];
  }));
  const owners = guideOwners(groups, slices);
  const visible = groups.filter((group) => !groupCollapsed(group)).flatMap((group) => group.steps);
  const keyOf = (step: GuideStep): string => JSON.stringify([stepViewed(step), stepCollapsed(step), readRanges.filter((marked) => marked.path === step.path),
    owners.threads.get(step.key) ?? [], owners.notes.get(step.key) ?? null, owners.draft === step.key ? [author, current?.details?.pendingComments] : null]);
  const numbers = new Map(groups.flatMap((group) => group.steps.map((step, index) => [step.key, index + 1] as const)));
  const draw = (step: GuideStep): HTMLElement => {
    stepKeys.set(step.key, keyOf(step));
    return stepBox(step, numbers.get(step.key) ?? 0, slices.get(step.key), owners.threads.get(step.key) ?? [], owners.notes.get(step.key), owners.draft === step.key);
  };
  const boxes = new Map([...container.querySelectorAll<HTMLElement>('.step-wrap')].map((node) => [node.dataset.key, node]));
  const targets = only === 'state' ? visible.filter((step) => stepKeys.get(step.key) !== keyOf(step))
    : only ? visible.filter((step) => only.includes(step.path)) : undefined;
  if (targets && boxes.size === visible.length && targets.every((step) => boxes.has(step.key))) {
    for (const step of targets) boxes.get(step.key)?.replaceWith(draw(step));
  } else {
    stepKeys.clear();
    container.replaceChildren(guideSummary(result.overview, current?.analysis.stale === true));
    for (const group of groups) {
      const isCollapsed = groupCollapsed(group);
      const { node, rail } = railNode(groupHead(group), 0, isCollapsed, () => { collapsed.set(guideState('group', group.key), !isCollapsed); save(); renderFiles(); });
      container.append(node);
      if (!isCollapsed) for (const step of group.steps) rail.append(railItem(draw(step)));
    }
  }
  updateGuideProgress(groups);
}

function stepBox(step: GuideStep, number: number, slice: FileDiff | undefined, threads: readonly Thread[], note: Thread | undefined, hasDraft: boolean): HTMLElement {
  const wrap = el('div', 'step-wrap');
  wrap.dataset.key = step.key;
  if (step.transition) wrap.append(el('div', 'transition', '↓ ' + step.transition));
  const file = files?.find((item) => item.path === step.path);
  if (!file || !slice) return wrap;
  const isCollapsed = stepCollapsed(step);
  const box = el('div', 'file step' + (isCollapsed ? ' collapsed' : ''));
  box.dataset.path = step.path;
  const head = el('div', 'file-head');
  const chevron = chevronMark(isCollapsed);
  const name = el('span', 'name');
  name.append(el('span', 'step-title', number + '.' + (step.title ? ' ' + step.title : '')), el('span', 'step-path', file.oldPath ? file.oldPath + ' → ' + file.path : file.path));
  const toggle = (): void => { collapsed.set(guideState('step', step.key), !isCollapsed); save(); renderFiles([step.path]); };
  chevron.addEventListener('click', toggle);
  name.addEventListener('click', toggle);
  const badge = el('span', 'badge ' + file.change, changeLetters[file.change]);
  badge.title = file.change;
  const lines = step.blocks.flatMap((block) => file.hunks[block.hunk]?.lines.slice(block.first, block.last + 1) ?? []);
  const stats = el('span', 'stats');
  stats.append(el('span', 'stat-add', '+' + lines.filter((line) => line.kind === 'add').length), ' ', el('span', 'stat-del', '−' + lines.filter((line) => line.kind === 'del').length));
  const label = el('label', 'viewed');
  const check = el('input');
  check.type = 'checkbox';
  check.checked = stepViewed(step);
  label.title = 'Mark this step\'s changes read. When every change in the file is read, the file is marked Viewed.';
  check.addEventListener('change', () => {
    collapsed.delete(guideState('step', step.key));
    if (!step.blocks.length) {
      markViewed(step.path, check.checked);
      post({ action: 'viewed', path: step.path, viewed: check.checked });
    } else if (check.checked) {
      const unread = step.blocks.map((block) => block.range).filter((marked) => selectedReadIds(file, marked) === undefined);
      const done = !viewed.has(step.path) && fullyRead(file, [...readRanges, ...unread]);
      readRanges = [...readRanges, ...unread.map((marked) => ({ id: 'pending', ...marked }))];
      if (done) markViewed(step.path, true);
      unread.forEach((marked, index) => post({ action: 'read', ...marked, viewed: done && index === unread.length - 1 }));
    } else {
      unmarkRead([...new Set(step.blocks.flatMap((block) => selectedReadIds(file, block.range) ?? []))]);
      if (viewed.has(step.path)) { markViewed(step.path, false); post({ action: 'viewed', path: step.path, viewed: false }); }
    }
    save();
    renderFiles([step.path]);
  });
  label.append(check, 'Viewed');
  const kind = previewKind(file);
  const showPreview = kind !== undefined && (previewing.has(file.path) || previewOnly(file));
  head.append(chevron, name, badge, stats, previewSwitch(file, showPreview), label, button('Open in editor', () => post({ action: 'editor', path: step.path })));
  box.append(head);
  const diff = el('div', 'diff');
  if (step.fileNote) {
    const about = el('div', 'file-note');
    about.append(el('span', 'tag', 'About this file'), ' ', step.fileNote);
    diff.append(about);
  }
  if (note) diff.append(threadBox(note));
  else if (step.note) diff.append(el('div', 'step-note', step.note));
  if (showPreview && kind === 'media') diff.append(mediaNode(file));
  else if (file.binary) diff.append(el('div', 'note muted', 'Binary file not shown.'));
  else if (showPreview) diff.append(previewNode(file, threads, new Set()));
  else if (!slice.hunks.length) diff.append(el('div', 'note muted', file.change === 'renamed' ? 'Renamed without changes.' : 'No content changes.'));
  else diff.append(table(slice, threads, new Set(), hasDraft ? composer : null, 'step:' + step.key));
  box.append(diff);
  wrap.append(box);
  return wrap;
}

/** Diff and Preview buttons for a file that can be previewed and still has a readable diff. */
function previewSwitch(file: FileDiff, showPreview: boolean): HTMLElement {
  const mode = el('span', 'seg');
  mode.hidden = previewKind(file) === undefined || previewOnly(file);
  for (const [text, on] of [['Diff', false], ['Preview', true]] as const) {
    const option = button(text, () => {
      if (on) previewing.add(file.path);
      else previewing.delete(file.path);
      save();
      renderFiles([file.path]);
    });
    option.setAttribute('aria-pressed', String(showPreview === on));
    mode.append(option);
  }
  return mode;
}

/** Diffs GitHub does not render until asked. */
function isLarge(file: FileDiff): boolean {
  return file.additions + file.deletions > 1500;
}

function fileBox(file: FileDiff, threads: readonly Thread[]): HTMLElement {
  const isCollapsed = collapsed.get(file.path) === true;
  const box = el('div', 'file' + (isCollapsed ? ' collapsed' : ''));
  box.dataset.path = file.path;
  const head = el('div', 'file-head');
  const chevron = chevronMark(isCollapsed);
  const base = file.path.split('/').at(-1) ?? file.path;
  const shown = folders ? base : file.path;
  const name = el('span', 'name', file.oldPath ? file.oldPath + ' → ' + shown : shown);
  name.title = file.path;
  const toggle = (): void => { collapsed.set(file.path, !isCollapsed); save(); renderFiles([file.path]); };
  chevron.addEventListener('click', toggle);
  name.addEventListener('click', toggle);
  const badge = el('span', 'badge ' + file.change, changeLetters[file.change]);
  badge.title = file.change;
  const stats = el('span', 'stats');
  if (file.change === 'unchanged') stats.append(el('span', 'file-chip', 'Not changed'));
  else stats.append(el('span', 'stat-add', '+' + file.additions), ' ', el('span', 'stat-del', '−' + file.deletions));
  const label = el('label', 'viewed');
  const check = el('input');
  check.type = 'checkbox';
  check.checked = viewed.has(file.path);
  check.addEventListener('change', () => {
    markViewed(file.path, check.checked);
    post({ action: 'viewed', path: file.path, viewed: check.checked });
    renderFiles([file.path]);
  });
  label.append(check, 'Viewed');
  const open = button('Open in editor', () => post({ action: 'editor', path: file.path }));
  const whole = fullFile(file);
  const full = button(whole ? 'Diff only' : 'Full file', () => {
    expanded.set(file.path, whole ? new Map() : new Map(Array.from({ length: file.hunks.length + 1 }, (_, index) => [index, { top: Infinity, bottom: 0 }])));
    loadContext(file);
    renderFiles([file.path]);
  });
  const kind = previewKind(file);
  const showPreview = kind !== undefined && (previewing.has(file.path) || previewOnly(file));
  full.hidden = showPreview || file.binary || file.change === 'added' || file.change === 'deleted' || file.change === 'unchanged' || !file.hunks.length || !atHead;
  const mode = previewSwitch(file, showPreview);
  const unresolved = threads.filter((thread) => !thread.resolved).length;
  const comments = el('span', 'muted comments', !threads.length ? '' : threads.length + (threads.length === 1 ? ' comment' : ' comments') + (unresolved === threads.length ? '' : ', ' + unresolved + ' open'));
  const chips = file.generated ? [el('span', 'file-chip', 'Generated')] : isLarge(file) ? [el('span', 'file-chip', 'Large diff')] : [];
  for (const chip of chips) chip.title = file.generated ? 'Generated file. GitHub folds these by default.' : 'Large diff, folded by default.';
  head.append(chevron, name, badge, stats, ...chips, comments, mode, label, full, open);
  box.append(head);
  const diff = el('div', 'diff');
  const placed = new Set(threads.filter((thread) => !standalone(thread)).map((thread) => thread.id));
  if (showPreview && kind === 'media') diff.append(mediaNode(file));
  else if (file.binary) diff.append(el('div', 'note muted', 'Binary file not shown.'));
  else if (showPreview) diff.append(previewNode(file, threads, placed));
  else if (!file.hunks.length) diff.append(el('div', 'note muted', file.change === 'renamed' ? 'Renamed without changes.' : 'No content changes.'));
  else diff.append(table(file, threads, placed));
  const outside = threads.filter((thread) => !placed.has(thread.id));
  if (outside.length) {
    const block = el('div', 'outside');
    block.append(el('div', 'muted', 'Comments on lines this diff does not show'), ...outside.map(threadBox));
    diff.prepend(block);
  }
  box.append(diff);
  return box;
}

function columnAt(cell: HTMLElement, event: MouseEvent): number | undefined {
  const caret = document.caretRangeFromPoint(event.clientX, event.clientY);
  if (!caret || !cell.contains(caret.startContainer)) return undefined;
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  let offset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node === caret.startContainer) return offset + caret.startOffset;
    offset += node.textContent?.length ?? 0;
  }
  return undefined;
}

function textRange(cell: HTMLElement, start: number, end: number): Range | undefined {
  const span = document.createRange();
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let begun = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!begun && start <= offset + length) { span.setStart(node, start - offset); begun = true; }
    if (begun && end <= offset + length) { span.setEnd(node, end - offset); return span; }
    offset += length;
  }
  return undefined;
}

function wordAt(cell: HTMLElement, column: number): { start: number; end: number } | undefined {
  const text = cell.textContent ?? '';
  const word = /[\p{L}\p{N}_$]/u;
  if (column >= text.length || !word.test(text[column] ?? '')) return undefined;
  let start = column;
  let end = column;
  while (start > 0 && word.test(text[start - 1] ?? '')) start -= 1;
  while (end < text.length && word.test(text[end] ?? '')) end += 1;
  return { start, end };
}

function lookupTarget(cell: HTMLElement): DefinitionTarget | undefined {
  const peekId = cell.closest('#peek') ? peeks[peekAt]?.id : undefined;
  const path = cell.closest<HTMLElement>('.file')?.dataset.path;
  return peekId ? { peek: peekId } : path !== undefined ? { path } : undefined;
}

const probes = new Map<string, boolean | 'pending'>();
let hovered: { id: string; cell: HTMLElement; start: number; end: number } | undefined;
let pointer: MouseEvent | undefined;
let probeTimer: ReturnType<typeof setTimeout> | undefined;

function setHighlight(name: string, span?: Range): void {
  if (!window.CSS?.highlights) return;
  if (span) CSS.highlights.set(name, new Highlight(span));
  else CSS.highlights.delete(name);
}

function showLink(): void {
  document.querySelectorAll('td.code.linked').forEach((cell) => cell.classList.remove('linked'));
  if (!hovered || probes.get(hovered.id) !== true) { setHighlight('lr-link'); return; }
  hovered.cell.classList.add('linked');
  setHighlight('lr-link', textRange(hovered.cell, hovered.start, hovered.end));
}

function probeAt(event: MouseEvent): void {
  clearTimeout(probeTimer);
  hovered = undefined;
  const cell = closestTo(event, 'td.code[data-line]');
  const target = cell ? lookupTarget(cell) : undefined;
  const column = cell ? columnAt(cell, event) : undefined;
  const word = cell && column !== undefined ? wordAt(cell, column) : undefined;
  if (!cell || !target || !word) { showLink(); return; }
  const id = JSON.stringify(['peek' in target ? target.peek : target.path, cell.dataset.line, word.start]);
  hovered = { id, cell, start: word.start, end: word.end };
  showLink();
  if (probes.has(id)) return;
  probeTimer = setTimeout(() => {
    probes.set(id, 'pending');
    post({ action: 'probe', id, ...target, line: Number(cell.dataset.line), column: word.start });
  }, 60);
}

function closePeek(): void {
  peeks.length = 0;
  peekAt = -1;
  renderPeek();
}

function renderPeek(): void {
  $('peek').hidden = peekAt < 0;
  setHighlight('lr-name');
  const peek = peeks[peekAt];
  if (!peek) return;
  $('peek-title').textContent = peek.guessed ? peek.location + ' · same name in this file' : peek.location;
  $<HTMLButtonElement>('peek-back').disabled = peekAt < 1;
  $<HTMLButtonElement>('peek-forward').disabled = peekAt >= peeks.length - 1;
  const body = el('table');
  const columns = el('colgroup');
  columns.append(el('col', 'num'), el('col'));
  body.append(columns);
  let nameCell: HTMLElement | undefined;
  peek.lines.forEach((html, index) => {
    const line = peek.startLine + index;
    const row = el('tr', line >= peek.focus.start && line <= peek.focus.end ? 'focus' : '');
    const cell = el('td', 'code');
    cell.innerHTML = html;
    cell.dataset.line = String(line);
    row.append(el('td', 'num', String(line)), cell);
    body.append(row);
    if (peek.name?.line === line) nameCell = cell;
  });
  const codeBox = $('peek-code');
  codeBox.replaceChildren(body);
  if (nameCell && peek.name) setHighlight('lr-name', textRange(nameCell, peek.name.start, peek.name.end));
  const first = body.querySelector<HTMLElement>('tr.focus');
  if (first) codeBox.scrollTop = Math.max(0, first.getBoundingClientRect().top - codeBox.getBoundingClientRect().top - 3 * first.offsetHeight);
}

/** Switch between the file list and the guide; the sidebar follows. */
function setView(next: View): void {
  view = next;
  closeToolbarMenu();
  if (next === 'guide' && (diffRange.kind !== 'all' || whitespace)) requestFiles({ kind: 'all' }, false);
  save();
  renderFiles();
  post({ action: 'view', view: next });
}

/** The Guide tab's count: steps once a guide exists, a pulse while Claude builds it. Build guide shows only in the guide. */
function showGuideTab(): void {
  const analysis = current?.analysis;
  const count = $('guide-count');
  const steps = analysis?.result?.groups.reduce((sum, group) => sum + group.steps.length, 0);
  count.className = analysis?.running ? 'count working' : 'count';
  count.textContent = analysis?.running || steps === undefined ? '' : String(steps);
  count.hidden = !analysis?.running && steps === undefined;
  $('files-count').textContent = files ? String(files.length - tabFiles().length) : '';
  for (const id of ['analyze', 'analysis-status', 'analyze-divider']) $(id).classList.toggle('off-view', view !== 'guide');
  for (const id of ['range', 'whitespace', 'filter-box', 'filter-menu']) $(id).classList.toggle('off-view', view !== 'files');
}

/** Show the guided layout with a step's group and the step open, scrolled to it. */
function revealStep(key: string): void {
  view = 'guide';
  const result = current?.analysis.result;
  if (files && result) {
    guide ??= buildGuide(result, files);
    const group = guide.find((item) => item.steps.some((step) => step.key === key));
    if (group) {
      collapsed.set(guideState('group', group.key), false);
      collapsed.set(guideState('step', key), false);
    }
  }
  save();
  renderFiles();
  document.querySelector('.step-wrap[data-key="' + CSS.escape(key) + '"]')?.scrollIntoView({ block: 'start' });
}

/** Show the guided layout with a section unfolded, scrolled to its head. */
function revealGroup(key: string): void {
  view = 'guide';
  collapsed.set(guideState('group', key), false);
  save();
  renderFiles();
  document.querySelector('[data-group="' + CSS.escape(key) + '"]')?.closest('.tree-node')?.scrollIntoView({ block: 'start' });
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined;

/** Show a hint that clears itself after a few seconds, on the next click, or on Escape. */
function showNotice(notice: NonNullable<ExtensionMessage['notice']>): void {
  const box = $('notice');
  const { extension } = notice;
  const link = el('a', '', 'Open on GitHub');
  if (notice.url !== undefined) link.href = notice.url;
  box.replaceChildren(el('span', '', notice.text), ...extension === undefined ? [] : [button('Find extension', () => { post({ action: 'find-extension', extension }); clearNotice(); }, 'small')],
    ...notice.url === undefined ? [] : [link]);
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(clearNotice, extension === undefined && notice.url === undefined ? 4000 : 8000);
}

function clearNotice(): void {
  clearTimeout(noticeTimer);
  $('notice').replaceChildren();
}

/** Paths whose diff differs from the one shown, or undefined when the file list or what it shows changed and every file needs drawing. */
function changedFiles(next: readonly FileDiff[], shownAs: string): string[] | undefined {
  const shown = files;
  if (view !== 'files' || shown === undefined || shownAs !== JSON.stringify([diffRange, whitespace, atHead])
    || shown.length !== next.length || next.some((file, index) => shown[index]?.path !== file.path)) return undefined;
  return next.filter((file, index) => JSON.stringify(file) !== JSON.stringify(shown[index])).map((file) => file.path);
}

/** A thread's live log on screen before a redraw, so Clawd can hop from it into Claude's new reply. */
interface LiveLog { readonly threadId: string; readonly messages: number; readonly log: HTMLElement; readonly at: DOMRect; readonly clawd: DOMRect }

function liveLogs(): LiveLog[] {
  return [...document.querySelectorAll<HTMLElement>('.claude-live[data-thread]')].flatMap((log) => {
    const clawd = log.querySelector('.clawd');
    const thread = current?.threads.find((candidate) => candidate.id === log.dataset.thread);
    return clawd && thread ? [{ threadId: thread.id, messages: thread.messages.length, log, at: log.getBoundingClientRect(), clawd: clawd.getBoundingClientRect() }] : [];
  });
}

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Once Claude's reply replaces its live log, the old log fades where it was and Clawd hops from it up into the reply's avatar. */
async function hopIntoAvatar(live: LiveLog): Promise<void> {
  const thread = current?.threads.find((candidate) => candidate.id === live.threadId);
  const box = document.getElementById('thread-' + live.threadId);
  if (reducedMotion.matches || !thread || !box || box.querySelector('.claude-live') || thread.messages.length <= live.messages || thread.messages.at(-1)?.author !== 'claude') return;
  const avatar = [...box.querySelectorAll<HTMLElement>('.clawd-avatar')].at(-1);
  const pose = avatar?.querySelector<HTMLElement>('.clawd-pose');
  const text = avatar?.nextElementSibling;
  if (!avatar || !pose || !(text instanceof HTMLElement)) return;
  Object.assign(live.log.style, { position: 'fixed', left: live.at.left + 'px', top: live.at.top + 'px', width: live.at.width + 'px', margin: '0', pointerEvents: 'none' });
  live.log.querySelector<HTMLElement>('.clawd')?.style.setProperty('visibility', 'hidden');
  document.body.append(live.log);
  live.log.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' }).finished.then(() => { live.log.remove(); }, () => { live.log.remove(); });
  // The avatar's own Clawd makes the hop: it starts offset onto the log row, feet to feet, and ends at offset zero, its resting place.
  const to = pose.getBoundingClientRect();
  const dx = Math.round(live.clawd.left + live.clawd.width / 2 - (to.left + to.width / 2)), dy = Math.round(live.clawd.bottom - to.bottom);
  const height = text.offsetHeight, from = Math.max(0, Math.round(live.at.bottom - text.getBoundingClientRect().top));
  Object.assign(text.style, { overflow: 'clip', boxSizing: 'border-box' });
  text.animate([{ height: from + 'px' }, { height: height + 'px' }], { duration: 260, easing: 'cubic-bezier(.2, .8, .2, 1)' }).finished
    .finally(() => { Object.assign(text.style, { overflow: '', boxSizing: '' }); }).catch(() => undefined);
  text.animate([{ opacity: 0, transform: 'translateY(2px)' }, { opacity: 1, transform: 'none' }], { duration: 200, delay: 180, easing: 'ease-out', fill: 'backwards' });
  avatar.animate([{ transform: 'scale(0)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }], { duration: 180, delay: 300, easing: 'ease-out', fill: 'backwards', pseudoElement: '::before' });
  pose.style.transform = `translate(${dx}px, ${dy}px)`;
  pose.dataset.pose = 'crouch';
  await wait(60);
  pose.dataset.pose = 'air';
  const steps = 6, jump = 6;
  const flight = pose.animate(Array.from({ length: steps + 1 }, (_, step) => {
    const done = step / steps, left = 1 - done;
    return { transform: step === steps ? 'translate(0px, 0px)' : `translate(${Math.round(dx * left)}px, ${Math.round(dy * left - jump * 4 * done * left)}px)` };
  }), { duration: 240 });
  pose.style.transform = '';
  await flight.finished.catch(() => undefined);
  pose.dataset.pose = 'crouch';
  await wait(60);
  delete pose.dataset.pose;
}

/** Open a new comment on lines picked outside the page, such as in the editor. */
function compose({ path, side, startLine, endLine }: NonNullable<ExtensionMessage['compose']>): void {
  if (!files?.some((file) => file.path === path)) { $('error').textContent = path + ' is not on this page.'; return; }
  if (view === 'guide') setView('files');
  const tab = tabOf(path);
  const switched = tab !== fileTab;
  fileTab = tab;
  pick(path, side, startLine, false).end = endLine;
  save();
  renderFiles(switched ? undefined : [path]);
  document.querySelector('[data-draft="composer"]')?.scrollIntoView({ block: 'center' });
}

function onExtensionMessage(data: ExtensionMessage): void {
  const live = data.state ? liveLogs() : [];
  if (data.state) render(data.state);
  for (const log of live) void hopIntoAvatar(log);
  const shownAs = JSON.stringify([diffRange, whitespace, atHead]);
  if (data.selection) { diffRange = data.selection.range; whitespace = data.selection.whitespace; atHead = data.atHead !== false; save(); }
  if (data.icons) fileIcons = data.icons;
  if (data.files) {
    const changed = changedFiles(data.files, shownAs);
    files = data.files;
    for (const file of files) if (!collapsed.has(file.path) && (file.generated || isLarge(file))) collapsed.set(file.path, true);
    if (changed === undefined) { guide = undefined; contextLines.clear(); loading.clear(); renderFiles(); }
    else {
      if (changed.length) guide = undefined;
      for (const path of changed) { contextLines.delete(path); loading.delete(path); }
      renderFiles(changed);
    }
  }
  if (data.markdown) {
    const entry = renderedPreviews.get(data.markdown.form);
    if (entry) renderedPreviews.set(data.markdown.form, { text: entry.text, html: data.markdown.html });
    const box = document.querySelector<HTMLElement>('[data-preview="' + CSS.escape(data.markdown.form) + '"]');
    if (box && entry) box.innerHTML = data.markdown.html || '<span class="muted">Nothing to preview.</span>';
  }
  if (data.commitDiff) {
    const { oid } = data.commitDiff;
    commitDiffs.set(oid, 'files' in data.commitDiff ? data.commitDiff.files : { error: data.commitDiff.error });
    renderCommitThreads(oid);
  }
  if (data.preview) { previews.set(data.preview.path, data.preview); loading.delete('preview:' + data.preview.path); renderFiles([data.preview.path]); }
  if (data.media) { medias.set(data.media.path, data.media); loading.delete('media:' + data.media.path); renderFiles([data.media.path]); }
  if (data.context) { contextLines.set(data.context.path, data.context.lines); loading.delete(data.context.path); renderFiles([data.context.path]); }
  if (data.definition) { peeks.length = peekAt + 1; peeks.push(data.definition); peekAt = peeks.length - 1; renderPeek(); }
  if (data.probe) { probes.set(data.probe.id, data.probe.found); showLink(); }
  if (data.revealStep) revealStep(data.revealStep);
  if (data.revealGroup) revealGroup(data.revealGroup);
  if (data.reveal && files) {
    fileTab = tabOf(data.reveal);
    collapsed.set(data.reveal, false);
    openFolders(data.reveal);
    save();
    renderFiles();
    document.querySelector('[data-path="' + CSS.escape(data.reveal) + '"]')?.scrollIntoView({ block: 'start' });
  }
  if (data.compose) compose(data.compose);
  if (data.filesError) $('files').replaceChildren(el('p', 'bad', 'Could not read the changes: ' + data.filesError));
  if (data.notice) showNotice(data.notice);
  if (data.error) {
    loading.clear();
    $('error').textContent = data.error;
    if (data.form && sending.delete(data.form)) { renderFiles(); if (current) renderConversation(current, true); }
  }
  if (data.done === 'review') $<HTMLTextAreaElement>('review').value = '';
  if (data.done === 'merge') closeMergeForm();
  if (data.done === 'title') closeTitleForm();
  if (data.done === 'dismiss') { dismissing = undefined; if (current) renderReviewers(current, true); }
  if (data.done === 'suggestions') { batch.clear(); renderBatch(); }
  if (data.done === 'conversation') {
    sending.delete('conversation');
    conversationDraft = '';
    previewTabs.delete('conversation');
    save();
    if (current) renderConversation(current, true);
  }
  if (data.done?.startsWith('edit:')) {
    const id = data.done.slice(5);
    sending.delete(data.done);
    edits.delete(id);
    previewTabs.delete(data.done);
    if (current) renderConversation(current, true);
    renderFiles([allThreads().find((thread) => thread.messages.some((entry) => 'id' in entry && entry.id === id))?.path]);
  }
  if (data.done === 'body') { editingBody = false; if (current) render(current); }
  if (data.done === 'composer') {
    sending.delete('composer');
    const path = composer?.path;
    composer = undefined;
    save();
    renderFiles([path]);
  }
  if (data.done?.startsWith('publish:')) {
    const id = data.done.slice(8);
    sending.delete(data.done);
    publishing.delete(id);
    previewTabs.delete(data.done);
    save();
    renderFiles([allThreads().find((thread) => thread.id === id)?.path]);
  }
  if (data.done?.startsWith('reply:')) {
    const id = data.done.slice(6);
    sending.delete(data.done);
    replies.delete(id);
    save();
    renderFiles([allThreads().find((thread) => thread.id === id)?.path]);
  }
  if (data.branches) { baseBranches = data.branches; renderBaseMenu(); }
  if (data.branchesError !== undefined) { baseBranches = data.branchesError; renderBaseMenu(); }
  if (data.pickerOptions) { pickerOptions = data.pickerOptions; pickerError = undefined; renderPicker(); }
  if (data.pickerError !== undefined) { pickerError = data.pickerError; renderPicker(); }
  if (data.idle) setBusy(false);
}

$('show-unpushed').addEventListener('click', showUnpushed);
for (const [id, action] of [['pr', 'pr'], ['push', 'push'], ['terminal', 'terminal'], ['retry', 'retry'], ['refresh', 'refresh']] as const) $(id).addEventListener('click', () => post({ action }));
$('remove-worktree').addEventListener('click', () => askInMenu('remove-worktree',
  'Remove the worktree for ' + (current?.number === undefined ? 'this PR' : '#' + current.number) + '? Its local comments are deleted too. Git refuses if it has uncommitted changes.',
  'Remove worktree', () => post({ action: 'remove-worktree' })));
// Re-rendered Clawds join the page clock instead of restarting their animation.
document.addEventListener('animationstart', (event) => {
  if (event.animationName !== 'clawd' || !(event.target instanceof Element)) return;
  for (const animation of event.target.getAnimations({ subtree: true })) if (animation instanceof CSSAnimation && animation.animationName === 'clawd') animation.startTime = 0;
});
setInterval(() => {
  for (const time of document.querySelectorAll<HTMLElement>('[data-since]')) time.textContent = elapsed(Number(time.dataset.since));
}, 1000);
$('error').addEventListener('click', () => { $('error').textContent = ''; });
document.addEventListener('pointerdown', (event) => { if (!(event.target instanceof Node && $('notice').contains(event.target))) clearNotice(); });
window.addEventListener('keydown', (event) => { if (event.key === 'Escape') clearNotice(); });
document.addEventListener('mousemove', (event) => {
  pointer = event;
  if (event.metaKey || event.ctrlKey) probeAt(event);
  else if (hovered) { hovered = undefined; showLink(); }
});
document.addEventListener('click', (event) => {
  if (!(event.metaKey || event.ctrlKey)) return;
  const cell = closestTo(event, 'td.code[data-line]');
  if (!cell) return;
  const column = columnAt(cell, event);
  const target = lookupTarget(cell);
  if (column === undefined || !target) return;
  event.preventDefault();
  $('error').textContent = '';
  post({ action: 'definition', ...target, line: Number(cell.dataset.line), column });
});
for (const type of ['keydown', 'keyup'] as const) {
  window.addEventListener(type, (event) => {
    const held = event.metaKey || event.ctrlKey;
    document.body.classList.toggle('peeking', held);
    if (held && pointer) probeAt(pointer);
    else if (!held) { clearTimeout(probeTimer); hovered = undefined; showLink(); }
  });
}
window.addEventListener('blur', () => { hovered = undefined; showLink(); });
window.addEventListener('keydown', (event) => { if (event.key === 'Escape' && peeks.length && !(event.target instanceof HTMLTextAreaElement)) closePeek(); });
$('peek-close').addEventListener('click', closePeek);
/** Drag the definition panel's left edge to resize it; double-click restores the default width. */
function showPeekWidth(): void {
  if (peekWidth === undefined) document.body.style.removeProperty('--peek-width');
  else document.body.style.setProperty('--peek-width', peekWidth + 'px');
}
showPeekWidth();
$('peek-resize').addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  const handle = $('peek-resize');
  handle.setPointerCapture(event.pointerId);
  document.body.classList.add('resizing');
  const move = (moved: PointerEvent): void => {
    peekWidth = Math.round(Math.min(window.innerWidth - 16, Math.max(320, window.innerWidth - moved.clientX - 8)));
    showPeekWidth();
  };
  const stop = (): void => {
    handle.removeEventListener('pointermove', move);
    document.body.classList.remove('resizing');
    save();
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', stop, { once: true });
  handle.addEventListener('pointercancel', stop, { once: true });
});
$('peek-resize').addEventListener('dblclick', () => { peekWidth = undefined; showPeekWidth(); save(); });
$('peek-back').addEventListener('click', () => { if (peekAt > 0) { peekAt -= 1; renderPeek(); } });
$('peek-forward').addEventListener('click', () => { if (peekAt < peeks.length - 1) { peekAt += 1; renderPeek(); } });
$('peek-open').addEventListener('click', () => {
  const peek = peeks[peekAt];
  if (peek) post({ action: 'open-definition', peek: peek.id });
});
$('unified').addEventListener('click', () => { layout = 'unified'; save(); renderFiles(); });
$('split').addEventListener('click', () => { layout = 'split'; save(); renderFiles(); });
for (const name of ['files', 'guide'] as const) $('view-' + name).addEventListener('click', () => { fileTab = undefined; setView(name); });
$('range').addEventListener('click', openRangeMenu);
$('whitespace').addEventListener('click', () => requestFiles(diffRange, !whitespace));
$<HTMLInputElement>('file-filter').value = fileFilter;
$('file-filter').addEventListener('input', () => { fileFilter = $<HTMLInputElement>('file-filter').value; applyFilters(); });
$('file-filter').addEventListener('keydown', (event) => { if (event.key === 'Escape') { $<HTMLInputElement>('file-filter').value = ''; fileFilter = ''; applyFilters(); $('file-filter').blur(); } });
$('filter-clear').addEventListener('click', () => { $<HTMLInputElement>('file-filter').value = ''; fileFilter = ''; applyFilters(); $('file-filter').focus(); });
$('filter-clear').hidden = fileFilter === '';
$('filter-menu').addEventListener('click', openFilterMenu);
$('fold-conversation').addEventListener('click', () => { conversationFolded = !conversationFolded; save(); if (current) renderConversation(current, true); });
$('filter-menu').setAttribute('aria-pressed', String(filtersOn()));
document.addEventListener('pointerdown', (event) => {
  if (toolbarMenu && event.target instanceof Node && !toolbarMenu.node.contains(event.target) && !$(toolbarMenu.anchor).contains(event.target)) closeToolbarMenu();
  if (emojiFor !== undefined && event.target instanceof Element && !event.target.closest('.reactions')) {
    emojiFor = undefined;
    renderFiles();
    if (current) renderConversation(current, true);
  }
});
window.addEventListener('keydown', onShortcut);
$('commit-batch').addEventListener('click', () => { if (batch.size) changePullRequest({ action: 'commit-suggestions', picked: [...batch.values()] }); });
$('discard-review').addEventListener('click', () => askInMenu('discard-review', 'Discard your pending review? Its comments are deleted. Nobody saw them yet.', 'Discard review',
  () => changePullRequest({ action: 'discard-review' })));
$('approve-runs').addEventListener('click', () => {
  const count = current?.conversation?.awaitingApproval.length ?? 0;
  askInMenu('approve-runs', 'Run ' + (count === 1 ? 'the workflow' : count + ' workflows') + ' from this fork? It runs code the fork\'s author wrote. Review changes to workflow files first.',
    'Approve and run', () => changePullRequest({ action: 'approve-runs' }));
});
$('update-branch').addEventListener('click', openUpdateMenu);
$('method').addEventListener('click', openMethodMenu);
$('auto-merge').addEventListener('click', () => clickMerge(true));
$('auto-merge-off').addEventListener('click', () => changePullRequest({ action: 'auto-merge-off' }));
$('dequeue').addEventListener('click', () => changePullRequest({ action: 'dequeue' }));
$('merge-cancel').addEventListener('click', closeMergeForm);
attachMentions($<HTMLTextAreaElement>('review'), $('review-box'));
$('folders').addEventListener('click', () => { folders = !folders; save(); renderFiles(); });
$('analyze').addEventListener('click', () => { $('error').textContent = ''; post({ action: current?.analysis.running ? 'analysis-stop' : 'analyze' }); });
for (const [id, value] of [['collapse', true], ['expand', false]] as const) {
  $(id).addEventListener('click', () => {
    if (view === 'guide') {
      for (const group of guide ?? []) {
        if (!value) collapsed.set(guideState('group', group.key), false);
        for (const step of group.steps) collapsed.set(guideState('step', step.key), value);
      }
    } else {
      for (const file of files ?? []) {
        collapsed.set(file.path, value);
        if (!value) openFolders(file.path);
      }
    }
    save();
    renderFiles();
  });
}
$('toggle-comments').addEventListener('click', () => {
  const open = !document.querySelector('details.thread[open]');
  for (const thread of allThreads()) threadOpen.set(thread.id, open);
  renderFiles();
  showCommentsTip();
});
$('toggle-comments').addEventListener('pointerenter', showCommentsTip);
function showCommentsTip(): void {
  setTip($('toggle-comments'), document.querySelector('details.thread[open]') ? 'Collapse all comments' : 'Expand all comments');
}
for (const review of reviewButtons) {
  review.addEventListener('click', () => {
    $('error').textContent = '';
    setBusy(true);
    post({ action: 'review', event: review.dataset.event as ReviewEvent, body: $<HTMLTextAreaElement>('review').value });
  });
}
$('conflict-send').addEventListener('click', () => {
  const answer = $<HTMLTextAreaElement>('conflict-answer');
  if (!answer.value.trim()) { answer.focus(); return; }
  $('error').textContent = '';
  post({ action: 'fix-conflicts', text: answer.value });
  answer.value = '';
});
$('conflict-cancel').addEventListener('click', () => post({ action: 'dismiss-conflict-question' }));
$('fix-conflicts').addEventListener('click', () => {
  $('error').textContent = '';
  $<HTMLButtonElement>('fix-conflicts').disabled = true;
  post({ action: 'fix-conflicts' });
});
$('edit-title').addEventListener('click', editTitle);
$('edit-body').addEventListener('click', editBody);
for (const what of ['reviewers', 'assignees', 'labels', 'milestone'] as const) $('pick-' + what).addEventListener('click', () => openPicker(what));
document.addEventListener('pointerdown', (event) => {
  if (picker && event.target instanceof Node && !picker.node.contains(event.target) && !$('pick-' + picker.what).contains(event.target)) closePicker(true);
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && picker) closePicker(false);
  if (event.key === 'Escape' && toolbarMenu) closeToolbarMenu();
  if (event.key === 'Escape' && asking) stopAsking();
});
$('merge').addEventListener('click', () => {
  if (current?.conversation?.merge.mergeQueue) changePullRequest({ action: 'enqueue' });
  else clickMerge(false);
});
window.addEventListener('message', (event: MessageEvent) => {
  const frame = event.source ? [...document.querySelectorAll<HTMLIFrameElement>('iframe.html-preview')].find((node) => node.contentWindow === event.source) : undefined;
  if (frame) frameMessage(frame, event.data);
  else onExtensionMessage(event.data as ExtensionMessage);
});
render(initial.state);
new ResizeObserver(([entry]) => {
  if (entry) document.body.style.setProperty('--bar-height', (entry.target as HTMLElement).offsetHeight + 'px');
}).observe($('files-bar'));
post({ action: 'ready' });
