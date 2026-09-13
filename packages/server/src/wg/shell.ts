import { $ } from 'bun';
import { createLog } from '@server/lib/log';
import * as real from './shell.real';
import * as shim from './shell.shim';
import { ALL_CAPABILITIES, capabilityRefusal, capabilityWarning, chooseHost, NO_CAPABILITIES, readShimOverride, type Capabilities, type WgHost } from './host';

const log = createLog('wg');

// Both adapters are checked against the seam's interface here rather than in their own files:
// `import * as` yields a module namespace, so a missing export or a mistyped signature in
// either one is a compile error at this line. This is the whole of the four-files-in-sync rule
// that used to live in CLAUDE.md.
const realHost: WgHost = real;
const shimHost: WgHost = shim;

const override = readShimOverride(process.env.WG_DEV_SHIM);

/**
 * The io half: actually looks at the host. The decisions taken from its answer are pure and
 * live in ./host.ts.
 */
const probeCapabilities = async (): Promise<Capabilities> => {
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

const capabilities = override === 'shim' ? NO_CAPABILITIES : override === 'real' ? ALL_CAPABILITIES : await probeCapabilities();

const refusal = capabilityRefusal(capabilities, { nodeEnv: process.env.NODE_ENV, override });
if (refusal) throw new Error(refusal);

const warning = capabilityWarning(capabilities);
if (warning) log.warn(warning);

const host = chooseHost(capabilities, realHost, shimHost);

export const { wgGenKey, wgGenPsk, wgDerivePublicKey, wgShow, isInterfaceUp, listInterfaces, startInterface, reloadInterface, stopInterface, applyExitRouting, applyFirewall, resetFirewall } = host;
