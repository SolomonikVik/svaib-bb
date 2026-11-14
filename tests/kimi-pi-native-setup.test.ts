import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { registerKimiSetup } from '../kimi-setup';
import type { KimiView } from '../kimi-contract';

const hostId = 'host_native';
const registration = { command: '/native/pi', args: [], agentDir: '/user/.pi/agent' };
async function fixture(options: { absent?: boolean; credential?: boolean; environmentKey?: boolean; interrupt?: boolean; installFails?: boolean; foreignEnv?: boolean; wrongModel?: boolean; missingModel?: boolean; fallback?: boolean; initialEvent?: boolean; requestedEvent?: boolean; unaccepted?: boolean; otherTurn?: boolean; raceOnOutput?: boolean; activeOnEvent?: boolean; catalogTimeoutOnce?: boolean } = {}) {
  let installed = !options.absent, credential = !!options.credential, owned = false, output = '';
  let installs = 0, spawns = 0, eventSeq = 1, becameActive = false;
  const env = [
    { name: 'KEEP_ME', value: null, note: null, secret: true },
    ...(options.environmentKey ? [{ name: 'KIMI_API_KEY', value: null, note: null, secret: true }] : []),
    ...(options.foreignEnv ? [{ name: 'PI_CODING_AGENT_DIR', value: null, note: null, secret: true }] : []),
  ];
  const f = createFakePluginHost({ pluginId: 'svaib-workplace', sdk: {
    system: { config: async () => ({ primaryHostId: hostId }) as never, machineEnvironment: async () => ({ variables: env }) as never },
    hosts: {
      list: async () => [{ id: hostId }, { id: 'another_computer' }] as never,
      installProviderCli: async input => { assert.deepEqual(input, { hostId, provider: 'pi', actionKind: 'install' }); installs++; installed = !options.installFails; return [] as never; },
    },
    projects: { list: async () => [{ id: 'personal', kind: 'personal' }] as never },
    providers: { models: async () => {
      if (options.catalogTimeoutOnce) { options.catalogTimeoutOnce = false; throw new Error('BB timeout'); }
      return { modelLoadError: null, providers: [{ id: 'pi', available: installed }], models: installed && (credential || options.environmentKey) ? [{ id: 'kimi-coding/k3.1-pro', routeProviderId: 'kimi-coding' }] : [] } as never;
    } },
    threads: {
      events: { list: async input => {
        if (options.activeOnEvent) becameActive = true;
        if (input.types?.includes('turn/input/accepted')) return [{ id: 'evt_accepted', threadId: input.threadId, seq: 2, createdAt: Date.now(), scope: { kind: 'turn', turnId: 'turn_fixture' }, type: 'turn/input/accepted', data: { providerThreadId: 'pi_fixture', clientRequestId: options.unaccepted ? 'other_request' : 'request_' + eventSeq } }];
        if (input.types?.includes('turn/completed')) return [{ id: 'evt_complete', threadId: input.threadId, seq: 3, createdAt: Date.now(), scope: { kind: 'turn', turnId: options.otherTurn ? 'other_turn' : 'turn_fixture' }, type: 'turn/completed', data: { providerThreadId: 'pi_fixture', status: 'completed' } }];
        if (input.types?.includes('client/turn/requested')) {
          assert.deepEqual(input.types, ['client/turn/requested', 'provider/modelFallback']);
          assert.equal(input.order, 'desc'); assert.equal(input.limit, '1');
          if (options.requestedEvent && !options.fallback) return [{ id: 'evt_requested_' + eventSeq, threadId: input.threadId, seq: eventSeq, createdAt: Date.now(), scope: { kind: 'thread' }, type: 'client/turn/requested',
            data: { direction: 'outbound', source: 'spawn', initiator: 'user', requestId: 'request_' + eventSeq, request: { method: 'thread/start', params: {} }, execution: { model: options.missingModel ? '' : options.wrongModel ? 'other/model' : 'kimi-coding/k3.1-pro', source: 'client/turn/requested' } } }] as never;
          if (!options.fallback) return [];
        } else {
        assert.deepEqual(input.types, ['client/thread/start', 'client/turn/start', 'provider/modelFallback']); assert.equal(input.order, 'desc'); assert.equal(input.limit, '1');
        }
        if (options.activeOnEvent) becameActive = true;
        if (options.fallback) return [{ id: 'evt_fallback', threadId: input.threadId, seq: 2, createdAt: Date.now(), scope: { kind: 'thread' }, type: 'provider/modelFallback', data: { providerThreadId: 'pi_fixture', originalModel: 'kimi-coding/k3.1-pro', fallbackModel: 'other/model', reason: 'provider', message: 'fixture fallback' } }];
        return [{ id: 'evt_sent_' + eventSeq, threadId: input.threadId, seq: eventSeq, createdAt: Date.now(), scope: { kind: 'thread' }, type: options.initialEvent ? 'client/thread/start' : 'client/turn/start',
          data: { direction: 'outbound', initiator: 'user', source: 'spawn', request: { method: options.initialEvent ? 'thread/start' : 'turn/start', params: options.requestedEvent ? {} : { options: options.missingModel ? {} : { model: options.wrongModel ? 'other/model' : 'kimi-coding/k3.1-pro' } } } } }];
      } },
      spawn: async input => { assert.equal(input.providerId, 'pi'); spawns++; return makeThreadResponse({ id: 'thr_native_check', providerId: 'pi', environmentId: 'env_native', originPluginId: 'svaib-workplace' }); },
      get: async ({ threadId }) => makeThreadResponse({ id: threadId, status: output && !becameActive ? 'idle' : 'active', providerId: 'pi', environmentId: 'env_native', originPluginId: 'svaib-workplace' }),
      output: async () => { if (options.raceOnOutput) eventSeq++; return { output }; }, stop: async () => undefined as never, delete: async () => undefined as never, list: async () => [],
    },
    environments: { get: async () => ({ hostId }) as never },
  }, experimental_callHostRpc: async ({ method, input }) => {
    if (method === 'runtimePrepare') return { platform: 'linux', status: 'ready', step: 'complete', message: '' };
    if (method === 'kimiPiNativePrerequisites') { assert.equal(installs, 0); return null; }
    if (method === 'kimiPiNativeInspect') return { installed, registration: installed ? registration : null, profile: credential ? 'ready' : 'absent', hasCredential: credential, canReplaceKey: owned };
    if (method === 'kimiPiNativePrepare') {
      const key = (input as { apiKey?: string }).apiKey;
      if (key) { credential = true; owned = true; }
      if (options.interrupt) { options.interrupt = false; throw new Error('after-commit'); }
      return registration;
    }
    if (method === 'kimiPiInspect') return { profile: 'absent', registration: null, needsKey: true, hasExternalProfile: false };
    if (method === 'kimiInspect') return { nodeReady: false, nodeVersion: null, profile: 'absent', agent: null };
    throw new Error('Unexpected host method');
  } });
  const controller = await registerKimiSetup(f.bb, hostId);
  const call = (name: string, input: unknown = null) => f.harness.behavior.callRpc(name, input) as Promise<KimiView>;
  return { ...f, controller, call, installs: () => installs, spawns: () => spawns, answer: () => { output = 'KIMI_READY'; } };
}

