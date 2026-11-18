#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const config = path.join(__dirname, 'checkout.json');
const launcher = fs.existsSync(config) ? JSON.parse(fs.readFileSync(config, 'utf8')).launcher : path.resolve(__dirname, '../../../cli/bin/run');
if (!path.isAbsolute(launcher) || !fs.existsSync(launcher)) {
    console.error('The Git Tree Compare checkout moved. Reinstall this skill with cli/bin/run skills install --global.');
    process.exit(1);
}
const child = spawn(launcher, process.argv.slice(2), { stdio: 'inherit', env: { ...process.env, GTC_INVOCATION_CWD: process.cwd() } });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
