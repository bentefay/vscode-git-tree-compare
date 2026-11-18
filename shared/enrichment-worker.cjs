'use strict';
const { parentPort } = require('node:worker_threads');
const core = require('./enrichment.cjs');
// Serial work keeps large Git reads bounded. The host coalesces pending refreshes.
let queue = Promise.resolve();
parentPort.on('message', message => {
    queue = queue.then(async () => {
        try {
            const allowed = ['saveSelection', 'context', 'load', 'publish'];
            if (!allowed.includes(message.method)) throw new Error('Unknown enrichment operation');
            parentPort.postMessage({ id: message.id, result: await core[message.method](...message.args) });
        } catch (error) { parentPort.postMessage({ id: message.id, error: error.message }); }
    });
});
