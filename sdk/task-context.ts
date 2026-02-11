// Task Context - Enhanced execution context for real-time feedback
// Provides checkpoints, progress reporting, and state diff tracking

import { BotSDK } from './index';
import { BotActions } from './actions';
import { formatWorldState } from './formatter';
import { computeStateDiff, formatStateDiff, StateDiff, createEmptyDiff } from './state-diff';
import type { BotWorldState } from './types';

export interface TaskProgress {
    action: string;
    status: 'starting' | 'in_progress' | 'completed' | 'failed' | 'paused';
    progress?: { current: number; total: number; unit?: string };
    message?: string;
    data?: any;
}

export interface CheckpointResult {
    continue: boolean;
    newInstructions?: string;
    abort?: boolean;
    abortReason?: string;
}

export interface TaskContextOptions {
    taskId: string;
    onProgress?: (progress: TaskProgress) => void;
    onCheckpoint?: (status: TaskStatus) => Promise<CheckpointResult>;
    progressInterval?: number; // ms between automatic progress reports
}

export interface TaskStatus {
    taskId: string;
    status: 'running' | 'paused' | 'completed' | 'failed' | 'aborted';
    currentAction: string;
    startTime: number;
    elapsedMs: number;
    checkpointCount: number;
    lastCheckpointTime: number;
    stateDiff: StateDiff;
    accumulatedDiff: StateDiff;
    progressReports: TaskProgress[];
    worldState: string; // Formatted state
    error?: string;
}

export class TaskContext {
    readonly taskId: string;
    readonly bot: BotActions;
    readonly sdk: BotSDK;

    private startTime: number;
    private startState: BotWorldState | null = null;
    private lastCheckpointState: BotWorldState | null = null;
    private checkpointCount = 0;
    private currentAction = 'initializing';
    private status: TaskStatus['status'] = 'running';
    private progressReports: TaskProgress[] = [];
    private onProgress?: (progress: TaskProgress) => void;
    private onCheckpoint?: (status: TaskStatus) => Promise<CheckpointResult>;
    private progressInterval: number;
    private stateListener: (() => void) | null = null;
    private lastProgressReport = 0;
    private abortReason?: string;

    // Captured logs for this task
    private logs: string[] = [];

    constructor(
        bot: BotActions,
        sdk: BotSDK,
        options: TaskContextOptions
    ) {
        this.taskId = options.taskId;
        this.bot = bot;
        this.sdk = sdk;
        this.onProgress = options.onProgress;
        this.onCheckpoint = options.onCheckpoint;
        this.progressInterval = options.progressInterval ?? 5000;
        this.startTime = Date.now();

        // Capture initial state
        this.startState = sdk.getState();
        this.lastCheckpointState = this.startState;

        // Set up periodic state monitoring
        this.setupStateMonitoring();
    }

    private setupStateMonitoring() {
        let lastAutoProgress = Date.now();

        this.stateListener = this.sdk.onStateUpdate((state) => {
            // Auto-report progress at intervals
            if (this.onProgress && Date.now() - lastAutoProgress >= this.progressInterval) {
                lastAutoProgress = Date.now();
                const diff = this.getStateDiffSinceLastCheckpoint();
                if (diff.summary.length > 0) {
                    this.onProgress({
                        action: this.currentAction,
                        status: 'in_progress',
                        message: diff.summary.join(', ')
                    });
                }
            }
        });
    }

    /**
     * Report progress without pausing.
     * Use this to keep Claude informed of what's happening.
     */
    reportProgress(progress: Omit<TaskProgress, 'status'> & { status?: TaskProgress['status'] }) {
        const fullProgress: TaskProgress = {
            status: 'in_progress',
            ...progress
        };
        this.progressReports.push(fullProgress);
        this.lastProgressReport = Date.now();

        if (this.onProgress) {
            this.onProgress(fullProgress);
        }

        // Also log it
        this.log(`[Progress] ${progress.action}: ${progress.message || ''}`);
    }

    /**
     * Set the current action being performed.
     * This is shown in status reports.
     */
    setAction(action: string) {
        this.currentAction = action;
        this.reportProgress({ action, status: 'starting', message: `Starting: ${action}` });
    }

