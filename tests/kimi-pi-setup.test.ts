import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { registerKimiSetup } from '../kimi-setup';
import type { KimiView } from '../kimi-contract';

const hostId = 'host_fixture';
const registration = { command: '/owned/node', args: ['/owned/launch.mjs', 'b61583ad-e867-4cd1-a2c4-ed2696b21c9d'] as [string, string], agentDir: '/owned/agent' };
async function fixture(options: { external?: boolean; existingKimi?: boolean; conflict?: boolean; interrupt?: boolean; envAuth?: boolean; multipleHosts?: boolean; coldCatalogue?: boolean } = {}) {
  let prepared = false; let output = ''; let testId = 0; let stopped = 0; let catalogReads = 0;
  const environment = new Map<string, { value: string; note: string | null }>([['KEEP_ME', { value: 'existing-value', note: null }]]);
  if (options.conflict) environment.set('PI_CODING_AGENT_DIR', { value: '/external', note: null });
  if (options.envAuth) environment.set('KIMI_API_KEY', { value: 'synthetic-private-value', note: null });
  const f = createFakePluginHost({ pluginId: 'svaib-workplace', sdk: {
    system: {
      config: async () => ({ primaryHostId: hostId }) as never,
      machineEnvironment: async () => ({ variables: [...environment].map(([name, item]) => ({ name, note: item.note, value: null, secret: true })) }) as never,
      setMachineEnvironmentVariable: async ({ name, value, note }) => { environment.set(name, { value, note: note ?? null }); return { variables: [] } as never; },
    },
    hosts: { list: async () => [{ id: hostId }, ...(options.multipleHosts ? [{ id: 'remote' }] : [])] as never },
    providers: { models: async () => {
      const owned = environment.get('PI_CODING_AGENT_DIR')?.value === registration.agentDir
        && environment.get('BB_PI_BRIDGE_COMMAND')?.value === registration.command;
      if (owned && options.coldCatalogue && catalogReads++ === 0) return { modelLoadError: null, providers: [{ id: 'pi', available: true }], models: [] } as never;
      return { modelLoadError: null, providers: [{ id: 'pi', available: owned || !!options.existingKimi }],
        models: owned || options.existingKimi ? [
          { id: 'other/model', isDefault: true, routeProviderId: 'other' },
          { id: 'kimi-coding/k3.1-pro', routeProviderId: 'kimi-coding' },
        ] : [] } as never;
    } },
    plugins: { getSettings: async () => ({ schema: { customAgents: { type: 'string' } }, values: { customAgents: '[]' } }) as never },
    projects: { list: async () => [{ id: 'personal', kind: 'personal' }] as never,
      machineEnvironment: async () => ({ variables: [] }) as never },
    threads: {
      events: { list: async input => {
        if (input.types?.includes('client/turn/requested')) return [];
        assert.deepEqual(input.types, ['client/thread/start', 'client/turn/start', 'provider/modelFallback']); assert.equal(input.order, 'desc'); assert.equal(input.limit, '1');
        return [{ id: 'evt_sent', threadId: input.threadId, seq: 1, createdAt: Date.now(), scope: { kind: 'thread' }, type: 'client/turn/start',
          data: { direction: 'outbound', initiator: 'user', source: 'spawn', request: { method: 'turn/start', params: { options: { model: 'kimi-coding/k3.1-pro' } } } } }];
      } },
      spawn: async () => makeThreadResponse({ id: `thr_pi${++testId}`, providerId: 'pi', environmentId: 'env_fixture', originPluginId: 'svaib-workplace' }),
      get: async ({ threadId }) => makeThreadResponse({ id: threadId, status: output ? 'idle' : 'active', providerId: 'pi', environmentId: 'env_fixture', originPluginId: 'svaib-workplace' }),
      output: async () => ({ output }),
      stop: async () => { stopped++; return undefined as never; },
      delete: async () => undefined as never,
      list: async () => [],
    },
    environments: { get: async () => ({ hostId }) as never },
  }, experimental_callHostRpc: async ({ method }) => {
      if (method === 'runtimePrepare') return { platform: 'linux', status: 'ready', step: 'complete', message: '' };
    if (method === 'kimiPiInspect') return { profile: prepared ? 'ready' : 'absent', registration: prepared ? registration : null,
      needsKey: !prepared, hasExternalProfile: !!options.external };
    if (method === 'kimiPiPrepare') {
      prepared = true;
      if (options.interrupt) { options.interrupt = false; throw new Error('interrupted-after-key'); }
      return registration;
    }
    if (method === 'kimiInspect') return { nodeReady: false, nodeVersion: null, profile: 'absent', agent: null };
    throw new Error('Unexpected host method');
  } });
  const controller = await registerKimiSetup(f.bb, hostId);
  const call = (method: string, input: unknown = null) => f.harness.behavior.callRpc(method, input) as Promise<KimiView>;
  await call('kimiSelectPiMode', { mode: 'managed' });
  return { ...f, controller, call, environment, setConflict: () => { environment.set('PI_CODING_AGENT_DIR', { value: '/new-user-choice', note: null }); },
    setOutput: (value: string) => { output = value; }, spawned: () => testId, stopped: () => stopped };
}

