const Mocha = require('mocha');
const path = require('node:path');
exports.run = () => new Promise((resolve, reject) => {
    const mocha = new Mocha({ timeout: 30000, reporter: path.join(__dirname, 'reporter.cjs') });
    mocha.addFile(path.join(__dirname, 'integration/untrusted.test.cjs'));
    mocha.run(failures => failures ? reject(new Error(`${failures} trust test(s) failed`)) : resolve());
});
