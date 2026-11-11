const { reporters } = require('mocha');
const fs = require('node:fs');
const path = require('node:path');
module.exports = class extends reporters.Spec {
    constructor(runner, options) {
        super(runner, options);
        const tests = [];
        const failures = [];
        runner.on('fail', (test, error) => failures.push({ title: test.fullTitle(), error: error.stack }));
        runner.on('test end', test => tests.push({ title: test.fullTitle(), state: test.state,
            duration: test.duration, error: test.err?.stack }));
        runner.on('end', () => {
            fs.writeFileSync(path.join(process.env.GTC_TEST_RESULTS, 'results.json'),
                JSON.stringify({ stats: runner.stats, tests, failures }, null, 2));
        });
    }
};