test('Pi choice prepares a separate native profile, checks its actual model and persists no key', async t => {
  const f = await fixture(); t.after(() => f.harness.lifecycle.dispose());
  assert.equal((await f.call('kimiSelectHarness', { harness: 'pi' })).stage, 'key');
  assert.equal(f.spawned(), 0);
  await f.call('kimiStart', { apiKey: 'sk-kimi-synthetic-only' });
  await f.controller.settled();
  assert.equal((await f.call('kimiStatus')).stage, 'restart'); assert.equal(f.spawned(), 0);
  await f.call('kimiStart', {}); await f.controller.settled();
  const view = await f.call('kimiStatus');
  assert.equal(view.harness, 'pi'); assert.equal(view.verifyModel, 'kimi-coding/k3.1-pro');
  assert.equal(view.phase, 'check'); assert.equal(f.spawned(), 1);
  const [args] = f.harness.inspection.sdk.callsTo('threads.spawn')[0] as [{ providerId: string; model: string; permissionMode: string }];
  assert.equal(args.providerId, 'pi'); assert.equal(args.model, 'kimi-coding/k3.1-pro');
  assert.equal(args.permissionMode, 'full');
  const entries = await f.bb.storage.kv.list();
  const stored = await Promise.all(entries.map(key => f.bb.storage.kv.get(key)));
  assert.equal(JSON.stringify(stored).includes('sk-kimi-'), false);
  assert.equal(f.harness.inspection.sdk.callsTo('plugins.updateSettings').length, 0);
  f.setOutput('KIMI_READY');
  assert.equal((await f.call('kimiCheckResponse')).stage, 'complete');
  assert.deepEqual([...f.environment.keys()].sort(), ['KEEP_ME', 'BB_PI_BRIDGE_COMMAND', 'BB_PI_BRIDGE_ARGS', 'PI_CODING_AGENT_DIR'].sort());
  assert.equal(f.environment.get('KEEP_ME')?.value, 'existing-value');
  assert.equal(JSON.stringify([...f.environment]).includes('sk-kimi-'), false);
  assert.equal(f.harness.inspection.sdk.callsTo('system.setMachineEnvironmentVariable').length, 6, 'both explicit starts deterministically write only owned launch values');
  await f.call('kimiRecheck'); await f.controller.settled();
  assert.equal(f.harness.inspection.sdk.callsTo('system.setMachineEnvironmentVariable').length, 9, 'explicit repair deterministically restores only marker-owned values');
  f.setOutput('KIMI_READY'); await f.call('kimiCheckResponse');
  f.setConflict();
  await f.call('kimiRecheck'); await f.controller.settled();
  assert.equal(f.environment.get('PI_CODING_AGENT_DIR')?.value, '/new-user-choice');
  assert.equal(f.harness.inspection.sdk.callsTo('system.setMachineEnvironmentVariable').length, 9, 'operator-owned override is preserved');

});

test('selection survives reload without resuming a previous Pi check', async t => {
  const f = await fixture(); t.after(() => f.harness.lifecycle.dispose());
  await f.call('kimiOpen');
  await f.call('kimiSelectHarness', { harness: 'pi' });
  await f.call('kimiStart', { apiKey: 'sk-kimi-reload-synthetic' }); await f.controller.settled();
  await f.call('kimiStart', {}); await f.controller.settled();
  const before = await f.call('kimiStatus');
  const reload = await f.harness.lifecycle.reload(async bb => { await registerKimiSetup(bb, hostId); });
  t.after(() => reload.harness.lifecycle.dispose());
  const after = await reload.harness.behavior.callRpc('kimiStatus', null) as KimiView;
  assert.equal(after.harness, 'pi'); assert.equal(after.testThreadId, null); assert.equal(after.phase, null); assert.equal(f.spawned(), 1);
  f.setOutput('KIMI_READY');
  assert.notEqual((await reload.harness.behavior.callRpc('kimiCheckResponse', null) as KimiView).stage, 'complete');
  const cc = await reload.harness.behavior.callRpc('kimiSelectHarness', { harness: 'claude-code' }) as KimiView;
  assert.equal(cc.harness, 'claude-code'); assert.equal(cc.stage, 'key');
  assert.equal((await reload.harness.behavior.callRpc('kimiSelectHarness', { harness: 'pi' }) as KimiView).stage, 'verify');
  assert.equal(reload.harness.inspection.sdk.callsTo('threads.spawn').length, 0);
  assert.equal(reload.harness.experimental_hostRpcCalls.filter(call => call.method === 'kimiPiPrepare').length, 0);
});

