import { resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AgentUpdate } from './contracts.js';
import {
  BridgeClient,
  BridgeError,
  BridgeProtocolError,
  isIdentifier,
  isText,
  parseThread,
  readBatch,
  readDescriptor,
  record,
} from './connection.js';
import { buildReviewPrompt, reviewInstructions, reviewReplyInstructions } from './eventPrompt.js';
import { maximumReplyLength } from './limits.js';
import { ownsSession } from './sessionBinding.js';

/** Produce a tool result without writing non-protocol output to standard output. */
function result(text: string, isError = false): CallToolResult {
  return isError ? { content: [{ type: 'text', text }], isError: true }
    : { content: [{ type: 'text', text }] };
}

/** Convert errors to short diagnostics that never include bridge credentials. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1000) : 'An unknown review bridge error occurred.';
}

/** Wait between reconnect attempts without delaying shutdown. */
function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolvePause) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolvePause();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}


/** Validate tool parameters explicitly even when a client bypasses the JSON schema. */
function eventIdFromArguments(argumentsValue: unknown, allowedKeys: readonly string[]): string {
  const args = record(argumentsValue);
  if (args === undefined || !isIdentifier(args.event_id)
    || Object.keys(args).some((key) => !allowedKeys.includes(key))) {
    throw new Error('Provide a valid event_id from the review notification or list_pending_reviews.');
  }
  return args.event_id;
}

