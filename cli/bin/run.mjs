#!/usr/bin/env node
import { Builtins, Cli } from 'clipanion';
import { requireEnvironment } from '../lib/process.mjs';
import { SetupCommand, DoctorCommand, CheckCommand, BuildCommand, VerifyCommand, TestCommand, DependenciesCommand } from '../commands/development.mjs';
import { PackageCommand, ReleaseCommand, InstallCommand } from '../commands/distribution.mjs';

requireEnvironment();
const cli = new Cli({ binaryLabel: 'Git Tree Compare', binaryName: 'run', binaryVersion: '1.0.0' });
for (const command of [Builtins.HelpCommand, Builtins.VersionCommand, SetupCommand, DoctorCommand,
    CheckCommand, BuildCommand, VerifyCommand, TestCommand, DependenciesCommand, PackageCommand, ReleaseCommand, InstallCommand]) cli.register(command);
await cli.runExit(process.argv.slice(2));
