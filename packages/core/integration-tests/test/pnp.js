import assert from 'assert';
import Module from 'module';
import path from 'path';
import {bundle, run, assertBundles} from '@parcel/test-utils';

describe('pnp', function() {
  it('should defer to the pnp resolution when needed', async function() {
    const resolve = request => {
      if (request === `testmodule`) {
        return path.join(__dirname, '/integration/pnp_require/pnp/testmodule');
      } else {
        // The plugins from the parcel config are also resolved through this function
        return require.resolve(request);
      }
    };

    const pnpapi = {resolveToUnqualified: resolve, resolveRequest: resolve};

    const origPnpVersion = process.versions.pnp;
    process.versions.pnp = 42;

    const origModuleLoad = Module._load;
    Module._load = (name, ...args) =>
      name === `pnpapi` ? pnpapi : origModuleLoad(name, ...args);

    try {
      let b = await bundle(
        path.join(__dirname, '/integration/pnp_require/index.js')
      );

      await assertBundles(b, [
        {
          name: 'index.js',
          assets: ['index.js', 'local.js', 'index.js']
        }
      ]);

      let output = await run(b);
      assert.equal(output(), 3);
    } finally {
      process.versions.pnp = origPnpVersion;
      Module._load = origModuleLoad;
    }
  });
});