test('existing native Kimi is verified without replacing its profile or asking for a key', async t => {
  const f = await fixture({ external: true, existingKimi: true }); t.after(() => f.harness.lifecycle.dispose());
  const view = await f.call('kimiSelectHarness', { harness: 'pi' });
  assert.equal(view.stage, 'verify'); assert.equal(view.canReplaceKey, false);
  assert.equal(f.harness.experimental_hostRpcCalls.filter(call => call.method === 'kimiPiPrepare').length, 0);
  assert.equal(f.harness.inspection.sdk.callsTo('system.setMachineEnvironmentVariable').length, 0);
  await f.call('kimiRecheck'); await f.controller.settled();
  assert.equal(f.spawned(), 1);
});

test('native Kimi authenticated by environment is preserved even without a profile file', async t => {
  const f = await fixture({ envAuth: true, existingKimi: true }); t.after(() => f.harness.lifecycle.dispose());
  assert.equal((await f.call('kimiSelectHarness', { harness: 'pi' })).stage, 'verify');
  await f.call('kimiRecheck'); await f.controller.settled();
  assert.equal(f.spawned(), 1);
  assert.equal(f.harness.inspection.sdk.callsTo('system.setMachineEnvironmentVariable').length, 0);
});

test('multiple enrolled computers cannot receive an absolute single-machine Pi launch', async t => {
  const f = await fixture({ multipleHosts: true }); t.after(() => f.harness.lifecycle.dispose());
  const view = await f.call('kimiSelectHarness', { harness: 'pi' });
  assert.equal(view.stage, 'blocked'); assert.match(view.message, /несколько компьютеров/);
  assert.equal(f.harness.inspection.sdk.callsTo('system.setMachineEnvironmentVariable').length, 0);
});

test('a cold cached empty native catalog is retried without asking for another installation', async t => {
  const f = await fixture({ coldCatalogue: true }); t.after(() => f.harness.lifecycle.dispose());
  await f.call('kimiSelectHarness', { harness: 'pi' });
  await f.call('kimiStart', { apiKey: 'sk-kimi-cold-synthetic' }); await f.controller.settled();
  assert.equal((await f.call('kimiStatus')).stage, 'restart');
  await f.call('kimiStart', {}); await f.controller.settled();
  assert.equal((await f.call('kimiStatus')).phase, 'check'); assert.equal(f.spawned(), 1);
  assert.equal(f.harness.experimental_hostRpcCalls.filter(call => call.method === 'kimiPiPrepare').length, 2);
});

test('external Pi settings and operator overrides block new provisioning and preserve the old profile', async t => {
  for (const options of [{ external: true }, { conflict: true }]) {
    const f = await fixture(options); t.after(() => f.harness.lifecycle.dispose());
    const view = await f.call('kimiSelectHarness', { harness: 'pi' });
    assert.equal(view.stage, 'blocked'); assert.match(view.message, /настройки|профиль/i);
    assert.equal(f.harness.experimental_hostRpcCalls.filter(call => call.method === 'kimiPiPrepare').length, 0);
    assert.equal(f.harness.inspection.sdk.callsTo('system.setMachineEnvironmentVariable').length, 0);
  }
});

test('interrupted preparation retries the committed profile without requesting a second key', async t => {
  const f = await fixture({ interrupt: true }); t.after(() => f.harness.lifecycle.dispose());
  await f.call('kimiSelectHarness', { harness: 'pi' });
  await f.call('kimiStart', { apiKey: 'sk-kimi-interrupted-synthetic' }); await f.controller.settled();
  assert.equal((await f.call('kimiStatus')).stage, 'registration');
  await f.call('kimiStart', {}); await f.controller.settled();
  assert.equal((await f.call('kimiStatus')).stage, 'restart');
  await f.call('kimiStart', {}); await f.controller.settled();
  assert.equal((await f.call('kimiStatus')).phase, 'check'); assert.equal(f.spawned(), 1);
});
