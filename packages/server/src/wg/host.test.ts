import { describe, expect, it } from 'bun:test';
import { ALL_CAPABILITIES, capabilityRefusal, capabilityWarning, chooseHost, NO_CAPABILITIES, readShimOverride, type WgHost } from './host';

// A host whose every member reports which adapter answered, so chooseHost's per-axis dispatch
// is observable without a real wg, an nft or NET_ADMIN.
const stub = (label: string): WgHost => {
	const tag = async () => label;
	return {
		wgGenKey: tag,
		wgGenPsk: tag,
		wgDerivePublicKey: tag,
		wgShow: async () => ({ interface: { privateKey: label, publicKey: label, listenPort: label, fwmark: label }, peers: [] }),
		isInterfaceUp: async () => label === 'real',
		listInterfaces: async () => [label],
		startInterface: async () => undefined,
		reloadInterface: async () => undefined,
		stopInterface: async () => undefined,
		applyExitRouting: async () => undefined,
		applyFirewall: async () => undefined,
		resetFirewall: async () => undefined,
	};
};

const real = stub('real');
const shim = stub('shim');

describe('readShimOverride', () => {
	it('reads the documented spellings and treats anything else as "probe"', () => {
		expect(readShimOverride('true')).toBe('shim');
		expect(readShimOverride('1')).toBe('shim');
		expect(readShimOverride('TRUE')).toBe('shim');
		expect(readShimOverride('false')).toBe('real');
		expect(readShimOverride('0')).toBe('real');
		expect(readShimOverride(undefined)).toBe('probe');
		expect(readShimOverride('')).toBe('probe');
		expect(readShimOverride('yes')).toBe('probe');
	});
});

describe('chooseHost', () => {
	it('dispatches per axis, not as one on/off switch', async () => {
		// the documented mixed case: real interfaces, shimmed nft
		const host = chooseHost({ crypto: true, network: true, firewall: false }, real, shim);

		expect(await host.wgGenKey()).toBe('real');
		expect(await host.listInterfaces()).toEqual(['real']);
		expect(await host.applyFirewall('')).toBeUndefined();
		expect(host.applyFirewall).toBe(shim.applyFirewall);
		expect(host.resetFirewall).toBe(shim.resetFirewall);
	});

	it('keeps exit routing on the network axis, so it survives a missing nft', () => {
		const host = chooseHost({ crypto: true, network: true, firewall: false }, real, shim);
		expect(host.applyExitRouting).toBe(real.applyExitRouting);
	});

	it('shims every axis when nothing is available', () => {
		const host = chooseHost(NO_CAPABILITIES, real, shim);
		expect(host.wgGenKey).toBe(shim.wgGenKey);
		expect(host.startInterface).toBe(shim.startInterface);
		expect(host.applyFirewall).toBe(shim.applyFirewall);
	});
});

describe('capabilityRefusal', () => {
	it('refuses to silently shim in production', () => {
		expect(capabilityRefusal({ crypto: true, network: false, firewall: true }, { nodeEnv: 'production', override: 'probe' })).toContain('Refusing to silently fall back');
	});

	it('allows an explicit WG_DEV_SHIM opt-in even in production', () => {
		expect(capabilityRefusal(NO_CAPABILITIES, { nodeEnv: 'production', override: 'shim' })).toBeNull();
	});

	it('allows a shimmed axis outside production', () => {
		expect(capabilityRefusal(NO_CAPABILITIES, { nodeEnv: 'development', override: 'probe' })).toBeNull();
		expect(capabilityRefusal(NO_CAPABILITIES, { nodeEnv: undefined, override: 'probe' })).toBeNull();
	});

	it('says nothing when every capability is present', () => {
		expect(capabilityRefusal(ALL_CAPABILITIES, { nodeEnv: 'production', override: 'probe' })).toBeNull();
	});
});

describe('capabilityWarning', () => {
	it('names each axis as real or shimmed', () => {
		const warning = capabilityWarning({ crypto: true, network: false, firewall: false });
		expect(warning).toContain('crypto: real');
		expect(warning).toContain('interfaces: shimmed');
		expect(warning).toContain('firewall: shimmed');
	});

	it('is silent on a fully capable host', () => {
		expect(capabilityWarning(ALL_CAPABILITIES)).toBeNull();
	});
});
