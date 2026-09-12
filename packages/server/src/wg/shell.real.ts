import { $ } from 'bun';
import { createLog } from '@server/lib/log';

import { exec } from 'child_process';
import { promisify } from 'util';

const log = createLog('wg');

const execAsync = promisify(exec);

export const cmd = async (command: string) => {
	try {
		log.info(`⚙️  ${command}`);
		let shell = '';
		try {
			await execAsync('command -v bash');
			shell = 'bash';
		} catch {
			try {
				await execAsync('command -v ash');
				shell = 'ash';
			} catch {
				throw new Error('Neither bash nor ash shell is available.');
			}
		}
		const { stdout, stderr } = await execAsync(command, { shell });
		return { stdout: stdout.trim(), stderr: stderr.trim() };
	} catch (error) {
		log.error(error);
		throw error;
	}
};

export const wgGenKey = async () => {
	return (await $`wg genkey`.text()).trim();
};

export const wgGenPsk = async () => {
	return (await $`wg genpsk`.text()).trim();
};

export const wgDerivePublicKey = async (privateKey: string) => {
	return (await $`wg pubkey < ${new Response(privateKey)}`.text()).trim();
};

export const wgShow = async (interfaceName: string) => {
	try {
		const output = (await $`wg show ${interfaceName} dump`.text()) ?? '';
		const lines = output.trim().split('\n');
		if (!lines.length) return null;
		const [privateKey, publicKey, listenPort, fwmark] = lines[0].split('\t');
		const peers = lines.slice(1).map((line) => {
			const [publicKey, presharedKey, endpoint, allowedIps, latestHandshake, transferRx, transferTx, persistentKeepalive] = line.split('\t');
			return {
				publicKey,
				presharedKey,
				endpoint,
				allowedIps,
				latestHandshake: parseInt(latestHandshake, 10),
				transferRx: parseInt(transferRx, 10),
				transferTx: parseInt(transferTx, 10),
				persistentKeepalive,
			};
		});
		return {
			interface: { privateKey, publicKey, listenPort, fwmark },
			peers,
		};
	} catch (error) {
		log.error(error);
		return null;
	}
};

// Every wireguard interface on the host, whoever created it - the input to converge's
// orphaned-exit-link sweep. `wg show interfaces` lists only wg devices, so an unrelated
// interface can never appear here.
export const listInterfaces = async (): Promise<string[]> => {
	try {
		return ((await $`wg show interfaces`.text()) ?? '').trim().split(/\s+/).filter(Boolean);
	} catch (error) {
		log.error(error);
		return [];
	}
};

export const isInterfaceUp = async (interfaceName: string) => {
	const output = (await $`ip a`.text()) ?? '';
	return output.includes(interfaceName);
};

// Takes the rendered config rather than a db row: this layer brings up *an interface*, and
// since exit nodes got interfaces of their own (wg/exitLinks.ts) there are two kinds of config
// to render. Deciding which is wg/converge.ts's job, not this adapter's.
export const startInterface = async (interfaceName: string, config: string) => {
	await Bun.write(`/tmp/${interfaceName}.conf`, config, { mode: 0o600 });
	await cmd(`wg-quick up /tmp/${interfaceName}.conf`);
};

export const reloadInterface = async (interfaceName: string, config: string) => {
	const conf = `/tmp/${interfaceName}.conf`;
	const stripped = `/tmp/${interfaceName}.stripped.conf`;

	await Bun.write(conf, config, { mode: 0o600 });

	// `wg-quick strip` needs no privileges; run it directly instead of via `cmd()`'s
	// bash/ash shell so this doesn't depend on bash process substitution (`<(...)`),
	// which ash does not support and the production image installs no bash for.
	const strippedConfig = (await $`wg-quick strip ${conf}`.text()).trim();
	await Bun.write(stripped, strippedConfig, { mode: 0o600 });

	await cmd(`wg syncconf ${interfaceName} ${stripped}`);
};

export const stopInterface = async (interfaceName: string) => {
	await cmd(`ip link delete dev ${interfaceName}`);
};

// Exit-node policy routing (see wg/exitRouting.ts). Takes an already-built command list
// rather than the servers themselves so that every `ip` invocation is decided by the pure
// builder there and this adapter stays a dumb executor - the same split as
// applyFirewall/buildRuleset. Commands are ordered (drain before repopulate) so they run
// sequentially, not concurrently.
export const applyExitRouting = async (commands: string[]) => {
	for (const command of commands) {
		await cmd(command);
	}
};

export const applyFirewall = async (ruleset: string) => {
	// feed the generated script on stdin rather than a temp file - no path to
	// inject, and no interpolation of the ruleset into a shell command at all.
	try {
		await $`nft -f - < ${new Response(ruleset)}`.quiet();
	} catch (error) {
		// Bun's ShellError.message is just "Failed with exit code N" - the actual
		// reason (nft prints the offending line + a caret) is on .stderr, and gets
		// silently dropped if not read here.
		const stderr = error instanceof Error && 'stderr' in error ? String((error as any).stderr) : '';
		throw new Error(`nft -f failed: ${stderr.trim() || error}`);
	}
};

export const resetFirewall = async () => {
	await $`nft delete table inet wgmgr`.quiet().nothrow();
};
