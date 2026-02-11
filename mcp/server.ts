#!/usr/bin/env bun
/**
 * MCP Code Execution Server for RS-Agent
 *
 * Manages multiple bot connections dynamically at runtime.
 * Agents can connect, disconnect, and execute code on any connected bot.
 *
 * Features:
 * - execute_code: Simple one-shot code execution
 * - run_task: Supervised task execution with checkpoints and progress reporting
 * - continue_task: Resume a paused task with new instructions
 * - get_task_status: Check on a running/paused task
 * - abort_task: Stop a running task
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { botManager } from './api/index.js';
import { formatWorldState } from '../sdk/formatter.js';
import { taskManager } from './task-manager.js';
import { formatStateDiff } from '../sdk/state-diff.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Create MCP server
const server = new Server(
  {
    name: 'rs-agent-bot',
    version: '3.0.0'
  },
  {
    capabilities: {
      resources: {},
      tools: {}
    }
  }
);

// List available API modules as resources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: 'file://api/bot.ts',
        name: 'Bot API',
        description: 'High-level bot actions: chopTree, walkTo, attackNpc, openBank, etc. Domain-aware methods that wait for effects.',
        mimeType: 'text/plain'
      },
      {
        uri: 'file://api/sdk.ts',
        name: 'SDK API',
        description: 'Low-level SDK: getState, sendWalk, getInventory, findNearbyNpc, etc. Direct protocol access.',
        mimeType: 'text/plain'
      }
    ]
  };
});

// Read API module contents
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  try {
    const uri = request.params.uri;
    let filePath: string;

    if (uri.startsWith('file://')) {
      const relativePath = uri.replace('file://', '');
      filePath = join(__dirname, relativePath);
    } else {
      throw new Error(`Unsupported URI scheme: ${uri}`);
    }

    const content = await Bun.file(filePath).text();

    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: 'text/plain',
          text: content
        }
      ]
    };
  } catch (error: any) {
    throw new Error(`Failed to read resource: ${error.message}`);
  }
});

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'execute_code',
        description: 'Execute TypeScript code on a bot. Auto-connects using credentials from bots/{name}/bot.env. The code runs in an async context with bot (BotActions) and sdk (BotSDK) available.',
        inputSchema: {
          type: 'object',
          properties: {
            bot_name: {
              type: 'string',
              description: 'Bot name (matches folder in bots/). Auto-connects on first use.'
            },
            code: {
              type: 'string',
              description: 'TypeScript code to execute. Available globals: bot (BotActions), sdk (BotSDK). Example: "await bot.chopTree(); return sdk.getState();"'
            },
            timeout: {
              type: 'number',
              description: 'Execution timeout in minutes (default: 2, max: 60)'
            }
          },
          required: ['bot_name', 'code']
        }
      },
      {
        name: 'disconnect_bot',
        description: 'Disconnect a connected bot',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Bot name to disconnect'
            }
          },
          required: ['name']
        }
      },
      {
        name: 'list_bots',
        description: 'List all connected bots',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'run_task',
        description: `Start a supervised task that can report progress and pause at checkpoints for feedback.

Use this for complex, multi-step operations where you want to:
- Monitor progress in real-time
- Make decisions based on intermediate results
- Adjust behavior mid-execution

The script has access to a TaskContext (ctx) with:
- ctx.bot: BotActions for high-level commands
- ctx.sdk: BotSDK for low-level access
- ctx.log(...): Log messages
- ctx.setAction(name): Set current action being performed
- ctx.reportProgress({action, message, progress}): Report progress
- ctx.checkpoint(reason): Pause and get new instructions from Claude
- ctx.shouldContinue(): Check if task should continue

Example:
\`\`\`
ctx.setAction('Chopping trees');
for (let i = 0; i < 10 && ctx.shouldContinue(); i++) {
  const result = await ctx.bot.chopTree();
  ctx.reportProgress({
    action: 'Chopping',
    progress: { current: i + 1, total: 10, unit: 'trees' },
    message: result.success ? 'Got logs' : result.message
  });

  // Checkpoint every 3 trees to let Claude review and adjust
  if ((i + 1) % 3 === 0) {
    const feedback = await ctx.checkpoint('Progress check');
    if (feedback.newInstructions) {
      ctx.log('New instructions:', feedback.newInstructions);
    }
  }
}
return ctx.getStateDiffFromStart();
\`\`\``,
        inputSchema: {
          type: 'object',
          properties: {
            bot_name: {
              type: 'string',
              description: 'Bot name (matches folder in bots/). Auto-connects on first use.'
            },
            code: {
              type: 'string',
              description: 'TypeScript code to execute. Has access to ctx (TaskContext) with bot, sdk, checkpoint(), reportProgress(), etc.'
            },
            description: {
              type: 'string',
              description: 'Short description of what this task does (for tracking)'
            }
          },
          required: ['bot_name', 'code', 'description']
        }
      },
      {
        name: 'continue_task',
        description: 'Resume a paused task with optional new instructions. Use after a task pauses at a checkpoint.',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description: 'The task ID returned by run_task'
            },
            instructions: {
              type: 'string',
              description: 'New instructions for the task (optional). The task will receive these via checkpoint result.'
            }
          },
          required: ['task_id']
        }
      },
      {
        name: 'get_task_status',
        description: 'Get the current status of a task, including progress, state changes, and whether it needs feedback.',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description: 'The task ID to check'
            },
            include_state: {
              type: 'boolean',
              description: 'Include full world state in response (default: true)'
            }
          },
          required: ['task_id']
        }
      },
      {
        name: 'abort_task',
        description: 'Stop a running or paused task.',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description: 'The task ID to abort'
            },
            reason: {
              type: 'string',
              description: 'Reason for aborting (optional)'
            }
          },
          required: ['task_id']
        }
      },
      {
        name: 'list_tasks',
        description: 'List all tracked tasks (running, paused, completed, etc.)',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      }
    ]
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'disconnect_bot': {
        const botName = args?.name as string;

        if (!botName) {
          return errorResponse('Bot name is required');
        }

        await botManager.disconnect(botName);
        return successResponse({ message: `Disconnected bot "${botName}"` });
      }

      case 'list_bots': {
        const bots = botManager.list();
        return successResponse({
          bots,
          count: bots.length
        });
      }

      case 'execute_code': {
        const botName = args?.bot_name as string;
        const code = args?.code as string;

        if (!botName) {
          return errorResponse('bot_name is required');
        }

        if (!code) {
          return errorResponse('code is required');
        }

        const isLongCode = code.length > 2000;

        // Auto-connect if not already connected
        let connection = botManager.get(botName);
        if (!connection) {
          console.error(`[MCP] Bot "${botName}" not connected, auto-connecting...`);
          connection = await botManager.connect(botName);
        }

        // Capture console output
        const logs: string[] = [];
        const originalLog = console.log;
        const originalWarn = console.warn;
        const originalError = console.error;

        console.log = (...args) => logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' '));
        console.warn = (...args) => logs.push('[warn] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' '));
        // Don't capture console.error - let it go to stderr for MCP debugging

        try {
          const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
          const fn = new AsyncFunction('bot', 'sdk', code);

          // Execute code with configurable timeout + MCP cancellation signal
          const timeoutMinutes = Math.min(Math.max((args?.timeout as number) || 2, 0.1), 60);
          const EXECUTION_TIMEOUT = timeoutMinutes * 60 * 1000;
          let timeoutId: ReturnType<typeof setTimeout>;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error(`Code execution timed out after ${timeoutMinutes} minute(s)`)), EXECUTION_TIMEOUT);
          });

          // AbortController that fires on MCP cancellation
          const abortController = new AbortController();
          const signal = abortController.signal;

          if (extra.signal) {
            if (extra.signal.aborted) {
              abortController.abort(extra.signal.reason);
            } else {
              extra.signal.addEventListener('abort', () => {
                console.error(`[MCP] execute_code cancelled by client for bot "${botName}"`);
                abortController.abort('Cancelled by client');
              }, { once: true });
            }
          }

          const cancelPromise = new Promise<never>((_, reject) => {
            signal.addEventListener('abort', () => {
              reject(new Error(typeof signal.reason === 'string' ? signal.reason : 'Code execution cancelled'));
            }, { once: true });
          });

          // Wrap bot and sdk in proxies that throw on every method call once cancelled
          const cancellable = <T extends object>(target: T): T =>
            new Proxy(target, {
              get(obj, prop, receiver) {
                const value = Reflect.get(obj, prop, receiver);
                if (typeof value === 'function') {
                  return (...args: any[]) => {
                    if (signal.aborted) throw new Error('Execution cancelled');
                    return value.apply(obj, args);
                  };
                }
                return value;
              }
            });

          let result: any;
          try {
            result = await Promise.race([fn(cancellable(connection.bot), cancellable(connection.sdk)), timeoutPromise, cancelPromise]);
          } finally {
            clearTimeout(timeoutId!);
            if (!signal.aborted) abortController.abort('Execution finished');
          }

          // Build formatted output
          const parts: string[] = [];

          if (logs.length > 0) {
            parts.push('── Console ──');
            parts.push(logs.join('\n'));
          }

          if (result !== undefined) {
            if (logs.length > 0) parts.push('');
            parts.push('── Result ──');
            parts.push(JSON.stringify(result, null, 2));
          }

          // Append formatted world state
          const state = connection.sdk.getState();
          if (state) {
            parts.push('');
            parts.push('── World State ──');
            parts.push(formatWorldState(state, connection.sdk.getStateAge()));
          }

          // Add reminder for long code
          if (isLongCode) {
            parts.push('');
            parts.push('── Tip ──');
            parts.push(`Long script detected. Consider writing to a .ts file and running with: bun run bots/${botName}/script.ts`);
          }

          const output = parts.length > 0 ? parts.join('\n') : '(no output)';

          return {
            content: [{ type: 'text', text: output }]
          };
        } finally {
          console.log = originalLog;
          console.warn = originalWarn;
          console.error = originalError;
        }
      }

      case 'run_task': {
        const botName = args?.bot_name as string;
        const code = args?.code as string;
        const description = args?.description as string;

        if (!botName) {
          return errorResponse('bot_name is required');
        }
        if (!code) {
          return errorResponse('code is required');
        }
        if (!description) {
          return errorResponse('description is required');
        }

        // Auto-connect if not already connected
        let connection = botManager.get(botName);
        if (!connection) {
          console.error(`[MCP] Bot "${botName}" not connected, auto-connecting...`);
          connection = await botManager.connect(botName);
        }

        // Start the supervised task
        const { taskId, initialStatus } = await taskManager.startTask(
          botName,
          connection.bot,
          connection.sdk,
          code,
          description
        );

        // Get task context
        const task = taskManager.getTaskStatus(taskId);
        if (!task) {
          return errorResponse('Failed to create task');
        }

        const ctx = task.context;

        // Import patterns for use in task code
        const patterns = await import('../sdk/patterns.js');

        // Create async function with ctx and patterns as parameters
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        const fn = new AsyncFunction('ctx', 'patterns', code);

        // Execute task in background - use Promise.race with a checkpoint detector
        const executionPromise = (async () => {
          try {
            const result = await fn(ctx, patterns);
            taskManager.completeTask(taskId, result);
            return { type: 'completed' as const, result };
          } catch (error: any) {
            // If task is awaiting feedback, it's a checkpoint pause, not an error
            if (task.status === 'awaiting_feedback') {
              return { type: 'paused' as const };
            }
            taskManager.failTask(taskId, error.message);
            return { type: 'error' as const, error };
          }
        })();

        // Wait for either completion OR checkpoint pause (first 100ms of execution)
        // This allows immediate checkpoints to return quickly
        const raceTimeout = new Promise<{ type: 'timeout' }>((resolve) =>
          setTimeout(() => resolve({ type: 'timeout' }), 100)
        );

        const outcome = await Promise.race([executionPromise, raceTimeout]);

        // Check current task status
        const currentTask = taskManager.getTaskStatus(taskId);
        const currentStatus = currentTask?.status ?? 'unknown';

        const buildOutput = (status: string, result?: any, error?: any) => {
          const parts: string[] = [];
          const ctxLogs = ctx.getLogs();

          if (status === 'completed') {
            parts.push(`# Task Completed: ${taskId}`);
            parts.push(`Description: ${description}`);
            parts.push('');

            if (ctxLogs.length > 0) {
              parts.push('── Console ──');
              parts.push(ctxLogs.join('\n'));
              parts.push('');
            }

            if (result !== undefined) {
              parts.push('── Result ──');
              parts.push(JSON.stringify(result, null, 2));
              parts.push('');
            }

            // Show state diff
            const diff = ctx.getStateDiffFromStart();
            if (diff.summary.length > 0) {
              parts.push('── Changes This Task ──');
              parts.push(formatStateDiff(diff));
              parts.push('');
            }
          } else if (status === 'awaiting_feedback' || status === 'paused') {
            parts.push(`# Task Paused: ${taskId}`);
            parts.push(`Description: ${description}`);
            parts.push(`Status: AWAITING FEEDBACK`);
            parts.push('');

            if (currentTask?.pendingCheckpoint) {
              parts.push(`Checkpoint Reason: ${currentTask.pendingCheckpoint.reason}`);
              parts.push('');
            }

            if (ctxLogs.length > 0) {
              parts.push('── Console (so far) ──');
              parts.push(ctxLogs.join('\n'));
              parts.push('');
            }

            // Show state diff so far
            const diff = ctx.getStateDiffFromStart();
            if (diff.summary.length > 0) {
              parts.push('── Changes So Far ──');
              parts.push(formatStateDiff(diff));
              parts.push('');
            }

            // Show progress reports
            if (currentTask?.progressHistory && currentTask.progressHistory.length > 0) {
              parts.push('── Progress ──');
              for (const p of currentTask.progressHistory.slice(-5)) {
                const prog = p.progress ? ` (${p.progress.current}/${p.progress.total}${p.progress.unit ? ' ' + p.progress.unit : ''})` : '';
                parts.push(`- ${p.action}: ${p.message || p.status}${prog}`);
              }
              parts.push('');
            }

            parts.push(`Use continue_task with task_id="${taskId}" to resume, or abort_task to stop.`);
            parts.push('');
          } else if (status === 'running') {
            parts.push(`# Task Running: ${taskId}`);
            parts.push(`Description: ${description}`);
            parts.push(`Status: RUNNING (executing in background)`);
            parts.push('');

            if (ctxLogs.length > 0) {
              parts.push('── Console (so far) ──');
              parts.push(ctxLogs.join('\n'));
              parts.push('');
            }

            parts.push(`Use get_task_status with task_id="${taskId}" to check progress.`);
            parts.push('');
          } else if (status === 'failed' || error) {
            parts.push(`# Task Failed: ${taskId}`);
            parts.push(`Description: ${description}`);
            parts.push('');
            parts.push(`Error: ${error?.message || 'Unknown error'}`);
            if (error?.stack) {
              parts.push('');
              parts.push('Stack trace:');
              parts.push(error.stack);
            }
            parts.push('');
          }

          // Append formatted world state
          const state = connection!.sdk.getState();
          if (state) {
            parts.push('── World State ──');
            parts.push(formatWorldState(state, connection!.sdk.getStateAge()));
          }

          return parts.join('\n');
        };

        // Handle based on outcome
        if (outcome.type === 'completed') {
          return { content: [{ type: 'text', text: buildOutput('completed', outcome.result) }] };
        } else if (outcome.type === 'error') {
          return { content: [{ type: 'text', text: buildOutput('failed', undefined, outcome.error) }], isError: true };
        } else if (outcome.type === 'paused' || currentStatus === 'awaiting_feedback') {
          return { content: [{ type: 'text', text: buildOutput('awaiting_feedback') }] };
        } else {
          // Task is still running - return running status
          // The task continues executing in background
          return { content: [{ type: 'text', text: buildOutput('running') }] };
        }
      }

      case 'continue_task': {
        const taskId = args?.task_id as string;
        const instructions = args?.instructions as string | undefined;

        if (!taskId) {
          return errorResponse('task_id is required');
        }

        const task = taskManager.getTaskStatus(taskId);
        if (!task) {
          return errorResponse(`Task ${taskId} not found`);
        }

        if (task.status !== 'awaiting_feedback') {
          return errorResponse(`Task ${taskId} is not paused (status: ${task.status})`);
        }

        try {
          // Resume the task
          taskManager.continueTask(taskId, instructions);

          // Wait briefly to see if task completes or pauses again
          await new Promise(resolve => setTimeout(resolve, 200));

          // Check the new status
          const updatedTask = taskManager.getTaskStatus(taskId);
          if (!updatedTask) {
            return { content: [{ type: 'text', text: `Task ${taskId} completed.` }] };
          }

          const ctx = updatedTask.context;
          const ctxLogs = ctx.getLogs();
          const parts: string[] = [];

          if (updatedTask.status === 'completed') {
            parts.push(`# Task Completed: ${taskId}`);
            parts.push('');

            if (ctxLogs.length > 0) {
              parts.push('── Console ──');
              parts.push(ctxLogs.join('\n'));
              parts.push('');
            }

            const diff = ctx.getStateDiffFromStart();
            if (diff.summary.length > 0) {
              parts.push('── Changes This Task ──');
              parts.push(formatStateDiff(diff));
              parts.push('');
            }
          } else if (updatedTask.status === 'awaiting_feedback') {
            parts.push(`# Task Paused Again: ${taskId}`);
            parts.push('');

            if (updatedTask.pendingCheckpoint) {
              parts.push(`Checkpoint Reason: ${updatedTask.pendingCheckpoint.reason}`);
              parts.push('');
            }

            if (ctxLogs.length > 0) {
              parts.push('── Console (so far) ──');
              parts.push(ctxLogs.join('\n'));
              parts.push('');
            }

            const diff = ctx.getStateDiffFromStart();
            if (diff.summary.length > 0) {
              parts.push('── Changes So Far ──');
              parts.push(formatStateDiff(diff));
              parts.push('');
            }

            if (updatedTask.progressHistory.length > 0) {
              parts.push('── Progress ──');
              for (const p of updatedTask.progressHistory.slice(-5)) {
                const prog = p.progress ? ` (${p.progress.current}/${p.progress.total}${p.progress.unit ? ' ' + p.progress.unit : ''})` : '';
                parts.push(`- ${p.action}: ${p.message || p.status}${prog}`);
              }
              parts.push('');
            }

            parts.push(`Use continue_task with task_id="${taskId}" to resume.`);
          } else if (updatedTask.status === 'failed') {
            parts.push(`# Task Failed: ${taskId}`);
            parts.push('');
            parts.push(`Error: ${ctx.getStatus().error || 'Unknown error'}`);
          } else {
            parts.push(`# Task Running: ${taskId}`);
            parts.push('');
            parts.push(`Status: ${updatedTask.status}`);
            parts.push(`Use get_task_status with task_id="${taskId}" to check progress.`);
          }

          // Add world state
          const connection = botManager.get(updatedTask.botName);
          if (connection) {
            const state = connection.sdk.getState();
            if (state) {
              parts.push('');
              parts.push('── World State ──');
              parts.push(formatWorldState(state, connection.sdk.getStateAge()));
            }
          }

          return { content: [{ type: 'text', text: parts.join('\n') }] };
        } catch (error: any) {
          return errorResponse(error.message);
        }
      }

      case 'get_task_status': {
        const taskId = args?.task_id as string;
        const includeState = args?.include_state !== false;

        if (!taskId) {
          return errorResponse('task_id is required');
        }

        const task = taskManager.getTaskStatus(taskId);
        if (!task) {
          return errorResponse(`Task ${taskId} not found`);
        }

        const parts: string[] = [];
        parts.push(`# Task Status: ${taskId}`);
        parts.push(`Description: ${task.description}`);
        parts.push(`Status: ${task.status.toUpperCase()}`);
        parts.push(`Duration: ${Math.round((Date.now() - task.startTime) / 1000)}s`);
        parts.push('');

        if (task.status === 'awaiting_feedback' && task.pendingCheckpoint) {
          parts.push(`## Awaiting Feedback`);
          parts.push(`Reason: ${task.pendingCheckpoint.reason}`);
          parts.push('');
        }

        // Show state diff
        const diff = task.context.getStateDiffFromStart();
        if (diff.summary.length > 0) {
          parts.push('## Changes So Far');
          parts.push(formatStateDiff(diff));
          parts.push('');
        }

        // Show progress reports
        if (task.progressHistory.length > 0) {
          parts.push('## Recent Progress');
          for (const p of task.progressHistory.slice(-5)) {
            const prog = p.progress ? ` (${p.progress.current}/${p.progress.total}${p.progress.unit ? ' ' + p.progress.unit : ''})` : '';
            parts.push(`- ${p.action}: ${p.message || p.status}${prog}`);
          }
          parts.push('');
        }

        // Show world state
        if (includeState) {
          const connection = botManager.get(task.botName);
          if (connection) {
            const state = connection.sdk.getState();
            if (state) {
              parts.push('## World State');
              parts.push(formatWorldState(state, connection.sdk.getStateAge()));
            }
          }
        }

        return {
          content: [{ type: 'text', text: parts.join('\n') }]
        };
      }

      case 'abort_task': {
        const taskId = args?.task_id as string;
        const reason = args?.reason as string | undefined;

        if (!taskId) {
          return errorResponse('task_id is required');
        }

        try {
          taskManager.abortTask(taskId, reason);
          return {
            content: [{ type: 'text', text: `Task ${taskId} aborted${reason ? ': ' + reason : ''}` }]
          };
        } catch (error: any) {
          return errorResponse(error.message);
        }
      }

      case 'list_tasks': {
        const tasks = taskManager.listTasks();

        if (tasks.length === 0) {
          return {
            content: [{ type: 'text', text: 'No tasks tracked.' }]
          };
        }

        const parts: string[] = [];
        parts.push('# Tasks');
        parts.push('');

        for (const task of tasks) {
          const pausedIndicator = task.isPaused ? ' [NEEDS FEEDBACK]' : '';
          parts.push(`- **${task.id}** (${task.botName}): ${task.status}${pausedIndicator}`);
          parts.push(`  ${task.description}`);
          parts.push(`  Duration: ${Math.round(task.elapsedMs / 1000)}s`);
        }

        return {
          content: [{ type: 'text', text: parts.join('\n') }]
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    const errorMessage = `Error: ${error.message}\n\nStack trace:\n${error.stack}`;
    return {
      content: [{ type: 'text', text: errorMessage }],
      isError: true
    };
  }
});

function successResponse(data: any) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
  };
}

function errorResponse(message: string) {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true
  };
}

// Start server
async function main() {
  console.error('[MCP Server] Starting RS-Agent MCP server v3.0 with real-time feedback...');
  console.error('[MCP Server] Tools: execute_code, run_task, continue_task, get_task_status, abort_task, list_tasks');
  console.error('[MCP Server] No bots connected. Use execute_code or run_task to auto-connect.');

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[MCP Server] Server running on stdio');
}

main().catch((error) => {
  console.error('[MCP Server] Fatal error:', error);
  process.exit(1);
});
