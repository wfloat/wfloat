import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import React from 'react';
import {create, act} from 'react-test-renderer';
import {transformSync} from '@babel/core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const compiled = new Map();
const cards = [
  'BatteryChargeCard', 'BatteryTemperatureCard', 'SystemMemoryCard',
  'BatteryCurrentCard', 'ThreadCpuCard', 'ThreadCountCard', 'BatteryVoltageCard',
  'PageFaultsCard', 'MemoryUsageCard', 'FileDescriptorCard', 'CpuUsageCard',
  'CpuHeadroomCard', 'ThermalHeadroomCard', 'ContextSwitchCard', 'NetworkCard',
  'PowerMonitorsCard', 'BatteryRefreshProbe', 'StorageIoCard', 'FileFaultProbeControl',
];

// Render actual components with React's renderer. Native reads stay pending and
// timers are inert: isolate lifecycle synchronization rather than metric values.
function harness(platform, initialState) {
  const listeners = new Set(), cache = new Map(), calls = [];
  const appState = {
    currentState: initialState,
    addEventListener(event, fn) {
      assert.equal(event, 'change'); listeners.add(fn);
      return {remove: () => listeners.delete(fn)};
    },
  };
  const nativeModules = new Proxy({}, {get: (_, module) => new Proxy({}, {
    get: (_, method) => () => {calls.push(`${String(module)}.${String(method)}`); return new Promise(() => {});},
  })});
  const rn = {AppState: appState, NativeModules: nativeModules,
    Platform: {OS: platform, select: values => values[platform] ?? values.default},
    StyleSheet: {create: x => x}, Text: 'Text', View: 'View', Pressable: 'Pressable'};
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = {exports: {}}; cache.set(file, module);
    if (!compiled.has(file)) {
      const baseline = process.env.WFLOAT_FOREGROUND_BASELINE;
      const old = baseline && resolve(baseline, 'src', file.slice(file.lastIndexOf('/') + 1));
      const source = readFileSync(old && existsSync(old) ? old : file, 'utf8');
      compiled.set(file, transformSync(source, {filename: file, babelrc: false, configFile: false,
        presets: [require.resolve('@react-native/babel-preset')]}).code);
    }
    const localRequire = name => {
      if (name === 'react-native') return rn;
      if (!name.startsWith('.')) return require(name);
      const base = resolve(dirname(file), name);
      const target = [base, `${base}.ts`, `${base}.tsx`].find(existsSync);
      assert(target, `Cannot resolve ${name}`); return load(target);
    };
    new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', '__DEV__',
      compiled.get(file))(localRequire, module, module.exports, () => 1, () => {}, () => 1, () => {}, false);
    if (/\/(ThreadCpuCard|ThreadCountCard)\.tsx$/.test(file)) {
      const name = file.endsWith('ThreadCpuCard.tsx') ? 'ThreadCpuCard' : 'ThreadCountCard';
      const Component = module.exports[name];
      module.exports[name] = function SourceOwnedCard(props) {
        load(resolve(root, 'src/threadSources.ts')).useThreadSources(true);
        return React.createElement(Component, props);
      };
    }
    return module.exports;
  }
  return {appState, calls, listeners, load,
    change(state) {appState.currentState = state; for (const fn of listeners) fn(state);}};
}

function paused(tree, name) {
  if (name === 'FileFaultProbeControl')
    return tree.root.findByProps({testID: 'file-fault-probe'}).props.disabled;
  return JSON.stringify(tree.toJSON()).includes('Paused');
}
const props = {workloadRunning: false, onRunningChange: () => {}, onProbeRunningChange: () => {}};
for (const platform of ['ios', 'android']) {
  for (const name of cards) {
    test(`${platform} ${name}: reconcile render/effect state and follow background/resume`, async () => {
      const h = harness(platform, 'unknown');
      const component = h.load(resolve(root, 'src', `${name}.tsx`))[name === 'FileFaultProbeControl' ? 'FileFaultProbe' : name];
      // Change AppState after render, before passive effects attach.
      const tree = create(React.createElement(component, props));
      assert.equal(paused(tree, name), true);
      h.appState.currentState = 'active';
      try {
        await act(async () => {});
        assert.equal(paused(tree, name), false, 'stale Paused UI after foreground initialization');
        if (name === 'PowerMonitorsCard') {
          await act(async () => tree.root.findByProps({testID: 'read-energy-monitors'}).props.onPress());
          assert(h.calls.includes('BenchPowerMonitors.read'), 'on-demand lifecycle ref also needs reconciliation');
        }
        await act(async () => h.change('background'));
        assert.equal(paused(tree, name), true);
        await act(async () => h.change('active'));
        assert.equal(paused(tree, name), false);
      } finally {await act(async () => tree.unmount());}
      assert.equal(h.listeners.size, 0, 'listener removed on unmount');
    });
    test(`${platform} ${name}: background mount stays paused until activation`, async () => {
      const h = harness(platform, 'active');
      const component = h.load(resolve(root, 'src', `${name}.tsx`))[name === 'FileFaultProbeControl' ? 'FileFaultProbe' : name];
      const tree = create(React.createElement(component, props));
      h.appState.currentState = 'background';
      try {
        await act(async () => {});
        assert.equal(paused(tree, name), true, 'must not assume a foreground mount');
        assert.equal(h.calls.length, 0, 'no native request while backgrounded');
        await act(async () => h.change('active'));
        assert.equal(paused(tree, name), false);
      } finally {await act(async () => tree.unmount());}
      assert.equal(h.listeners.size, 0);
    });
  }
}
