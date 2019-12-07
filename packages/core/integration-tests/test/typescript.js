import assert from 'assert';
import path from 'path';
import {
  bundle,
  run,
  assertBundles,
  distDir,
  outputFS,
} from '@parcel/test-utils';
import {readFileSync} from 'fs';

const configPath = path.join(
  __dirname,
  '/integration/typescript-config/.parcelrc',
);

const tscConfig = {
  ...JSON.parse(readFileSync(configPath)),
  filePath: configPath,
};

describe('typescript', function() {
  // This tests both the Babel transformer implementation of typescript (which
  // powers typescript by default in Parcel) as well as through the Typescript
  // tsc transformer. Use a null config to indicate the default config, and the
  // tsc config to use the tsc transformer instead.
  //
  // If testing details specific to either implementation, create another suite.
  for (let config of [
    null /* default config -- testing babel typescript */,
    tscConfig,
  ]) {
    it('should produce a ts bundle using ES6 imports', async function() {
      let b = await bundle(
        path.join(__dirname, '/integration/typescript/index.ts'),
        {config},
      );

      assertBundles(b, [
        {
          type: 'js',
          assets: ['index.ts', 'Local.ts'],
        },
      ]);

      let output = await run(b);
      assert.equal(typeof output.count, 'function');
      assert.equal(output.count(), 3);
    });

    it('should produce a ts bundle using commonJS require', async function() {
      let b = await bundle(
        path.join(__dirname, '/integration/typescript-require/index.ts'),
        {config},
      );

      assertBundles(b, [
        {
          type: 'js',
          assets: ['index.ts', 'Local.ts'],
        },
      ]);

      let output = await run(b);
      assert.equal(typeof output.count, 'function');
      assert.equal(output.count(), 3);
    });

    it('should support json require', async function() {
      let b = await bundle(
        path.join(__dirname, '/integration/typescript-json/index.ts'),
      );

      // assert.equal(b.assets.size, 2);
      // assert.equal(b.childBundles.size, 1);

      let output = await run(b);
      assert.equal(typeof output.count, 'function');
      assert.equal(output.count(), 3);
    });

    it('should support env variables', async function() {
      let b = await bundle(
        path.join(__dirname, '/integration/typescript-env/index.ts'),
        {config},
      );

      assertBundles(b, [
        {
          type: 'js',
          assets: ['index.ts'],
        },
      ]);

      let output = await run(b);
      assert.equal(typeof output.env, 'function');
      assert.equal(output.env(), 'test');
    });

    it('should support importing a URL to a raw asset', async function() {
      let b = await bundle(
        path.join(__dirname, '/integration/typescript-raw/index.ts'),
        {config},
      );

      assertBundles(b, [
        {
          name: 'index.js',
          assets: ['index.ts', 'test.txt.js'],
        },
        {
          type: 'txt',
          assets: ['test.txt'],
        },
      ]);

      let output = await run(b);
      assert.equal(typeof output.getRaw, 'function');
      assert(/^\/test\.[0-9a-f]+\.txt$/.test(output.getRaw()));
      assert(await outputFS.exists(path.join(distDir, output.getRaw())));
    });

    it('should minify with minify enabled', async function() {
      let b = await bundle(
        path.join(__dirname, '/integration/typescript-require/index.ts'),
        {
          config,
          minify: true,
        },
      );

      assertBundles(b, [
        {
          type: 'js',
          assets: ['index.ts', 'Local.ts'],
        },
      ]);

      let output = await run(b);
      assert.equal(typeof output.count, 'function');
      assert.equal(output.count(), 3);

      let js = await outputFS.readFile(path.join(distDir, 'index.js'), 'utf8');
      assert(!js.includes('local.a'));
    });

    it('should support compiling JSX', async function() {
      await bundle(
        path.join(__dirname, '/integration/typescript-jsx/index.tsx'),
        {config},
      );

      let file = await outputFS.readFile(
        path.join(distDir, 'index.js'),
        'utf8',
      );
      assert(file.includes('React.createElement("div"'));
    });

    it('should use esModuleInterop by default', async function() {
      let b = await bundle(
        path.join(__dirname, '/integration/typescript-interop/index.ts'),
        {config},
      );

      assertBundles(b, [
        {
          name: 'index.js',
          assets: ['index.ts', 'commonjs-module.js'],
        },
      ]);

      let output = await run(b);
      assert.equal(typeof output.test, 'function');
      assert.equal(output.test(), 'test passed');
    });

    it('fs.readFileSync should inline a file as a string', async function() {
      if (config != null) {
        return;
      }
      let b = await bundle(
        path.join(__dirname, '/integration/typescript-fs/index.ts'),
        {config},
      );

      const text = 'export default <div>Hello</div>;';
      let output = await run(b);

      assert.deepEqual(output, {
        fromTs: text,
        fromTsx: text,
      });
    });
  }
});
