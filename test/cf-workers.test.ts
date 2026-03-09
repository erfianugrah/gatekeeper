import { SELF, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import {
	UPSTREAM_HOST,
	createAccountKey,
	registerAccountUpstreamToken,
	cleanupCreatedResources,
	__testClearInflightCache,
} from './helpers';
import type { PolicyDocument } from '../src/policy-types';

// ─── Constants ──────────────────────────────────────────────────────────────

const ACCOUNT_ID = 'aaaa1111bbbb2222cccc3333dddd4444';
const SCRIPT_NAME = 'my-worker';
const VERSION_ID = 'ver_abc123def456';
const DEPLOYMENT_ID = 'dep_xyz789ghi012';
const DOMAIN_ID = 'dom_123456789abc';
const SECRET_NAME = 'MY_SECRET';
const TAIL_ID = 'tail_001';
const POLICY_VERSION = '2025-01-01' as const;

const WORKERS_BASE = `/cf/accounts/${ACCOUNT_ID}/workers`;
const CF_API_WORKERS_PATH = `/client/v4/accounts/${ACCOUNT_ID}/workers`;

// ─── Policy factories ───────────────────────────────────────────────────────

function workersWildcardPolicy(): PolicyDocument {
	return {
		version: POLICY_VERSION,
		statements: [{ effect: 'allow', actions: ['workers:*'], resources: [`account:${ACCOUNT_ID}`] }],
	};
}

function workersReadOnlyPolicy(): PolicyDocument {
	return {
		version: POLICY_VERSION,
		statements: [
			{
				effect: 'allow',
				actions: [
					'workers:list_scripts',
					'workers:get_script',
					'workers:get_content',
					'workers:get_settings',
					'workers:get_script_settings',
					'workers:list_versions',
					'workers:get_version',
					'workers:list_deployments',
					'workers:get_deployment',
					'workers:list_secrets',
					'workers:get_secret',
					'workers:get_schedules',
					'workers:list_tails',
					'workers:get_subdomain',
					'workers:get_account_subdomain',
					'workers:get_account_settings',
					'workers:list_domains',
					'workers:get_domain',
					'workers:telemetry',
				],
				resources: [`account:${ACCOUNT_ID}`],
			},
		],
	};
}

function workersDeployOnlyPolicy(): PolicyDocument {
	return {
		version: POLICY_VERSION,
		statements: [
			{
				effect: 'allow',
				actions: [
					'workers:update_script',
					'workers:update_content',
					'workers:update_settings',
					'workers:create_version',
					'workers:create_deployment',
					'workers:upload_assets',
					'workers:update_schedules',
					'workers:update_subdomain',
					'workers:get_settings',
					'workers:get_account_subdomain',
				],
				resources: [`account:${ACCOUNT_ID}`],
			},
		],
	};
}

function workersScriptScopedPolicy(scriptName: string): PolicyDocument {
	return {
		version: POLICY_VERSION,
		statements: [
			{
				effect: 'allow',
				actions: ['workers:*'],
				resources: [`account:${ACCOUNT_ID}`],
				conditions: [{ field: 'workers.script_name', operator: 'eq', value: scriptName }],
			},
		],
	};
}

// ─── Test helpers ───────────────────────────────────────────────────────────

function mockWorkersUpstream(method: string, path: string, status = 200, body?: string, headers?: Record<string, string>) {
	const defaultBody =
		status < 400
			? '{"success":true,"errors":[],"messages":[],"result":{}}'
			: `{"success":false,"errors":[{"code":${status},"message":"Error"}]}`;
	fetchMock
		.get(UPSTREAM_HOST)
		.intercept({ method, path })
		.reply(status, body ?? defaultBody, { headers: { 'Content-Type': 'application/json', ...(headers ?? {}) } });
}

function mockBinaryUpstream(method: string, path: string, body: string, contentType: string) {
	fetchMock
		.get(UPSTREAM_HOST)
		.intercept({ method, path })
		.reply(200, body, { headers: { 'Content-Type': contentType } });
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeAll(async () => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
	await registerAccountUpstreamToken(ACCOUNT_ID, 'cf-test-workers-token-abcdef1234567890');
});

beforeEach(() => {
	__testClearInflightCache();
});

afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
});