/** Connect the local MCP channel and forward durable human review events. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const noPush = args.includes('--no-push');
  const connectionArgs = args.filter((argument) => argument !== '--no-push');
  const descriptorArgument = connectionArgs[1];
  if (args.length !== (noPush ? 3 : 2) || connectionArgs.length !== 2
    || connectionArgs[0] !== '--connection' || descriptorArgument === undefined) {
    throw new Error('Usage: node channel.cjs --connection /absolute/path/to/connection.json [--no-push]');
  }
  const descriptorPath = resolve(descriptorArgument);
  const descriptor = await readDescriptor(descriptorPath);
  const bindingPath = process.env['LOCAL_REVIEW_SESSION_BINDING'];
  const sessionId = process.env['CLAUDE_CODE_SESSION_ID'];
  const selected = async (): Promise<boolean> => bindingPath === undefined || await ownsSession(bindingPath, descriptor.workspaceRoot, sessionId);
  const shutdown = new AbortController();
  const bridge = new BridgeClient(descriptor, descriptorPath, shutdown.signal, noPush ? 'tools' : 'channel');
  const server = new Server({ name: 'local-review', version: '0.4.5' }, {
    capabilities: { tools: {}, ...(noPush ? {} : { experimental: { 'claude/channel': {} } }) },
    instructions: reviewInstructions,
  });
  const delivered = new Set<string>();
  let stopping = false;

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    shutdown.abort();
    try {
      await server.close();
    } finally {
      process.stdin.pause();
    }
  };
  const requestStop = (): void => {
    void stop().catch((error: unknown) => process.stderr.write(`Local Review: ${describeError(error)}\n`));
  };
  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);
  process.stdin.once('end', requestStop);
  server.onclose = requestStop;
  const initialized = new Promise<void>((resolveInitialized) => {
    const readyOrStopped = (): void => {
      shutdown.signal.removeEventListener('abort', readyOrStopped);
      resolveInitialized();
    };
    server.oninitialized = readyOrStopped;
    shutdown.signal.addEventListener('abort', readyOrStopped, { once: true });
  });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: 'acknowledge_review',
        description: 'Confirm receipt of an immutable human review event before starting work. This is the explicit delivery acknowledgement.',
        inputSchema: {
          type: 'object', properties: { event_id: { type: 'string', minLength: 1, maxLength: 256 } },
          required: ['event_id'], additionalProperties: false,
        },
      },
      {
        name: 'set_review_working',
        description: 'Show the human that you have started work on the acknowledged review event.',
        inputSchema: {
          type: 'object', properties: { event_id: { type: 'string', minLength: 1, maxLength: 256 } },
          required: ['event_id'], additionalProperties: false,
        },
      },
      {
        name: 'reply_to_review',
        description: 'Reply with Markdown inside the original VS Code review thread. Use answered for questions or summaries and ready when implementation is ready for human review. Only the human resolves threads.',
        inputSchema: {
          type: 'object',
          properties: {
            event_id: { type: 'string', minLength: 1, maxLength: 256 },
            text: { type: 'string', description: reviewReplyInstructions, minLength: 1, maxLength: maximumReplyLength },
            status: { type: 'string', enum: ['answered', 'ready'] },
          },
          required: ['event_id', 'text', 'status'], additionalProperties: false,
        },
      },
      {
        name: 'list_pending_reviews',
        description: 'Inspect current unresolved review events and thread context, including delivery status. Use after a superseded event or uncertain connection result.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    try {
      if (!await selected()) return result('Diese Unterhaltung ist nicht mit Local Review verbunden. In der gewünschten Unterhaltung /local-review:connect ausführen. Ältere Claude-Versionen benötigen ein Update.', true);
      if (request.params.name === 'list_pending_reviews') {
        const argsRecord = record(request.params.arguments ?? {});
        if (argsRecord === undefined || Object.keys(argsRecord).length !== 0) {
          return result('list_pending_reviews does not accept arguments.', true);
        }
        const batch = readBatch(await bridge.request('/pending'), descriptor.workspaceRoot);
        return result(JSON.stringify(batch, null, 2));
      }

      const supported = ['acknowledge_review', 'set_review_working', 'reply_to_review'];
      if (!supported.includes(request.params.name)) return result('Unknown Local Review tool.', true);
      const isReply = request.params.name === 'reply_to_review';
      const eventId = eventIdFromArguments(request.params.arguments, isReply ? ['event_id', 'text', 'status'] : ['event_id']);
      let update: AgentUpdate;
      if (isReply) {
        const argsRecord = record(request.params.arguments);
        if (argsRecord === undefined || !isText(argsRecord.text, maximumReplyLength)
          || argsRecord.text.trim().length === 0 || (argsRecord.status !== 'answered' && argsRecord.status !== 'ready')) {
          return result('Provide non-empty reply text and status answered or ready.', true);
        }
        update = { eventId, status: argsRecord.status, text: argsRecord.text };
      } else {
        update = { eventId, status: request.params.name === 'acknowledge_review' ? 'received' : 'working' };
      }
      const response = record(await bridge.request('/update', update));
      if (response === undefined) throw new Error('The review bridge returned an invalid update response.');
      const thread = parseThread(response.thread);
      return result(JSON.stringify({
        thread_id: thread.id,
        event_id: eventId,
        event_status: update.status,
        thread_status: thread.status,
      }));
    } catch (error: unknown) {
      if (error instanceof BridgeError && error.status === 409) {
        return result('This event is superseded or no longer actionable. Stop work on it and call list_pending_reviews for the current human feedback.', true);
      }
      if (error instanceof BridgeError) return result(describeError(error), true);
      return result(`${describeError(error)} If this followed an update, its outcome may be uncertain. Inspect list_pending_reviews before repeating a reply.`, true);
    }
  });

  try {
    await server.connect(new StdioServerTransport());
    await initialized;
    let sequence = 0;
    let recovering = true;
    let retryDelay = 500;
    let lastDiagnostic = '';
    let lastRefreshDiagnostic = '';
    while (!shutdown.signal.aborted) {
      try {
        if (noPush) {
          if (!await selected()) {
            await pause(1_000, shutdown.signal);
            continue;
          }
          const health = record(await bridge.request('/health'));
          if (health?.workspaceRoot !== descriptor.workspaceRoot) {
            throw new Error('The review bridge returned a health response for a different workspace.');
          }
          retryDelay = 500;
          lastDiagnostic = '';
          lastRefreshDiagnostic = '';
          await pause(15_000, shutdown.signal);
          continue;
        }
        const batch = readBatch(await bridge.request(recovering ? '/pending' : `/events?after=${sequence}`), descriptor.workspaceRoot);
        const threads = new Map(batch.threads.map((thread) => [thread.id, thread]));
        const events = [...batch.events].sort((left, right) => left.sequence - right.sequence);
        for (const event of events) {
          if (shutdown.signal.aborted) break;
          if ((recovering || !event.acknowledged) && !delivered.has(event.id)) {
            await server.notification({
              method: 'notifications/claude/channel',
              params: {
                content: buildReviewPrompt(event, threads.get(event.threadId)),
                meta: { event_id: event.id, thread_id: event.threadId, intent: event.intent },
              },
            });
            delivered.add(event.id);
          }
          sequence = Math.max(sequence, event.sequence);
        }
        recovering = false;
        retryDelay = 500;
        lastDiagnostic = '';
        lastRefreshDiagnostic = '';
      } catch (error: unknown) {
        if (shutdown.signal.aborted) break;
        if (error instanceof BridgeProtocolError) throw error;
        const diagnostic = describeError(error);
        if (diagnostic !== lastDiagnostic) {
          process.stderr.write(`Local Review: ${diagnostic} Reconnecting automatically.\n`);
          lastDiagnostic = diagnostic;
        }
        try {
          if (await bridge.refresh()) {
            sequence = 0;
            delivered.clear();
            recovering = true;
          }
          lastRefreshDiagnostic = '';
        } catch (refreshError: unknown) {
          const refreshDiagnostic = describeError(refreshError);
          if (refreshDiagnostic !== lastRefreshDiagnostic) {
            process.stderr.write(`Local Review: ${refreshDiagnostic}\n`);
            lastRefreshDiagnostic = refreshDiagnostic;
          }
        }
        await pause(retryDelay, shutdown.signal);
        retryDelay = Math.min(retryDelay * 2, 10_000);
      }
    }
  } finally {
    process.removeListener('SIGINT', requestStop);
    process.removeListener('SIGTERM', requestStop);
    process.stdin.removeListener('end', requestStop);
    await stop();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`Local Review: ${describeError(error)}\n`);
  process.exitCode = 1;
});
