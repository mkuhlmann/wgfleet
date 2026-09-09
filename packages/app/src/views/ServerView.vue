<template>
	<div class="flex flex-col gap-8">
		<div class="text-xs text-muted" v-if="isLoading">loading server... <span class="caret"></span></div>

		<!-- Server Details -->
		<div class="flex flex-col gap-4" v-if="server">
			<div class="flex items-center justify-between flex-wrap gap-3">
				<h1 class="text-lg font-bold text-text"><span class="text-accent-dim">///</span> {{ server.friendlyName ?? server.id }}</h1>
				<BaseButton :as="'router-link'" :to="{ name: 'servers-policy', params: { id: server.id } }" variant="secondary">policy</BaseButton>
			</div>

			<PeerModal v-model:visible="showAddPeerModal" :server="server" />
			<PeerModal v-model:visible="showEditPeerModal" :peer="selectedPeer" :server="server" />
			<PeerTrafficModal v-model:visible="showPeerTrafficModal" :server-id="server.id" :peer="selectedTrafficPeer" />
			<ServerModal v-model:visible="showEditServerModal" :server="server" />

			<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
				<BaseCard :title="server.friendlyName ?? server.id">
					<template #actions>
						<BaseButton @click="showEditServerModal = true" variant="ghost" size="sm">edit</BaseButton>
					</template>
					<div class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm text-muted">
						<span class="whitespace-nowrap">id</span>
						<span class="text-text text-right break-all">{{ server.id }}</span>

						<span class="whitespace-nowrap">interface</span>
						<span class="text-text text-right break-all">{{ server.interfaceName }}</span>

						<span class="whitespace-nowrap">endpoint</span>
						<span class="text-text text-right break-all">{{ server.wgEndpoint }}</span>

						<span class="whitespace-nowrap">listen port</span>
						<span class="text-text text-right">{{ server.wgListenPort }}</span>

						<span class="whitespace-nowrap">wireguard address</span>
						<span class="text-text text-right break-all">{{ server.wgAddress }}</span>

						<span class="whitespace-nowrap">cidr range</span>
						<span class="text-text text-right break-all">{{ server.cidrRange }}</span>

						<span class="whitespace-nowrap">reserved ips</span>
						<span class="text-text text-right">{{ server.reservedIps }}</span>

						<span class="whitespace-nowrap">nat</span>
						<span class="text-text text-right">{{ server.enableNat ? 'enabled' : 'disabled' }}</span>
					</div>
				</BaseCard>

				<TrafficCard :buckets="serverTraffic?.buckets ?? []" :resolution="resolution" @update:resolution="resolution = $event" :enabled="serverTraffic?.enabled" />
			</div>
		</div>

		<div class="rule-line"></div>

		<!-- Peers List -->
		<div class="flex flex-col gap-4">
			<div class="flex justify-between items-center flex-wrap gap-3">
				<h2 class="text-base font-bold text-text"><span class="text-accent-dim">///</span> peers</h2>
				<BaseButton @click="showAddPeerModal = true">add peer</BaseButton>
			</div>

			<DataView :items="peers || []" :filter-fields="['id', 'friendlyName', 'wgAddress']" default-layout="grid">
				<template #grid-item="{ item: peer }">
					<BaseCard :title="peer.friendlyName ?? peer.id" class="h-full flex flex-col">
						<template #actions>
							<BaseButton @click="showTraffic(peer)" variant="ghost" size="sm">t</BaseButton>
						</template>
						<div class="flex-1 flex flex-col gap-3">
							<div class="text-xs flex items-center gap-2 flex-wrap">
								<span v-if="!peer.peerInfo" class="text-unknown border border-unknown/40 rounded-sm px-1.5 py-0.5">unknown</span>
								<span v-else-if="peer.peerInfo.connected" class="text-up border border-up/40 rounded-sm px-1.5 py-0.5">up</span>
								<span v-else class="text-down border border-down/40 rounded-sm px-1.5 py-0.5">down</span>
								<span v-for="name in tagNames(peer.tagIds)" :key="name" class="text-accent-dim border border-accent-dim/40 rounded-sm px-1.5 py-0.5">[{{ name }}]</span>
							</div>

							<div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm text-muted">
								<span class="whitespace-nowrap">id</span>
								<span class="text-text text-right break-all">{{ peer.id }}</span>

								<span class="whitespace-nowrap">address</span>
								<span class="text-text text-right break-all">{{ peer.wgAddress }}</span>

								<template v-if="peer.peerInfo">
									<span class="whitespace-nowrap">handshake</span>
									<span class="text-text text-right break-words">{{ peer.peerInfo.wgLatestHandshake == 0 ? '-' : new Date(peer.peerInfo.wgLatestHandshake * 1000).toLocaleString() }}</span>

									<span class="whitespace-nowrap">received</span>
									<span class="text-text text-right">{{ formatBytes(peer.peerInfo.wgTransferRx) }}</span>

									<span class="whitespace-nowrap">transmitted</span>
									<span class="text-text text-right">{{ formatBytes(peer.peerInfo.wgTransferTx) }}</span>
								</template>
							</div>
						</div>

						<template #footer>
							<div class="grid grid-cols-2 gap-2">
								<BaseButton @click="showQrCode(peer.id)" variant="secondary" size="sm">qr</BaseButton>
								<BaseButton @click="showConfig(peer.id)" variant="secondary" size="sm">cfg</BaseButton>
								<BaseButton @click="editPeer(peer)" variant="secondary" size="sm">edit</BaseButton>
								<BaseButton @click="deletePeer(peer.id)" variant="danger" size="sm">del</BaseButton>
							</div>
						</template>
					</BaseCard>
				</template>

				<template #table-header>
					<th class="px-4 py-2.5">status</th>
					<th class="px-4 py-2.5">name/id</th>
					<th class="px-4 py-2.5">address</th>
					<th class="px-4 py-2.5">tags</th>
					<th class="px-4 py-2.5">transfer</th>
					<th class="px-4 py-2.5 text-right">actions</th>
				</template>

				<template #table-row="{ item: peer }">
					<td class="px-4 py-3">
						<span v-if="!peer.peerInfo" class="text-unknown border border-unknown/40 rounded-sm px-1.5 py-0.5">unknown</span>
						<span v-else-if="peer.peerInfo.connected" class="text-up border border-up/40 rounded-sm px-1.5 py-0.5">up</span>
						<span v-else class="text-down border border-down/40 rounded-sm px-1.5 py-0.5">down</span>
					</td>
					<td class="px-4 py-3 font-medium text-text">
						{{ peer.friendlyName ?? peer.id }}
					</td>
					<td class="px-4 py-3 text-muted">
						{{ peer.wgAddress }}
					</td>
					<td class="px-4 py-3 text-muted text-xs">
						<span v-if="tagNames(peer.tagIds).length" class="text-accent-dim">[{{ tagNames(peer.tagIds).join('] [') }}]</span>
						<span v-else>-</span>
					</td>
					<td class="px-4 py-3 text-muted text-xs">
						<div v-if="peer.peerInfo">
							<div>&darr; {{ formatBytes(peer.peerInfo.wgTransferRx) }}</div>
							<div>&uarr; {{ formatBytes(peer.peerInfo.wgTransferTx) }}</div>
						</div>
						<div v-else>-</div>
					</td>
					<td class="px-4 py-3 text-right">
						<div class="flex justify-end gap-2">
							<BaseButton @click="showQrCode(peer.id)" variant="ghost" size="sm">qr</BaseButton>
							<BaseButton @click="showConfig(peer.id)" variant="ghost" size="sm">cfg</BaseButton>
							<BaseButton @click="showTraffic(peer)" variant="ghost" size="sm">t</BaseButton>
							<BaseButton @click="editPeer(peer)" variant="ghost" size="sm">edit</BaseButton>
							<BaseButton @click="deletePeer(peer.id)" variant="ghost" size="sm" class="text-down!">del</BaseButton>
						</div>
					</td>
				</template>
			</DataView>
		</div>
	</div>

	<BaseModal v-model:visible="modalQrCode" header="qr code">
		<div class="bg-white p-3 rounded-sm flex justify-center">
			<QrcodeVue v-if="modalQrCode" :size="280" :value="wgConfig" />
		</div>
	</BaseModal>

	<BaseModal v-model:visible="modalConfig" header="configuration">
		<div class="bg-bg p-4 rounded-sm border border-border">
			<pre class="font-mono text-xs text-muted overflow-auto max-h-[60vh] whitespace-pre-wrap break-all">{{ wgConfig }}</pre>
		</div>
		<template #footer>
			<div class="flex items-center gap-4 w-full justify-end">
				<span class="opacity-0 transition-opacity text-up text-xs" :class="{ 'opacity-100': showCopiedToClipboard }">copied</span>
				<BaseButton @click="copyConfig" variant="primary">copy to clipboard</BaseButton>
			</div>
		</template>
	</BaseModal>