afterAll(async () => {
	await cleanupCreatedResources();
});

// ─── Authentication ─────────────────────────────────────────────────────────

describe('Workers proxy — authentication', () => {
	it('401 when no Authorization header', async () => {
		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts`, { method: 'GET' });
		expect(res.status).toBe(401);
		const data = await res.json<any>();
		expect(data.success).toBe(false);
	});

	it('401 with invalid key', async () => {
		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts`, {
			method: 'GET',
			headers: { Authorization: 'Bearer gw_invalid_key_that_does_not_exist' },
		});
		expect(res.status).toBe(401);
	});

	it('400 with invalid account ID format', async () => {
		const res = await SELF.fetch('http://localhost/cf/accounts/not-valid/workers/scripts', {
			method: 'GET',
			headers: { Authorization: 'Bearer gw_test' },
		});
		expect(res.status).toBe(400);
	});
});

// ─── List scripts ───────────────────────────────────────────────────────────

describe('Workers proxy — list scripts', () => {
	it('proxies GET /scripts with wildcard policy', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('GET', `${CF_API_WORKERS_PATH}/scripts`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
	});

	it('403 when deploy-only policy (no list_scripts)', async () => {
		const keyId = await createAccountKey(workersDeployOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(403);
	});
});

// ─── Script CRUD ────────────────────────────────────────────────────────────

describe('Workers proxy — script CRUD', () => {
	it('proxies PUT /scripts/:name (multipart upload)', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('PUT', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}`, {
			method: 'PUT',
			headers: {
				Authorization: `Bearer ${keyId}`,
				'Content-Type': 'multipart/form-data; boundary=----formdata',
			},
			body: '------formdata\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n{"main_module":"index.js"}\r\n------formdata--',
		});
		expect(res.status).toBe(200);
	});

	it('proxies GET /scripts/:name (raw JS download)', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockBinaryUpstream('GET', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}`, 'export default { fetch() {} }', 'application/javascript');

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('application/javascript');
		const text = await res.text();
		expect(text).toBe('export default { fetch() {} }');
	});

	it('proxies DELETE /scripts/:name', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('DELETE', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('403 DELETE with read-only policy', async () => {
		const keyId = await createAccountKey(workersReadOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(403);
	});
});

// ─── Script content ─────────────────────────────────────────────────────────

describe('Workers proxy — script content', () => {
	it('proxies PUT /scripts/:name/content (content upload)', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('PUT', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}/content`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/content`, {
			method: 'PUT',
			headers: {
				Authorization: `Bearer ${keyId}`,
				'Content-Type': 'multipart/form-data; boundary=----formdata',
				'CF-WORKER-BODY-PART': 'index.js',
				'CF-WORKER-MAIN-MODULE-PART': 'index.js',
			},
			body: '------formdata\r\nContent-Disposition: form-data; name="index.js"\r\n\r\nexport default {}\r\n------formdata--',
		});
		expect(res.status).toBe(200);
	});

	it('proxies GET /scripts/:name/content/v2 (binary download)', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockBinaryUpstream('GET', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}/content/v2`, 'binary-module-data', 'application/octet-stream');

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/content/v2`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toBe('binary-module-data');
	});

	it('403 content upload with read-only policy', async () => {
		const keyId = await createAccountKey(workersReadOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/content`, {
			method: 'PUT',
			headers: {
				Authorization: `Bearer ${keyId}`,
				'Content-Type': 'multipart/form-data; boundary=----formdata',
			},
			body: '------formdata--',
		});
		expect(res.status).toBe(403);
	});
});

// ─── Settings ───────────────────────────────────────────────────────────────

describe('Workers proxy — settings', () => {
	it('proxies GET /scripts/:name/settings', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('GET', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}/settings`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/settings`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('proxies PATCH /scripts/:name/settings (multipart)', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('PATCH', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}/settings`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/settings`, {
			method: 'PATCH',
			headers: {
				Authorization: `Bearer ${keyId}`,
				'Content-Type': 'multipart/form-data; boundary=----formdata',
			},
			body: '------formdata\r\nContent-Disposition: form-data; name="settings"\r\n\r\n{"bindings":[]}\r\n------formdata--',
		});
		expect(res.status).toBe(200);
	});

	it('proxies GET /scripts/:name/script-settings', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('GET', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}/script-settings`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/script-settings`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('proxies PATCH /scripts/:name/script-settings', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('PATCH', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}/script-settings`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/script-settings`, {
			method: 'PATCH',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ logpush: true }),
		});
		expect(res.status).toBe(200);
	});

	it('403 PATCH settings with read-only policy', async () => {
		const keyId = await createAccountKey(workersReadOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/settings`, {
			method: 'PATCH',
			headers: {
				Authorization: `Bearer ${keyId}`,
				'Content-Type': 'multipart/form-data; boundary=----formdata',
			},
			body: '------formdata--',
		});
		expect(res.status).toBe(403);
	});
});

