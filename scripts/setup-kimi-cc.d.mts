import type { KimiAgent } from '../kimi-contract';
type Install = (executable: string, args: string[], options?: object) => Promise<void>;
export const ADAPTER: string;
export function npmCliPath(nodeExecutable?: string): Promise<string>;
export function registration(root: string, executable?: string): KimiAgent;
export function provision(options: { root: string; apiKey: string; install?: Install; npmCli?: string; nodeExecutable?: string }): Promise<KimiAgent>;
export function resumeProvision(options: { root: string; install?: Install; npmCli?: string }): Promise<KimiAgent>;
