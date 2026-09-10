import type { ServerPeer } from '@server/db/schema';

// Test-only third adapter at the wg/shell seam (alongside shell.real.ts and shell.shim.ts -
// see shell.ts's capability-detection dispatcher). Behaves like the shim (no real network/nft
// changes, no filesystem writes) but additionally keeps a call log and the last-applied
// firewall ruleset, so tests can assert *that* a mutation reloaded an interface or synced the
// firewall, not just that the handler returned 200. Wired in via tests/setup.ts's
// `mock.module('@server/wg/shell', ...)`, which replaces the whole module for every test - see
// CLAUDE.md's note on the wg/shell layer for why a function missing from an adapter here is
// `undefined` in every test.
export type RecordedCall =
	| { fn: 'startServer'; interfaceName: string }
	| { fn: 'reloadServer'; interfaceName: string }
	| { fn: 'stopServer'; interfaceName: string }
	| { fn: 'applyFirewall'; ruleset: string }
	| { fn: 'resetFirewall' }
	| { fn: 'applyExitRouting'; commands: string[] };

const calls: RecordedCall[] = [];
let lastAppliedRuleset: string | null = null;
let lastAppliedExitRouting: string[] | null = null;
const upInterfaces = new Set<string>();

export const shellCallLog = {
	calls: () => [...calls],
	callsFor: (interfaceName: string) => calls.filter((c) => 'interfaceName' in c && c.interfaceName === interfaceName),
	lastAppliedRuleset: () => lastAppliedRuleset,
	lastAppliedExitRouting: () => lastAppliedExitRouting,
	isUp: (interfaceName: string) => upInterfaces.has(interfaceName),
	// Tests share one process (see tests/setup.ts) - call this in beforeEach/afterEach to stop
	// one test's recorded calls leaking into the next.
	reset: () => {
		calls.length = 0;
		lastAppliedRuleset = null;
		lastAppliedExitRouting = null;
		upInterfaces.clear();
	},
};

export const cmd = async (command: string) => ({ stdout: '', stderr: '' });

export const wgGenKey = async () => 'mockedPrivateKey';
export const wgGenPsk = async () => 'mockedPsk';
export const wgDerivePublicKey = async (_privateKey: string) => 'mockedPublicKey';

export const wgShow = async (_interfaceName: string) => ({
	interface: { privateKey: 'mockedPrivateKey', publicKey: 'mockedPublicKey', listenPort: 'mockedPort', fwmark: 'mockedFwmark' },
	peers: [] as never[],
});

export const isInterfaceUp = async (interfaceName: string) => upInterfaces.has(interfaceName);

export const startServer = async (server: ServerPeer) => {
	upInterfaces.add(server.interfaceName);
	calls.push({ fn: 'startServer', interfaceName: server.interfaceName });
};

export const reloadServer = async (server: ServerPeer) => {
	calls.push({ fn: 'reloadServer', interfaceName: server.interfaceName });
};

export const stopServer = async (server: ServerPeer) => {
	upInterfaces.delete(server.interfaceName);
	calls.push({ fn: 'stopServer', interfaceName: server.interfaceName });
};

export const applyFirewall = async (ruleset: string) => {
	lastAppliedRuleset = ruleset;
	calls.push({ fn: 'applyFirewall', ruleset });
};

export const resetFirewall = async () => {
	lastAppliedRuleset = null;
	calls.push({ fn: 'resetFirewall' });
};

export const applyExitRouting = async (commands: string[]) => {
	lastAppliedExitRouting = commands;
	calls.push({ fn: 'applyExitRouting', commands });
};
