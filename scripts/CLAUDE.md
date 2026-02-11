# Script Improvement Methodology

A scientific approach to developing and iterating on automation scripts.

**Scope**: Fresh accounts, single-play session scripts.

## Core Principles

1. **Fail Fast** - Detect stagnation early. Use short timeouts initially, then extend as confidence builds.

2. **Inspectable Runs** - Every run produces output that answers: what happened, why did it fail, what could improve?

3. **Horizontal Structure** - Each script is independent. Its logs and improvements live together so it can evolve on its own.

4. **Insights Over Data** - Log meaningful events (actions taken, outcomes) not noise. The goal is to extract learnings like "this approach worked" or "this caused failure."

5. **Confidence-Based Timeouts** - Start with short runs (1-3 mins) to validate new approaches, then extend as confidence builds if need more time

6. **Robustness at depth** - Scripts improve via the lab log cycle: run -> observe -> hypothesize -> fix -> repeat. We want to stay simple but scale towards success at longer goal time horizons.

## The Iteration Cycle

```
Hypothesize -> Implement -> Run -> Observe -> Record in lab_log -> Improve -> Repeat
```

1. **Define Goal** - What does success look like? What's the reward function?
2. **Write Script** - Implement v1 using `runScript()`
3. **Run** - Execute with `bun scripts/<name>/script.ts`
4. **Analyze** - Review console output and final world state
5. **Document** - Record insights in lab_log.md
6. **Improve** - Fix issues, optimize approach, refine logic to remove un-needed code
7. **Repeat**

## Autonomous Testing

**Scripts must be run and tested, not just written.** The agent should:

1. **Run the script** after writing it using `bun scripts/<name>/script.ts`
2. **Observe the output** - watch for errors, stalls, timeouts, or unexpected behavior
3. **Analyze what happened** - read the console output and final state
4. **Fix issues immediately** - don't wait for user feedback on obvious problems
5. **Re-run until stable** - a script isn't "done" until it runs successfully

This is a closed-loop process. Writing code without running it is incomplete work. The goal is working automation, not just code that compiles.

## Directory Structure

```
scripts/
├── CLAUDE.md                   # This file
├── script_best_practices.md    # Common patterns & pitfalls
└── <script-name>/              # Each script is self-contained
    ├── script.ts               # The automation code
    └── lab_log.md              # Observations & improvements
```

## Using the Script Runner

Scripts use `runScript()` from `sdk/runner` for execution. For fresh accounts with browser automation, compose with `generateSave()` and `launchBotWithSDK()`.

### Basic Script (Existing Account)

```typescript
import { runScript } from '../../sdk/runner';

await runScript(async (ctx) => {
  const { bot, sdk, log } = ctx;

  while (sdk.getState()?.skills.find(s => s.name === 'Woodcutting')?.baseLevel < 10) {
    await bot.dismissBlockingUI();
    const tree = sdk.findNearbyLoc(/^tree$/i);
    if (tree) await bot.chopTree(tree);
  }

  log('Goal achieved!');
}, {
  timeout: 10 * 60 * 1000,  // 10 minutes
});
```

### Fresh Account Script (with Browser)

```typescript
import { runScript, type ScriptContext } from '../../sdk/runner';
import { generateSave, TestPresets } from '../../sdk/test/utils/save-generator';
import { launchBotWithSDK } from '../../sdk/test/utils/browser';

async function main() {
  // Create fresh account
  const username = `bot${Math.random().toString(36).slice(2, 7)}`;
  await generateSave(username, TestPresets.LUMBRIDGE_SPAWN);

  // Launch browser and connect
  const session = await launchBotWithSDK(username, { usePuppeteer: true });

  try {
    await runScript(async (ctx) => {
      // Your script logic here
      await ctx.bot.chopTree();
    }, {
      connection: { bot: session.bot, sdk: session.sdk },
      timeout: 10 * 60 * 1000,
    });
  } finally {
    await session.cleanup();
  }
}

main().catch(console.error);
```

### Context API

| Method | Purpose |
|--------|---------|
| `ctx.bot.*` | High-level BotActions (chopTree, walkTo, attackNpc, etc.) |
| `ctx.sdk.*` | Low-level SDK (getState, sendWalk, findNearbyNpc, etc.) |
| `ctx.log(msg)` | Captured logging (printed after script) |

