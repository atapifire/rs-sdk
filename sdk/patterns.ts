// Common patterns for supervised script execution
// Use these helpers to create robust, feedback-friendly bot scripts

import { TaskContext } from './task-context';
import type { BotWorldState, InventoryItem, NearbyNpc, NearbyLoc } from './types';

export interface LoopOptions {
    /** Max iterations (default: 100) */
    maxIterations?: number;
    /** Checkpoint every N iterations (default: 5) */
    checkpointEvery?: number;
    /** Custom checkpoint reason */
    checkpointReason?: string;
    /** Stop if inventory is full */
    stopOnFullInventory?: boolean;
    /** Stop if this item count is reached */
    stopOnItemCount?: { item: string | RegExp; count: number };
    /** Stop if this skill level is reached */
    stopOnSkillLevel?: { skill: string; level: number };
    /** Custom stop condition */
    stopWhen?: (state: BotWorldState, iteration: number) => boolean;
}

/**
 * Run a loop with automatic progress reporting and checkpoints.
 *
 * @example
 * ```ts
 * await loop(ctx, 'Chopping trees', async (i) => {
 *   const result = await ctx.bot.chopTree();
 *   return result.success;
 * }, { checkpointEvery: 3, stopOnFullInventory: true });
 * ```
 */
export async function loop(
    ctx: TaskContext,
    actionName: string,
    action: (iteration: number) => Promise<boolean>,
    options: LoopOptions = {}
): Promise<{ completed: number; stopped: string }> {
    const {
        maxIterations = 100,
        checkpointEvery = 5,
        checkpointReason = 'Progress check',
        stopOnFullInventory = false,
        stopOnItemCount,
        stopOnSkillLevel,
        stopWhen
    } = options;

    ctx.setAction(actionName);
    let completed = 0;
    let stopReason = 'max iterations';

    for (let i = 0; i < maxIterations && ctx.shouldContinue(); i++) {
        // Check stop conditions
        const state = ctx.sdk.getState();
        if (state) {
            if (stopOnFullInventory && state.inventory.length >= 28) {
                stopReason = 'inventory full';
                break;
            }

            if (stopOnItemCount) {
                const regex = typeof stopOnItemCount.item === 'string'
                    ? new RegExp(stopOnItemCount.item, 'i')
                    : stopOnItemCount.item;
                const count = state.inventory
                    .filter(item => regex.test(item.name))
                    .reduce((sum, item) => sum + item.count, 0);
                if (count >= stopOnItemCount.count) {
                    stopReason = `reached ${stopOnItemCount.count} ${stopOnItemCount.item}`;
                    break;
                }
            }

            if (stopOnSkillLevel) {
                const skill = state.skills.find(s =>
                    s.name.toLowerCase() === stopOnSkillLevel.skill.toLowerCase()
                );
                if (skill && skill.baseLevel >= stopOnSkillLevel.level) {
                    stopReason = `reached level ${stopOnSkillLevel.level} ${stopOnSkillLevel.skill}`;
                    break;
                }
            }

            if (stopWhen && stopWhen(state, i)) {
                stopReason = 'custom condition';
                break;
            }
        }

        // Perform action
        const success = await action(i);
        if (success) {
            completed++;
        }

        // Report progress
        ctx.reportProgress({
            action: actionName,
            progress: { current: completed, total: maxIterations, unit: 'iterations' },
            message: success ? 'Success' : 'Failed (continuing)'
        });

        // Checkpoint periodically
        if ((i + 1) % checkpointEvery === 0) {
            const feedback = await ctx.checkpoint(`${checkpointReason}: ${completed} completed`);
            if (!feedback.continue) {
                stopReason = 'aborted';
                break;
            }
            if (feedback.newInstructions) {
                ctx.log(`Received instructions: ${feedback.newInstructions}`);
            }
        }
    }

    ctx.log(`Loop finished: ${completed} completed, stopped: ${stopReason}`);
    return { completed, stopped: stopReason };
}

/**
 * Gather resources until inventory is full or target count reached.
 *
 * @example
 * ```ts
 * await gatherUntilFull(ctx, 'logs', async () => {
 *   const result = await ctx.bot.chopTree();
 *   return result.success;
 * });
 * ```
 */