</template>

<script setup lang="ts">
import { queryServer, queryServerPeers } from '@app/queries/queryServers';
import { queryServerTraffic, type TrafficResolution } from '@app/queries/queryTraffic';
import { queryServerTags } from '@app/queries/queryPolicy';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { useRoute } from 'vue-router';
import { ref, computed } from 'vue';
import { api } from '@app/queries/edenClient';
import { invalidate } from '@app/queries/keys';
import QrcodeVue from 'qrcode.vue';
import PeerModal from '@app/components/PeerModal.vue';
import PeerTrafficModal from '@app/components/PeerTrafficModal.vue';
import ServerModal from '@app/components/ServerModal.vue';
import TrafficCard from '@app/components/TrafficCard.vue';
import { formatBytes } from '@app/lib/format';
import type { Peer } from '@server/db/schema';

// wgLast* are internal delta-tracking bookkeeping the api never returns (see serversPeers.ts) -
// every peer object handled in this view/PeerModal omits them.
type PublicPeer = Omit<Peer, 'wgLastRxBytes' | 'wgLastTxBytes' | 'wgLastSampledAt'>;
import BaseButton from '@app/components/BaseButton.vue';
import BaseCard from '@app/components/BaseCard.vue';
import DataView from '@app/components/DataView.vue';
import BaseModal from '@app/components/BaseModal.vue';

