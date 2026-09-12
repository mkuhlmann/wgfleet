import { $ } from 'bun';
import { createLog } from '@server/lib/log';
import * as real from './shell.real';
import * as shim from './shell.shim';

const log = createLog('wg');

const override = (process.env.WG_DEV_SHIM ?? '').toLowerCase();
const forceShim = override === 'true' || override === '1';
const forceReal = override === 'false' || override === '0';

const detectCapabilities = async () => {
	if (forceShim) return { crypto: false, network: false, firewall: false };
	if (forceReal) return { crypto: true, network: true, firewall: true };

	const hasCrypto = !!Bun.which('wg');
	let hasNetwork = hasCrypto && !!Bun.which('wg-quick') && !!Bun.which('ip');

	if (hasNetwork) {
		// wg genkey/pubkey/psk need no privileges, but managing interfaces needs
		// NET_ADMIN. Probe that specifically, since the binaries can be present
		// without the permission (e.g. an unprivileged dev container).
		const probe = `wgshimprobe${process.pid}`;
		const add = await $`ip link add dev ${probe} type dummy`.quiet().nothrow();
		hasNetwork = add.exitCode === 0;
		await $`ip link delete dev ${probe}`.quiet().nothrow();
	}

	// nft can be present without NET_ADMIN too - probe by actually listing tables
	// rather than trusting the binary's presence.
	let hasFirewall = !!Bun.which('nft');
	if (hasFirewall) {
		const list = await $`nft list tables`.quiet().nothrow();
		hasFirewall = list.exitCode === 0;
	}

	return { crypto: hasCrypto, network: hasNetwork, firewall: hasFirewall };
};

const capabilities = await detectCapabilities();

if (!capabilities.crypto || !capabilities.network || !capabilities.firewall) {
	if (process.env.NODE_ENV === 'production' && !forceShim) {
		throw new Error('wg/wg-quick/ip/nft are missing or lack permission to manage network interfaces (NET_ADMIN capability required). ' + 'Refusing to silently fall back to the development shim in production. Set WG_DEV_SHIM=true to override.');
	}
	log.warn(
		`⚠️  WireGuard/network tooling unavailable (crypto: ${capabilities.crypto ? 'real' : 'shimmed'}, interfaces: ${capabilities.network ? 'real' : 'shimmed'}, firewall: ${capabilities.firewall ? 'real' : 'shimmed'}). ` +
			'Running with the development shim — no real tunnels or network changes will be made.',
	);
}

export const wgGenKey = capabilities.crypto ? real.wgGenKey : shim.wgGenKey;
export const wgGenPsk = capabilities.crypto ? real.wgGenPsk : shim.wgGenPsk;
export const wgDerivePublicKey = capabilities.crypto ? real.wgDerivePublicKey : shim.wgDerivePublicKey;

export const wgShow = capabilities.network ? real.wgShow : shim.wgShow;
export const isInterfaceUp = capabilities.network ? real.isInterfaceUp : shim.isInterfaceUp;
export const listInterfaces = capabilities.network ? real.listInterfaces : shim.listInterfaces;
export const startInterface = capabilities.network ? real.startInterface : shim.startInterface;
export const reloadInterface = capabilities.network ? real.reloadInterface : shim.reloadInterface;
export const stopInterface = capabilities.network ? real.stopInterface : shim.stopInterface;
// `network`, not `firewall`: exit routing is pure `ip rule`/`ip route` and must not depend on
// nft being available - see the rejected-alternative note in wg/exitRouting.ts.
export const applyExitRouting = capabilities.network ? real.applyExitRouting : shim.applyExitRouting;

export const applyFirewall = capabilities.firewall ? real.applyFirewall : shim.applyFirewall;
export const resetFirewall = capabilities.firewall ? real.resetFirewall : shim.resetFirewall;

export const cmd = real.cmd;
