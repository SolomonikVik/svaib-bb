import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { isPiModelCredentialName, kimiPiRegistrationSchema, type KimiPiRegistration } from './kimi-pi-contract';

/** Only paths and launch arguments are persisted or registered. Never credentials. */
export type PiLaunch = KimiPiRegistration;
const names = ['PI_CODING_AGENT_DIR', 'BB_PI_BRIDGE_ARGS', 'BB_PI_BRIDGE_COMMAND'] as const;

export async function createKimiPiSupport(bb: BbPluginApi, hostId: string | null) {
  const key = 'kimi-pi-launch:v1:' + (hostId ?? 'unavailable');
  const saved = kimiPiRegistrationSchema.safeParse(await bb.storage.kv.get(key));
  let launch: PiLaunch | null = saved.success ? saved.data : null;
  const supported = typeof bb.sdk.system.machineEnvironment === 'function'
    && typeof bb.sdk.system.setMachineEnvironmentVariable === 'function';
  const note = (registration: PiLaunch) => `svaib Kimi/Pi ${registration.args[1]}`;
  async function preflight() {
    if (!hostId || !supported) throw new Error('PI_UNSUPPORTED');
    // The public environment API addresses the server machine, not an arbitrary host.
    if ((await bb.sdk.system.config()).primaryHostId !== hostId) throw new Error('PI_WRONG_HOST');
    if ((await bb.sdk.hosts.list()).some(host => host.id !== hostId)) throw new Error('PI_MULTIPLE_HOSTS');
    const environment = await bb.sdk.system.machineEnvironment();
    for (const variable of environment.variables) {
      if (!(names as readonly string[]).includes(variable.name)) continue;
      if (!launch || variable.note !== note(launch)) throw new Error('PI_FOREIGN_ENV');
    }
    return environment;
  }
  return {
    supported,
    owned: () => launch !== null,
    async managedActive() {
      const registration = launch;
      if (!registration) return false;
      const environment = await bb.sdk.system.machineEnvironment();
      return names.every(name => environment.variables.some(variable => variable.name === name && variable.note === note(registration)));
    },
    async nativePreflight() {
      if (!hostId || (await bb.sdk.system.config()).primaryHostId !== hostId) throw new Error('PI_WRONG_HOST');
      const environment = await bb.sdk.system.machineEnvironment();
      // Public reads hide values. Never guess the profile behind an operator override.
      if (environment.variables.some(variable => (names as readonly string[]).includes(variable.name))) throw new Error('PI_FOREIGN_ENV');
    },
    async nativeEnvironmentCredential() {
      return (await bb.sdk.system.machineEnvironment()).variables.some(variable => variable.name === 'KIMI_API_KEY');
    },
    async installNative() {
      await this.nativePreflight();
      if (!hostId || typeof bb.sdk.hosts.installProviderCli !== 'function') throw new Error('PI_NATIVE_INSTALL_UNAVAILABLE');
      // The official installer serializes its jobs. The caller verifies the
      // actual executable after this request, including an ambiguous Failed result.
      try { await bb.sdk.hosts.installProviderCli({ hostId, provider: 'pi', actionKind: 'install' }); }
      catch { /* A transport/installer error alone does not prove the CLI is absent. */ }
    },
    async hasExternalCredentials() {
      return (await bb.sdk.system.machineEnvironment()).variables.some(variable => isPiModelCredentialName(variable.name));
    },
    preflight,
    async activate(registration: PiLaunch) {
      const parsed = kimiPiRegistrationSchema.parse(registration);
      if (launch && launch.args[1] !== parsed.args[1]) throw new Error('PI_LAUNCH_CHANGED');
      const repairing = launch !== null && JSON.stringify(launch) !== JSON.stringify(parsed);
      await preflight();
      // Save ownership before the first setter. A restart between setters can
      // safely fill missing names without replacing any existing value.
      await bb.storage.kv.set(key, parsed); launch = parsed;
      const values = { PI_CODING_AGENT_DIR: parsed.agentDir,
        BB_PI_BRIDGE_ARGS: JSON.stringify(parsed.args), BB_PI_BRIDGE_COMMAND: parsed.command };
      let changed = false;
      // Commit the command last. Persisted launch plus matching ownership notes
      // permits explicit repair; operator variables still fail preflight.
      for (const name of names) {
        const current = await preflight();
        const missing = !current.variables.some(variable => variable.name === name);
        await bb.sdk.system.setMachineEnvironmentVariable({ name, value: values[name], note: note(parsed) });
        changed ||= repairing || missing;
      }
      const confirmed = await preflight();
      if (names.some(name => !confirmed.variables.some(variable => variable.name === name && variable.note === note(parsed)))) {
        throw new Error('PI_REGISTRATION_INCOMPLETE');
      }
      return { changed };
    },
  };
}
