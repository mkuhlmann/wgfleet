// Test-only third adapter at the wg/shell seam (alongside shell.real.ts and shell.shim.ts -
// see shell.ts's capability-detection dispatcher). Behaves like the shim (no real network/nft
// changes, no filesystem writes) but additionally keeps a call log and the last-applied
// firewall ruleset, so tests can assert *that* a mutation reloaded an interface or synced the
// firewall, not just that the handler returned 200. Wired in via tests/setup.ts's
// `mock.module('@server/wg/shell', ...)`, which replaces the whole module for every test - see
// CLAUDE.md's note on the wg/shell layer for why a function missing from an adapter here is
// `undefined` in every test.
export type RecordedCall =
	| { fn: 'startInterface'; interfaceName: string }
	| { fn: 'reloadInterface'; interfaceName: string }
	| { fn: 'stopInterface'; interfaceName: string }
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
	configFor: (interfaceName: string) => configs.get(interfaceName) ?? null,
	upInterfaces: () => [...upInterfaces].sort(),
	// Tests share one process (see tests/setup.ts) - call this in beforeEach/afterEach to stop
	// one test's recorded calls leaking into the next.
	reset: () => {
		calls.length = 0;
		lastAppliedRuleset = null;
		lastAppliedExitRouting = null;
		upInterfaces.clear();
		configs.clear();
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

export const listInterfaces = async (): Promise<string[]> => [...upInterfaces];

export const isInterfaceUp = async (interfaceName: string) => upInterfaces.has(interfaceName);

// The rendered config is recorded too - it is how tests assert what actually went onto an
// interface (which peers a server's config carries, and that an exit link carries 0.0.0.0/0)
// without a real wg to read it back from.
const configs = new Map<string, string>();

export const startInterface = async (interfaceName: string, config: string) => {
	upInterfaces.add(interfaceName);
	configs.set(interfaceName, config);
	calls.push({ fn: 'startInterface', interfaceName });
};

export const reloadInterface = async (interfaceName: string, config: string) => {
	configs.set(interfaceName, config);
	calls.push({ fn: 'reloadInterface', interfaceName });
};

export const stopInterface = async (interfaceName: string) => {
	upInterfaces.delete(interfaceName);
	configs.delete(interfaceName);
	calls.push({ fn: 'stopInterface', interfaceName });
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
