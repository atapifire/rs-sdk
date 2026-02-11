#!/usr/bin/env bun
/**
 * Zanaris (Lost City) Dungeon Pathfinding Test
 *
 * Verifies that pathfinding works in Zanaris, a dungeon area at high Z
 * coordinates (Z ~9550-9592). This was previously broken because the
 * collision exporter didn't include dungeon mapsquares.
 *
 * The test spawns a bot at the Zanaris entry point and walks between
 * several known locations within the area.
 *
 * Success criteria:
 * 1. Source zone is allocated (collision data exists for Zanaris)
 * 2. Pathfinder finds routes between points
 * 3. Bot successfully walks to each target within tolerance
 */

import { runTest, sleep } from './utils/test-runner';
import { Locations } from './utils/save-generator';

// Known walkable points in Zanaris (region 50_149, level 0)
const ZANARIS_SPAWN = Locations.ZANARIS;  // (3220, 9592) - teleport entry
const WALK_TARGETS = [
    { x: 3215, z: 9577, label: 'west of spawn' },
    { x: 3238, z: 9558, label: 'eastern market door' },
    { x: 3233, z: 9554, label: 'southern market door' },
    { x: 3220, z: 9592, label: 'back to spawn' },
];

const WALK_TOLERANCE = 5;

runTest({
    name: 'Zanaris Dungeon Pathfinding',
    saveConfig: {
        position: ZANARIS_SPAWN,
    },
    launchOptions: { skipTutorial: false },
}, async ({ sdk, bot }) => {
    console.log('Goal: Walk between points in Zanaris to verify dungeon pathfinding');
    console.log(`Zanaris region: mapsquare (50, 149), world Z ~9536-9599`);

    await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0, 10000);
    await sleep(500);

    const startState = sdk.getState();
    const player = startState?.player;
    console.log(`Position: (${player?.worldX}, ${player?.worldZ}), level: ${player?.level}`);

    if (!player || player.worldZ < 9000) {
        console.log('FAILED: Bot is not in dungeon area (expected Z > 9000)');
        return false;
    }

    // Step 1: Verify zone allocation
    console.log('\n--- Step 1: Zone allocation check ---');
    const probe = sdk.findPath(WALK_TARGETS[0]!.x, WALK_TARGETS[0]!.z);
    console.log(`findPath: success=${probe.success}, waypoints=${probe.waypoints.length}, error=${probe.error ?? 'none'}`);

    if (!probe.success) {
        console.log(`FAILED: ${probe.error}`);
        console.log('Collision data likely missing for dungeon mapsquares.');
        return false;
    }
    if (probe.waypoints.length === 0) {
        console.log('FAILED: 0 waypoints - no route found');
        return false;
    }
    console.log('PASS: Zones allocated, pathfinder found a route');

    // Step 2: Walk the circuit
    console.log('\n--- Step 2: Walk between Zanaris locations ---');
    let passed = 0;
    let failed = 0;

    for (const target of WALK_TARGETS) {
        console.log(`\n-> ${target.label} (${target.x}, ${target.z})`);
        await bot.dismissBlockingUI();

        const result = await bot.walkTo(target.x, target.z, WALK_TOLERANCE);
        const s = sdk.getState();
        const px = s?.player?.worldX ?? 0;
        const pz = s?.player?.worldZ ?? 0;
        const dist = Math.sqrt((px - target.x) ** 2 + (pz - target.z) ** 2);

        if (result.success && dist <= WALK_TOLERANCE) {
            console.log(`   PASS: at (${px}, ${pz}), ${dist.toFixed(1)} tiles away`);
            passed++;
        } else {
            console.log(`   FAIL: at (${px}, ${pz}), ${dist.toFixed(1)} tiles away`);
            if (!result.success) console.log(`   Error: ${result.message}`);
            failed++;
        }
    }

    // Summary
    console.log(`\n=== Results: ${passed}/${WALK_TARGETS.length} passed, ${failed} failed ===`);
    const final = sdk.getState();
    console.log(`Final position: (${final?.player?.worldX}, ${final?.player?.worldZ})`);

    if (failed === 0) {
        console.log('SUCCESS: Dungeon pathfinding works in Zanaris');
        return true;
    } else {
        console.log('FAILED: Some walks did not complete');
        return false;
    }
});