// ─── Versions ───────────────────────────────────────────────────────────────

describe('Workers proxy — versions', () => {
	it('proxies POST /scripts/:name/versions (multipart)', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('POST', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}/versions`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/versions`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${keyId}`,
				'Content-Type': 'multipart/form-data; boundary=----formdata',
			},
			body: '------formdata\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n{}\r\n------formdata--',
		});
		expect(res.status).toBe(200);
	});

	it('proxies GET /scripts/:name/versions', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('GET', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}/versions`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/versions`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('proxies GET /scripts/:name/versions/:versionId', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('GET', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}/versions/${VERSION_ID}`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/versions/${VERSION_ID}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('403 create version with read-only policy', async () => {
		const keyId = await createAccountKey(workersReadOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/versions`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${keyId}`,
				'Content-Type': 'multipart/form-data; boundary=----formdata',
			},
			body: '------formdata--',
		});
		expect(res.status).toBe(403);
	});
});

// ─── Deployments ────────────────────────────────────────────────────────────

describe('Workers proxy — deployments', () => {
	it('proxies POST /scripts/:name/deployments', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('POST', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}/deployments`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/deployments`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ strategy: 'percentage', versions: [{ version_id: VERSION_ID, percentage: 100 }] }),
		});
		expect(res.status).toBe(200);
	});

	it('proxies GET /scripts/:name/deployments', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('GET', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}/deployments`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/deployments`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('proxies GET /scripts/:name/deployments/:id', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('GET', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}/deployments/${DEPLOYMENT_ID}`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/deployments/${DEPLOYMENT_ID}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('proxies DELETE /scripts/:name/deployments/:id', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('DELETE', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}/deployments/${DEPLOYMENT_ID}`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/deployments/${DEPLOYMENT_ID}`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('403 create deployment with read-only policy', async () => {
		const keyId = await createAccountKey(workersReadOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/deployments`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(403);
	});
});

// ─── Secrets ────────────────────────────────────────────────────────────────

