import type { ServerPeer } from '../db/schema';
import { peersTable, serverPeersTable } from '../db/schema';
import { db } from '@server/db';
import { createLog } from '@server/lib/log';
import { generateServerConfig } from './config';
import { randomBytes, createHash } from 'crypto';
import { eq } from 'drizzle-orm';

const log = createLog('wg:shim');

const upInterfaces = new Set<string>();
const trafficCounters: Record<string, { rx: number; tx: number }> = {};

export const cmd = async (command: string) => {
	log.warn(`[shim] not running: ${command}`);
	return { stdout: '', stderr: '' };
};

export const wgGenKey = async () => {
	return randomBytes(32).toString('base64');
};

export const wgGenPsk = async () => {
	return randomBytes(32).toString('base64');
};

export const wgDerivePublicKey = async (privateKey: string) => {
	return createHash('sha256').update(privateKey).digest().toString('base64');
};

export const wgShow = async (interfaceName: string) => {
	if (!upInterfaces.has(interfaceName)) return null;

	const server = await db.query.serverPeersTable.findFirst({ where: eq(serverPeersTable.interfaceName, interfaceName) });
	if (!server) {
		return { interface: { privateKey: 'shimmed', publicKey: 'shimmed', listenPort: '0', fwmark: 'off' }, peers: [] };
	}

	const dbPeers = await db.query.peersTable.findMany({ where: eq(peersTable.serverPeerId, server.id) });

	const peers = dbPeers.map((peer) => {
		const counter = (trafficCounters[peer.wgPublicKey] ??= { rx: 0, tx: 0 });
		counter.rx += Math.floor(Math.random() * 50_000);
		counter.tx += Math.floor(Math.random() * 50_000);

		return {
			publicKey: peer.wgPublicKey,
			presharedKey: peer.wgPresharedKey ?? '',
			endpoint: '127.0.0.1:0',
			allowedIps: peer.wgAddress,
			latestHandshake: Math.floor(Date.now() / 1000),
			transferRx: counter.rx,
			transferTx: counter.tx,
			persistentKeepalive: 'off',
		};
	});

	return {
		interface: {
			privateKey: server.wgPrivateKey,
			publicKey: server.wgPublicKey,
			listenPort: String(server.wgListenPort),
			fwmark: 'off',
		},
		peers,
	};
};

export const isInterfaceUp = async (interfaceName: string) => {
	return upInterfaces.has(interfaceName);
};

export const startServer = async (server: ServerPeer) => {
	log.info(`[shim] "starting" server ${server.interfaceName} (no real network changes made)`);
	await Bun.write('/tmp/' + server.interfaceName + '.conf', await generateServerConfig(server), { mode: 0o600 });
	upInterfaces.add(server.interfaceName);
};

export const reloadServer = async (server: ServerPeer) => {
	log.info(`[shim] "reloading" server ${server.interfaceName} (no real network changes made)`);
	await Bun.write('/tmp/' + server.interfaceName + '.conf', await generateServerConfig(server), { mode: 0o600 });
};

export const stopServer = async (server: ServerPeer) => {
	log.info(`[shim] "stopping" server ${server.interfaceName} (no real network changes made)`);
	upInterfaces.delete(server.interfaceName);
};

export const applyExitRouting = async (commands: string[]) => {
	log.info(`(shim) apply exit routing:\n${commands.join('\n')}`);
};

export const applyFirewall = async (ruleset: string) => {
	log.info(`[shim] "applying" firewall ruleset (no real network changes made) - written to /tmp/wgmgr.nft`);
	await Bun.write('/tmp/wgmgr.nft', ruleset, { mode: 0o600 });
};

export const resetFirewall = async () => {
	log.info(`[shim] "resetting" firewall ruleset (no real network changes made)`);
};
