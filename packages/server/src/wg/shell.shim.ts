import { peersTable, serverPeersTable } from '../db/schema';
import { db } from '@server/db';
import { createLog } from '@server/lib/log';
import { randomBytes, createHash } from 'crypto';
import { eq } from 'drizzle-orm';

const log = createLog('wg:shim');

const upInterfaces = new Set<string>();
const trafficCounters: Record<string, { rx: number; tx: number }> = {};

const shimmedPeer = (peer: { wgPublicKey: string; wgPresharedKey: string | null; wgAddress: string }) => {
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

	// An exit link's interface carries exactly one peer - the exit node itself - so the shim
	// answers for both kinds of interface from the same peers table (see wg/exitLinks.ts).
	const exitNode = await db.query.peersTable.findFirst({ where: eq(peersTable.exitInterfaceName, interfaceName) });
	if (exitNode) {
		return {
			interface: { privateKey: exitNode.exitPrivateKey ?? 'shimmed', publicKey: exitNode.exitPublicKey ?? 'shimmed', listenPort: String(exitNode.exitListenPort ?? 0), fwmark: 'off' },
			peers: [shimmedPeer(exitNode)],
		};
	}

	const server = await db.query.serverPeersTable.findFirst({ where: eq(serverPeersTable.interfaceName, interfaceName) });
	if (!server) {
		return { interface: { privateKey: 'shimmed', publicKey: 'shimmed', listenPort: '0', fwmark: 'off' }, peers: [] };
	}

	const dbPeers = (await db.query.peersTable.findMany({ where: eq(peersTable.serverPeerId, server.id) })).filter((p) => !p.isExitNode);

	const peers = dbPeers.map(shimmedPeer);

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

export const listInterfaces = async (): Promise<string[]> => [...upInterfaces];

export const isInterfaceUp = async (interfaceName: string) => {
	return upInterfaces.has(interfaceName);
};

export const startInterface = async (interfaceName: string, config: string) => {
	log.info(`[shim] "starting" interface ${interfaceName} (no real network changes made)`);
	await Bun.write(`/tmp/${interfaceName}.conf`, config, { mode: 0o600 });
	upInterfaces.add(interfaceName);
};

export const reloadInterface = async (interfaceName: string, config: string) => {
	log.info(`[shim] "reloading" interface ${interfaceName} (no real network changes made)`);
	await Bun.write(`/tmp/${interfaceName}.conf`, config, { mode: 0o600 });
};

export const stopInterface = async (interfaceName: string) => {
	log.info(`[shim] "stopping" interface ${interfaceName} (no real network changes made)`);
	upInterfaces.delete(interfaceName);
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