    /**
     * Log a message (captured for task output).
     */
    log(...args: any[]) {
        const message = args.map(a =>
            typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)
        ).join(' ');
        this.logs.push(message);
        console.log(message);
    }

    /**
     * Log a warning.
     */
    warn(...args: any[]) {
        const message = args.map(a =>
            typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)
        ).join(' ');
        this.logs.push(`[warn] ${message}`);
        console.warn(message);
    }

    /**
     * Create a checkpoint - pauses and reports status to Claude.
     * Returns new instructions if Claude wants to modify behavior.
     *
     * Use this at logical breakpoints:
     * - After completing a subtask
     * - When a decision is needed
     * - When encountering unexpected state
     * - Periodically during long operations
     */
    async checkpoint(reason: string): Promise<CheckpointResult> {
        this.checkpointCount++;
        const checkpointTime = Date.now();

        this.log(`[Checkpoint ${this.checkpointCount}] ${reason}`);

        const status = this.getStatus();
        status.status = 'paused';

        // Update last checkpoint state
        this.lastCheckpointState = this.sdk.getState();

        if (this.onCheckpoint) {
            try {
                const result = await this.onCheckpoint(status);
                if (result.abort) {
                    this.status = 'aborted';
                    this.abortReason = result.abortReason || 'Aborted by supervisor';
                    return result;
                }
                if (result.newInstructions) {
                    this.log(`[New Instructions] ${result.newInstructions}`);
                }
                return result;
            } catch (error: any) {
                this.log(`[Checkpoint Error] ${error.message}`);
                return { continue: true };
            }
        }

        return { continue: true };
    }

    /**
     * Check if task should continue or has been aborted.
     */
    shouldContinue(): boolean {
        return this.status === 'running';
    }

    /**
     * Get state diff since the start of the task.
     */
    getStateDiffFromStart(): StateDiff {
        const currentState = this.sdk.getState();
        if (!this.startState || !currentState) {
            return createEmptyDiff(0);
        }
        return computeStateDiff(this.startState, currentState);
    }

    /**
     * Get state diff since the last checkpoint.
     */
    getStateDiffSinceLastCheckpoint(): StateDiff {
        const currentState = this.sdk.getState();
        if (!this.lastCheckpointState || !currentState) {
            return createEmptyDiff(0);
        }
        return computeStateDiff(this.lastCheckpointState, currentState);
    }

    /**
     * Get current task status.
     */
    getStatus(): TaskStatus {
        const currentState = this.sdk.getState();
        const now = Date.now();

        return {
            taskId: this.taskId,
            status: this.status,
            currentAction: this.currentAction,
            startTime: this.startTime,
            elapsedMs: now - this.startTime,
            checkpointCount: this.checkpointCount,
            lastCheckpointTime: this.lastProgressReport,
            stateDiff: this.getStateDiffSinceLastCheckpoint(),
            accumulatedDiff: this.getStateDiffFromStart(),
            progressReports: this.progressReports.slice(-10),
            worldState: currentState ? formatWorldState(currentState, this.sdk.getStateAge()) : '(no state)',
            error: this.abortReason
        };
    }

    /**
     * Get all captured logs.
     */
    getLogs(): string[] {
        return this.logs;
    }

    /**
     * Mark task as completed successfully.
     */
    complete(result?: any) {
        this.status = 'completed';
        this.reportProgress({
            action: this.currentAction,
            status: 'completed',
            message: 'Task completed',
            data: result
        });
    }

    /**
     * Mark task as failed.
     */
    fail(error: string) {
        this.status = 'failed';
        this.abortReason = error;
        this.reportProgress({
            action: this.currentAction,
            status: 'failed',
            message: error
        });
    }

    /**
     * Clean up resources.
     */
    cleanup() {
        if (this.stateListener) {
            this.stateListener();
            this.stateListener = null;
        }
    }

    /**
     * Format the final task report.
     */
    formatReport(): string {
        const status = this.getStatus();
        const lines: string[] = [];

        lines.push(`# Task Report: ${this.taskId}`);
        lines.push(`Status: ${status.status.toUpperCase()}`);
        lines.push(`Duration: ${Math.round(status.elapsedMs / 1000)}s`);
        lines.push(`Checkpoints: ${status.checkpointCount}`);

        if (status.error) {
            lines.push('');
            lines.push(`## Error`);
            lines.push(status.error);
        }

        // Show accumulated changes
        const totalDiff = this.getStateDiffFromStart();
        if (totalDiff.summary.length > 0) {
            lines.push('');
            lines.push('## Changes This Task');
            lines.push(formatStateDiff(totalDiff));
        }

        // Show logs
        if (this.logs.length > 0) {
            lines.push('');
            lines.push('## Log');
            for (const log of this.logs.slice(-20)) {
                lines.push(log);
            }
            if (this.logs.length > 20) {
                lines.push(`... and ${this.logs.length - 20} more entries`);
            }
        }

        // Show current state
        lines.push('');
        lines.push(status.worldState);

        return lines.join('\n');
    }
}

/**
 * Create a task context for supervised script execution.
 */
export function createTaskContext(
    bot: BotActions,
    sdk: BotSDK,
    taskId: string,
    options?: Partial<TaskContextOptions>
): TaskContext {
    return new TaskContext(bot, sdk, {
        taskId,
        ...options
    });
}
