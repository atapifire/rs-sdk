#!/usr/bin/env bun
/**
 * Simple test: Walk from Lumbridge to Falador
 * Tests the improved long-distance pathfinding with chained intermediate waypoints.
 */

import { launchBotWithSDK, sleep } from './utils/browser';
import { generateSave, Locations } from './utils/save-generator';

const BOT_NAME = process.env.BOT_NAME ?? `lum2fal${Math.random().toString(36).slice(2, 5)}`;

// Falador center coordinates
const FALADOR = { x: 2964, z: 3378 };

async function main() {
    console.log('=== Lumbridge to Falador Navigation Test ===\n');

    // Start at Lumbridge Castle
    await generateSave(BOT_NAME, {
        position: Locations.LUMBRIDGE_CASTLE,
        skills: { Agility: 99 }, // Fast running
    });

    const session = await launchBotWithSDK(BOT_NAME, { skipTutorial: false });
    const { sdk, bot } = session;

    try {
        // Wait for player state
        await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0, 10000);
        await sleep(500);

        const startState = sdk.getState();
        const startX = startState?.player?.worldX ?? 0;
        const startZ = startState?.player?.worldZ ?? 0;

        const distance = Math.sqrt(
            Math.pow(FALADOR.x - startX, 2) + Math.pow(FALADOR.z - startZ, 2)
        );

        console.log(`Start: (${startX}, ${startZ}) - Lumbridge`);
        console.log(`Destination: (${FALADOR.x}, ${FALADOR.z}) - Falador`);
        console.log(`Distance: ${distance.toFixed(0)} tiles\n`);

        const startTime = Date.now();

        // Walk to Falador
        console.log('Walking to Falador...\n');
        const result = await bot.walkTo(FALADOR.x, FALADOR.z, 15);

        const elapsed = Date.now() - startTime;

        const endState = sdk.getState();
        const endX = endState?.player?.worldX ?? 0;
        const endZ = endState?.player?.worldZ ?? 0;

        const finalDist = Math.sqrt(
            Math.pow(FALADOR.x - endX, 2) + Math.pow(FALADOR.z - endZ, 2)
        );

        console.log(`\n--- Result ---`);
        console.log(`Success: ${result.success}`);
        console.log(`End position: (${endX}, ${endZ})`);
        console.log(`Distance to Falador: ${finalDist.toFixed(0)} tiles`);
        console.log(`Time: ${(elapsed / 1000).toFixed(1)}s`);
        console.log(`Message: ${result.message}`);

        const passed = finalDist <= 15;
        console.log(`\n${passed ? 'TEST PASSED' : 'TEST FAILED'}`);

        return passed;
    } finally {
        await session.cleanup();
    }
}

main()
    .then(ok => process.exit(ok ? 0 : 1))
    .catch(e => {
        console.error('Fatal:', e);
        process.exit(1);
    });
