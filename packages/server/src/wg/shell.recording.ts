import type { WgHost, WgInterfaceDump } from './host';

/**
 * Test-only third adapter at the wg/shell seam (alongside shell.real.ts and shell.shim.ts -
 * see shell.ts's capability dispatcher). Behaves like the shim - no real network/nft changes,
 * no filesystem writes - but deterministically, and it keeps a log of every call, so tests can
 * assert *that* a mutation reloaded an interface or resynced the firewall rather than only
 * that the handler returned 200. Wired in via tests/setup.ts, which spreads `recordingHost`
 * over the mocked module, so its exports are derived from `WgHost` rather than re-declared -
 * a function added to the seam is recorded here without touching this file.
 */

/**
 * Every call goes through here, so nothing can be implemented-but-not-recorded: `fn` is a
 * `keyof WgHost` and the arguments are kept verbatim.
 */
export type RecordedCall = { [K in keyof WgHost]: { fn: K; args: Parameters<WgHost[K]> } }[keyof WgHost];

const calls: RecordedCall[] = [];
const upInterfaces = new Set<string>();
const configs = new Map<string, string>();
let lastAppliedRuleset: string | null = null;
let lastAppliedExitRouting: string[] | null = null;

/** The behaviour under the recorder: an in-memory host, deterministic so tests can assert on it. */
const base: WgHost = {
	wgGenKey: async () => 'mockedPrivateKey',
	wgGenPsk: async () => 'mockedPsk',
	wgDerivePublicKey: async (_privateKey: string) => 'mockedPublicKey',

	wgShow: async (_interfaceName: string): Promise<WgInterfaceDump | null> => ({
		interface: { privateKey: 'mockedPrivateKey', publicKey: 'mockedPublicKey', listenPort: 'mockedPort', fwmark: 'mockedFwmark' },
		peers: [],
	}),
	isInterfaceUp: async (interfaceName: string) => upInterfaces.has(interfaceName),
	listInterfaces: async () => [...upInterfaces],
	// The rendered config is recorded too - it is how tests assert what actually went onto an
	// interface (which peers a server's config carries, and that an exit link carries
	// 0.0.0.0/0) without a real wg to read it back from.
	startInterface: async (interfaceName: string, config: string) => {
		upInterfaces.add(interfaceName);
		configs.set(interfaceName, config);
	},
	reloadInterface: async (interfaceName: string, config: string) => {
		configs.set(interfaceName, config);
	},
	stopInterface: async (interfaceName: string) => {
		upInterfaces.delete(interfaceName);
		configs.delete(interfaceName);
	},
	applyExitRouting: async (commands: string[]) => {
		lastAppliedExitRouting = commands;
	},

	applyFirewall: async (ruleset: string) => {
		lastAppliedRuleset = ruleset;
	},
	resetFirewall: async () => {
		lastAppliedRuleset = null;
	},
};

/** Wraps every member of a host so that calling it appends to `calls` first. */
const recorded = (host: WgHost): WgHost =>
	Object.fromEntries(
		(Object.keys(host) as (keyof WgHost)[]).map((fn) => [
			fn,
			(...args: unknown[]) => {
				calls.push({ fn, args } as RecordedCall);
				return (host[fn] as (...a: unknown[]) => unknown)(...args);
			},
		]),
	) as WgHost;

export const recordingHost = recorded(base);

export const shellCallLog = {
	calls: () => [...calls],
	/** Every call whose first argument is this interface name, in order. */
	callsFor: (interfaceName: string) => calls.filter((c) => c.args[0] === interfaceName),
	/** Just the function names for one interface - the usual "did it start or reload?" question. */
	fnsFor: (interfaceName: string) => calls.filter((c) => c.args[0] === interfaceName).map((c) => c.fn),
	/** Just the function names, in call order. */
	fns: () => calls.map((c) => c.fn),
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
