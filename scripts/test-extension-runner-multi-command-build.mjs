#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  bundleExtensionRunner,
} from './measure-extension-bundle-cache.mjs';

const require = createRequire(import.meta.url);
const Module = require('node:module');

function createBuildFixture(commandCount) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `sc-extension-multi-build-${commandCount}-`));
  const userDataDir = path.join(tmpDir, 'userData');
  const extDir = path.join(tmpDir, 'extension');
  const srcDir = path.join(extDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  const commands = Array.from({ length: commandCount }, (_unused, index) => {
    const name = `command-${index}`;
    fs.writeFileSync(
      path.join(srcDir, `${name}.ts`),
      [
        `export default async function ${name.replace(/-/g, '_')}() {`,
        `  return ${JSON.stringify(name)};`,
        `}`,
        '',
      ].join('\n')
    );
    return {
      name,
      title: `Command ${index}`,
      description: `Command ${index}`,
      mode: 'view',
    };
  });

  fs.writeFileSync(
    path.join(extDir, 'package.json'),
    JSON.stringify(
      {
        name: `multi-build-fixture-${commandCount}`,
        title: `Multi Build Fixture ${commandCount}`,
        description: 'Fixture for batched extension builds',
        owner: 'codex',
        commands,
      },
      null,
      2
    )
  );

  return { tmpDir, userDataDir, extDir };
}

test('buildAllCommands batches 1/5/20 command fixtures into one esbuild call each', async (t) => {
  for (const commandCount of [1, 5, 20]) {
    await t.test(`${commandCount} command fixture`, async () => {
      const fixture = createBuildFixture(commandCount);
      let bundledRunner;
      const esbuild = require('esbuild');
      const originalBuild = esbuild.build;
      const originalLoad = Module._load;
      const buildCalls = [];
      const patchedBuild = async function patchedBuild(options) {
        if (options?.absWorkingDir === fixture.extDir) {
          const entryCount = Array.isArray(options.entryPoints)
            ? options.entryPoints.length
            : Object.keys(options.entryPoints || {}).length;
          buildCalls.push({
            entryCount,
            outdir: options.outdir,
            outfile: options.outfile,
          });
        }
        return originalBuild.call(this, options);
      };
      Module._load = function patchedModuleLoad(request, parent, isMain) {
        if (request === 'esbuild') {
          return { ...esbuild, build: patchedBuild };
        }
        return originalLoad.call(this, request, parent, isMain);
      };

      try {
        bundledRunner = await bundleExtensionRunner(fixture.userDataDir);
        const runner = require(bundledRunner);
        const built = await runner.buildAllCommands(`multi-build-fixture-${commandCount}`, fixture.extDir);

        assert.equal(built, commandCount);
        assert.equal(buildCalls.length, 1, 'expected one esbuild invocation for all commands');
        assert.equal(buildCalls[0].entryCount, commandCount);
        assert.equal(buildCalls[0].outdir, path.join(fixture.extDir, '.sc-build'));
        assert.equal(buildCalls[0].outfile, undefined);

        for (let index = 0; index < commandCount; index += 1) {
          assert.ok(
            fs.existsSync(path.join(fixture.extDir, '.sc-build', `command-${index}.js`)),
            `expected command-${index}.js output`
          );
        }
      } finally {
        Module._load = originalLoad;
        try {
          if (bundledRunner) fs.unlinkSync(bundledRunner);
        } catch {}
        try {
          fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
        } catch {}
      }
    });
  }
});