### Configuration

```typescript
interface RunOptions {
  timeout?: number;        // Max runtime in ms
  connection?: { bot, sdk }; // Use existing connection
  autoConnect?: boolean;   // Connect if not connected (default: true)
  disconnectAfter?: boolean; // Disconnect when done (default: false)
  printState?: boolean;    // Print world state after (default: true)
}
```

### Choosing Timeouts

Choose timeout based on confidence in the approach:

| Duration | Use Case |
|----------|----------|
| **1-2m** | New scripts, untested approaches, debugging |
| **5m** | Validated approach, building confidence |
| **10m+** | Proven strategy, final optimization runs |

**Pattern**: Start short, extend as you prove it works. A failed 10-minute run wastes more time than five 2-minute diagnostic runs.

## Lab Log Format

Document insights in `lab_log.md`:

```markdown
# Lab Log: goblin-killer

## Run 001 - 2026-01-24 12:30

**Outcome**: stall
**Duration**: 45s

### What Happened
- Found goblin, started combat
- Goblin died, loot dropped
- Script didn't pick up loot, kept looking for goblins

### Root Cause
Missing loot pickup after kills

### Fix
Add `await bot.pickupItem(/bones|coins/)` after combat ends

---

## Run 002 - 2026-01-24 12:45

**Outcome**: success
**Duration**: 8m 32s

### What Worked
- Loot pickup fix resolved stall
- Reached level 10 successfully

### Optimization Ideas
- Could prioritize goblins by distance
- Add eating when HP low
```

## Handling Surprise

**Surprise is normal.** Scripts fail. Actions don't work. Something unexpected happens. When this occurs:

1. **Don't panic** - Read the error output carefully. The runner shows stack traces and game state.
2. **Drop to a short timeout** - Switch to a 1-minute diagnostic run to understand what's happening.
3. **Check the final state** - Did the action actually change anything?
4. **Review game messages** - Often the game tells you why something failed ("You can't reach that", "Inventory full", etc.)

### Common Surprises

| Surprise | What to check | Response |
|----------|---------------|----------|
| **Action does nothing** | Is dialog open? Is there an obstacle? | Check `state.dialog.isOpen`, try `bot.dismissBlockingUI()` |
| **Can't find NPC/object** | Are we in the right place? Did it despawn? | Log position, check `nearbyNpcs`/`nearbyLocs` |
| **Script stalls** | Is player animating? Stuck in dialog? | Check `player.animId`, `dialog.isOpen` |
| **Unexpected error** | Read the full stack trace | The state context shows position, HP, inventory |

## Best Practices

See **[script_best_practices.md](./script_best_practices.md)** for detailed patterns and common pitfalls (dialog handling, fishing spots, state quirks, etc.).

1. **Dismiss blocking dialogs** - Level-up congratulations and other dialogs block all actions. Check `state.dialog.isOpen` in your main loop and call `sdk.sendClickDialog(0)` to dismiss.

2. **Use `ctx.log()`** for key decisions - easier to understand what happened

3. **Document insights** in lab_log.md - patterns that work, issues that fail

4. **One change at a time** - easier to attribute improvements/regressions

5. **Commit working versions** before major changes

## Learnings Section

After a run of improvement (5+ cycles or whenever you run out of ideas / feel stuck), add a **Learnings** section to the end of the lab_log with three categories:

```markdown
---

## Learnings

### 1. Strategic Findings
What works and what doesn't - both code patterns and game strategies:
- Effective approaches discovered
- Failed strategies and why they failed
- Optimal parameters found (batch sizes, thresholds, timing)
- Game mechanics insights

### 2. Process & Tooling Reflections
Meta-observations on the improvement process itself:
- What made debugging easier/harder
- Logging improvements that would help
- Run analysis techniques that worked
- Suggestions for the runner or methodology

### 3. SDK Issues & Gaps
Problems or missing features in the Bot SDK:
- Functions that don't work as expected
- Missing functionality that would help
- API design issues encountered
- Workarounds that shouldn't be necessary
```

This helps capture institutional knowledge that benefits future scripts and SDK development.
