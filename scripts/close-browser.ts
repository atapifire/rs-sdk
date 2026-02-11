/**
 * Close the shared browser used by script runs.
 * Run this when you're done with all scripts and want to free resources.
 *
 * Usage: bun scripts/close-browser.ts
 */

import { closeSharedBrowser } from '../sdk/test/utils/browser';

closeSharedBrowser()
    .then(() => {
        console.log('Done');
        process.exit(0);
    })
    .catch((err) => {
        console.error('Error:', err);
        process.exit(1);
    });
