#!/usr/bin/env bun
/**
 * Walk North Test (SDK)
 * Walk at least 40 tiles north from starting position.
 * Tests basic walking without gate/door handling.
 */

import { launchBotWithSDK, sleep, type SDKSession } from './utils/browser';

const BOT_NAME = process.env.BOT_NAME;
const MIN_NORTH_DISTANCE = 40;
const WALK_STEP = 15;

async function runTest(): Promise<boolean> {
    console.log('=== Walk North Test (SDK) ===');
    console.log(`Goal: Walk ${MIN_NORTH_DISTANCE}+ tiles north`);

    let session: SDKSession | null = null;

    try {
        session = await launchBotWithSDK(BOT_NAME);
        const { sdk, bot } = session;
        console.log(`Bot '${session.botName}' ready!`);

        const startState = sdk.getState();
        if (!startState?.player) {
            throw new Error('Could not get player position');
        }

        const startX = startState.player.worldX;
        const startZ = startState.player.worldZ;
        console.log(`Start: (${startX}, ${startZ})`);

        let currentZ = startZ;
        let totalNorth = 0;

        while (totalNorth < MIN_NORTH_DISTANCE) {
            const currentState = sdk.getState();
            if (!currentState?.player) continue;

            const currentX = currentState.player.worldX;
            currentZ = currentState.player.worldZ;

            // Walk north
            const targetZ = currentZ + WALK_STEP;
            const result = await bot.walkTo(currentX, targetZ);

            if (result.success) {
                const newState = sdk.getState();
                if (newState?.player) {
                    const moved = newState.player.worldZ - startZ;
                    totalNorth = Math.max(totalNorth, moved);
                }
            }

            if (totalNorth % 30 < WALK_STEP) {
                console.log(`Progress: ${totalNorth}/${MIN_NORTH_DISTANCE} tiles north`);
            }

            await sleep(100);
        }

        const finalState = sdk.getState();
        console.log(`Final: (${finalState?.player?.worldX}, ${finalState?.player?.worldZ})`);
        console.log(`Walked ${totalNorth} tiles north`);

        return totalNorth >= MIN_NORTH_DISTANCE;
    } finally {
        if (session) {
            await session.cleanup();
        }
    }
}

runTest()
    .then(ok => {
        console.log(ok ? '\nPASSED' : '\nFAILED');
        process.exit(ok ? 0 : 1);
    })
    .catch(e => {
        console.error('Fatal:', e);
        process.exit(1);
    });
