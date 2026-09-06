import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@app/stores/auth';

const router = createRouter({
	history: createWebHistory(import.meta.env.BASE_URL),
	linkActiveClass: 'active',
	routes: [
		{
			path: '/login',
			name: 'login',
			component: () => import('../views/LoginView.vue'),
		},
		{
			path: '/servers',
			name: 'servers',
			component: () => import('../views/ServerListView.vue'),
		},
		{
			path: '/servers/:id',
			name: 'servers-detail',
			component: () => import('../views/ServerView.vue'),
		},
		{
			path: '/servers/:id/policy',
			name: 'servers-policy',
			component: () => import('../views/ServerPolicyView.vue'),
		},
	],
});

router.beforeEach(async (to, from) => {
	if (to.name !== 'login') {
		const authStore = useAuthStore();
		if (!(await authStore.isAuthenticated())) {
			return { name: 'login' };
		}
	}
});

export default router;
