// @flow

import type {MutableAsset, PluginOptions} from '@parcel/types';

import * as types from '@babel/types';
import traverse from '@babel/traverse';
import {isURL, md5FromString, createDependencyLocation} from '@parcel/utils';
import {hasBinding, morph} from './utils';
import invariant from 'assert';

const serviceWorkerPattern = ['navigator', 'serviceWorker', 'register'];

export default ({
  ImportDeclaration(node, {asset}) {
    asset.meta.isES6Module = true;
    addDependency(asset, node.source);
  },

  ExportNamedDeclaration(node, {asset}) {
    asset.meta.isES6Module = true;
    if (node.source) {
      addDependency(asset, node.source);
    }
  },

  ExportAllDeclaration(node, {asset}) {
    asset.meta.isES6Module = true;
    addDependency(asset, node.source);
  },

  ExportDefaultDeclaration(node, {asset}) {
    asset.meta.isES6Module = true;
  },

  CallExpression(node, {asset}, ancestors) {
    let {callee, arguments: args} = node;

    let isRequire =
      types.isIdentifier(callee) &&
      callee.name === 'require' &&
      args.length === 1 &&
      types.isStringLiteral(args[0]) &&
      !hasBinding(ancestors, 'require') &&
      !isInFalsyBranch(ancestors);

    if (isRequire) {
      let isOptional =
        ancestors.some(a => types.isTryStatement(a)) || undefined;
      invariant(asset.ast);
      let isAsync = isRequireAsync(ancestors, node, asset.ast);
      addDependency(asset, args[0], {isOptional, isAsync});
      return;
    }

    let isDynamicImport =
      callee.type === 'Import' &&
      args.length === 1 &&
      types.isStringLiteral(args[0]);

    if (isDynamicImport) {
      // Ignore dynamic imports of fully specified urls
      if (isURL(args[0].value)) {
        return;
      }

      addDependency(asset, args[0], {isAsync: true});

      node.callee = types.identifier('require');
      invariant(asset.ast);
      asset.ast.isDirty = true;
      return;
    }

    let isRegisterServiceWorker =
      types.isStringLiteral(args[0]) &&
      types.matchesPattern(callee, serviceWorkerPattern) &&
      !hasBinding(ancestors, 'navigator') &&
      !isInFalsyBranch(ancestors);

    if (isRegisterServiceWorker) {
      // Treat service workers as an entry point so filenames remain consistent across builds.
      // https://developers.google.com/web/fundamentals/primers/service-workers/lifecycle#avoid_changing_the_url_of_your_service_worker_script
      addURLDependency(asset, args[0], {
        isEntry: true,
        env: {context: 'service-worker'},
      });
      return;
    }

    let isImportScripts =
      (asset.env.context === 'web-worker' ||
        asset.env.context === 'service-worker') &&
      callee.name === 'importScripts';

    if (isImportScripts) {
      for (let arg of args) {
        if (types.isStringLiteral(arg)) {
          addURLDependency(asset, arg);
        }
      }
      return;
    }
  },

  NewExpression(node, {asset, options}, ancestors) {
    let {callee, arguments: args} = node;

    let isWebWorker =
      callee.type === 'Identifier' &&
      (callee.name === 'Worker' || callee.name === 'SharedWorker') &&
      !hasBinding(ancestors, callee.name) &&
      !isInFalsyBranch(ancestors) &&
      types.isStringLiteral(args[0]) &&
      (args.length === 1 || args.length === 2);

    if (isWebWorker) {
      let isModule = false;
      if (types.isObjectExpression(args[1])) {
        let prop = args[1].properties.find(v =>
          types.isIdentifier(v.key, {name: 'type'}),
        );
        if (prop && types.isStringLiteral(prop.value))
          isModule = prop.value.value === 'module';
      }

      addURLDependency(asset, args[0], {
        env: {
          context: 'web-worker',
          outputFormat: isModule && options.scopeHoist ? 'esmodule' : undefined,
        },
      });
      return;
    }
  },
}: {
  [key: string]: (
    node: any,
    {|asset: MutableAsset, options: PluginOptions|},
    ancestors: Array<any>,
  ) => void,
  ...,
});

function isInFalsyBranch(ancestors) {
  // Check if any ancestors are if statements
  return ancestors.some((node, index) => {
    if (types.isIfStatement(node)) {
      let res = evaluateExpression(node.test);
      if (res && res.confident) {
        // If the test is truthy, exclude the dep if it is in the alternate branch.
        // If the test if falsy, exclude the dep if it is in the consequent branch.
        let child = ancestors[index + 1];
        return res.value ? child === node.alternate : child === node.consequent;
      }
    }
  });
}