describe('Workers proxy — secrets', () => {
	it('proxies PUT /scripts/:name/secrets', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('PUT', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}/secrets`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/secrets`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: SECRET_NAME, text: 'secret-value', type: 'secret_text' }),
		});
		expect(res.status).toBe(200);
	});

	it('proxies GET /scripts/:name/secrets', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('GET', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}/secrets`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/secrets`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('proxies DELETE /scripts/:name/secrets/:secretName', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('DELETE', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}/secrets/${SECRET_NAME}`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/secrets/${SECRET_NAME}`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('403 update secret with read-only policy', async () => {
		const keyId = await createAccountKey(workersReadOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/secrets`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: SECRET_NAME, text: 'val', type: 'secret_text' }),
		});
		expect(res.status).toBe(403);
	});
});

// ─── Schedules ──────────────────────────────────────────────────────────────

describe('Workers proxy — schedules', () => {
	it('proxies PUT /scripts/:name/schedules', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('PUT', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}/schedules`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/schedules`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify([{ cron: '*/5 * * * *' }]),
		});
		expect(res.status).toBe(200);
	});

	it('proxies GET /scripts/:name/schedules', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('GET', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}/schedules`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/schedules`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});
});

// ─── Tails ──────────────────────────────────────────────────────────────────

describe('Workers proxy — tails', () => {
	it('proxies POST /scripts/:name/tails', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('POST', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}/tails`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/tails`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
	});

	it('proxies GET /scripts/:name/tails', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('GET', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}/tails`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/tails`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('proxies DELETE /scripts/:name/tails/:tailId', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('DELETE', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}/tails/${TAIL_ID}`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/tails/${TAIL_ID}`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('403 create tail with read-only policy', async () => {
		const keyId = await createAccountKey(workersReadOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/tails`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(403);
	});
});

// ─── Script subdomain ───────────────────────────────────────────────────────

describe('Workers proxy — script subdomain', () => {
	it('proxies POST /scripts/:name/subdomain', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('POST', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}/subdomain`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/subdomain`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ enabled: true }),
		});
		expect(res.status).toBe(200);
	});

	it('proxies GET /scripts/:name/subdomain', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('GET', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}/subdomain`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/subdomain`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});
});

// ─── Assets upload session ──────────────────────────────────────────────────

describe('Workers proxy — assets upload', () => {
	it('proxies POST /scripts/:name/assets-upload-session', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('POST', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}/assets-upload-session`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/assets-upload-session`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ manifest: { '/index.html': { hash: 'abc123', size: 100 } } }),
		});
		expect(res.status).toBe(200);
	});
});

// ─── Account subdomain ──────────────────────────────────────────────────────

