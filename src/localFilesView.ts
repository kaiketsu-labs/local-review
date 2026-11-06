import { basename, join } from 'node:path';
import * as vscode from 'vscode';
import type { ReviewThread } from './contracts.js';
import { fileTree, type FileFolder } from './fileTree.js';
import { checkoutLabel, groupByRepository, type LocalCheckout, matchesFilter } from './localCheckouts.js';
import { listRepositoryFiles } from './localReview.js';

interface RepositoryFile { readonly path: string }
type Node =
  | { readonly kind: 'repository'; readonly repository: string; readonly name: string; readonly checkouts: readonly LocalCheckout[] }
  | { readonly kind: 'checkout'; readonly checkout: LocalCheckout }
  | { readonly kind: 'folder'; readonly checkout: LocalCheckout; readonly folder: FileFolder<RepositoryFile> }
  | { readonly kind: 'file'; readonly checkout: LocalCheckout; readonly path: string };

const checkoutIcons: Record<LocalCheckout['kind'], string> = { folder: 'repo', worktree: 'git-branch', pr: 'git-pull-request' };
const checkoutNotes: Record<LocalCheckout['kind'], string> = { folder: '', worktree: 'worktree', pr: 'PR' };

/**
 * The Local view: every checkout's files as a tree, with Git's change marks and the number of open comments.
 * With one checkout its files are the top level; with several, checkouts sit under their repository's row.
 * Clicking a file shows it on that checkout's review page.
 */
export class LocalFilesView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.#changed.event;
  #checkouts: Promise<readonly LocalCheckout[]> | undefined;
  readonly #trees = new Map<string, Promise<FileFolder<RepositoryFile>>>();
  #filter = '';

  constructor(
    private readonly listCheckouts: () => Promise<readonly LocalCheckout[]>,
    /** A checkout's threads, or none while its review has not started. */
    private readonly threads: (checkout: LocalCheckout) => Promise<readonly ReviewThread[]>,
  ) {}

  /** List the checkouts and their files again, after files or worktrees were added or removed. */
  reload(): void {
    this.#checkouts = undefined;
    this.#trees.clear();
    this.#changed.fire(undefined);
  }

  /** Show only checkouts whose repository, branch or PR matches `filter`; empty shows all. */
  setFilter(filter: string): void {
    this.#filter = filter.trim();
    this.#changed.fire(undefined);
  }

  get filter(): string {
    return this.#filter;
  }

  /** Redraw comment counts without listing the files again. */
  redraw(): void {
    this.#changed.fire(undefined);
  }

  /** The checkouts last listed. */
  checkouts(): Promise<readonly LocalCheckout[]> {
    this.#checkouts ??= this.listCheckouts().catch(() => []);
    return this.#checkouts;
  }

  #tree(checkout: LocalCheckout): Promise<FileFolder<RepositoryFile>> {
    let tree = this.#trees.get(checkout.root);
    if (tree === undefined) {
      tree = listRepositoryFiles(checkout.root).then((paths) => fileTree(paths.map((path) => ({ path }))), () => fileTree<RepositoryFile>([]));
      this.#trees.set(checkout.root, tree);
    }
    return tree;
  }

  async #contents(checkout: LocalCheckout, folder: FileFolder<RepositoryFile>): Promise<Node[]> {
    return [
      ...folder.folders.map((child): Node => ({ kind: 'folder', checkout, folder: child })),
      ...folder.files.map((file): Node => ({ kind: 'file', checkout, path: file.path })),
    ];
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (node === undefined) {
      const all = await this.checkouts();
      const [only] = all;
      if (all.length === 1 && only !== undefined && this.#filter === '') return this.#contents(only, await this.#tree(only));
      return groupByRepository(all.filter((checkout) => matchesFilter(checkout, this.#filter)))
        .map(({ repository, name, checkouts }): Node => ({ kind: 'repository', repository, name, checkouts }));
    }
    if (node.kind === 'repository') return node.checkouts.map((checkout): Node => ({ kind: 'checkout', checkout }));
    if (node.kind === 'checkout') return this.#contents(node.checkout, await this.#tree(node.checkout));
    return node.kind === 'folder' ? this.#contents(node.checkout, node.folder) : [];
  }

  async getTreeItem(node: Node): Promise<vscode.TreeItem> {
    if (node.kind === 'repository') {
      // A filter opens every matching repository; its own id keeps VS Code from reusing the closed state.
      const filtering = this.#filter !== '';
      const item = new vscode.TreeItem(node.name, filtering ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `repository:${node.repository}${filtering ? ':filtered' : ''}`;
      item.iconPath = new vscode.ThemeIcon('repo');
      item.description = String(node.checkouts.length);
      item.tooltip = node.repository;
      return item;
    }
    if (node.kind === 'checkout') {
      const { checkout } = node;
      const item = new vscode.TreeItem(checkoutLabel(checkout), vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `checkout:${checkout.root}`;
      item.iconPath = new vscode.ThemeIcon(checkoutIcons[checkout.kind]);
      item.description = checkoutNotes[checkout.kind];
      item.tooltip = checkout.root;
      item.contextValue = 'pairReview.checkout';
      return item;
    }
    // Without a resource, folders get no theme icon, which would draw a second arrow next to the tree's own.
    if (node.kind === 'folder') {
      const item = new vscode.TreeItem(node.folder.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `folder:${node.checkout.root}:${node.folder.path}`;
      return item;
    }
    const item = new vscode.TreeItem(basename(node.path), vscode.TreeItemCollapsibleState.None);
    item.id = `file:${node.checkout.root}:${node.path}`;
    item.resourceUri = vscode.Uri.file(join(node.checkout.root, node.path));
    item.iconPath = vscode.ThemeIcon.File;
    item.contextValue = 'pairReview.localFile';
    item.command = { command: 'pairReview.openLocalFile', title: 'Show on review page', arguments: [node.checkout.root, node.path] };
    const open = (await this.threads(node.checkout)).filter((thread) => !thread.resolved && thread.anchor.path === node.path).length;
    if (open > 0) item.description = open === 1 ? '1 comment' : `${open} comments`;
    return item;
  }

  dispose(): void {
    this.#changed.dispose();
  }
}