const route = useRoute();
const serverId = route.params.id as string;

const { data: server, isLoading } = useQuery(queryServer(serverId));
const { data: peers } = useQuery(queryServerPeers(serverId));
const { data: tags } = useQuery(queryServerTags(serverId));

const resolution = ref<TrafficResolution>('1m');
const { data: serverTraffic } = useQuery(computed(() => queryServerTraffic(serverId, resolution.value)));

const tagNameById = computed(() => new Map((tags.value ?? []).map((t) => [t.id, t.friendlyName ?? t.name])));
const tagNames = (tagIds: string[] | undefined) => (tagIds ?? []).map((id) => tagNameById.value.get(id)).filter((name): name is string => Boolean(name));

const queryClient = useQueryClient();

const modalQrCode = ref(false);
const modalConfig = ref(false);
const wgConfig = ref('');

const showQrCode = async (peerId: string) => {
	await getPeerConfig(peerId);
	modalQrCode.value = wgConfig.value !== '';
};

const getPeerConfig = async (peerId: string) => {
	const config = await api.wg.peers({ id: peerId }).config.get();
	wgConfig.value = config.data ?? '';
};

const showConfig = async (peerId: string) => {
	await getPeerConfig(peerId);
	modalConfig.value = wgConfig.value !== '';
};

const showCopiedToClipboard = ref(false);
const copyConfig = async () => {
	await navigator.clipboard.writeText(wgConfig.value);
	showCopiedToClipboard.value = true;
	setTimeout(() => {
		showCopiedToClipboard.value = false;
	}, 2000);
};

const showAddPeerModal = ref(false);
const showEditPeerModal = ref(false);
const showEditServerModal = ref(false);
const selectedPeer = ref<PublicPeer>();

const editPeer = (peer: PublicPeer) => {
	selectedPeer.value = peer;
	showEditPeerModal.value = true;
};

const showPeerTrafficModal = ref(false);
const selectedTrafficPeer = ref<PublicPeer | null>(null);

const showTraffic = (peer: PublicPeer) => {
	selectedTrafficPeer.value = peer;
	showPeerTrafficModal.value = true;
};

const deletePeer = async (peerId: string) => {
	if (!confirm('Are you sure you want to delete this peer?')) return;

	await api.wg
		.servers({ id: serverId })
		.peers({ peerId: peerId })
		.delete();
	// a peer delete also cascades referencing grants server-side (serversPeers.ts) - see
	// invalidate.afterPeerDelete
	await invalidate.afterPeerDelete(queryClient, serverId);
};
</script>
