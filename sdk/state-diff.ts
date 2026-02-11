// State Diff Tracking - Track meaningful changes between bot states
// Used for real-time feedback to Claude during script execution

import type { BotWorldState, InventoryItem, SkillState, NearbyNpc, GroundItem } from './types';

export interface StateDiff {
    tick: { before: number; after: number; elapsed: number };

    // Inventory changes
    inventory: {
        gained: Array<{ name: string; count: number; id: number }>;
        lost: Array<{ name: string; count: number; id: number }>;
        changed: Array<{ name: string; before: number; after: number; id: number }>;
    };

    // Skill changes
    skills: {
        xpGained: Array<{ name: string; xp: number; levelUp?: boolean; newLevel?: number }>;
    };

    // Combat changes
    combat: {
        damageTaken: number;
        damageDealt: number;
        kills: number;
        healthChange: number;
    };

    // Position changes
    position: {
        moved: boolean;
        from?: { x: number; z: number };
        to?: { x: number; z: number };
        distance: number;
    };

    // Dialog/interface changes
    ui: {
        dialogOpened: boolean;
        dialogClosed: boolean;
        interfaceOpened: boolean;
        interfaceClosed: boolean;
        shopOpened: boolean;
        shopClosed: boolean;
    };

    // NPC changes
    npcs: {
        appeared: Array<{ name: string; index: number }>;
        disappeared: Array<{ name: string; index: number }>;
        died: Array<{ name: string; index: number }>;
    };

    // Game messages received
    messages: string[];

    // Summary
    summary: string[];
}

export function createEmptyDiff(tick: number): StateDiff {
    return {
        tick: { before: tick, after: tick, elapsed: 0 },
        inventory: { gained: [], lost: [], changed: [] },
        skills: { xpGained: [] },
        combat: { damageTaken: 0, damageDealt: 0, kills: 0, healthChange: 0 },
        position: { moved: false, distance: 0 },
        ui: {
            dialogOpened: false, dialogClosed: false,
            interfaceOpened: false, interfaceClosed: false,
            shopOpened: false, shopClosed: false
        },
        npcs: { appeared: [], disappeared: [], died: [] },
        messages: [],
        summary: []
    };
}

