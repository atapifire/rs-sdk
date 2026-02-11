# Cooking

## Cooking on a Range

Use `bot.useItemOnLoc(item, loc)` with raw food on a range:

```typescript
const raw = sdk.findInventoryItem(/^raw shrimps$/i);
const range = sdk.findNearbyLoc(/^range$/i);
if (raw && range) {
  await bot.useItemOnLoc(raw, range);
}
```

## Range Locations

| Location | Coordinates | Notes |
|----------|-------------|-------|
| **Lumbridge (near Bob's Axes)** | **(3211, 3215)** | **USE THIS.** Accessible without any quests. |
| Lumbridge Castle kitchen | (3211, 3256) | **REQUIRES Cook's Assistant quest completion.** Will not let you use it without the quest. |

**COMMON MISTAKE**: The range inside Lumbridge Castle kitchen (ground floor, north side) is locked behind the Cook's Assistant quest. If you haven't completed it, the game will not allow you to cook there. Use the range near Bob's Brilliant Axes shop south of the castle instead.
