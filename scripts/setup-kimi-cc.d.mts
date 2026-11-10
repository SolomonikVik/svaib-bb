import type { KimiAgent } from '../kimi-contract';
import type { KimiDiagnosticLog } from '../kimi-diagnostics';
type Install = (executable: string, args: string[], options?: object) => Promise<void>;
type DiscoveryOptions = { fetchImpl?: typeof fetch; signal?: AbortSignal; log?: KimiDiagnosticLog };
export const ADAPTER: string;
export function npmCliPath(nodeExecutable?: string): Promise<string>;
export function registration(root: string, executable?: string, legacy?: boolean | 'catalog'): KimiAgent;
export function provision(options: { root: string; apiKey: string; install?: Install; npmCli?: string; nodeExecutable?: string } & DiscoveryOptions): Promise<KimiAgent>;
export function resumeProvision(options: { root: string; install?: Install; npmCli?: string; nodeExecutable?: string } & DiscoveryOptions): Promise<KimiAgent>;

export const MODELS: string[][];
export function upgradeProvision(root: string, options?: DiscoveryOptions & { restrictContext?: boolean }): Promise<KimiAgent>;
export function validateProvision(root: string): Promise<{ catalog: { models: { id: string; context: number; retired: boolean }[] } }>;