export function computeStateDiff(before: BotWorldState, after: BotWorldState): StateDiff {
    const diff = createEmptyDiff(before.tick);
    diff.tick = {
        before: before.tick,
        after: after.tick,
        elapsed: after.tick - before.tick
    };

    // Inventory changes
    const beforeInv = new Map<number, { name: string; count: number; id: number }>();
    const afterInv = new Map<number, { name: string; count: number; id: number }>();

    // Group by item ID and sum counts
    for (const item of before.inventory) {
        const existing = beforeInv.get(item.id);
        if (existing) {
            existing.count += item.count;
        } else {
            beforeInv.set(item.id, { name: item.name, count: item.count, id: item.id });
        }
    }
    for (const item of after.inventory) {
        const existing = afterInv.get(item.id);
        if (existing) {
            existing.count += item.count;
        } else {
            afterInv.set(item.id, { name: item.name, count: item.count, id: item.id });
        }
    }

    // Find gained items
    for (const [id, item] of afterInv) {
        const beforeItem = beforeInv.get(id);
        if (!beforeItem) {
            diff.inventory.gained.push(item);
            diff.summary.push(`+${item.count} ${item.name}`);
        } else if (item.count > beforeItem.count) {
            diff.inventory.changed.push({ ...item, before: beforeItem.count, after: item.count });
            diff.summary.push(`+${item.count - beforeItem.count} ${item.name}`);
        }
    }

    // Find lost items
    for (const [id, item] of beforeInv) {
        const afterItem = afterInv.get(id);
        if (!afterItem) {
            diff.inventory.lost.push(item);
            diff.summary.push(`-${item.count} ${item.name}`);
        } else if (afterItem.count < item.count) {
            if (!diff.inventory.changed.find(c => c.id === id)) {
                diff.inventory.changed.push({ ...item, before: item.count, after: afterItem.count });
            }
            diff.summary.push(`-${item.count - afterItem.count} ${item.name}`);
        }
    }

    // Skill XP changes
    const beforeSkills = new Map<string, SkillState>();
    for (const skill of before.skills) {
        beforeSkills.set(skill.name, skill);
    }

    for (const skill of after.skills) {
        const beforeSkill = beforeSkills.get(skill.name);
        if (beforeSkill && skill.experience > beforeSkill.experience) {
            const xpGain = skill.experience - beforeSkill.experience;
            const levelUp = skill.baseLevel > beforeSkill.baseLevel;
            diff.skills.xpGained.push({
                name: skill.name,
                xp: xpGain,
                levelUp,
                newLevel: levelUp ? skill.baseLevel : undefined
            });
            if (levelUp) {
                diff.summary.push(`LEVEL UP! ${skill.name} -> ${skill.baseLevel}`);
            } else {
                diff.summary.push(`+${xpGain} ${skill.name} XP`);
            }
        }
    }

    // Combat changes
    const beforeHp = before.skills.find(s => s.name === 'Hitpoints')?.level ?? 10;
    const afterHp = after.skills.find(s => s.name === 'Hitpoints')?.level ?? 10;
    diff.combat.healthChange = afterHp - beforeHp;

    // Check combat events
    if (after.combatEvents) {
        const newEvents = after.combatEvents.filter(e => e.tick > before.tick);
        for (const evt of newEvents) {
            if (evt.type === 'damage_taken') {
                diff.combat.damageTaken += evt.damage;
            } else if (evt.type === 'damage_dealt') {
                diff.combat.damageDealt += evt.damage;
            } else if (evt.type === 'kill') {
                diff.combat.kills++;
            }
        }
    }

    if (diff.combat.damageTaken > 0) {
        diff.summary.push(`Took ${diff.combat.damageTaken} damage`);
    }
    if (diff.combat.damageDealt > 0) {
        diff.summary.push(`Dealt ${diff.combat.damageDealt} damage`);
    }
    if (diff.combat.kills > 0) {
        diff.summary.push(`Killed ${diff.combat.kills} target(s)`);
    }

    // Position changes
    if (before.player && after.player) {
        const dx = after.player.worldX - before.player.worldX;
        const dz = after.player.worldZ - before.player.worldZ;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > 0) {
            diff.position = {
                moved: true,
                from: { x: before.player.worldX, z: before.player.worldZ },
                to: { x: after.player.worldX, z: after.player.worldZ },
                distance: Math.round(dist)
            };
            if (dist >= 5) {
                diff.summary.push(`Moved ${Math.round(dist)} tiles`);
            }
        }
    }

    // UI changes
    diff.ui.dialogOpened = !before.dialog.isOpen && after.dialog.isOpen;
    diff.ui.dialogClosed = before.dialog.isOpen && !after.dialog.isOpen;
    diff.ui.interfaceOpened = !before.interface?.isOpen && !!after.interface?.isOpen;
    diff.ui.interfaceClosed = !!before.interface?.isOpen && !after.interface?.isOpen;
    diff.ui.shopOpened = !before.shop?.isOpen && !!after.shop?.isOpen;
    diff.ui.shopClosed = !!before.shop?.isOpen && !after.shop?.isOpen;

    if (diff.ui.dialogOpened) diff.summary.push('Dialog opened');
    if (diff.ui.dialogClosed) diff.summary.push('Dialog closed');
    if (diff.ui.shopOpened) diff.summary.push(`Shop opened: ${after.shop?.title}`);
    if (diff.ui.shopClosed) diff.summary.push('Shop closed');

    // NPC changes
    const beforeNpcs = new Map<number, NearbyNpc>();
    for (const npc of before.nearbyNpcs) {
        beforeNpcs.set(npc.index, npc);
    }

    const afterNpcs = new Map<number, NearbyNpc>();
    for (const npc of after.nearbyNpcs) {
        afterNpcs.set(npc.index, npc);
        if (!beforeNpcs.has(npc.index)) {
            diff.npcs.appeared.push({ name: npc.name, index: npc.index });
        }
    }

    for (const [idx, npc] of beforeNpcs) {
        if (!afterNpcs.has(idx)) {
            diff.npcs.disappeared.push({ name: npc.name, index: idx });
            // If NPC was in combat and disappeared, probably died
            if (npc.inCombat) {
                diff.npcs.died.push({ name: npc.name, index: idx });
                diff.summary.push(`${npc.name} died`);
            }
        }
    }

    // Game messages
    if (after.gameMessages) {
        const newMessages = after.gameMessages.filter(m => m.tick > before.tick);
        diff.messages = newMessages.map(m => m.text.replace(/@\w+@/g, ''));
    }

    return diff;
}

export function formatStateDiff(diff: StateDiff): string {
    if (diff.summary.length === 0) {
        return '(no significant changes)';
    }

    const lines: string[] = [];
    lines.push(`Changes over ${diff.tick.elapsed} ticks:`);
    for (const item of diff.summary) {
        lines.push(`  - ${item}`);
    }

    if (diff.messages.length > 0) {
        lines.push('Messages:');
        for (const msg of diff.messages.slice(-3)) {
            lines.push(`  > ${msg}`);
        }
    }

    return lines.join('\n');
}