export async function gatherUntilFull(
    ctx: TaskContext,
    resourceName: string,
    gatherAction: () => Promise<boolean>,
    options: { checkpointEvery?: number; targetCount?: number } = {}
): Promise<{ gathered: number; inventoryFull: boolean }> {
    const { checkpointEvery = 5, targetCount } = options;

    ctx.setAction(`Gathering ${resourceName}`);

    const resourceRegex = new RegExp(resourceName, 'i');
    const countResource = () => {
        const state = ctx.sdk.getState();
        if (!state) return 0;
        return state.inventory
            .filter(item => resourceRegex.test(item.name))
            .reduce((sum, item) => sum + item.count, 0);
    };

    const startCount = countResource();
    let actionCount = 0;

    while (ctx.shouldContinue()) {
        const state = ctx.sdk.getState();
        if (!state) break;

        // Check if inventory full
        if (state.inventory.length >= 28) {
            ctx.log('Inventory full');
            break;
        }

        // Check if target reached
        const currentCount = countResource();
        if (targetCount && currentCount >= targetCount) {
            ctx.log(`Target count reached: ${currentCount}`);
            break;
        }

        // Perform gather action
        const success = await gatherAction();
        actionCount++;

        // Report progress
        const gathered = countResource() - startCount;
        ctx.reportProgress({
            action: `Gathering ${resourceName}`,
            progress: { current: gathered, total: targetCount ?? 28, unit: resourceName },
            message: success ? `Got ${resourceName}` : 'Trying again'
        });

        // Checkpoint periodically
        if (actionCount % checkpointEvery === 0) {
            const feedback = await ctx.checkpoint(`Gathered ${gathered} ${resourceName}`);
            if (!feedback.continue) break;
        }
    }

    const finalCount = countResource();
    const gathered = finalCount - startCount;
    const inventoryFull = ctx.sdk.getState()?.inventory.length === 28;

    return { gathered, inventoryFull };
}

/**
 * Train a skill until reaching a target level.
 *
 * @example
 * ```ts
 * await trainUntilLevel(ctx, 'Woodcutting', 10, async () => {
 *   return await ctx.bot.chopTree();
 * });
 * ```
 */
export async function trainUntilLevel(
    ctx: TaskContext,
    skillName: string,
    targetLevel: number,
    trainAction: () => Promise<{ success: boolean; message?: string }>,
    options: { checkpointEvery?: number; maxActions?: number } = {}
): Promise<{ levelReached: boolean; xpGained: number; actionsPerformed: number }> {
    const { checkpointEvery = 10, maxActions = 500 } = options;

    ctx.setAction(`Training ${skillName} to ${targetLevel}`);

    const getSkill = () => ctx.sdk.getState()?.skills.find(s =>
        s.name.toLowerCase() === skillName.toLowerCase()
    );

    const startXp = getSkill()?.experience ?? 0;
    let actionCount = 0;
    let levelReached = false;

    while (ctx.shouldContinue() && actionCount < maxActions) {
        const skill = getSkill();
        if (skill && skill.baseLevel >= targetLevel) {
            levelReached = true;
            ctx.log(`Reached level ${targetLevel}!`);
            break;
        }

        const result = await trainAction();
        actionCount++;

        // Report progress
        const currentXp = getSkill()?.experience ?? 0;
        const xpGained = currentXp - startXp;
        const currentLevel = skill?.baseLevel ?? 1;

        ctx.reportProgress({
            action: `Training ${skillName}`,
            progress: { current: currentLevel, total: targetLevel, unit: 'levels' },
            message: `Level ${currentLevel}, +${xpGained} XP`
        });

        // Checkpoint periodically
        if (actionCount % checkpointEvery === 0) {
            const feedback = await ctx.checkpoint(
                `Level ${currentLevel}/${targetLevel}, +${xpGained} XP, ${actionCount} actions`
            );
            if (!feedback.continue) break;
        }
    }

    const finalXp = getSkill()?.experience ?? 0;
    return {
        levelReached,
        xpGained: finalXp - startXp,
        actionsPerformed: actionCount
    };
}

/**
 * Combat loop - attack targets until a condition is met.
 *
 * @example
 * ```ts
 * await combatLoop(ctx, /cow/i, {
 *   eatFoodWhenBelow: 5,
 *   stopWhenKills: 10
 * });
 * ```
 */