test('default Pi configures the existing native profile without global env, second installation or restart', async t => {
  const f = await fixture(); t.after(() => f.harness.lifecycle.dispose());
  const chosen = await f.call('kimiSelectHarness', { harness: 'pi' });
  assert.equal(chosen.piMode, 'native'); assert.equal(chosen.stage, 'key');
  await Promise.all([f.call('kimiStart', { apiKey: 'sk-kimi-native-synthetic' }), f.call('kimiStart', { apiKey: 'sk-kimi-native-synthetic' })]);
  await f.controller.settled();
  const view = await f.call('kimiStatus');
  assert.equal(view.phase, 'check'); assert.equal(f.spawns(), 1); assert.equal(f.installs(), 0);
  assert.equal(f.harness.inspection.sdk.callsTo('system.setMachineEnvironmentVariable').length, 0);
  assert.equal(f.harness.inspection.sdk.callsTo('hosts.list').length, 0, 'other enrolled hosts do not block a local profile update');
  assert.equal(f.harness.experimental_hostRpcCalls.some(call => call.method === 'kimiPiPrepare'), false);
  const stored = await Promise.all((await f.bb.storage.kv.list()).map(key => f.bb.storage.kv.get(key)));
  assert.equal(JSON.stringify(stored).includes('sk-kimi-'), false);
  f.answer(); assert.equal((await f.call('kimiCheckResponse')).stage, 'complete');
  const runtime = await f.harness.behavior.callRpc('kimiPiRuntime', null) as { mode: string; registration: unknown };
  assert.equal(runtime.mode, 'native'); assert.deepEqual(runtime.registration, registration);
});

