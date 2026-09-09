import { db } from '../packages/server/src/db';
import {
	serverPeersTable,
	peerTagsTable,
	peerTagAssignmentsTable,
	peersTable,
	policyGrantsTable,
	trafficBucketsTable,
	adminSessionsTable,
} from '../packages/server/src/db/schema';
import { migrateDb } from '../packages/server/src/db';
import { nanoid } from 'nanoid';

async function seed() {
	console.log('Migrating database...');
	await migrateDb();

	console.log('Clearing existing data...');
	await db.delete(trafficBucketsTable);
	await db.delete(policyGrantsTable);
	await db.delete(peerTagAssignmentsTable);
	await db.delete(peersTable);
	await db.delete(peerTagsTable);
	await db.delete(serverPeersTable);
	await db.delete(adminSessionsTable);

	console.log('Seeding servers...');
	const server1Id = 'srv_frankfurt';
	const server2Id = 'srv_virginia';

	const now = new Date();
	const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000);

	await db.insert(serverPeersTable).values([
		{
			id: server1Id,
			friendlyName: 'EU-Central (Frankfurt)',
			interfaceName: 'wg-eu0',
			cidrRange: '10.8.0.0/24',
			reservedIps: 10,
			wgAddress: '10.8.0.1',
			wgListenPort: 51820,
			wgEndpoint: 'vpn-fra.company.net:51820',
			wgPrivateKey: 'eO2+c84g2Y8o9mE3c+9jF2w1h0v3t8s7q6p5o4n3m2l1=',
			wgPublicKey: 'FRApubKey+x8y7z6w5v4u3t2s1r0q9p8o7n6m5l4k3j2i1=',
			authToken: 'srv_token_frankfurt_000000000000',
			enableNat: true,
			lifetimeRxBytes: 15420000000,
			lifetimeTxBytes: 31200000000,
			statsSince: thirtyDaysAgo,
		},
		{
			id: server2Id,
			friendlyName: 'US-East (N. Virginia)',
			interfaceName: 'wg-us0',
			cidrRange: '10.9.0.0/24',
			reservedIps: 10,
			wgAddress: '10.9.0.1',
			wgListenPort: 51821,
			wgEndpoint: 'vpn-iad.company.net:51821',
			wgPrivateKey: 'aB3+d95h3Z9p0nF4d+0kG3x2i1w4u9t8r7q6p5o4n3m2k3=',
			wgPublicKey: 'IADpubKey+y9z8a7b6c5d4e3f2g1h0i9j8k7l6m5n4o3p2=',
			authToken: 'srv_token_virginia_0000000000000',
			enableNat: false,
			lifetimeRxBytes: 6890000000,
			lifetimeTxBytes: 9450000000,
			statsSince: thirtyDaysAgo,
		},
	]);

	console.log('Seeding tags...');
	const tagDevId = 'tag_devs';
	const tagInfraId = 'tag_infra';
	const tagContractorId = 'tag_contractors';
	const tagOpsId = 'tag_ops';

	await db.insert(peerTagsTable).values([
		{
			id: tagDevId,
			serverPeerId: server1Id,
			name: 'developers',
			friendlyName: 'Core Engineering',
		},
		{
			id: tagInfraId,
			serverPeerId: server1Id,
			name: 'infra',
			friendlyName: 'Production Infrastructure',
		},
		{
			id: tagContractorId,
			serverPeerId: server1Id,
			name: 'contractors',
			friendlyName: 'External Contractors',
		},
		{
			id: tagOpsId,
			serverPeerId: server2Id,
			name: 'us-ops',
			friendlyName: 'US Operations Team',
		},
	]);

	console.log('Seeding peers...');
	const peerAliceId = 'peer_alice';
	const peerBobId = 'peer_bob';
	const peerCiId = 'peer_ci_runner';
	const peerContractorId = 'peer_contractor_dave';
	const peerUsEveId = 'peer_us_eve';

	await db.insert(peersTable).values([
		{
			id: peerAliceId,
			serverPeerId: server1Id,
			friendlyName: 'Alice - MacBook Pro',
			wgAddress: '10.8.0.11',
			wgPrivateKey: 'alicePrivKey1111111111111111111111111111111111=',
			wgPublicKey: 'alicePubKey1111111111111111111111111111111111=',
			wgPresharedKey: 'alicePsk111111111111111111111111111111111111=',
			authToken: 'alice_auth_token_000000000000000',
			wgLastRxBytes: 4210000000,
			wgLastTxBytes: 8930000000,
			wgLastSampledAt: new Date(now.getTime() - 45 * 1000),
			lifetimeRxBytes: 12500000000,
			lifetimeTxBytes: 24100000000,
			statsSince: thirtyDaysAgo,
		},
		{
			id: peerBobId,
			serverPeerId: server1Id,
			friendlyName: 'Bob - ThinkPad Arch Linux',
			wgAddress: '10.8.0.12',
			wgPrivateKey: 'bobPrivKey22222222222222222222222222222222222=',
			wgPublicKey: 'bobPubKey22222222222222222222222222222222222=',
			wgPresharedKey: 'bobPsk22222222222222222222222222222222222222=',
			authToken: 'bob_auth_token_00000000000000000',
			wgLastRxBytes: 2340000000,
			wgLastTxBytes: 4120000000,
			wgLastSampledAt: new Date(now.getTime() - 2 * 60 * 1000),
			lifetimeRxBytes: 5800000000,
			lifetimeTxBytes: 11200000000,
			statsSince: thirtyDaysAgo,
		},
		{
			id: peerCiId,
			serverPeerId: server1Id,
			friendlyName: 'CI/CD Build Cluster Node',
			wgAddress: '10.8.0.20',
			wgPrivateKey: 'ciPrivKey33333333333333333333333333333333333=',
			wgPublicKey: 'ciPubKey33333333333333333333333333333333333=',
			wgPresharedKey: 'ciPsk333333333333333333333333333333333333333=',
			authToken: 'ci_auth_token_000000000000000000',
			wgLastRxBytes: 8870000000,
			wgLastTxBytes: 18150000000,
			wgLastSampledAt: new Date(now.getTime() - 10 * 1000),
			lifetimeRxBytes: 35000000000,
			lifetimeTxBytes: 62000000000,
			statsSince: thirtyDaysAgo,
		},
		{
			id: peerContractorId,
			serverPeerId: server1Id,
			friendlyName: 'Dave (Contractor) - Laptop',
			wgAddress: '10.8.0.30',
			wgPrivateKey: 'davePrivKey4444444444444444444444444444444444=',
			wgPublicKey: 'davePubKey4444444444444444444444444444444444=',
			wgPresharedKey: 'davePsk44444444444444444444444444444444444444=',
			authToken: 'dave_auth_token_0000000000000000',
			wgLastRxBytes: 0,
			wgLastTxBytes: 0,
			wgLastSampledAt: null, // offline / never connected
			lifetimeRxBytes: 450000000,
			lifetimeTxBytes: 910000000,
			statsSince: thirtyDaysAgo,
		},
		{
			id: peerUsEveId,
			serverPeerId: server2Id,
			friendlyName: 'Eve - US DevOps Station',
			wgAddress: '10.9.0.11',
			wgPrivateKey: 'evePrivKey55555555555555555555555555555555555=',
			wgPublicKey: 'evePubKey55555555555555555555555555555555555=',
			wgPresharedKey: 'evePsk555555555555555555555555555555555555555=',
			authToken: 'eve_auth_token_00000000000000000',
			wgLastRxBytes: 1540000000,
			wgLastTxBytes: 2890000000,
			wgLastSampledAt: new Date(now.getTime() - 120 * 1000),
			lifetimeRxBytes: 4200000000,
			lifetimeTxBytes: 7800000000,
			statsSince: thirtyDaysAgo,
		},
	]);

	console.log('Seeding tag assignments...');
	await db.insert(peerTagAssignmentsTable).values([
		{ peerId: peerAliceId, tagId: tagDevId },
		{ peerId: peerBobId, tagId: tagDevId },
		{ peerId: peerCiId, tagId: tagInfraId },
		{ peerId: peerContractorId, tagId: tagContractorId },
		{ peerId: peerUsEveId, tagId: tagOpsId },
	]);

	console.log('Seeding policy grants...');
	await db.insert(policyGrantsTable).values([
		{
			id: 'grant_1',
			serverPeerId: server1Id,
			position: 0,
			enabled: true,
			action: 'allow',
			srcKind: 'tag',
			srcTagId: tagInfraId,
			dstKind: 'any',
			protocol: 'any',
			comment: 'Infra can communicate with any destination',
		},
		{
			id: 'grant_2',
			serverPeerId: server1Id,
			position: 1,
			enabled: true,
			action: 'allow',
			srcKind: 'tag',
			srcTagId: tagDevId,
			dstKind: 'tag',
			dstTagId: tagInfraId,
			protocol: 'tcp',
			ports: '22,80,443,6443',
			comment: 'Engineers can access staging & admin web ports',
		},
		{
			id: 'grant_3',
			serverPeerId: server1Id,
			position: 2,
			enabled: true,
			action: 'allow',
			srcKind: 'tag',
			srcTagId: tagDevId,
			dstKind: 'internet',
			protocol: 'any',
			comment: 'Engineers allowed full internet egress via gateway NAT',
		},
		{
			id: 'grant_4',
			serverPeerId: server1Id,
			position: 3,
			enabled: true,
			action: 'deny',
			srcKind: 'tag',
			srcTagId: tagContractorId,
			dstKind: 'tag',
			dstTagId: tagInfraId,
			protocol: 'any',
			comment: 'Block contractors from core infra',
		},
		{
			id: 'grant_5',
			serverPeerId: server1Id,
			position: 4,
			enabled: true,
			action: 'allow',
			srcKind: 'tag',
			srcTagId: tagContractorId,
			dstKind: 'cidr',
			dstCidr: '10.8.0.50/32',
			protocol: 'tcp',
			ports: '443',
			comment: 'Allow contractors staging portal access only',
		},
	]);

	console.log('Seeding traffic buckets for charts...');
	// Generate 1-minute buckets for the last 60 minutes
	const bucketRows: Array<{
		id: string;
		peerId: string;
		serverPeerId: string;
		resolution: '1m' | '1h' | '1d';
		bucketStart: Date;
		rxBytes: number;
		txBytes: number;
	}> = [];

	const currentMinuteFloor = Math.floor(now.getTime() / 60000) * 60000;
	for (let i = 60; i >= 0; i--) {
		const bucketTime = new Date(currentMinuteFloor - i * 60000);
		// Alice traffic
		const aliceNoise = Math.sin(i / 5) + 1.2;
		bucketRows.push({
			id: nanoid(),
			peerId: peerAliceId,
			serverPeerId: server1Id,
			resolution: '1m',
			bucketStart: bucketTime,
			rxBytes: Math.floor(150000 * aliceNoise),
			txBytes: Math.floor(450000 * aliceNoise),
		});

		// Bob traffic
		const bobNoise = Math.cos(i / 4) + 1.1;
		bucketRows.push({
			id: nanoid(),
			peerId: peerBobId,
			serverPeerId: server1Id,
			resolution: '1m',
			bucketStart: bucketTime,
			rxBytes: Math.floor(80000 * bobNoise),
			txBytes: Math.floor(220000 * bobNoise),
		});

		// CI traffic (bursty)
		const ciBurst = i % 10 === 0 ? 5 : 1;
		bucketRows.push({
			id: nanoid(),
			peerId: peerCiId,
			serverPeerId: server1Id,
			resolution: '1m',
			bucketStart: bucketTime,
			rxBytes: Math.floor(600000 * ciBurst),
			txBytes: Math.floor(1200000 * ciBurst),
		});
	}

	// Also generate 1-hour buckets for the last 48 hours
	const currentHourFloor = Math.floor(now.getTime() / 3600000) * 3600000;
	for (let h = 48; h >= 0; h--) {
		const hourTime = new Date(currentHourFloor - h * 3600000);
		bucketRows.push({
			id: nanoid(),
			peerId: peerAliceId,
			serverPeerId: server1Id,
			resolution: '1h',
			bucketStart: hourTime,
			rxBytes: Math.floor(12000000 + Math.random() * 8000000),
			txBytes: Math.floor(25000000 + Math.random() * 15000000),
		});
		bucketRows.push({
			id: nanoid(),
			peerId: peerBobId,
			serverPeerId: server1Id,
			resolution: '1h',
			bucketStart: hourTime,
			rxBytes: Math.floor(6000000 + Math.random() * 4000000),
			txBytes: Math.floor(14000000 + Math.random() * 8000000),
		});
		bucketRows.push({
			id: nanoid(),
			peerId: peerCiId,
			serverPeerId: server1Id,
			resolution: '1h',
			bucketStart: hourTime,
			rxBytes: Math.floor(40000000 + Math.random() * 30000000),
			txBytes: Math.floor(85000000 + Math.random() * 50000000),
		});
	}

	for (const row of bucketRows) {
		await db.insert(trafficBucketsTable).values(row);
	}

	console.log(`Successfully seeded ${bucketRows.length} traffic buckets.`);
	console.log('Mock data seeding complete!');
}

seed().catch((err) => {
	console.error('Seed failed:', err);
	process.exit(1);
});
