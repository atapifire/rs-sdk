// Task Manager - Tracks running tasks and handles checkpoints
// Enables real-time feedback loop between bot scripts and Claude

import { TaskContext, TaskStatus, CheckpointResult, TaskProgress, createTaskContext } from '../sdk/task-context';
import { BotActions } from '../sdk/actions';
import { BotSDK } from '../sdk/index';
import { formatWorldState } from '../sdk/formatter';
import { formatStateDiff } from '../sdk/state-diff';

export interface RunningTask {
    id: string;
    botName: string;
    context: TaskContext;
    startTime: number;
    code: string;
    description: string;
    status: 'running' | 'paused' | 'awaiting_feedback' | 'completed' | 'failed' | 'aborted';
    lastUpdate: number;

    // For paused tasks awaiting feedback
    pendingCheckpoint?: {
        reason: string;
        status: TaskStatus;
        resolve: (result: CheckpointResult) => void;
        reject: (error: Error) => void;
    };

    // Progress history
    progressHistory: TaskProgress[];

    // Accumulated logs
    logs: string[];
}

class TaskManager {
    private tasks = new Map<string, RunningTask>();
    private taskCounter = 0;

    /**
     * Generate a unique task ID.
     */
    generateTaskId(): string {
        return `task-${++this.taskCounter}-${Date.now().toString(36)}`;
    }

    /**
     * Start a new supervised task.
     */
    async startTask(
        botName: string,
        bot: BotActions,
        sdk: BotSDK,
        code: string,
        description: string,
        options: {
            checkpointMode?: 'auto' | 'manual' | 'periodic';
            checkpointInterval?: number; // ms for periodic mode
        } = {}
    ): Promise<{ taskId: string; initialStatus: TaskStatus }> {
        const taskId = this.generateTaskId();

        const task: RunningTask = {
            id: taskId,
            botName,
            startTime: Date.now(),
            code,
            description,
            status: 'running',
            lastUpdate: Date.now(),
            progressHistory: [],
            logs: [],
            context: null as any // Will be set below
        };

        // Create context with checkpoint handling
        const context = createTaskContext(bot, sdk, taskId, {
            onProgress: (progress) => {
                task.progressHistory.push(progress);
                task.lastUpdate = Date.now();
            },
            onCheckpoint: async (status) => {
                return this.handleCheckpoint(taskId, status);
            },
            progressInterval: options.checkpointInterval ?? 5000
        });

        task.context = context;
        this.tasks.set(taskId, task);

        return {
            taskId,
            initialStatus: context.getStatus()
        };
    }

    /**
     * Handle a checkpoint from a running task.
     * If feedback is needed, pauses and waits for continue_task call.
     */
    private async handleCheckpoint(taskId: string, status: TaskStatus): Promise<CheckpointResult> {
        const task = this.tasks.get(taskId);
        if (!task) {
            return { continue: false, abort: true, abortReason: 'Task not found' };
        }

        task.status = 'awaiting_feedback';
        task.lastUpdate = Date.now();

        // Create a promise that will be resolved when continue_task is called
        return new Promise((resolve, reject) => {
            task.pendingCheckpoint = {
                reason: status.currentAction,
                status,
                resolve,
                reject
            };

            // Don't timeout - let Claude decide when to continue
            // The task will stay paused until continue_task is called
        });
    }

    /**
     * Continue a paused task with new instructions.
     */
    continueTask(taskId: string, instructions?: string): CheckpointResult {
        const task = this.tasks.get(taskId);
        if (!task) {
            throw new Error(`Task ${taskId} not found`);
        }

        if (!task.pendingCheckpoint) {
            throw new Error(`Task ${taskId} is not paused at a checkpoint`);
        }

        const result: CheckpointResult = {
            continue: true,
            newInstructions: instructions
        };

        task.pendingCheckpoint.resolve(result);
        task.pendingCheckpoint = undefined;
        task.status = 'running';
        task.lastUpdate = Date.now();

        return result;
    }

    /**
     * Abort a task.
     */
    abortTask(taskId: string, reason?: string): void {
        const task = this.tasks.get(taskId);
        if (!task) {
            throw new Error(`Task ${taskId} not found`);
        }

        task.status = 'aborted';
        task.lastUpdate = Date.now();

        if (task.pendingCheckpoint) {
            task.pendingCheckpoint.resolve({
                continue: false,
                abort: true,
                abortReason: reason || 'Task aborted by user'
            });
            task.pendingCheckpoint = undefined;
        }

        task.context.cleanup();
    }

    /**
     * Get task status.
     */
    getTaskStatus(taskId: string): RunningTask | undefined {
        return this.tasks.get(taskId);
    }

    /**
     * Get all tasks.
     */
    listTasks(): Array<{
        id: string;
        botName: string;
        status: string;
        description: string;
        elapsedMs: number;
        isPaused: boolean;
    }> {
        const result: Array<{
            id: string;
            botName: string;
            status: string;
            description: string;
            elapsedMs: number;
            isPaused: boolean;
        }> = [];

        for (const [id, task] of this.tasks) {
            result.push({
                id,
                botName: task.botName,
                status: task.status,
                description: task.description,
                elapsedMs: Date.now() - task.startTime,
                isPaused: task.status === 'awaiting_feedback'
            });
        }

        return result;
    }

    /**
     * Mark task as completed.
     */
    completeTask(taskId: string, result?: any): void {
        const task = this.tasks.get(taskId);
        if (task) {
            task.status = 'completed';
            task.lastUpdate = Date.now();
            task.context.complete(result);
            task.context.cleanup();
        }
    }

    /**
     * Mark task as failed.
     */
    failTask(taskId: string, error: string): void {
        const task = this.tasks.get(taskId);
        if (task) {
            task.status = 'failed';
            task.lastUpdate = Date.now();
            task.context.fail(error);
            task.context.cleanup();
        }
    }

    /**
     * Clean up old tasks.
     */
    cleanup(maxAgeMs: number = 30 * 60 * 1000): number {
        const now = Date.now();
        let cleaned = 0;

        for (const [id, task] of this.tasks) {
            if (now - task.lastUpdate > maxAgeMs && task.status !== 'running' && task.status !== 'awaiting_feedback') {
                task.context.cleanup();
                this.tasks.delete(id);
                cleaned++;
            }
        }

        return cleaned;
    }

    /**
     * Format a task's full report.
     */
    formatTaskReport(taskId: string): string {
        const task = this.tasks.get(taskId);
        if (!task) {
            return `Task ${taskId} not found`;
        }

        return task.context.formatReport();
    }
}

// Singleton instance
export const taskManager = new TaskManager();
