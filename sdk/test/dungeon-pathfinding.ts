#!/usr/bin/env bun
/**
 * Dungeon Pathfinding Test
 *
 * Verifies that the SDK pathfinder works in dungeon areas (high Z coordinates).
 * Dungeons use world Z > 9000, which maps to mapsquares 144+.
 *
 * This test spawns a bot in the Dwarven Mine (Falador Mine) and attempts
 * to pathfind and walk between several points within the dungeon.
 *
 * Success criteria:
 * 1. Pathfinder can find routes within the dungeon (zones are allocated)
 * 2. Bot can walk between points using bot.walkTo()
 * 3. Bot arrives within tolerance of each target
 */

import { runTest, sleep } from './utils/test-runner';
import { Locations } from './utils/save-generator';

// Points within the Dwarven Mine (all on level 0, Z ~9750-9800)
const DWARVEN_MINE_START = Locations.FALADOR_MINE;  // (3045, 9780)
const WALK_TARGETS = [
    { x: 3035, z: 9772, label: 'west side of mine' },
    { x: 3055, z: 9790, label: 'east side of mine' },
    { x: 3045, z: 9780, label: 'back to start' },
];

const WALK_TOLERANCE = 5;

runTest({
    name: 'Dungeon Pathfinding Test',
    saveConfig: {
        position: DWARVEN_MINE_START,
    },
    launchOptions: { skipTutorial: false },
}, async ({ sdk, bot }) => {
    console.log('Goal: Verify pathfinding works in dungeon areas (high Z coordinates)');

    // Wait for state to load
    await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0, 10000);
    await sleep(500);

    const startState = sdk.getState();
    const player = startState?.player;
    console.log(`Starting position: (${player?.worldX}, ${player?.worldZ}), level: ${player?.level}`);

    if (!player || player.worldZ < 9000) {
        console.log('FAILED: Bot is not in a dungeon area (Z should be > 9000)');
        return false;
    }

    // Step 1: Check that pathfinder zones are allocated for dungeon area
    console.log('\n--- Step 1: Check zone allocation ---');
    const pathResult = sdk.findPath(WALK_TARGETS[0]!.x, WALK_TARGETS[0]!.z);
    console.log(`findPath result: success=${pathResult.success}, waypoints=${pathResult.waypoints.length}, error=${pathResult.error ?? 'none'}`);

    if (!pathResult.success) {
        console.log(`FAILED: Pathfinder error: ${pathResult.error}`);
        console.log('This likely means collision data was not exported for dungeon mapsquares.');
        console.log(`Player at Z=${player.worldZ}, mapsquare Z=${Math.floor(player.worldZ / 64)}`);
        return false;
    }

    if (pathResult.waypoints.length === 0) {
        console.log('FAILED: Pathfinder returned 0 waypoints (no route found)');
        return false;
    }
    console.log('PASS: Dungeon zones are allocated and pathfinder can find routes');

    // Step 2: Walk between points in the dungeon
    console.log('\n--- Step 2: Walk between dungeon points ---');
    let allWalksSucceeded = true;

    for (const target of WALK_TARGETS) {
        console.log(`\nWalking to ${target.label} (${target.x}, ${target.z})...`);
        await bot.dismissBlockingUI();

        const result = await bot.walkTo(target.x, target.z, WALK_TOLERANCE);

        const afterState = sdk.getState();
        const px = afterState?.player?.worldX ?? 0;
        const pz = afterState?.player?.worldZ ?? 0;
        const dist = Math.sqrt(Math.pow(px - target.x, 2) + Math.pow(pz - target.z, 2));

        if (result.success && dist <= WALK_TOLERANCE) {
            console.log(`  PASS: Arrived at (${px}, ${pz}), ${dist.toFixed(1)} tiles from target`);
        } else {
            console.log(`  FAIL: At (${px}, ${pz}), ${dist.toFixed(1)} tiles from target`);
            if (!result.success) console.log(`  Walk error: ${result.message}`);
            allWalksSucceeded = false;
        }
    }

    // Summary
    console.log('\n=== Summary ===');
    const finalState = sdk.getState();
    console.log(`Final position: (${finalState?.player?.worldX}, ${finalState?.player?.worldZ}), level: ${finalState?.player?.level}`);

    if (allWalksSucceeded) {
        console.log('SUCCESS: Pathfinding works correctly in dungeon areas');
        return true;
    } else {
        console.log('FAILED: Some walks did not complete successfully');
        return false;
    }
});
