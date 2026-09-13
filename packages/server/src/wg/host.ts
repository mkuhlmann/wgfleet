/**
 * The interface every adapter at the wg/shell seam implements - the one place the set of
 * things this manager can ask of its host is written down.
 *
 * There are three adapters (shell.real.ts, shell.shim.ts, shell.recording.ts) and the names
 * used to be re-declared in each of them plus the dispatcher, with nothing linking the four
 * lists: adding a function meant editing four files, and forgetting one left it `undefined` in
 * every test. `WgHost` replaces that rule with a type - shell.ts assigns each adapter's module
 * namespace to it, so a missing or mistyped member is a compile error rather than a runtime
 * `undefined`.
 *
 * Only the capability-gated surface belongs here. `cmd()` (shell.real.ts) is an implementation
 * detail of the real adapter, not something a caller may reach for.
 */

/** One peer's line in `wg show <iface> dump`. */
export type WgPeerDump = {
	publicKey: string;
	presharedKey: string;
	endpoint: string;
	allowedIps: string;
	latestHandshake: number;
	transferRx: number;
	transferTx: number;
	persistentKeepalive: string;
};

/** A whole `wg show <iface> dump`, or null when the interface is not up. */
export type WgInterfaceDump = {
	interface: { privateKey: string; publicKey: string; listenPort: string; fwmark: string };
	peers: WgPeerDump[];
};

/** Key material. Needs the `wg` binary, but no privileges. */
export type WgCrypto = {
	wgGenKey(): Promise<string>;
	wgGenPsk(): Promise<string>;
	wgDerivePublicKey(privateKey: string): Promise<string>;
};

/** Interfaces and routing. Needs `wg-quick`/`ip` *and* NET_ADMIN. */
export type WgNetwork = {
	wgShow(interfaceName: string): Promise<WgInterfaceDump | null>;
	/**
	 * Whether a wireguard interface of exactly this name exists. Exact, never a substring
	 * match: converge() picks start-vs-reload from this answer, and reloading is a
	 * `wg syncconf`, which applies the peers but not the `[Interface]` half - so a false
	 * positive silently leaves an interface running the wrong key and port.
	 */
	isInterfaceUp(interfaceName: string): Promise<boolean>;
	/** Every wireguard interface on the host, whoever created it. */
	listInterfaces(): Promise<string[]>;
	startInterface(interfaceName: string, config: string): Promise<void>;
	reloadInterface(interfaceName: string, config: string): Promise<void>;
	stopInterface(interfaceName: string): Promise<void>;
	applyExitRouting(commands: string[]): Promise<void>;
};

/** The nft ruleset. Needs `nft` *and* NET_ADMIN. */
export type WgFirewall = {
	applyFirewall(ruleset: string): Promise<void>;
	resetFirewall(): Promise<void>;
};

export type WgHost = WgCrypto & WgNetwork & WgFirewall;

export type Capabilities = { crypto: boolean; network: boolean; firewall: boolean };

export const CRYPTO_FNS = ['wgGenKey', 'wgGenPsk', 'wgDerivePublicKey'] as const satisfies readonly (keyof WgCrypto)[];
// `applyExitRouting` is network, not firewall: exit routing is pure `ip rule`/`ip route` and
// must not depend on nft being available - see the rejected-alternative note in exitRouting.ts.
export const NETWORK_FNS = ['wgShow', 'isInterfaceUp', 'listInterfaces', 'startInterface', 'reloadInterface', 'stopInterface', 'applyExitRouting'] as const satisfies readonly (keyof WgNetwork)[];
export const FIREWALL_FNS = ['applyFirewall', 'resetFirewall'] as const satisfies readonly (keyof WgFirewall)[];

/**
 * Picks one adapter per capability axis, member by member. Pure: the probing that produces
 * `capabilities` is io (probeCapabilities below), deciding what to do about it is not, and
 * keeping them apart is what makes the decision testable at all - the dispatcher used to run
 * the probe at import time under a top-level `await`, so none of this was reachable from a test.
 */
export const chooseHost = (capabilities: Capabilities, real: WgHost, shim: WgHost): WgHost => {
	const pick = <K extends keyof WgHost>(available: boolean, fn: K): WgHost[K] => (available ? real[fn] : shim[fn]);

	return {
		wgGenKey: pick(capabilities.crypto, 'wgGenKey'),
		wgGenPsk: pick(capabilities.crypto, 'wgGenPsk'),
		wgDerivePublicKey: pick(capabilities.crypto, 'wgDerivePublicKey'),

		wgShow: pick(capabilities.network, 'wgShow'),
		isInterfaceUp: pick(capabilities.network, 'isInterfaceUp'),
		listInterfaces: pick(capabilities.network, 'listInterfaces'),
		startInterface: pick(capabilities.network, 'startInterface'),
		reloadInterface: pick(capabilities.network, 'reloadInterface'),
		stopInterface: pick(capabilities.network, 'stopInterface'),
		applyExitRouting: pick(capabilities.network, 'applyExitRouting'),

		applyFirewall: pick(capabilities.firewall, 'applyFirewall'),
		resetFirewall: pick(capabilities.firewall, 'resetFirewall'),
	};
};

/**
 * How `WG_DEV_SHIM` is read: `true`/`1` forces every axis to the shim, `false`/`0` forces every
 * axis to the real adapter (skipping the probes), anything else - including unset - probes.
 */
export const readShimOverride = (raw: string | undefined): 'shim' | 'real' | 'probe' => {
	const value = (raw ?? '').toLowerCase();
	if (value === 'true' || value === '1') return 'shim';
	if (value === 'false' || value === '0') return 'real';
	return 'probe';
};

export const ALL_CAPABILITIES: Capabilities = { crypto: true, network: true, firewall: true };
export const NO_CAPABILITIES: Capabilities = { crypto: false, network: false, firewall: false };

/**
 * Whether a set of capabilities is a refusal in this environment: production never silently
 * shims, but `WG_DEV_SHIM=true` is an explicit opt-in that overrides that. Returns the message
 * to throw, or null to proceed.
 */
export const capabilityRefusal = (capabilities: Capabilities, env: { nodeEnv: string | undefined; override: 'shim' | 'real' | 'probe' }): string | null => {
	if (capabilities.crypto && capabilities.network && capabilities.firewall) return null;
	if (env.nodeEnv !== 'production' || env.override === 'shim') return null;

	return 'wg/wg-quick/ip/nft are missing or lack permission to manage network interfaces (NET_ADMIN capability required). ' + 'Refusing to silently fall back to the development shim in production. Set WG_DEV_SHIM=true to override.';
};

/** The boot warning for a partially shimmed host, or null when nothing is shimmed. */
export const capabilityWarning = (capabilities: Capabilities): string | null => {
	if (capabilities.crypto && capabilities.network && capabilities.firewall) return null;

	const axis = (available: boolean) => (available ? 'real' : 'shimmed');
	return (
		`⚠️  WireGuard/network tooling unavailable (crypto: ${axis(capabilities.crypto)}, interfaces: ${axis(capabilities.network)}, firewall: ${axis(capabilities.firewall)}). ` +
		'Running with the development shim — no real tunnels or network changes will be made.'
	);
};