function evaluateExpression(node) {
  // Wrap the node in a standalone program so we can traverse it
  node = types.file(types.program([types.expressionStatement(node)]));

  // Find the first expression and evaluate it.
  let res = null;
  traverse(node, {
    Expression(path) {
      res = path.evaluate();
      path.stop();
    },
  });

  return res;
}

// TypeScript, Rollup, and Parcel itself generate these patterns for async imports in CommonJS
//   1. TypeScript - Promise.resolve().then(function () { return require(...) })
//   2. Rollup - new Promise(function (resolve) { resolve(require(...)) })
//   3. Parcel - Promise.resolve(require(...))
function isRequireAsync(ancestors, requireNode, ast) {
  let parent = ancestors[ancestors.length - 2];

  // Promise.resolve().then(() => require('foo'))
  // Promise.resolve().then(() => { return require('foo') })
  // Promise.resolve().then(function () { return require('foo') })
  let functionParent = getFunctionParent(ancestors);
  if (
    functionParent &&
    types.isCallExpression(functionParent) &&
    types.isMemberExpression(functionParent.callee) &&
    functionParent.callee.property.name === 'then' &&
    isPromiseResolve(functionParent.callee.object)
  ) {
    // If the `require` call is not immediately returned (e.g. wrapped in another function),
    // then transform the AST to create a promise chain so that the require is by itself.
    // This is because the require will return a promise rather than the module synchronously.
    // For example, TypeScript generates the following with the esModuleInterop flag:
    //   Promise.resolve().then(() => __importStar(require('./foo')));
    // This is transformed into:
    //   Promise.resolve().then(() => require('./foo')).then(res => __importStar(res));
    if (
      !types.isArrowFunctionExpression(parent) &&
      !types.isReturnStatement(parent)
    ) {
      // Replace the original `require` call with a reference to a variable
      let requireClone = types.clone(requireNode);
      let v = types.identifier(
        '$parcel$' + md5FromString(requireNode.arguments[0].value).slice(-4),
      );
      morph(requireNode, v);

      // Add the variable as a param to the parent function
      let fn = functionParent.arguments[0];
      fn.params[0] = v;

      // Replace original function with only the require call
      functionParent.arguments[0] = types.isArrowFunctionExpression(fn)
        ? types.arrowFunctionExpression([], requireClone)
        : types.functionExpression(
            null,
            [],
            types.blockStatement([types.returnStatement(requireClone)]),
          );

      // Add the original function as an additional promise chain
      let replacement = types.callExpression(
        types.memberExpression(
          types.clone(functionParent),
          types.identifier('then'),
        ),
        [fn],
      );

      morph(functionParent, replacement);
      ast.isDirty = true;
    }

    return true;
  }

  // Promise.resolve(require('foo'))
  if (isPromiseResolve(parent) && parent.arguments[0] === requireNode) {
    return true;
  }

  // new Promise(resolve => resolve(require('foo')))
  // new Promise(resolve => { resolve(require('foo')) })
  // new Promise(function (resolve) { resolve(require('foo')) })
  if (
    functionParent &&
    types.isCallExpression(parent) &&
    types.isIdentifier(parent.callee) &&
    types.isNewExpression(functionParent) &&
    types.isIdentifier(functionParent.callee) &&
    functionParent.callee.name === 'Promise' &&
    types.isFunction(functionParent.arguments[0]) &&
    types.isIdentifier(functionParent.arguments[0].params[0]) &&
    parent.callee.name === functionParent.arguments[0].params[0].name
  ) {
    return true;
  }
}

function isPromiseResolve(node) {
  return (
    types.isCallExpression(node) &&
    types.isMemberExpression(node.callee) &&
    types.isIdentifier(node.callee.object) &&
    node.callee.object.name === 'Promise' &&
    node.callee.property.name === 'resolve'
  );
}

function getFunctionParent(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (types.isFunction(ancestors[i])) {
      return ancestors[i - 1];
    }
  }
}

function addDependency(
  asset,
  node,
  opts: ?{|isAsync?: boolean, isOptional?: boolean|},
) {
  asset.addDependency({
    moduleSpecifier: node.value,
    loc: node.loc && createDependencyLocation(node.loc.start, node.value, 0, 1),
    isAsync: opts ? opts.isAsync : false,
    isOptional: opts ? opts.isOptional : false,
  });
}

function addURLDependency(asset, node, opts = {}) {
  node.value = asset.addURLDependency(node.value, {
    loc: node.loc && createDependencyLocation(node.loc.start, node.value, 0, 1),
    ...opts,
  });
  invariant(asset.ast);
  asset.ast.isDirty = true;
}
