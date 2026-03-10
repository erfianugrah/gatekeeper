/**
 * Smoke tests — sections 15-19: S3 Credential CRUD, Operations, IAM Enforcement,
 * Action Mutations, Deny Statements, Revocation, Permanent Delete, Analytics.
 */

import type { SmokeContext } from './helpers.js';
import {
	admin,
	section,
	assertStatus,
	assertJson,
	assertTruthy,
	s3client,
	s3req,
	sleep,
	state,
	green,
	red,
	yellow,
	BASE,
	R2_ACCESS_KEY,
	R2_SECRET_KEY,
	R2_ENDPOINT,
	S3_TEST_BUCKET,
	SKIP_S3,
} from './helpers.js';

export async function run(ctx: SmokeContext): Promise<void> {
	if (SKIP_S3) {
		section('S3 Proxy Tests (skipped — no R2 credentials)');
		console.log(`  ${yellow('SKIP')}  Set R2_TEST_ACCESS_KEY, R2_TEST_SECRET_KEY, R2_TEST_ENDPOINT in .env`);
		return;
	}

	// ─── 15. S3 Credential CRUD ─────────────────────────────────

	section('S3 Credential CRUD');

	// Register upstream R2 endpoint
	const r2Reg = await admin('POST', '/admin/upstream-r2', {
		name: 'smoke-r2',
		endpoint: R2_ENDPOINT,
		access_key_id: R2_ACCESS_KEY,
		secret_access_key: R2_SECRET_KEY,
		bucket_names: [S3_TEST_BUCKET],
	});
	ctx.s3UpstreamId = r2Reg.body?.result?.id;
	if (r2Reg.body?.success) {
		state.pass++;
		console.log(`  ${green('PASS')}  register upstream R2 -> success (${ctx.s3UpstreamId})`);
	} else {
		state.fail++;
		state.errors.push(`register upstream R2 failed: ${r2Reg.body?.errors?.[0]?.message ?? 'unknown'}`);
		console.log(`  ${red('FAIL')}  register upstream R2`);
	}

	// Full-access S3 credential
	const FULL_S3_POLICY = {
		version: '2025-01-01',
		statements: [{ effect: 'allow', actions: ['s3:*'], resources: ['account:*', 'bucket:*', 'object:*'] }],
	};
	const fullCred = await admin('POST', '/admin/s3/credentials', {
		name: 'smoke-s3-full',
		policy: FULL_S3_POLICY,
		upstream_token_id: ctx.s3UpstreamId,
	});
	assertStatus('create full-access S3 credential -> 200', fullCred, 200);
	const S3_FULL_AK = fullCred.body?.result?.credential?.access_key_id;
	const S3_FULL_SK = fullCred.body?.result?.credential?.secret_access_key;
	assertTruthy('S3 cred has GK prefix', S3_FULL_AK?.startsWith('GK'));
	if (S3_FULL_AK) state.createdS3Creds.push(S3_FULL_AK);

	// Read-only credential
	const READONLY_S3_POLICY = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['s3:GetObject', 's3:HeadObject', 's3:ListBucket', 's3:ListAllMyBuckets'],
				resources: ['account:*', 'bucket:*', 'object:*'],
			},
		],
	};
	const roCred = await admin('POST', '/admin/s3/credentials', {
		name: 'smoke-s3-readonly',
		policy: READONLY_S3_POLICY,
		upstream_token_id: ctx.s3UpstreamId,
	});
	assertStatus('create read-only S3 credential -> 200', roCred, 200);
	const S3_RO_AK = roCred.body?.result?.credential?.access_key_id;
	const S3_RO_SK = roCred.body?.result?.credential?.secret_access_key;
	if (S3_RO_AK) state.createdS3Creds.push(S3_RO_AK);

	// List credentials
	const listCreds = await admin('GET', '/admin/s3/credentials');
	assertStatus('list S3 credentials -> 200', listCreds, 200);
	const smokeCredCount = (listCreds.body?.result ?? []).filter(
		(c: any) => c.access_key_id === S3_FULL_AK || c.access_key_id === S3_RO_AK,
	).length;
	assertTruthy(`both smoke creds in list (found ${smokeCredCount})`, smokeCredCount >= 2);

	// Get single credential
	const getCred = await admin('GET', `/admin/s3/credentials/${S3_FULL_AK}`);
	assertStatus('get S3 credential -> 200', getCred, 200);
	assertJson('get cred returns correct id', getCred.body?.result?.credential?.access_key_id, S3_FULL_AK);

	// Validation
	const noCredName = await admin('POST', '/admin/s3/credentials', { policy: FULL_S3_POLICY, upstream_token_id: ctx.s3UpstreamId });
	assertStatus('S3 cred missing name -> 400', noCredName, 400);

	const noCredPol = await admin('POST', '/admin/s3/credentials', { name: 'x', upstream_token_id: ctx.s3UpstreamId });
	assertStatus('S3 cred missing policy -> 400', noCredPol, 400);

	// ─── 16. S3 Operations (full-access) ────────────────────────

	section('S3 Operations (full-access)');

	const fullClient = s3client(S3_FULL_AK, S3_FULL_SK);

	// ListBuckets
	const lb = await s3req(fullClient, 'GET', '/');
	if (lb.status === 200 && lb.raw.includes('<Bucket>')) {
		state.pass++;
		const bucketMatches = lb.raw.match(/<Name>/g);
		console.log(`  ${green('PASS')}  ListBuckets -> success (${bucketMatches?.length ?? 0} buckets)`);
	} else {
		state.fail++;
		state.errors.push(`ListBuckets failed: HTTP ${lb.status}`);
		console.log(`  ${red('FAIL')}  ListBuckets (HTTP ${lb.status})`);
	}

	// PutObject
	const smokeKey = `smoke-test-${Date.now()}.txt`;
	const putUrl = `${BASE}/s3/${S3_TEST_BUCKET}/${smokeKey}`;
	const putSigned = await fullClient.sign(putUrl, {
		method: 'PUT',
		headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'content-type': 'text/plain' },
		body: 'smoke test content',
	});
	const putRes = await fetch(putSigned);
	if (putRes.ok) {
		state.pass++;
		console.log(`  ${green('PASS')}  PutObject -> success (key: ${smokeKey})`);
	} else {
		state.fail++;
		state.errors.push(`PutObject failed: HTTP ${putRes.status}`);
		console.log(`  ${red('FAIL')}  PutObject (HTTP ${putRes.status})`);
	}

	// HeadObject
	const headUrl = `${BASE}/s3/${S3_TEST_BUCKET}/${smokeKey}`;
	const headSigned = await fullClient.sign(headUrl, {
		method: 'HEAD',
		headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
	});
	const headRes = await fetch(headSigned);
	if (headRes.ok) {
		state.pass++;
		console.log(`  ${green('PASS')}  HeadObject -> success`);
	} else {
		state.fail++;
		state.errors.push(`HeadObject failed: HTTP ${headRes.status}`);
		console.log(`  ${red('FAIL')}  HeadObject (HTTP ${headRes.status})`);
	}

	// GetObject
	const getUrl = `${BASE}/s3/${S3_TEST_BUCKET}/${smokeKey}`;
	const getSigned = await fullClient.sign(getUrl, {
		method: 'GET',
		headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
	});
	const getRes = await fetch(getSigned);
	const getBody = await getRes.text();
	if (getBody.includes('smoke test content')) {
		state.pass++;
		console.log(`  ${green('PASS')}  GetObject -> correct content`);
	} else {
		state.fail++;
		state.errors.push(`GetObject content mismatch: got '${getBody.slice(0, 100)}'`);
		console.log(`  ${red('FAIL')}  GetObject content mismatch`);
	}

	// ListObjectsV2
	const listUrl = `${BASE}/s3/${S3_TEST_BUCKET}?list-type=2&prefix=smoke-test-&max-keys=10`;
	const listSigned = await fullClient.sign(listUrl, {
		method: 'GET',
		headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
	});
	const listRes = await fetch(listSigned);
	const listBody = await listRes.text();
	if (listBody.includes('<Key>')) {
		const objMatches = listBody.match(/<Key>/g);
		state.pass++;
		console.log(`  ${green('PASS')}  ListObjectsV2 -> ${objMatches?.length ?? 0} objects with prefix`);
	} else {
		state.fail++;
		state.errors.push(`ListObjectsV2 failed: HTTP ${listRes.status}`);
		console.log(`  ${red('FAIL')}  ListObjectsV2`);
	}

	// DeleteObject
	const delUrl = `${BASE}/s3/${S3_TEST_BUCKET}/${smokeKey}`;
	const delSigned = await fullClient.sign(delUrl, {
		method: 'DELETE',
		headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
	});
	await fetch(delSigned);
	// Verify with HEAD — should be 404
	const verifyHead = await fullClient.sign(headUrl, {
		method: 'HEAD',
		headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
	});
	const verifyRes = await fetch(verifyHead);
	if (verifyRes.status === 404) {
		state.pass++;
		console.log(`  ${green('PASS')}  DeleteObject -> object removed`);
	} else {
		state.fail++;
		state.errors.push(`DeleteObject: object still exists (HEAD returned ${verifyRes.status})`);
		console.log(`  ${red('FAIL')}  DeleteObject (object still exists)`);
	}

	// ─── 17. S3 IAM Enforcement (read-only) ─────────────────────

	section('S3 IAM Enforcement (read-only)');

	const roClient = s3client(S3_RO_AK, S3_RO_SK);

	// ListBuckets — should work
	const roLb = await s3req(roClient, 'GET', '/');
	if (roLb.status === 200 && roLb.raw.includes('<Bucket>')) {
		state.pass++;
		console.log(`  ${green('PASS')}  read-only: ListBuckets -> allowed`);
	} else {
		state.fail++;
		state.errors.push(`read-only ListBuckets should succeed: HTTP ${roLb.status}`);
		console.log(`  ${red('FAIL')}  read-only: ListBuckets`);
	}

	// PutObject — should be denied
	const roPutUrl = `${BASE}/s3/${S3_TEST_BUCKET}/smoke-denied.txt`;
	const roPutSigned = await roClient.sign(roPutUrl, {
		method: 'PUT',
		headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'content-type': 'text/plain' },
		body: 'denied content',
	});
	const roPutRes = await fetch(roPutSigned);
	if (roPutRes.status === 403) {
		state.pass++;
		console.log(`  ${green('PASS')}  read-only: PutObject -> denied (403)`);
	} else {
		state.fail++;
		state.errors.push(`read-only PutObject should be denied: HTTP ${roPutRes.status}`);
		console.log(`  ${red('FAIL')}  read-only: PutObject should be denied (got ${roPutRes.status})`);
	}

	// DeleteObject — should be denied
	const roDelUrl = `${BASE}/s3/${S3_TEST_BUCKET}/nonexistent.txt`;
	const roDelSigned = await roClient.sign(roDelUrl, {
		method: 'DELETE',
		headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
	});
	const roDelRes = await fetch(roDelSigned);
	if (roDelRes.status === 403) {
		state.pass++;
		console.log(`  ${green('PASS')}  read-only: DeleteObject -> denied (403)`);
	} else {
		state.fail++;
		state.errors.push(`read-only DeleteObject should be denied: HTTP ${roDelRes.status}`);
		console.log(`  ${red('FAIL')}  read-only: DeleteObject should be denied (got ${roDelRes.status})`);
	}

	// Invalid credential — should fail
	const badClient = s3client('GK_INVALID_KEY', 'invalid_secret');
	const badLb = await s3req(badClient, 'GET', '/');
	if (badLb.status === 403) {
		state.pass++;
		console.log(`  ${green('PASS')}  invalid credential -> rejected (403)`);
	} else {
		state.fail++;
		state.errors.push(`invalid credential should be rejected: HTTP ${badLb.status}`);
		console.log(`  ${red('FAIL')}  invalid credential should be rejected (got ${badLb.status})`);
	}

	// ─── 17b. S3 Action Mutation Coverage ───────────────────────

	section('S3 Action Mutation Coverage');

	async function testS3ActionCred(
		label: string,
		allowActions: string[],
		okMethod: string,
		okPath: string,
		okBody: string | undefined,
		failMethod: string,
		failPath: string,
		failBody: string | undefined,
	): Promise<void> {
		const pol = {
			version: '2025-01-01',
			statements: [{ effect: 'allow', actions: allowActions, resources: ['account:*', 'bucket:*', 'object:*'] }],
		};
		const cr = await admin('POST', '/admin/s3/credentials', {
			name: `smoke-s3-${label}`,
			policy: pol,
			upstream_token_id: ctx.s3UpstreamId,
		});
		assertStatus(`${label} cred created -> 200`, cr, 200);
		const ak = cr.body?.result?.credential?.access_key_id;
		const sk = cr.body?.result?.credential?.secret_access_key;
		if (ak) state.createdS3Creds.push(ak);

		const client = s3client(ak, sk);

		// Allowed operation
		const okUrl = `${BASE}/s3${okPath}`;
		const okHeaders: Record<string, string> = { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' };
		if (okBody) okHeaders['content-type'] = 'text/plain';
		const okSigned = await client.sign(okUrl, { method: okMethod, headers: okHeaders, body: okBody });
		const okRes = await fetch(okSigned);
		if (okRes.ok || okRes.status === 204 || okRes.status === 404) {
			state.pass++;
			console.log(`  ${green('PASS')}  ${label}: allowed op -> ${okRes.status}`);
		} else {
			state.fail++;
			state.errors.push(`${label}: allowed op should not be 403, got HTTP ${okRes.status}`);
			console.log(`  ${red('FAIL')}  ${label}: allowed op (got ${okRes.status})`);
		}
		if (okRes.body && !okRes.bodyUsed) await okRes.text().catch(() => {});

		// Denied operation
		const failUrl = `${BASE}/s3${failPath}`;
		const failHeaders: Record<string, string> = { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' };
		if (failBody) failHeaders['content-type'] = 'text/plain';
		const failSigned = await client.sign(failUrl, { method: failMethod, headers: failHeaders, body: failBody });
		const failRes = await fetch(failSigned);
		if (failRes.status === 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  ${label}: denied op -> 403`);
		} else {
			state.fail++;
			state.errors.push(`${label}: denied op should be 403, got HTTP ${failRes.status}`);
			console.log(`  ${red('FAIL')}  ${label}: denied op (got ${failRes.status})`);
		}
		if (failRes.body && !failRes.bodyUsed) await failRes.text().catch(() => {});
	}

	// GetObject only — PutObject denied
	await testS3ActionCred(
		'get-only',
		['s3:GetObject'],
		'GET',
		`/${S3_TEST_BUCKET}/nonexistent-smoke.txt`,
		undefined,
		'PUT',
		`/${S3_TEST_BUCKET}/smoke-denied-put.txt`,
		'denied',
	);

	// PutObject only — GetObject denied
	const putOnlyTs = Date.now();
	await testS3ActionCred(
		'put-only',
		['s3:PutObject'],
		'PUT',
		`/${S3_TEST_BUCKET}/smoke-put-only-${putOnlyTs}.txt`,
		'put-only test',
		'GET',
		`/${S3_TEST_BUCKET}/nonexistent-smoke.txt`,
		undefined,
	);
	// Clean up the object we just created
	const putOnlyCleanUrl = `${BASE}/s3/${S3_TEST_BUCKET}/smoke-put-only-${putOnlyTs}.txt`;
	try {
		const cleanSigned = await fullClient.sign(putOnlyCleanUrl, {
			method: 'DELETE',
			headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
		});
		await fetch(cleanSigned);
	} catch {
		/* best effort */
	}

	// DeleteObject only — PutObject denied
	await testS3ActionCred(
		'delete-only',
		['s3:DeleteObject'],
		'DELETE',
		`/${S3_TEST_BUCKET}/nonexistent-smoke.txt`,
		undefined,
		'PUT',
		`/${S3_TEST_BUCKET}/smoke-denied-put.txt`,
		'denied',
	);

	// ListBucket only — PutObject denied
	await testS3ActionCred(
		'list-only',
		['s3:ListBucket'],
		'GET',
		`/${S3_TEST_BUCKET}?list-type=2&max-keys=1`,
		undefined,
		'PUT',
		`/${S3_TEST_BUCKET}/smoke-denied-put.txt`,
		'denied',
	);

	// ListAllMyBuckets only — PutObject denied
	await testS3ActionCred(
		'list-buckets-only',
		['s3:ListAllMyBuckets'],
		'GET',
		'/',
		undefined,
		'PUT',
		`/${S3_TEST_BUCKET}/smoke-denied-put.txt`,
		'denied',
	);

	// ─── 17c. S3 Deny Statement Authorization ───────────────────

	section('S3 Deny Statement Authorization');

	// allow s3:* + deny s3:PutObject → GetObject allowed, PutObject denied
	const denyPutPolicy = {
		version: '2025-01-01',
		statements: [
			{ effect: 'allow', actions: ['s3:*'], resources: ['account:*', 'bucket:*', 'object:*'] },
			{ effect: 'deny', actions: ['s3:PutObject'], resources: ['account:*', 'bucket:*', 'object:*'] },
		],
	};
	const dpCred = await admin('POST', '/admin/s3/credentials', {
		name: 'smoke-s3-deny-put',
		policy: denyPutPolicy,
		upstream_token_id: ctx.s3UpstreamId,
	});
	assertStatus('create deny-PutObject S3 cred -> 200', dpCred, 200);
	const S3_DENY_PUT_AK = dpCred.body?.result?.credential?.access_key_id;
	const S3_DENY_PUT_SK = dpCred.body?.result?.credential?.secret_access_key;
	if (S3_DENY_PUT_AK) state.createdS3Creds.push(S3_DENY_PUT_AK);

	const dpClient = s3client(S3_DENY_PUT_AK, S3_DENY_PUT_SK);

	// GetObject — allowed (s3:* allows, deny doesn't match GetObject)
	const dpGet = await s3req(dpClient, 'GET', `/${S3_TEST_BUCKET}/nonexistent-smoke.txt`);
	if (dpGet.status !== 403) {
		state.pass++;
		console.log(`  ${green('PASS')}  deny-put cred: GetObject -> ${dpGet.status} (not 403, IAM allowed)`);
	} else {
		state.fail++;
		state.errors.push(`deny-put GetObject should not be 403`);
		console.log(`  ${red('FAIL')}  deny-put cred: GetObject should not be 403`);
	}

	// ListBuckets — allowed
	const dpLb = await s3req(dpClient, 'GET', '/');
	if (dpLb.status !== 403) {
		state.pass++;
		console.log(`  ${green('PASS')}  deny-put cred: ListBuckets -> ${dpLb.status} (not 403, IAM allowed)`);
	} else {
		state.fail++;
		state.errors.push(`deny-put ListBuckets should not be 403`);
		console.log(`  ${red('FAIL')}  deny-put cred: ListBuckets should not be 403`);
	}

	// DeleteObject — allowed
	const dpDel = await s3req(dpClient, 'DELETE', `/${S3_TEST_BUCKET}/nonexistent-smoke.txt`);
	if (dpDel.status !== 403) {
		state.pass++;
		console.log(`  ${green('PASS')}  deny-put cred: DeleteObject -> ${dpDel.status} (not 403, IAM allowed)`);
	} else {
		state.fail++;
		state.errors.push(`deny-put DeleteObject should not be 403`);
		console.log(`  ${red('FAIL')}  deny-put cred: DeleteObject should not be 403`);
	}

	// PutObject — denied
	const dpPutUrl = `${BASE}/s3/${S3_TEST_BUCKET}/smoke-deny-put-test.txt`;
	const dpPutSigned = await dpClient.sign(dpPutUrl, {
		method: 'PUT',
		headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'content-type': 'text/plain' },
		body: 'should be denied',
	});
	const dpPutRes = await fetch(dpPutSigned);
	if (dpPutRes.status === 403) {
		state.pass++;
		console.log(`  ${green('PASS')}  deny-put cred: PutObject -> 403 (denied)`);
	} else {
		state.fail++;
		state.errors.push(`deny-put PutObject should be 403, got ${dpPutRes.status}`);
		console.log(`  ${red('FAIL')}  deny-put cred: PutObject should be 403 (got ${dpPutRes.status})`);
	}
	if (dpPutRes.body && !dpPutRes.bodyUsed) await dpPutRes.text().catch(() => {});

	// allow s3:* + deny s3:DeleteObject → DeleteObject denied, rest allowed
	const denyDelPolicy = {
		version: '2025-01-01',
		statements: [
			{ effect: 'allow', actions: ['s3:*'], resources: ['account:*', 'bucket:*', 'object:*'] },
			{ effect: 'deny', actions: ['s3:DeleteObject'], resources: ['account:*', 'bucket:*', 'object:*'] },
		],
	};
	const ddCred = await admin('POST', '/admin/s3/credentials', {
		name: 'smoke-s3-deny-del',
		policy: denyDelPolicy,
		upstream_token_id: ctx.s3UpstreamId,
	});
	assertStatus('create deny-DeleteObject S3 cred -> 200', ddCred, 200);
	const S3_DENY_DEL_AK = ddCred.body?.result?.credential?.access_key_id;
	const S3_DENY_DEL_SK = ddCred.body?.result?.credential?.secret_access_key;
	if (S3_DENY_DEL_AK) state.createdS3Creds.push(S3_DENY_DEL_AK);

	const ddClient = s3client(S3_DENY_DEL_AK, S3_DENY_DEL_SK);

	// PutObject — allowed
	const ddPutKey = `smoke-deny-del-${Date.now()}.txt`;
	const ddPutUrl = `${BASE}/s3/${S3_TEST_BUCKET}/${ddPutKey}`;
	const ddPutSigned = await ddClient.sign(ddPutUrl, {
		method: 'PUT',
		headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'content-type': 'text/plain' },
		body: 'test deny-del',
	});
	const ddPutRes = await fetch(ddPutSigned);
	if (ddPutRes.ok) {
		state.pass++;
		console.log(`  ${green('PASS')}  deny-del cred: PutObject -> allowed`);
	} else {
		state.fail++;
		state.errors.push(`deny-del PutObject should be allowed, got ${ddPutRes.status}`);
		console.log(`  ${red('FAIL')}  deny-del cred: PutObject (got ${ddPutRes.status})`);
	}

	// DeleteObject — denied
	const ddDelUrl = `${BASE}/s3/${S3_TEST_BUCKET}/${ddPutKey}`;
	const ddDelSigned = await ddClient.sign(ddDelUrl, {
		method: 'DELETE',
		headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
	});
	const ddDelRes = await fetch(ddDelSigned);
	if (ddDelRes.status === 403) {
		state.pass++;
		console.log(`  ${green('PASS')}  deny-del cred: DeleteObject -> 403 (denied)`);
	} else {
		state.fail++;
		state.errors.push(`deny-del DeleteObject should be 403, got ${ddDelRes.status}`);
		console.log(`  ${red('FAIL')}  deny-del cred: DeleteObject should be 403 (got ${ddDelRes.status})`);
	}
	if (ddDelRes.body && !ddDelRes.bodyUsed) await ddDelRes.text().catch(() => {});

	// Clean up with the full-access client
	const ddCleanSigned = await fullClient.sign(ddDelUrl, {
		method: 'DELETE',
		headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
	});
	await fetch(ddCleanSigned).catch(() => {});

	// Deny-only S3 cred: deny s3:* with no allow → everything denied
	const denyOnlyS3Policy = {
		version: '2025-01-01',
		statements: [{ effect: 'deny', actions: ['s3:*'], resources: ['account:*', 'bucket:*', 'object:*'] }],
	};
	const doS3Cred = await admin('POST', '/admin/s3/credentials', {
		name: 'smoke-s3-deny-only',
		policy: denyOnlyS3Policy,
		upstream_token_id: ctx.s3UpstreamId,
	});
	assertStatus('create deny-only S3 cred -> 200', doS3Cred, 200);
	const S3_DENY_ONLY_AK = doS3Cred.body?.result?.credential?.access_key_id;
	const S3_DENY_ONLY_SK = doS3Cred.body?.result?.credential?.secret_access_key;
	if (S3_DENY_ONLY_AK) state.createdS3Creds.push(S3_DENY_ONLY_AK);

	const doS3Client = s3client(S3_DENY_ONLY_AK, S3_DENY_ONLY_SK);

	const doS3Lb = await s3req(doS3Client, 'GET', '/');
	if (doS3Lb.status === 403) {
		state.pass++;
		console.log(`  ${green('PASS')}  deny-only S3 cred: ListBuckets -> 403`);
	} else {
		state.fail++;
		state.errors.push(`deny-only S3 ListBuckets should be 403, got ${doS3Lb.status}`);
		console.log(`  ${red('FAIL')}  deny-only S3 cred: ListBuckets (got ${doS3Lb.status})`);
	}

	const doS3Get = await s3req(doS3Client, 'GET', `/${S3_TEST_BUCKET}/foo.txt`);
	if (doS3Get.status === 403) {
		state.pass++;
		console.log(`  ${green('PASS')}  deny-only S3 cred: GetObject -> 403`);
	} else {
		state.fail++;
		state.errors.push(`deny-only S3 GetObject should be 403, got ${doS3Get.status}`);
		console.log(`  ${red('FAIL')}  deny-only S3 cred: GetObject (got ${doS3Get.status})`);
	}

	// allow s3:GetObject,s3:ListBucket + deny s3:ListBucket → ListBucket denied, GetObject allowed
	const denyListPolicy = {
		version: '2025-01-01',
		statements: [
			{ effect: 'allow', actions: ['s3:GetObject', 's3:ListBucket'], resources: ['account:*', 'bucket:*', 'object:*'] },
			{ effect: 'deny', actions: ['s3:ListBucket'], resources: ['account:*', 'bucket:*', 'object:*'] },
		],
	};
	const dlCred = await admin('POST', '/admin/s3/credentials', {
		name: 'smoke-s3-deny-list',
		policy: denyListPolicy,
		upstream_token_id: ctx.s3UpstreamId,
	});
	assertStatus('create deny-ListBucket S3 cred -> 200', dlCred, 200);
	const S3_DENY_LIST_AK = dlCred.body?.result?.credential?.access_key_id;
	const S3_DENY_LIST_SK = dlCred.body?.result?.credential?.secret_access_key;
	if (S3_DENY_LIST_AK) state.createdS3Creds.push(S3_DENY_LIST_AK);

	const dlClient = s3client(S3_DENY_LIST_AK, S3_DENY_LIST_SK);

	// GetObject — allowed
	const dlGet = await s3req(dlClient, 'GET', `/${S3_TEST_BUCKET}/nonexistent.txt`);
	if (dlGet.status !== 403) {
		state.pass++;
		console.log(`  ${green('PASS')}  deny-list cred: GetObject -> ${dlGet.status} (IAM allowed)`);
	} else {
		state.fail++;
		state.errors.push(`deny-list GetObject should not be 403`);
		console.log(`  ${red('FAIL')}  deny-list cred: GetObject should not be 403`);
	}

	// ListBucket — denied
	const dlList = await s3req(dlClient, 'GET', `/${S3_TEST_BUCKET}?list-type=2&max-keys=1`);
	if (dlList.status === 403) {
		state.pass++;
		console.log(`  ${green('PASS')}  deny-list cred: ListBucket -> 403 (denied)`);
	} else {
		state.fail++;
		state.errors.push(`deny-list ListBucket should be 403, got ${dlList.status}`);
		console.log(`  ${red('FAIL')}  deny-list cred: ListBucket (got ${dlList.status})`);
	}

	// ─── 18. S3 Credential Revocation ───────────────────────────

	section('S3 Credential Revocation');

	const revCred = await admin('POST', '/admin/s3/credentials', {
		name: 'smoke-s3-revoke',
		policy: FULL_S3_POLICY,
		upstream_token_id: ctx.s3UpstreamId,
	});
	assertStatus('create credential for revoke -> 200', revCred, 200);
	const S3_REVOKE_AK = revCred.body?.result?.credential?.access_key_id;
	const S3_REVOKE_SK = revCred.body?.result?.credential?.secret_access_key;
	if (S3_REVOKE_AK) state.createdS3Creds.push(S3_REVOKE_AK);

	// Verify it works before revocation
	const revClient = s3client(S3_REVOKE_AK, S3_REVOKE_SK);
	const preRevLb = await s3req(revClient, 'GET', '/');
	if (preRevLb.status === 200) {
		state.pass++;
		console.log(`  ${green('PASS')}  pre-revoke: ListBuckets works`);
	} else {
		state.fail++;
		state.errors.push(`pre-revoke ListBuckets should work: HTTP ${preRevLb.status}`);
		console.log(`  ${red('FAIL')}  pre-revoke: ListBuckets`);
	}

	// Revoke
	const revokeCred = await admin('DELETE', `/admin/s3/credentials/${S3_REVOKE_AK}`);
	assertStatus('revoke S3 credential -> 200', revokeCred, 200);

	// Verify denied after revocation
	const postRevLb = await s3req(revClient, 'GET', '/');
	if (postRevLb.status === 403) {
		state.pass++;
		console.log(`  ${green('PASS')}  post-revoke: ListBuckets -> rejected (403)`);
	} else {
		state.fail++;
		state.errors.push(`post-revoke ListBuckets should be rejected: HTTP ${postRevLb.status}`);
		console.log(`  ${red('FAIL')}  post-revoke: ListBuckets should be rejected (got ${postRevLb.status})`);
	}

	// ─── 18b. S3 Credential Permanent Delete ────────────────────

	section('S3 Credential Permanent Delete');

	// Hard-delete the revoked credential
	const s3HardDel = await admin('DELETE', `/admin/s3/credentials/${S3_REVOKE_AK}?permanent=true`);
	assertStatus('hard-delete revoked S3 cred -> 200', s3HardDel, 200);
	assertJson('S3 hard-delete has deleted:true', s3HardDel.body?.result?.deleted, true);

	// GET -> 404
	const getDelCred = await admin('GET', `/admin/s3/credentials/${S3_REVOKE_AK}`);
	assertStatus('GET hard-deleted S3 cred -> 404', getDelCred, 404);

	// Hard-delete nonexistent -> 404
	const s3HardDelNone = await admin('DELETE', '/admin/s3/credentials/GK000000000000000000?permanent=true');
	assertStatus('hard-delete nonexistent S3 cred -> 404', s3HardDelNone, 404);

	// Hard-delete an active credential directly
	const hdS3Cred = await admin('POST', '/admin/s3/credentials', {
		name: 'smoke-s3-hard-del-active',
		policy: FULL_S3_POLICY,
		upstream_token_id: ctx.s3UpstreamId,
	});
	assertStatus('create S3 cred for hard-delete -> 200', hdS3Cred, 200);
	const HD_S3_AK = hdS3Cred.body?.result?.credential?.access_key_id;
	if (HD_S3_AK) state.createdS3Creds.push(HD_S3_AK);

	const s3HardDelActive = await admin('DELETE', `/admin/s3/credentials/${HD_S3_AK}?permanent=true`);
	assertStatus('hard-delete active S3 cred -> 200', s3HardDelActive, 200);
	assertJson('active S3 hard-delete has deleted:true', s3HardDelActive.body?.result?.deleted, true);
	// Remove from cleanup list
	const s3HdIdx = state.createdS3Creds.indexOf(HD_S3_AK);
	if (s3HdIdx >= 0) state.createdS3Creds.splice(s3HdIdx, 1);

	// ─── 19. S3 Analytics ───────────────────────────────────────

	section('S3 Analytics');

	await sleep(1000);

	const s3Events = await admin('GET', '/admin/s3/analytics/events');
	assertStatus('S3 events -> 200', s3Events, 200);
	const s3EventCount = s3Events.body?.result?.length ?? 0;
	assertTruthy(`S3 event count > 0 (got ${s3EventCount})`, s3EventCount > 0);

	const s3Summary = await admin('GET', '/admin/s3/analytics/summary');
	assertStatus('S3 summary -> 200', s3Summary, 200);
	assertTruthy('S3 summary has total_requests', s3Summary.body?.result?.total_requests > 0);
}