export async function combatLoop(
    ctx: TaskContext,
    targetPattern: string | RegExp,
    options: {
        eatFoodWhenBelow?: number;
        foodPattern?: string | RegExp;
        stopWhenKills?: number;
        stopWhenNoTargets?: boolean;
        checkpointEvery?: number;
        maxIterations?: number;
    } = {}
): Promise<{ kills: number; damageTaken: number; foodEaten: number }> {
    const {
        eatFoodWhenBelow = 5,
        foodPattern = /shrimp|chicken|fish|bread|cake|meat|lobster/i,
        stopWhenKills,
        stopWhenNoTargets = true,
        checkpointEvery = 5,
        maxIterations = 100
    } = options;

    ctx.setAction('Combat');

    const regex = typeof targetPattern === 'string'
        ? new RegExp(targetPattern, 'i')
        : targetPattern;

    let kills = 0;
    let damageTaken = 0;
    let foodEaten = 0;
    let iterations = 0;

    while (ctx.shouldContinue() && iterations < maxIterations) {
        iterations++;
        const state = ctx.sdk.getState();
        if (!state) break;

        // Check health and eat if needed
        const hp = state.skills.find(s => s.name === 'Hitpoints')?.level ?? 10;
        if (hp <= eatFoodWhenBelow) {
            const food = ctx.sdk.findInventoryItem(foodPattern);
            if (food) {
                const eatResult = await ctx.bot.eatFood(food);
                if (eatResult.success) {
                    foodEaten++;
                    ctx.log(`Ate ${food.name}, healed ${eatResult.hpGained} HP`);
                }
            } else {
                ctx.log('Low HP but no food! Consider retreating.');
                const feedback = await ctx.checkpoint('Low HP, no food available');
                if (!feedback.continue) break;
            }
        }

        // Check stop conditions
        if (stopWhenKills && kills >= stopWhenKills) {
            ctx.log(`Reached ${kills} kills`);
            break;
        }

        // Find target
        const target = state.nearbyNpcs.find(n =>
            regex.test(n.name) && !n.inCombat && n.hp > 0
        );

        if (!target) {
            if (stopWhenNoTargets) {
                ctx.log('No targets available');
                break;
            }
            // Wait for respawn
            await ctx.sdk.waitForTicks(3);
            continue;
        }

        // Attack target
        const attackResult = await ctx.bot.attackNpc(target);
        if (!attackResult.success) {
            ctx.log(`Attack failed: ${attackResult.message}`);
            continue;
        }

        // Wait for combat to end
        try {
            await ctx.sdk.waitForCondition(s => {
                const npc = s.nearbyNpcs.find(n => n.index === target.index);
                return !npc || npc.hp <= 0 || !s.player?.combat.inCombat;
            }, 60000);

            const npcAfter = ctx.sdk.getState()?.nearbyNpcs.find(n => n.index === target.index);
            if (!npcAfter || npcAfter.hp <= 0) {
                kills++;
                ctx.log(`Killed ${target.name} (${kills} total)`);
            }
        } catch {
            ctx.log('Combat timeout');
        }

        // Report progress
        ctx.reportProgress({
            action: 'Combat',
            progress: stopWhenKills
                ? { current: kills, total: stopWhenKills, unit: 'kills' }
                : undefined,
            message: `${kills} kills, ${foodEaten} food eaten`
        });

        // Checkpoint periodically
        if (iterations % checkpointEvery === 0) {
            const feedback = await ctx.checkpoint(`Combat: ${kills} kills, HP: ${hp}`);
            if (!feedback.continue) break;
        }
    }

    // Calculate total damage taken from diff
    const diff = ctx.getStateDiffFromStart();
    damageTaken = diff.combat.damageTaken;

    return { kills, damageTaken, foodEaten };
}

/**
 * Bank routine - go to bank, deposit items, withdraw items, return.
 *
 * @example
 * ```ts
 * await bankRoutine(ctx, {
 *   deposit: /logs/i,
 *   withdraw: [{ item: /axe/i, count: 1 }],
 *   returnTo: { x: 3200, z: 3200 }
 * });
 * ```
 */
export async function bankRoutine(
    ctx: TaskContext,
    options: {
        deposit?: string | RegExp | 'all';
        withdraw?: Array<{ item: string | RegExp; count: number }>;
        returnTo?: { x: number; z: number };
    } = {}
): Promise<{ deposited: number; withdrawn: number; success: boolean }> {
    const { deposit = 'all', withdraw = [], returnTo } = options;

    ctx.setAction('Banking');
    let deposited = 0;
    let withdrawn = 0;

    // Open bank
    ctx.log('Opening bank...');
    const openResult = await ctx.bot.openBank();
    if (!openResult.success) {
        ctx.log(`Failed to open bank: ${openResult.message}`);
        return { deposited: 0, withdrawn: 0, success: false };
    }

    // Deposit items
    if (deposit === 'all') {
        const inventory = ctx.sdk.getInventory();
        for (const item of inventory) {
            const result = await ctx.bot.depositItem(item, -1);
            if (result.success) {
                deposited += result.amountDeposited ?? 1;
            }
        }
        ctx.log(`Deposited ${deposited} items`);
    } else {
        const items = ctx.sdk.getInventory().filter(item => {
            const regex = typeof deposit === 'string'
                ? new RegExp(deposit, 'i')
                : deposit;
            return regex.test(item.name);
        });
        for (const item of items) {
            const result = await ctx.bot.depositItem(item, -1);
            if (result.success) {
                deposited += result.amountDeposited ?? 1;
            }
        }
        ctx.log(`Deposited ${deposited} matching items`);
    }

    // Withdraw items
    for (const { item, count } of withdraw) {
        const bankItems = ctx.sdk.getBankItems();
        const regex = typeof item === 'string' ? new RegExp(item, 'i') : item;
        const bankItem = bankItems.find(i => regex.test(i.name));

        if (bankItem) {
            const result = await ctx.bot.withdrawItem(bankItem.slot, count);
            if (result.success) {
                withdrawn++;
                ctx.log(`Withdrew ${bankItem.name}`);
            }
        } else {
            ctx.log(`Item not in bank: ${item}`);
        }
    }

    // Close bank
    await ctx.bot.closeBank();

    // Return to location if specified
    if (returnTo) {
        ctx.log(`Walking back to (${returnTo.x}, ${returnTo.z})...`);
        await ctx.bot.walkTo(returnTo.x, returnTo.z);
    }

    ctx.reportProgress({
        action: 'Banking',
        status: 'completed',
        message: `Deposited ${deposited}, withdrew ${withdrawn}`
    });

    return { deposited, withdrawn, success: true };
}
