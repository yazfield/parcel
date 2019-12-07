import assert from 'assert';
import path from 'path';
import {
  bundle,
  run,
  assertBundles,
  distDir,
  removeDistDirectory,
  outputFS,
} from '@parcel/test-utils';

describe('css', () => {
  afterEach(async () => {
    await removeDistDirectory();
  });

  it('should produce two bundles when importing a CSS file', async () => {
    let b = await bundle(path.join(__dirname, '/integration/css/index.js'));

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js', 'local.js'],
      },
      {
        name: 'index.css',
        assets: ['index.css', 'local.css'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 3);
  });

  it('should bundle css dependencies in the correct, postorder traversal order', async () => {
    let b = await bundle(path.join(__dirname, '/integration/css-order/a.css'));

    // Given a tree of css with imports:
    //      A
    //    /   \
    //   B     E
    //  / \
    // C   D
    //
    // (A imports B (which imports C and D) and E)
    //
    // ...styles should be applied in the order C, D, B, E, A

    assertBundles(b, [
      {
        name: 'a.css',
        assets: ['a.css', 'b.css', 'c.css', 'd.css', 'e.css'],
      },
    ]);

    let css = await outputFS.readFile(path.join(distDir, 'a.css'), 'utf8');
    assert.ok(
      css.indexOf('.c {') < css.indexOf('.d {') &&
        css.indexOf('.d {') < css.indexOf('.b {') &&
        css.indexOf('.b {') < css.indexOf('.e {') &&
        css.indexOf('.e {') < css.indexOf('.a {'),
    );
  });

  it('should support loading a CSS bundle along side dynamic imports', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/dynamic-css/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: [
          'cacheLoader.js',
          'css-loader.js',
          'index.js',
          'js-loader.js',
          'JSRuntime.js',
        ],
      },
      {name: /local\.[0-9a-f]{8}\.js/, assets: ['local.js']},
      {name: /local\.[0-9a-f]{8}\.css/, assets: ['local.css']},
      {name: 'index.css', assets: ['index.css']},
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(await output(), 3);
  });

  it('should support importing CSS from a CSS file', async function() {
    let b = await bundle(
      path.join(__dirname, '/integration/css-import/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js'],
      },
      {
        name: 'index.css',
        assets: ['index.css', 'other.css', 'local.css'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 2);

    let css = await outputFS.readFile(path.join(distDir, '/index.css'), 'utf8');
    assert(css.includes('.local'));
    assert(css.includes('.other'));
    assert(/@media print {\s*.other/.test(css));
    assert(css.includes('.index'));
  });

  it('should support linking to assets with url() from CSS', async function() {
    let b = await bundle(path.join(__dirname, '/integration/css-url/index.js'));

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js'],
      },
      {
        name: 'index.css',
        assets: ['index.css'],
      },
      {
        type: 'woff2',
        assets: ['test.woff2'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 2);

    let css = await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8');
    assert(/url\("\/test\.[0-9a-f]+\.woff2"\)/.test(css));
    assert(css.includes('url("http://google.com")'));
    assert(css.includes('.index'));
    assert(css.includes('url("data:image/gif;base64,quotes")'));
    assert(css.includes('.quotes'));
    assert(css.includes('url(data:image/gif;base64,no-quote)'));
    assert(css.includes('.no-quote'));

    assert(
      await outputFS.exists(
        path.join(distDir, css.match(/url\("(\/test\.[0-9a-f]+\.woff2)"\)/)[1]),
      ),
    );
  });

  it('should support linking to assets with url() from CSS in production', async function() {
    let b = await bundle(
      path.join(__dirname, '/integration/css-url/index.js'),
      {
        minify: true,
      },
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js'],
      },
      {
        name: 'index.css',
        assets: ['index.css'],
      },
      {
        type: 'woff2',
        assets: ['test.woff2'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 2);

    let css = await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8');
    assert(
      /url\(\/test\.[0-9a-f]+\.woff2\)/.test(css),
      'woff ext found in css',
    );
    assert(css.includes('url(http://google.com)'), 'url() found');
    assert(css.includes('.index'), '.index found');
    assert(css.includes('url("data:image/gif;base64,quotes")'));
    assert(css.includes('.quotes'));
    assert(css.includes('url(data:image/gif;base64,no-quote)'));
    assert(css.includes('.no-quote'));

    assert(
      await outputFS.exists(
        path.join(distDir, css.match(/url\((\/test\.[0-9a-f]+\.woff2)\)/)[1]),
      ),
    );
  });

  it('should support linking to assets in parent folders with url() from CSS', async function() {
    let b = await bundle(
      [
        path.join(__dirname, '/integration/css-url-relative/src/a/style1.css'),
        path.join(__dirname, '/integration/css-url-relative/src/b/style2.css'),
      ],
      {
        minify: true,
        sourceMaps: false,
      },
    );

    assertBundles(b, [
      {
        type: 'css',
        assets: ['style1.css'],
      },
      {
        type: 'css',
        assets: ['style2.css'],
      },
      {
        type: 'png',
        assets: ['foo.png'],
      },
    ]);

    let css = await outputFS.readFile(
      path.join(distDir, 'a', 'style1.css'),
      'utf8',
    );

    assert(css.includes('background-image'), 'includes `background-image`');
    assert(/url\([^)]*\)/.test(css), 'includes url()');

    assert(
      await outputFS.exists(path.join(distDir, css.match(/url\(([^)]*)\)/)[1])),
      'path specified in url() exists',
    );
  });

  it('should minify CSS when minify is set', async function() {
    let b = await bundle(
      path.join(__dirname, '/integration/cssnano/index.js'),
      {
        minify: true,
      },
    );

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 3);

    let css = await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8');
    assert(css.includes('.local'));
    assert(css.includes('.index'));

    // TODO: Make this `2` when a `sourceMappingURL` is added
    assert.equal(css.split('\n').length, 1);
  });

  it('should inline data-urls for text-encoded files', async () => {
    await bundle(path.join(__dirname, '/integration/data-url/text.css'));
    let css = await outputFS.readFile(path.join(distDir, 'text.css'), 'utf8');
    assert.equal(
      css,
      `.svg-img {
  background-image: url('data:image/svg+xml,%3Csvg%3E%0A%0A%3C%2Fsvg%3E%0A');
}
`,
    );
  });

  it('should inline data-urls for binary files', async () => {
    await bundle(path.join(__dirname, '/integration/data-url/binary.css'));
    let css = await outputFS.readFile(path.join(distDir, 'binary.css'), 'utf8');
    assert(
      css.startsWith(`.webp-img {
  background-image: url('data:image/webp;base64,UklGR`),
    );
  });
});