describe('Workers proxy — account subdomain', () => {
	it('proxies GET /subdomain', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('GET', `${CF_API_WORKERS_PATH}/subdomain`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/subdomain`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('proxies PUT /subdomain', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('PUT', `${CF_API_WORKERS_PATH}/subdomain`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/subdomain`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ subdomain: 'my-subdomain' }),
		});
		expect(res.status).toBe(200);
	});

	it('403 PUT subdomain with read-only policy', async () => {
		const keyId = await createAccountKey(workersReadOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/subdomain`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ subdomain: 'my-subdomain' }),
		});
		expect(res.status).toBe(403);
	});
});

// ─── Account settings ───────────────────────────────────────────────────────

describe('Workers proxy — account settings', () => {
	it('proxies GET /account-settings', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('GET', `${CF_API_WORKERS_PATH}/account-settings`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/account-settings`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('proxies PUT /account-settings', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('PUT', `${CF_API_WORKERS_PATH}/account-settings`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/account-settings`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ default_usage_model: 'unbound' }),
		});
		expect(res.status).toBe(200);
	});
});

// ─── Custom domains ─────────────────────────────────────────────────────────

describe('Workers proxy — custom domains', () => {
	it('proxies GET /domains', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('GET', `${CF_API_WORKERS_PATH}/domains`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/domains`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('proxies PUT /domains', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('PUT', `${CF_API_WORKERS_PATH}/domains`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/domains`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ hostname: 'api.example.com', service: SCRIPT_NAME, zone_id: 'zone123' }),
		});
		expect(res.status).toBe(200);
	});

	it('proxies GET /domains/:id', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('GET', `${CF_API_WORKERS_PATH}/domains/${DOMAIN_ID}`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/domains/${DOMAIN_ID}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('proxies DELETE /domains/:id', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('DELETE', `${CF_API_WORKERS_PATH}/domains/${DOMAIN_ID}`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/domains/${DOMAIN_ID}`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});
});

// ─── Observability / Telemetry ──────────────────────────────────────────────

describe('Workers proxy — telemetry', () => {
	it('proxies POST /observability/telemetry/keys', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('POST', `${CF_API_WORKERS_PATH}/observability/telemetry/keys`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/observability/telemetry/keys`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
	});

	it('proxies POST /observability/telemetry/query', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('POST', `${CF_API_WORKERS_PATH}/observability/telemetry/query`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/observability/telemetry/query`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ query: 'SELECT count() FROM events' }),
		});
		expect(res.status).toBe(200);
	});

	it('proxies POST /observability/telemetry/values', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('POST', `${CF_API_WORKERS_PATH}/observability/telemetry/values`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/observability/telemetry/values`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
	});
});

// ─── Per-script policy scoping ──────────────────────────────────────────────

describe('Workers proxy — script-scoped policy', () => {
	it('allows operations on matching script name', async () => {
		const keyId = await createAccountKey(workersScriptScopedPolicy(SCRIPT_NAME));
		mockWorkersUpstream('GET', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}/settings`);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/settings`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('403 when script name does not match policy', async () => {
		const keyId = await createAccountKey(workersScriptScopedPolicy('allowed-worker'));

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/other-worker/settings`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(403);
	});

	it('account-level actions not blocked by script-scoped policy (no script_name field)', async () => {
		// Account subdomain has no workers.script_name field, so a script-scoped condition
		// with eq operator should NOT match (field missing -> condition fails -> 403)
		const keyId = await createAccountKey(workersScriptScopedPolicy(SCRIPT_NAME));

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/subdomain`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		// Script-scoped policy with condition on workers.script_name won't match account-level action
		// because the field is absent — policy engine treats absent field as condition failure
		expect(res.status).toBe(403);
	});
});

// ─── Upstream error forwarding ──────────────────────────────────────────────

describe('Workers proxy — upstream error forwarding', () => {
	it('forwards 404 from upstream', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream('GET', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}`, 404, undefined, {});

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		// 404 on binary passthrough — the handler checks status >= 200 && < 300 for passthrough
		expect(res.status).toBe(404);
	});

	it('forwards rate-limit headers on 429', async () => {
		const keyId = await createAccountKey(workersWildcardPolicy());
		mockWorkersUpstream(
			'GET',
			`${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}/deployments`,
			429,
			'{"success":false,"errors":[{"code":429,"message":"Rate limited"}]}',
			{ 'Retry-After': '60', 'RateLimit-Remaining': '0' },
		);

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/deployments`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(429);
		expect(res.headers.get('Retry-After')).toBe('60');
		expect(res.headers.get('RateLimit-Remaining')).toBe('0');
	});
});

// ─── Deploy-only policy ─────────────────────────────────────────────────────

describe('Workers proxy — deploy-only policy', () => {
	it('allows wrangler deploy flow actions', async () => {
		const keyId = await createAccountKey(workersDeployOnlyPolicy());

		// Step 1: GET account subdomain
		mockWorkersUpstream('GET', `${CF_API_WORKERS_PATH}/subdomain`);
		const subdomainRes = await SELF.fetch(`http://localhost${WORKERS_BASE}/subdomain`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(subdomainRes.status).toBe(200);

		// Step 2: GET settings
		mockWorkersUpstream('GET', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}/settings`);
		const settingsRes = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/settings`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(settingsRes.status).toBe(200);

		// Step 3: PUT content (multipart)
		mockWorkersUpstream('PUT', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}/content`);
		const contentRes = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/content`, {
			method: 'PUT',
			headers: {
				Authorization: `Bearer ${keyId}`,
				'Content-Type': 'multipart/form-data; boundary=----formdata',
			},
			body: '------formdata--',
		});
		expect(contentRes.status).toBe(200);

		// Step 4: POST deployments
		mockWorkersUpstream('POST', `${CF_API_WORKERS_PATH}/scripts/${SCRIPT_NAME}/deployments`);
		const deployRes = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/deployments`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(deployRes.status).toBe(200);
	});

	it('blocks delete with deploy-only policy', async () => {
		const keyId = await createAccountKey(workersDeployOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(403);
	});

	it('blocks secret management with deploy-only policy', async () => {
		const keyId = await createAccountKey(workersDeployOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${WORKERS_BASE}/scripts/${SCRIPT_NAME}/secrets`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'SECRET', text: 'val', type: 'secret_text' }),
		});
		expect(res.status).toBe(403);
	});
});
