#!/usr/bin/env bun
/**
 * Demo: What a bot can learn from Zeke's Scimitar Shop
 * Shows the shop inventory and price data available via SDK
 */

import { runTest, sleep } from './utils/test-runner';
import { Items } from './utils/save-generator';

runTest({
    name: "Zeke's Shop Demo",
    saveConfig: {
        position: { x: 3274, z: 3186 }, // Near Al-Kharid furnace, close to Zeke
        inventory: [
            { id: Items.COINS, count: 10000 },
        ],
    },
    launchOptions: { skipTutorial: false },
}, async ({ sdk, bot }) => {
    console.log("=== What a Bot Can Learn from Zeke's Scimitar Shop ===\n");

    await sdk.waitForCondition(s => (s.player?.worldX ?? 0) > 0, 10000);
    await sleep(500);

    // Find and open Zeke's shop
    const zeke = sdk.findNearbyNpc(/zeke/i);
    if (!zeke) {
        console.log('ERROR: Zeke not found nearby');
        return false;
    }
    console.log(`Found ${zeke.name} at distance ${zeke.distance}\n`);

    const openResult = await bot.openShop(zeke);
    if (!openResult.success) {
        console.log(`Failed to open shop: ${openResult.message}`);
        return false;
    }

    const shop = sdk.getState()?.shop;
    if (!shop?.isOpen) {
        console.log('Shop not open');
        return false;
    }

    // === SHOP CONFIGURATION ===
    console.log('─────────────────────────────────────────────');
    console.log('SHOP CONFIGURATION');
    console.log('─────────────────────────────────────────────');
    console.log(`Shop Name: ${shop.title}`);
    if (shop.shopConfig) {
        const cfg = shop.shopConfig;
        console.log(`Buy Multiplier:  ${cfg.buyMultiplier / 10}% (what shop pays you)`);
        console.log(`Sell Multiplier: ${cfg.sellMultiplier / 10}% (what you pay shop)`);
        console.log(`Haggle Delta:    ${cfg.haggle} (price change per stock level)`);
    }

    // === SHOP INVENTORY ===
    console.log('\n─────────────────────────────────────────────');
    console.log('SHOP INVENTORY (What you can BUY)');
    console.log('─────────────────────────────────────────────');
    console.log('Item                 Stock   Base Cost   Buy Price   Sell Price');
    console.log('────────────────────────────────────────────────────────────────');

    for (const item of shop.shopItems) {
        const name = item.name.padEnd(20);
        const stock = String(item.count).padStart(5);
        const base = String(item.baseCost).padStart(10) + 'gp';
        const buy = String(item.buyPrice).padStart(10) + 'gp';
        const sell = String(item.sellPrice).padStart(11) + 'gp';
        console.log(`${name} ${stock} ${base} ${buy} ${sell}`);
    }

    // === PRICE ANALYSIS ===
    console.log('\n─────────────────────────────────────────────');
    console.log('PRICE ANALYSIS');
    console.log('─────────────────────────────────────────────');

    for (const item of shop.shopItems) {
        const markup = ((item.buyPrice / item.baseCost) * 100).toFixed(0);
        const sellPct = ((item.sellPrice / item.baseCost) * 100).toFixed(0);
        const profit = item.buyPrice - item.sellPrice;
        console.log(`${item.name}:`);
        console.log(`  - Buy at ${markup}% of base value (${item.buyPrice}gp)`);
        console.log(`  - Sell at ${sellPct}% of base value (${item.sellPrice}gp)`);
    }


    if (shop.playerItems.length === 0) {
        console.log('(No sellable items in inventory)');
    } else {
        console.log('Item                 Count   Base Cost   You Get');
        console.log('─────────────────────────────────────────────────');
        for (const item of shop.playerItems) {
            const name = item.name.padEnd(20);
            const count = String(item.count).padStart(5);
            const base = String(item.baseCost).padStart(10) + 'gp';
            const sell = String(item.sellPrice).padStart(8) + 'gp';
            console.log(`${name} ${count} ${base} ${sell}`);
        }
    }



    // Find best value item to buy
    const bestBuy = shop.shopItems.reduce((best, item) =>
        item.buyPrice < best.buyPrice ? item : best
    );
    console.log(`Cheapest item to buy: ${bestBuy.name} (${bestBuy.buyPrice}gp)`);

    // Find most expensive item
    const mostExpensive = shop.shopItems.reduce((best, item) =>
        item.buyPrice > best.buyPrice ? item : best
    );
    console.log(`Most expensive item: ${mostExpensive.name} (${mostExpensive.buyPrice}gp)`);

    // buy most expensive item that's in stock
    const itemToBuy = shop.shopItems
        .filter(item => item.count > 0)
        .reduce((best, item) => item.buyPrice > best.buyPrice ? item : best);

    const buyResult = await bot.buyFromShop(itemToBuy.name, 1);
    if (!buyResult.success) {
        console.log(`Failed to buy ${itemToBuy.name}: ${buyResult.message}`);
        return false;
    }
    console.log(`Bought ${buyResult.item?.name} `);

    // Check what player can sell
    const playerCoins = sdk.findInventoryItem(/coins/i);
    console.log(`\nPlayer has: ${playerCoins?.count || 0} coins`);

    const canAfford = shop.shopItems.filter(i => i.buyPrice <= (playerCoins?.count || 0));
    console.log(`Can afford: ${canAfford.map(i => i.name).join(', ') || 'nothing'}`);

    // Calculate potential profit from selling inventory
    const sellableScimitars = shop.playerItems.filter(i => /scimitar/i.test(i.name));
    if (sellableScimitars.length > 0) {
        const totalSellValue = sellableScimitars.reduce((sum, i) => sum + (i.sellPrice * i.count), 0);
        console.log(`\nIf you sell your scimitars: +${totalSellValue}gp`);
    }

    await bot.closeShop();

    console.log('\n=== Demo Complete ===');
    return true;
});
