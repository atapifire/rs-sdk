# Mining

Successful patterns for mining automation.

## Finding Rocks

Rocks are **locations** (not NPCs). Filter for rocks with a "Mine" option:

```typescript
const rock = state.nearbyLocs
    .filter(loc => /rocks?$/i.test(loc.name))
    .filter(loc => loc.optionsWithIndex.some(o => /^mine$/i.test(o.text)))
    .sort((a, b) => a.distance - b.distance)[0];
```

## Mining Action

```typescript
// Walk closer if needed (interaction range is ~3 tiles)
if (rock.distance > 3) {
    await ctx.sdk.sendWalk(rock.x, rock.z, true);
    await new Promise(r => setTimeout(r, 1000));
}

const mineOpt = rock.optionsWithIndex.find(o => /^mine$/i.test(o.text));
await ctx.sdk.sendInteractLoc(rock.x, rock.z, rock.id, mineOpt.opIndex);
```

## Detecting Mining Activity

Animation ID 625 indicates active mining:

```typescript
const isMining = state.player?.animId === 625;
const isIdle = state.player?.animId === -1;
```

## Rock IDs → Ore Types (SE Varrock Mine)

Rocks are ALL named "Rocks" — you **must** prospect to tell them apart:

| Rock ID | Ore |
|---------|-----|
| 2090 | **Copper** |
| 2091 | **Copper** |
| 2092 | **Iron** |
| 2093 | **Tin** |
| 2094 | **Tin** |
| 2095 | **Iron** |

**IMPORTANT:** Previous learnings had 2092=tin and 2093=iron — this was WRONG.
Always prospect or test-mine to verify on your server instance.

**How to mine specific ore:**
```typescript
// Mine copper specifically (IDs 2090 or 2091)
const copperRock = state.nearbyLocs
    .filter(loc => loc.id === 2090 || loc.id === 2091)
    .filter(loc => loc.optionsWithIndex.some(o => /^mine$/i.test(o.text)))
    .sort((a, b) => a.distance - b.distance)[0];

// Mine tin specifically (IDs 2093 or 2094)
const tinRock = state.nearbyLocs
    .filter(loc => loc.id === 2093 || loc.id === 2094)
    .filter(loc => loc.optionsWithIndex.some(o => /^mine$/i.test(o.text)))
    .sort((a, b) => a.distance - b.distance)[0];
```

Use `Prospect` option on a rock to discover its ore type if unsure.

## Rock IDs → Ore Types (Al Kharid Mine)

| Rock ID | Ore |
|---------|-----|
| 2092 | **Iron** |
| 2093 | **Tin** |
| 2096 | **Coal** |
| 2098 | **Gold** |
| 2100 | **Silver** |
| 2103 | **Mithril** |
| 450, 2097, 2099, 2101, 2102 | Unknown (depleted during testing) |

**Note:** Al Kharid mine is full of Lvl 14 scorpions. Combat 27+ with defensive style is enough to survive while mining. The scorpion fights actually train Defence passively.

## Reliable Locations

| Location | Coordinates | Notes |
|----------|-------------|-------|
| SE Varrock mine | (3285, 3365) | Copper (2090/2091), tin (2093/2094), iron (2092/2095) |
| Al Kharid mine | (3295, 3287) | Iron, coal, gold, silver, mithril, tin + unknowns. Scorpions! |
| Lumbridge Swamp mine | - | Interactions fail silently, avoid |

**Getting to Al Kharid mine from Lumbridge:** Pay 10gp toll at gate (3268, 3227), walk NE. Dialog sequence: continue → continue → "Yes, ok." (index 3) → continue.

## Counting Ore

```typescript
function countOre(ctx): number {
    const state = ctx.sdk.getState();
    if (!state) return 0;
    return state.inventory
        .filter(i => /ore$/i.test(i.name))
        .reduce((sum, i) => sum + i.count, 0);
}
```

## Drop When Full

```typescript
if (state.inventory.length >= 28) {
    const ores = state.inventory.filter(i => /ore$/i.test(i.name));
    for (const ore of ores) {
        await ctx.sdk.sendDropItem(ore.slot);
        await new Promise(r => setTimeout(r, 100));
    }
}
```