test('absent native Pi is installed through BB before the protected key step', async t => {
  const f = await fixture({ absent: true }); t.after(() => f.harness.lifecycle.dispose());
  assert.equal((await f.call('kimiSelectHarness', { harness: 'pi' })).stage, 'registration');
  await f.call('kimiStart', {}); await f.controller.settled();
  assert.equal((await f.call('kimiStatus')).stage, 'key'); assert.equal(f.installs(), 1); assert.equal(f.spawns(), 0);
  assert.equal(f.harness.experimental_hostRpcCalls.filter(call => call.method === 'kimiPiNativePrerequisites').length, 1);
  await f.call('kimiStart', { apiKey: 'sk-kimi-installed-synthetic' }); await f.controller.settled();
  assert.equal((await f.call('kimiStatus')).phase, 'check'); assert.equal(f.installs(), 1);
  assert.equal(f.harness.experimental_hostRpcCalls.filter(call => call.method === 'kimiPiNativePrerequisites').length, 1, 'ready Pi never reinstalls prerequisites');
});

test('the Pi verification chat uses the permission mode supported by native Pi', async t => {
  const f = await fixture({ credential: true }); t.after(() => f.harness.lifecycle.dispose());
  await f.call('kimiSelectHarness', { harness: 'pi' });
  await f.call('kimiStart', {}); await f.controller.settled();
  const [request] = f.harness.inspection.sdk.callsTo('threads.spawn')[0] as [{ permissionMode: string }];
  assert.equal(request.permissionMode, 'full');
});

test('native Pi keeps waiting after a cold catalogue lookup times out once', async t => {
  const f = await fixture({ catalogTimeoutOnce: true }); t.after(() => f.harness.lifecycle.dispose());
  await f.call('kimiSelectHarness', { harness: 'pi' });
  await f.call('kimiStart', { apiKey: 'sk-kimi-cold-synthetic' }); await f.controller.settled();
  assert.equal((await f.call('kimiStatus')).phase, 'check');
  assert.equal(f.spawns(), 1);
  assert.ok(f.harness.inspection.sdk.callsTo('providers.models').length >= 2);
});

test('working native OAuth or environment key is verified without credential replacement', async t => {
  for (const options of [{ credential: true }, { environmentKey: true }]) {
    const f = await fixture(options); t.after(() => f.harness.lifecycle.dispose());
    assert.equal((await f.call('kimiSelectHarness', { harness: 'pi' })).stage, 'verify');
    await f.call('kimiRecheck'); await f.controller.settled();
    assert.equal(f.spawns(), 1); assert.equal(f.installs(), 0);
    assert.equal(f.harness.experimental_hostRpcCalls.some(call => (call.input as { apiKey?: string })?.apiKey), false);
    assert.equal((await f.call('kimiStatus')).canReplaceKey, false);
  }
});

test('interruption after native key commit resumes without asking for a second key', async t => {
  const f = await fixture({ interrupt: true }); t.after(() => f.harness.lifecycle.dispose());
  await f.call('kimiSelectHarness', { harness: 'pi' });
  await f.call('kimiStart', { apiKey: 'sk-kimi-resume-synthetic' }); await f.controller.settled();
  assert.equal((await f.call('kimiStatus')).stage, 'registration');
  await f.call('kimiStart', {}); await f.controller.settled();
  assert.equal((await f.call('kimiStatus')).phase, 'check'); assert.equal(f.installs(), 0);
  const calls = f.harness.experimental_hostRpcCalls.filter(call => call.method === 'kimiPiNativePrepare');
  assert.equal((calls[1].input as { apiKey?: string }).apiKey, undefined);
});

