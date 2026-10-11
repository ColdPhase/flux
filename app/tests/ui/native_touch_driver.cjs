'use strict';
// TEST ONLY, pinned Python Playwright 1.62.0 driver. No server or general protocol forwarding.
const fs = require('node:fs');
const path = require('node:path');

const COMMAND = 'fluxNativeTouch';
const fail = message => { throw new Error('FLUX_NATIVE_TOUCH_UNSUPPORTED: ' + message); };
const packageDir = process.env.FLUX_UI_PW_DRIVER_PACKAGE;
if (process.env.FLUX_UI_NATIVE_TOUCH_RPC !== '1' || !packageDir)
  fail('the matched UI helper must explicitly enable this driver extension');
if (path.resolve(process.argv[1] || '') !== path.join(packageDir, 'cli.js') || process.argv[2] !== 'run-driver')
  fail('only the matched Python stdio driver can load this extension');
const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json')));
const browsers = JSON.parse(fs.readFileSync(path.join(packageDir, 'browsers.json')));
const webkit = browsers.browsers.find(browser => browser.name === 'webkit');
if (pkg.version !== '1.62.0' || webkit?.revision !== '2336' || webkit?.browserVersion !== '26.5')
  fail('requires Playwright 1.62.0 and Linux WebKit 26.5/rev2336');
require(path.join(packageDir, 'lib/bootstrap'));
const { DispatcherConnection } = require(path.join(packageDir, 'lib/coreBundle')).server;
if (typeof DispatcherConnection?.prototype?.dispatch !== 'function')
  fail('the pinned driver dispatcher is unavailable');
const originalDispatch = DispatcherConnection.prototype.dispatch;
const active = new WeakMap();
const pending = new WeakSet();
const objectWithKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

DispatcherConnection.prototype.dispatch = async function (message) {
  if (message?.method !== COMMAND) return originalDispatch.call(this, message);
  const { id, guid, params } = message;
  let page;
  let entered = false;
  try {
    if (!Number.isSafeInteger(id) || id <= 0 || typeof guid !== 'string') fail('invalid request id or page GUID');
    if (!objectWithKeys(params, ['type', 'point'])
      || !['touchStart', 'touchMove', 'touchEnd', 'touchCancel'].includes(params.type)
      || !objectWithKeys(params.point, ['x', 'y', 'id'])) fail('only a typed single-point native touch is accepted');
    const point = params.point;
    if (![point.x, point.y, point.id].every(Number.isSafeInteger) || point.id < 1 || point.id > 2147483647)
      fail('native points require integer CSS coordinates and a positive bounded id');
    if (typeof this._dispatcherByGuid?.get !== 'function') fail('the pinned page-dispatcher map is unavailable');
    const dispatcher = this._dispatcherByGuid.get(guid);
    if (dispatcher?._type !== 'Page') fail('the original Python Page GUID is unavailable');
    page = dispatcher._object;
    const options = page.browserContext?._options;
    const browserOptions = page.browserContext?._browser?.options;
    if (browserOptions?.browserType !== 'webkit' || browserOptions.customExecutablePath
      || options?.hasTouch !== true || options?.isMobile !== true) fail('requires the matched native phone WebKit page');
    if (!options.viewport || point.x < 0 || point.x > options.viewport.width || point.y < 0 || point.y > options.viewport.height)
      fail('the native point must lie inside this page viewport');
    if (typeof page.isClosedOrClosingOrCrashed !== 'function' || page.isClosedOrClosingOrCrashed()) fail('the product page is closed');
    const native = page.delegate?._pageProxySession;
    if (typeof native?.send !== 'function') fail('the pinned native WebKit page session is unavailable');
    if (pending.has(page)) fail('a native input command is already pending on this page');
    const previous = active.get(page);
    if (params.type === 'touchStart' ? !!previous : !previous || previous.id !== point.id)
      fail('native touch must start once and keep its id through move/end');
    if (['touchEnd', 'touchCancel'].includes(params.type)
      && (previous.x !== point.x || previous.y !== point.y)) fail('release must retain the final native point');
    pending.add(page);
    entered = true;
    await native.send('Input.dispatchTouchEvent', { type: params.type, modifiers: 0, touchPoints: [point] });
    if (this._dispatcherByGuid.get(guid) !== dispatcher) fail('the original product page closed during native input');
    if (params.type === 'touchEnd' || params.type === 'touchCancel') active.delete(page);
    else active.set(page, { ...point });
    this.onmessage({ id, result: { pageGuid: guid, transport: 'webkit-native', version: pkg.version, revision: webkit.revision } });
  } catch (error) {
    if (entered) active.delete(page);
    // Matches pinned server/errors.ts SerializedError; never print on the framed protocol stdout.
    this.onmessage({ id, error: { error: { name: error.name, message: error.message, stack: error.stack } } });
  } finally {
    if (entered) pending.delete(page);
  }
};