test('isolated installation is an explicit fallback and retains its own multi-host guard', async t => {
  const f = await fixture({ absent: true, installFails: true }); t.after(() => f.harness.lifecycle.dispose());
  await f.call('kimiSelectHarness', { harness: 'pi' });
  await f.call('kimiStart', {}); await f.controller.settled();
  assert.equal((await f.call('kimiStatus')).piMode, 'native');
  const fallback = await f.call('kimiSelectPiMode', { mode: 'managed' });
  assert.equal(fallback.piMode, 'managed'); assert.equal(fallback.stage, 'blocked'); assert.match(fallback.message, /несколько компьютеров/);
  assert.equal(f.harness.inspection.sdk.callsTo('system.setMachineEnvironmentVariable').length, 0);
});


test('another Pi model cannot confirm Kimi with the same response', async t => {
  const f = await fixture({ credential: true, wrongModel: true }); t.after(() => f.harness.lifecycle.dispose());
  await f.call('kimiSelectHarness', { harness: 'pi' });
  await f.call('kimiStart', {}); await f.controller.settled();
  f.answer();
  const view = await f.call('kimiCheckResponse');
  assert.equal(view.stage, 'verify'); assert.equal(view.hidden, false);
  assert.match(view.message, /модель Kimi/);
});


test('missing outbound model or a provider fallback cannot confirm Kimi', async t => {
  for (const options of [{ missingModel: true }, { fallback: true }]) {
    const f = await fixture({ credential: true, ...options }); t.after(() => f.harness.lifecycle.dispose());
    await f.call('kimiSelectHarness', { harness: 'pi' }); await f.call('kimiStart', {}); await f.controller.settled();
    f.answer(); assert.equal((await f.call('kimiCheckResponse')).stage, 'verify');
  }
});

test('the first outbound thread/start also proves the Kimi model', async t => {
  const f = await fixture({ credential: true, initialEvent: true }); t.after(() => f.harness.lifecycle.dispose());
  await f.call('kimiSelectHarness', { harness: 'pi' }); await f.call('kimiStart', {}); await f.controller.settled();
  f.answer(); assert.equal((await f.call('kimiCheckResponse')).stage, 'complete');
});

test('BB resolved execution proves the model when thread/start has empty params', async t => {
  const f = await fixture({ credential: true, requestedEvent: true }); t.after(() => f.harness.lifecycle.dispose());
  await f.call('kimiSelectHarness', { harness: 'pi' }); await f.call('kimiStart', {}); await f.controller.settled();
  f.answer(); assert.equal((await f.call('kimiCheckResponse')).stage, 'complete');
});

test('resolved execution still rejects a different model, fallback, unmatched acceptance or changed turn', async t => {
  for (const options of [{ wrongModel: true }, { fallback: true }, { unaccepted: true }, { otherTurn: true }, { raceOnOutput: true }, { activeOnEvent: true }]) {
    const f = await fixture({ credential: true, requestedEvent: true, ...options }); t.after(() => f.harness.lifecycle.dispose());
    await f.call('kimiSelectHarness', { harness: 'pi' }); await f.call('kimiStart', {}); await f.controller.settled();
    f.answer(); assert.equal((await f.call('kimiCheckResponse')).stage, 'verify');
  }
});


test('a turn starting during verification cannot reuse an older response', async t => {
  for (const options of [{ raceOnOutput: true }, { activeOnEvent: true }]) {
    const f = await fixture({ credential: true, ...options }); t.after(() => f.harness.lifecycle.dispose());
    await f.call('kimiSelectHarness', { harness: 'pi' }); await f.call('kimiStart', {}); await f.controller.settled();
    f.answer(); assert.equal((await f.call('kimiCheckResponse')).stage, 'verify');
  }
});
