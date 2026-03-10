/**
 * Smoke tests — sections 15-19: S3 Credential CRUD, Operations, IAM Enforcement,
 * Action Mutations, Deny Statements, Revocation, Permanent Delete, Analytics.
 */

import type { SmokeContext } from './helpers.js';
import {
	req,
	admin,
	section,
	assertStatus,
	assertJson,
	assertMatch,
	assertTruthy,
	s3client,
	s3req,
	sleep,
	state,
	green,
	red,
	yellow,
	BASE,
	ADMIN_KEY,
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

	// --- Schema validation ---

	const noCredName = await admin('POST', '/admin/s3/credentials', { policy: FULL_S3_POLICY, upstream_token_id: ctx.s3UpstreamId });
	assertStatus('S3 cred missing name -> 400', noCredName, 400);

	const noCredPol = await admin('POST', '/admin/s3/credentials', { name: 'x', upstream_token_id: ctx.s3UpstreamId });
	assertStatus('S3 cred missing policy -> 400', noCredPol, 400);

	const noCredToken = await admin('POST', '/admin/s3/credentials', { name: 'x', policy: FULL_S3_POLICY });
	assertStatus('S3 cred missing upstream_token_id -> 400', noCredToken, 400);

	const badCredVer = await admin('POST', '/admin/s3/credentials', {
		name: 'x',
		upstream_token_id: ctx.s3UpstreamId,
		policy: { version: 'wrong', statements: [] },
	});
	assertStatus('S3 cred invalid policy version -> 400', badCredVer, 400);

	const emptyCredStmt = await admin('POST', '/admin/s3/credentials', {
		name: 'x',
		upstream_token_id: ctx.s3UpstreamId,
		policy: { version: '2025-01-01', statements: [] },
	});
	assertStatus('S3 cred empty statements -> 400', emptyCredStmt, 400);

	const badCredJson = await req('POST', '/admin/s3/credentials', 'not json at all', {
		'X-Admin-Key': ADMIN_KEY!,
		'Content-Type': 'application/json',
	});
	assertStatus('S3 cred invalid JSON body -> 400', badCredJson, 400);

	// --- R2 Binding validation ---

	section('R2 Binding Validation');

	// R1: Nonexistent upstream R2 endpoint
	const r2NoEndpoint = await admin('POST', '/admin/s3/credentials', {
		name: 'x',
		upstream_token_id: 'upr2_does_not_exist_at_all',
		policy: FULL_S3_POLICY,
	});
	assertStatus('nonexistent R2 endpoint -> 400', r2NoEndpoint, 400);
	assertMatch('error mentions endpoint not found', r2NoEndpoint.body?.errors?.[0]?.message ?? '', /not found/i);

	// R2: Non-S3 action
	const r2WrongAction = await admin('POST', '/admin/s3/credentials', {
		name: 'x',
		upstream_token_id: ctx.s3UpstreamId,
		policy: {
			version: '2025-01-01',
			statements: [{ effect: 'allow', actions: ['purge:host'], resources: ['account:*', 'bucket:*', 'object:*'] }],
		},
	});
	assertStatus('S3 cred with non-S3 action -> 400', r2WrongAction, 400);
	assertMatch('error mentions s3: prefix', r2WrongAction.body?.errors?.[0]?.message ?? '', /s3:/i);

	// R3: Bare wildcard resource "*"
	const r2BareWildcard = await admin('POST', '/admin/s3/credentials', {
		name: 'x',
		upstream_token_id: ctx.s3UpstreamId,
		policy: { version: '2025-01-01', statements: [{ effect: 'allow', actions: ['s3:*'], resources: ['*'] }] },
	});
	assertStatus('S3 cred bare wildcard resource -> 400', r2BareWildcard, 400);
	assertMatch('error mentions wildcard not allowed', r2BareWildcard.body?.errors?.[0]?.message ?? '', /wildcard/i);

	// R4: Bucket not in endpoint scope (endpoint has specific bucket)
	const r2WrongBucket = await admin('POST', '/admin/s3/credentials', {
		name: 'x',
		upstream_token_id: ctx.s3UpstreamId,
		policy: {
			version: '2025-01-01',
			statements: [{ effect: 'allow', actions: ['s3:*'], resources: ['account:*', 'bucket:not-allowed-bucket', 'object:*'] }],
		},
	});
	assertStatus('S3 cred wrong bucket -> 400', r2WrongBucket, 400);
	assertMatch('error mentions bucket not covered', r2WrongBucket.body?.errors?.[0]?.message ?? '', /not covered/i);

	// R4b: Object resource with wrong bucket
	const r2WrongObjBucket = await admin('POST', '/admin/s3/credentials', {
		name: 'x',
		upstream_token_id: ctx.s3UpstreamId,
		policy: {
			version: '2025-01-01',
			statements: [{ effect: 'allow', actions: ['s3:*'], resources: ['account:*', 'object:wrong-bucket/key.txt'] }],
		},
	});
	assertStatus('S3 cred object with wrong bucket -> 400', r2WrongObjBucket, 400);

	// GAP 4 fix: Invalid resource prefix (zone:, foo:, etc.)
	const r2InvalidPrefix = await admin('POST', '/admin/s3/credentials', {
		name: 'x',
		upstream_token_id: ctx.s3UpstreamId,
		policy: {
			version: '2025-01-01',
			statements: [{ effect: 'allow', actions: ['s3:*'], resources: ['zone:some-zone'] }],
		},
	});
	assertStatus('S3 cred with zone: resource prefix -> 400', r2InvalidPrefix, 400);
	assertMatch('error mentions valid prefixes', r2InvalidPrefix.body?.errors?.[0]?.message ?? '', /account:|bucket:|object:/i);

	// Happy path: correct bucket name scoped
	const r2CorrectBucket = await admin('POST', '/admin/s3/credentials', {
		name: 'smoke-s3-bucket-scoped',
		upstream_token_id: ctx.s3UpstreamId,
		policy: {
			version: '2025-01-01',
			statements: [
				{ effect: 'allow', actions: ['s3:*'], resources: ['account:*', `bucket:${S3_TEST_BUCKET}`, `object:${S3_TEST_BUCKET}/*`] },
			],
		},
	});
	assertStatus('S3 cred with correct bucket scope -> 200', r2CorrectBucket, 200);
	const correctBucketAk = r2CorrectBucket.body?.result?.credential?.access_key_id;
	const correctBucketSk = r2CorrectBucket.body?.result?.credential?.secret_access_key;
	if (correctBucketAk) state.createdS3Creds.push(correctBucketAk);

	// Multiple errors in one request
	const r2MultiError = await admin('POST', '/admin/s3/credentials', {
		name: 'x',
		upstream_token_id: ctx.s3UpstreamId,
		policy: {
			version: '2025-01-01',
			statements: [{ effect: 'allow', actions: ['purge:host', 's3:GetObject'], resources: ['*', 'zone:foo'] }],
		},
	});
	assertStatus('S3 cred multiple binding errors -> 400', r2MultiError, 400);

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

	// ─── 16b. Large Multipart Upload + Concurrent Downloads ────
	//
	// Tests the full multipart upload lifecycle through the proxy:
	//   CreateMultipartUpload → concurrent UploadPart → CompleteMultipartUpload
	// Then verifies with HEAD, concurrent range-GET downloads, and cleanup.
	//
	// Configurable via env vars (defaults in parentheses):
	//   S3_LARGE_PART_MB   — size of each part in MB (50)
	//   S3_LARGE_PARTS     — number of parts (4)       → total = 200 MB
	//   S3_LARGE_CONCURRENCY — max concurrent uploads/downloads (4)
	//
	// CF edge limits per-request body to 100 MB (Free/Pro), so part size
	// must stay under that. Multipart is the only way to push GiB-scale objects.

	const PART_MB = Number(process.env['S3_LARGE_PART_MB'] || 50);
	const PART_COUNT = Number(process.env['S3_LARGE_PARTS'] || 4);
	const CONCURRENCY = Number(process.env['S3_LARGE_CONCURRENCY'] || 4);
	const PART_SIZE = PART_MB * 1024 * 1024;
	const TOTAL_SIZE = PART_SIZE * PART_COUNT;
	const totalMB = PART_MB * PART_COUNT;

	section(`S3 Multipart Upload (${PART_COUNT} x ${PART_MB} MB = ${totalMB} MB, concurrency ${CONCURRENCY})`);

	const mpKey = `smoke-multipart-${Date.now()}.bin`;
	const mpObjUrl = `${BASE}/s3/${S3_TEST_BUCKET}/${mpKey}`;

	// --- Step 1: CreateMultipartUpload ---
	const initUrl = `${mpObjUrl}?uploads`;
	const initSigned = await fullClient.sign(initUrl, {
		method: 'POST',
		headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
	});
	const initRes = await fetch(initSigned);
	const initBody = await initRes.text();
	const uploadIdMatch = initBody.match(/<UploadId>([^<]+)<\/UploadId>/);
	const uploadId = uploadIdMatch?.[1];
	assertTruthy(`multipart: CreateMultipartUpload -> ${initRes.status} (got uploadId)`, initRes.ok && uploadId);

	if (uploadId) {
		const partEtags: { partNumber: number; etag: string }[] = [];
		let uploadOk = true;

		// --- Step 2: Upload parts concurrently ---
		/** Generate a deterministic buffer for a given part number. */
		function makePart(partNum: number): Buffer {
			const buf = Buffer.alloc(PART_SIZE);
			// Fill with repeating 4-byte pattern: [partNum, offset_high, offset_mid, offset_low]
			// This lets us verify any byte position maps back to the correct part.
			for (let i = 0; i < PART_SIZE; i += 4) {
				buf[i] = partNum & 0xff;
				buf[i + 1] = (i >> 16) & 0xff;
				buf[i + 2] = (i >> 8) & 0xff;
				buf[i + 3] = i & 0xff;
			}
			return buf;
		}

		/** Upload a single part, return ETag on success. */
		async function uploadPart(partNum: number): Promise<string | null> {
			const partBuf = makePart(partNum);
			const partUrl = `${mpObjUrl}?partNumber=${partNum}&uploadId=${encodeURIComponent(uploadId!)}`;
			const signed = await fullClient.sign(partUrl, {
				method: 'PUT',
				headers: {
					'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
					'content-type': 'application/octet-stream',
					'content-length': String(PART_SIZE),
				},
				body: partBuf as unknown as BodyInit,
			});
			const res = await fetch(signed);
			if (res.body && !res.bodyUsed) await res.text().catch(() => {});
			if (!res.ok) return null;
			const etag = res.headers.get('etag');
			return etag || null;
		}

		// Fire parts in batches of CONCURRENCY
		const t0 = Date.now();
		for (let batch = 0; batch < PART_COUNT; batch += CONCURRENCY) {
			const batchEnd = Math.min(batch + CONCURRENCY, PART_COUNT);
			const promises: Promise<{ partNumber: number; etag: string | null }>[] = [];
			for (let i = batch; i < batchEnd; i++) {
				const partNum = i + 1; // S3 parts are 1-indexed
				promises.push(uploadPart(partNum).then((etag) => ({ partNumber: partNum, etag })));
			}
			const results = await Promise.all(promises);
			for (const r of results) {
				if (r.etag) {
					partEtags.push({ partNumber: r.partNumber, etag: r.etag });
				} else {
					uploadOk = false;
				}
			}
		}
		const uploadMs = Date.now() - t0;
		const uploadMbps = ((totalMB * 8) / (uploadMs / 1000)).toFixed(1);
		assertTruthy(
			`multipart: uploaded ${PART_COUNT} parts (${totalMB} MB) in ${(uploadMs / 1000).toFixed(1)}s (${uploadMbps} Mbps)`,
			uploadOk && partEtags.length === PART_COUNT,
		);

		// --- Step 3: CompleteMultipartUpload ---
		partEtags.sort((a, b) => a.partNumber - b.partNumber);
		const completeXml = [
			'<CompleteMultipartUpload>',
			...partEtags.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`),
			'</CompleteMultipartUpload>',
		].join('');

		const completeUrl = `${mpObjUrl}?uploadId=${encodeURIComponent(uploadId)}`;
		const completeSigned = await fullClient.sign(completeUrl, {
			method: 'POST',
			headers: {
				'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
				'content-type': 'application/xml',
				'content-length': String(Buffer.byteLength(completeXml)),
			},
			body: completeXml,
		});
		const completeRes = await fetch(completeSigned);
		const completeBody = await completeRes.text();
		const hasLocation = completeBody.includes('<Location>') || completeBody.includes('<ETag>');
		assertTruthy(`multipart: CompleteMultipartUpload -> ${completeRes.status}`, completeRes.ok && hasLocation);

		// --- Step 4: HEAD — verify total size ---
		const headSigned = await fullClient.sign(mpObjUrl, {
			method: 'HEAD',
			headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
		});
		const headRes = await fetch(headSigned);
		const headLen = Number(headRes.headers.get('content-length') ?? 0);
		assertTruthy(`multipart: HEAD content-length == ${TOTAL_SIZE} (got ${headLen})`, headLen === TOTAL_SIZE);

		// --- Step 5: Concurrent range-GET downloads — verify content integrity ---
		// For each part, fetch the first 16 bytes and verify the deterministic pattern.

		async function verifyPartRange(partNum: number): Promise<boolean> {
			const rangeStart = (partNum - 1) * PART_SIZE;
			const rangeEnd = rangeStart + 15; // first 16 bytes of the part
			const rangeSigned = await fullClient.sign(mpObjUrl, {
				method: 'GET',
				headers: {
					'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
					Range: `bytes=${rangeStart}-${rangeEnd}`,
				},
			});
			const rangeRes = await fetch(rangeSigned);
			if (rangeRes.status !== 206 && rangeRes.status !== 200) return false;
			const buf = Buffer.from(await rangeRes.arrayBuffer());
			if (buf.length < 4) return false;
			// Check the deterministic pattern: byte 0 = partNum, bytes 1-3 = offset encoding (offset 0)
			return buf[0] === (partNum & 0xff) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
		}

		const t1 = Date.now();
		const verifyPromises: Promise<{ partNumber: number; ok: boolean }>[] = [];
		for (let i = 1; i <= PART_COUNT; i++) {
			verifyPromises.push(verifyPartRange(i).then((ok) => ({ partNumber: i, ok })));
		}
		const verifyResults = await Promise.all(verifyPromises);
		const verifyMs = Date.now() - t1;
		const allVerified = verifyResults.every((r) => r.ok);
		const failedParts = verifyResults.filter((r) => !r.ok).map((r) => r.partNumber);
		if (allVerified) {
			assertTruthy(`multipart: ${PART_COUNT} concurrent range-GETs verified in ${verifyMs}ms`, true);
		} else {
			assertTruthy(`multipart: range-GET verification failed for parts: ${failedParts.join(', ')}`, false);
		}

		// --- Step 6: Concurrent full downloads (stress test) ---
		// Fire CONCURRENCY simultaneous full-object GETs and verify they all return the right size.
		const t2 = Date.now();
		const dlPromises: Promise<{ idx: number; size: number; ok: boolean }>[] = [];
		for (let i = 0; i < CONCURRENCY; i++) {
			dlPromises.push(
				(async () => {
					const signed = await fullClient.sign(mpObjUrl, {
						method: 'GET',
						headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
					});
					const res = await fetch(signed);
					// Stream through to count bytes without buffering into a huge single allocation
					let size = 0;
					let firstByte = -1;
					if (res.body) {
						const reader = res.body.getReader();
						for (;;) {
							const { done, value } = await reader.read();
							if (done) break;
							if (firstByte === -1 && value.length > 0) firstByte = value[0];
							size += value.length;
						}
					}
					return { idx: i, size, ok: size === TOTAL_SIZE && firstByte === 1 };
				})(),
			);
		}
		const dlResults = await Promise.all(dlPromises);
		const dlMs = Date.now() - t2;
		const allDlOk = dlResults.every((r) => r.ok);
		const dlTotalMB = CONCURRENCY * totalMB;
		const dlMbps = ((dlTotalMB * 8) / (dlMs / 1000)).toFixed(1);
		if (allDlOk) {
			assertTruthy(
				`multipart: ${CONCURRENCY} concurrent full downloads (${dlTotalMB} MB total) in ${(dlMs / 1000).toFixed(1)}s (${dlMbps} Mbps)`,
				true,
			);
		} else {
			const failedDl = dlResults.filter((r) => !r.ok);
			for (const f of failedDl) {
				assertTruthy(`multipart: concurrent download #${f.idx} failed (got ${f.size} bytes, expected ${TOTAL_SIZE})`, false);
			}
		}

		// --- Step 7: Cleanup ---
		const delSigned = await fullClient.sign(mpObjUrl, {
			method: 'DELETE',
			headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
		});
		const delRes = await fetch(delSigned);
		assertTruthy(`multipart: DeleteObject -> ${delRes.status}`, delRes.status === 204 || delRes.status === 200);
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
	// Remove from cleanup list since it's already gone
	const s3RevIdx = state.createdS3Creds.indexOf(S3_REVOKE_AK);
	if (s3RevIdx >= 0) state.createdS3Creds.splice(s3RevIdx, 1);

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

	// ─── 19. S3 Resource Scoping at Runtime ─────────────────────

	section('S3 Resource Scoping');

	// 1c. Bucket-scoped credential — wrong bucket should be 403
	// Uses the bucket-scoped credential created in the R2 Binding Validation section
	if (correctBucketAk && correctBucketSk) {
		const bucketScopedClient = s3client(correctBucketAk, correctBucketSk);

		// ListObjectsV2 on the correct bucket -> 200
		const bsListOk = await s3req(bucketScopedClient, 'GET', `/${S3_TEST_BUCKET}?list-type=2&max-keys=1`);
		if (bsListOk.status !== 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  bucket-scoped: list correct bucket -> ${bsListOk.status} (not 403)`);
		} else {
			state.fail++;
			state.errors.push('bucket-scoped: list correct bucket should not be 403');
			console.log(`  ${red('FAIL')}  bucket-scoped: list correct bucket got 403`);
		}

		// ListObjectsV2 on a wrong bucket -> 403
		const bsListBad = await s3req(bucketScopedClient, 'GET', '/wrong-bucket-name?list-type=2&max-keys=1');
		if (bsListBad.status === 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  bucket-scoped: list wrong bucket -> 403`);
		} else {
			state.fail++;
			state.errors.push(`bucket-scoped: list wrong bucket should be 403, got ${bsListBad.status}`);
			console.log(`  ${red('FAIL')}  bucket-scoped: list wrong bucket (got ${bsListBad.status})`);
		}

		// GetObject from correct bucket -> not 403 (404 if key doesn't exist, that's fine)
		const bsGetOk = await s3req(bucketScopedClient, 'GET', `/${S3_TEST_BUCKET}/nonexistent-scope-test.txt`);
		if (bsGetOk.status !== 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  bucket-scoped: get from correct bucket -> ${bsGetOk.status} (not 403)`);
		} else {
			state.fail++;
			state.errors.push('bucket-scoped: get from correct bucket should not be 403');
			console.log(`  ${red('FAIL')}  bucket-scoped: get from correct bucket got 403`);
		}

		// GetObject from wrong bucket -> 403
		const bsGetBad = await s3req(bucketScopedClient, 'GET', '/wrong-bucket-name/some-key.txt');
		if (bsGetBad.status === 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  bucket-scoped: get from wrong bucket -> 403`);
		} else {
			state.fail++;
			state.errors.push(`bucket-scoped: get from wrong bucket should be 403, got ${bsGetBad.status}`);
			console.log(`  ${red('FAIL')}  bucket-scoped: get from wrong bucket (got ${bsGetBad.status})`);
		}
	}

	// 1d. Object-prefix-scoped credential — wrong prefix should be 403
	section('S3 Prefix Scoping');

	const PREFIX_S3_POLICY = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
				resources: ['account:*', `bucket:${S3_TEST_BUCKET}`, `object:${S3_TEST_BUCKET}/images/*`],
			},
		],
	};
	const prefixCred = await admin('POST', '/admin/s3/credentials', {
		name: 'smoke-s3-prefix-scoped',
		policy: PREFIX_S3_POLICY,
		upstream_token_id: ctx.s3UpstreamId,
	});
	assertStatus('create prefix-scoped S3 cred -> 200', prefixCred, 200);
	const prefixAk = prefixCred.body?.result?.credential?.access_key_id;
	const prefixSk = prefixCred.body?.result?.credential?.secret_access_key;
	if (prefixAk) state.createdS3Creds.push(prefixAk);

	if (prefixAk && prefixSk) {
		const prefixClient = s3client(prefixAk, prefixSk);

		// PutObject to images/smoke-test.jpg -> 200
		const pfPutOkUrl = `${BASE}/s3/${S3_TEST_BUCKET}/images/smoke-test-${Date.now()}.jpg`;
		const pfPutOkSigned = await prefixClient.sign(pfPutOkUrl, {
			method: 'PUT',
			headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'content-type': 'image/jpeg' },
			body: 'fake image data',
		});
		const pfPutOkRes = await fetch(pfPutOkSigned);
		if (pfPutOkRes.ok) {
			state.pass++;
			console.log(`  ${green('PASS')}  prefix-scoped: put to images/ -> ${pfPutOkRes.status}`);
		} else {
			state.fail++;
			state.errors.push(`prefix-scoped: put to images/ should succeed, got ${pfPutOkRes.status}`);
			console.log(`  ${red('FAIL')}  prefix-scoped: put to images/ (got ${pfPutOkRes.status})`);
		}
		// Clean up the object we just created
		const pfCleanUrl = pfPutOkUrl;
		try {
			const cleanSigned = await fullClient.sign(pfCleanUrl, {
				method: 'DELETE',
				headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
			});
			await fetch(cleanSigned);
		} catch {
			/* best effort */
		}

		// GetObject from images/ -> not 403
		const pfGetOk = await s3req(prefixClient, 'GET', `/${S3_TEST_BUCKET}/images/nonexistent.jpg`);
		if (pfGetOk.status !== 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  prefix-scoped: get from images/ -> ${pfGetOk.status} (not 403)`);
		} else {
			state.fail++;
			state.errors.push('prefix-scoped: get from images/ should not be 403');
			console.log(`  ${red('FAIL')}  prefix-scoped: get from images/ got 403`);
		}

		// GetObject from secrets/ -> 403
		const pfGetBad = await s3req(prefixClient, 'GET', `/${S3_TEST_BUCKET}/secrets/forbidden.txt`);
		if (pfGetBad.status === 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  prefix-scoped: get from secrets/ -> 403`);
		} else {
			state.fail++;
			state.errors.push(`prefix-scoped: get from secrets/ should be 403, got ${pfGetBad.status}`);
			console.log(`  ${red('FAIL')}  prefix-scoped: get from secrets/ (got ${pfGetBad.status})`);
		}

		// PutObject to secrets/ -> 403
		const pfPutBadUrl = `${BASE}/s3/${S3_TEST_BUCKET}/secrets/forbidden-${Date.now()}.txt`;
		const pfPutBadSigned = await prefixClient.sign(pfPutBadUrl, {
			method: 'PUT',
			headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'content-type': 'text/plain' },
			body: 'should be denied',
		});
		const pfPutBadRes = await fetch(pfPutBadSigned);
		if (pfPutBadRes.status === 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  prefix-scoped: put to secrets/ -> 403`);
		} else {
			state.fail++;
			state.errors.push(`prefix-scoped: put to secrets/ should be 403, got ${pfPutBadRes.status}`);
			console.log(`  ${red('FAIL')}  prefix-scoped: put to secrets/ (got ${pfPutBadRes.status})`);
		}
		if (pfPutBadRes.body && !pfPutBadRes.bodyUsed) await pfPutBadRes.text().catch(() => {});
	}

	// 7a. S3 resource-scoped deny: allow bucket-wide, deny GetObject on secrets/ prefix
	section('S3 Resource-Scoped Deny');

	const DENY_PREFIX_POLICY = {
		version: '2025-01-01',
		statements: [
			{ effect: 'allow', actions: ['s3:*'], resources: ['account:*', `bucket:${S3_TEST_BUCKET}`, `object:${S3_TEST_BUCKET}/*`] },
			{ effect: 'deny', actions: ['s3:GetObject'], resources: [`object:${S3_TEST_BUCKET}/secrets/*`] },
		],
	};
	const denyPrefixCred = await admin('POST', '/admin/s3/credentials', {
		name: 'smoke-s3-deny-prefix',
		policy: DENY_PREFIX_POLICY,
		upstream_token_id: ctx.s3UpstreamId,
	});
	assertStatus('create deny-prefix S3 cred -> 200', denyPrefixCred, 200);
	const dpfAk = denyPrefixCred.body?.result?.credential?.access_key_id;
	const dpfSk = denyPrefixCred.body?.result?.credential?.secret_access_key;
	if (dpfAk) state.createdS3Creds.push(dpfAk);

	if (dpfAk && dpfSk) {
		const dpfClient = s3client(dpfAk, dpfSk);

		// PutObject to public/test.txt -> 200 (deny doesn't cover PutObject)
		const dpfPutPubTs = Date.now();
		const dpfPutPubUrl = `${BASE}/s3/${S3_TEST_BUCKET}/public/test-${dpfPutPubTs}.txt`;
		const dpfPutPubSigned = await dpfClient.sign(dpfPutPubUrl, {
			method: 'PUT',
			headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'content-type': 'text/plain' },
			body: 'public content',
		});
		const dpfPutPubRes = await fetch(dpfPutPubSigned);
		if (dpfPutPubRes.ok) {
			state.pass++;
			console.log(`  ${green('PASS')}  deny-prefix: put to public/ -> ${dpfPutPubRes.status}`);
		} else {
			state.fail++;
			state.errors.push(`deny-prefix: put to public/ should succeed, got ${dpfPutPubRes.status}`);
			console.log(`  ${red('FAIL')}  deny-prefix: put to public/ (got ${dpfPutPubRes.status})`);
		}

		// GetObject from public/test.txt -> 200 (deny resource doesn't match public/)
		const dpfGetPub = await s3req(dpfClient, 'GET', `/${S3_TEST_BUCKET}/public/test-${dpfPutPubTs}.txt`);
		if (dpfGetPub.status !== 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  deny-prefix: get from public/ -> ${dpfGetPub.status} (not 403)`);
		} else {
			state.fail++;
			state.errors.push('deny-prefix: get from public/ should not be 403');
			console.log(`  ${red('FAIL')}  deny-prefix: get from public/ got 403`);
		}

		// PutObject to secrets/key.txt -> 200 (deny only covers s3:GetObject, not PutObject)
		const dpfPutSecTs = Date.now();
		const dpfPutSecUrl = `${BASE}/s3/${S3_TEST_BUCKET}/secrets/key-${dpfPutSecTs}.txt`;
		const dpfPutSecSigned = await dpfClient.sign(dpfPutSecUrl, {
			method: 'PUT',
			headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'content-type': 'text/plain' },
			body: 'secret content',
		});
		const dpfPutSecRes = await fetch(dpfPutSecSigned);
		if (dpfPutSecRes.ok) {
			state.pass++;
			console.log(`  ${green('PASS')}  deny-prefix: put to secrets/ -> ${dpfPutSecRes.status} (deny is GetObject only)`);
		} else {
			state.fail++;
			state.errors.push(`deny-prefix: put to secrets/ should succeed, got ${dpfPutSecRes.status}`);
			console.log(`  ${red('FAIL')}  deny-prefix: put to secrets/ (got ${dpfPutSecRes.status})`);
		}

		// GetObject from secrets/key.txt -> 403 (deny matches: s3:GetObject + object:bucket/secrets/*)
		const dpfGetSec = await s3req(dpfClient, 'GET', `/${S3_TEST_BUCKET}/secrets/key-${dpfPutSecTs}.txt`);
		if (dpfGetSec.status === 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  deny-prefix: get from secrets/ -> 403 (deny fires)`);
		} else {
			state.fail++;
			state.errors.push(`deny-prefix: get from secrets/ should be 403, got ${dpfGetSec.status}`);
			console.log(`  ${red('FAIL')}  deny-prefix: get from secrets/ (got ${dpfGetSec.status})`);
		}

		// Clean up test objects with full-access client
		for (const cleanPath of [
			`/s3/${S3_TEST_BUCKET}/public/test-${dpfPutPubTs}.txt`,
			`/s3/${S3_TEST_BUCKET}/secrets/key-${dpfPutSecTs}.txt`,
		]) {
			try {
				const cleanUrl = `${BASE}${cleanPath}`;
				const cleanSigned = await fullClient.sign(cleanUrl, {
					method: 'DELETE',
					headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
				});
				await fetch(cleanSigned);
			} catch {
				/* best effort */
			}
		}
	}

	// ─── 20. S3 Exact Object Key Scoping ───────────────────────

	section('S3 Exact Object Key Scoping');

	// Credential scoped to a single exact object — not a prefix, one specific key
	const EXACT_OBJ_POLICY = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['s3:GetObject', 's3:PutObject'],
				resources: [`object:${S3_TEST_BUCKET}/config/app.json`],
			},
		],
	};
	const exactObjCred = await admin('POST', '/admin/s3/credentials', {
		name: 'smoke-s3-exact-obj',
		policy: EXACT_OBJ_POLICY,
		upstream_token_id: ctx.s3UpstreamId,
	});
	assertStatus('create exact-object S3 cred -> 200', exactObjCred, 200);
	const eoAk = exactObjCred.body?.result?.credential?.access_key_id;
	const eoSk = exactObjCred.body?.result?.credential?.secret_access_key;
	if (eoAk) state.createdS3Creds.push(eoAk);

	if (eoAk && eoSk) {
		const eoClient = s3client(eoAk, eoSk);

		// Put to exact key -> 200
		const eoPutOkUrl = `${BASE}/s3/${S3_TEST_BUCKET}/config/app.json`;
		const eoPutSigned = await eoClient.sign(eoPutOkUrl, {
			method: 'PUT',
			headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'content-type': 'application/json' },
			body: '{"env":"test"}',
		});
		const eoPutRes = await fetch(eoPutSigned);
		if (eoPutRes.ok) {
			state.pass++;
			console.log(`  ${green('PASS')}  exact-obj: put config/app.json -> ${eoPutRes.status}`);
		} else {
			state.fail++;
			state.errors.push(`exact-obj: put config/app.json should succeed, got ${eoPutRes.status}`);
			console.log(`  ${red('FAIL')}  exact-obj: put config/app.json (got ${eoPutRes.status})`);
		}

		// Get exact key -> not 403
		const eoGetOk = await s3req(eoClient, 'GET', `/${S3_TEST_BUCKET}/config/app.json`);
		if (eoGetOk.status !== 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  exact-obj: get config/app.json -> ${eoGetOk.status} (not 403)`);
		} else {
			state.fail++;
			state.errors.push('exact-obj: get config/app.json should not be 403');
			console.log(`  ${red('FAIL')}  exact-obj: get config/app.json got 403`);
		}

		// Get a different key in same directory -> 403
		const eoGetBad = await s3req(eoClient, 'GET', `/${S3_TEST_BUCKET}/config/db.json`);
		if (eoGetBad.status === 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  exact-obj: get config/db.json -> 403 (different key)`);
		} else {
			state.fail++;
			state.errors.push(`exact-obj: get config/db.json should be 403, got ${eoGetBad.status}`);
			console.log(`  ${red('FAIL')}  exact-obj: get config/db.json (got ${eoGetBad.status})`);
		}

		// Get a key in a completely different path -> 403
		const eoGetOther = await s3req(eoClient, 'GET', `/${S3_TEST_BUCKET}/data/report.csv`);
		if (eoGetOther.status === 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  exact-obj: get data/report.csv -> 403`);
		} else {
			state.fail++;
			state.errors.push(`exact-obj: get data/report.csv should be 403, got ${eoGetOther.status}`);
			console.log(`  ${red('FAIL')}  exact-obj: get data/report.csv (got ${eoGetOther.status})`);
		}

		// ListBuckets -> 403 (no account:* resource)
		const eoLb = await s3req(eoClient, 'GET', '/');
		if (eoLb.status === 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  exact-obj: ListBuckets -> 403 (no account:*)`);
		} else {
			state.fail++;
			state.errors.push(`exact-obj: ListBuckets should be 403, got ${eoLb.status}`);
			console.log(`  ${red('FAIL')}  exact-obj: ListBuckets (got ${eoLb.status})`);
		}

		// Clean up
		try {
			const cleanSigned = await fullClient.sign(eoPutOkUrl, {
				method: 'DELETE',
				headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
			});
			await fetch(cleanSigned);
		} catch {
			/* best effort */
		}
	}

	// ─── 21. S3 Multiple Prefix Patterns ────────────────────────

	section('S3 Multiple Prefix Patterns');

	// Credential that allows images/* and docs/* but NOT secrets/* or anything else
	const MULTI_PREFIX_POLICY = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['s3:GetObject', 's3:PutObject'],
				resources: [`object:${S3_TEST_BUCKET}/images/*`, `object:${S3_TEST_BUCKET}/docs/*`],
			},
			{
				effect: 'allow',
				actions: ['s3:ListBucket'],
				resources: [`bucket:${S3_TEST_BUCKET}`],
			},
		],
	};
	const mpCred = await admin('POST', '/admin/s3/credentials', {
		name: 'smoke-s3-multi-prefix',
		policy: MULTI_PREFIX_POLICY,
		upstream_token_id: ctx.s3UpstreamId,
	});
	assertStatus('create multi-prefix S3 cred -> 200', mpCred, 200);
	const mpAk = mpCred.body?.result?.credential?.access_key_id;
	const mpSk = mpCred.body?.result?.credential?.secret_access_key;
	if (mpAk) state.createdS3Creds.push(mpAk);

	if (mpAk && mpSk) {
		const mpClient = s3client(mpAk, mpSk);

		// Get from images/ -> not 403
		const mpImgOk = await s3req(mpClient, 'GET', `/${S3_TEST_BUCKET}/images/photo.jpg`);
		if (mpImgOk.status !== 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  multi-prefix: get images/ -> ${mpImgOk.status} (not 403)`);
		} else {
			state.fail++;
			state.errors.push('multi-prefix: get images/ should not be 403');
			console.log(`  ${red('FAIL')}  multi-prefix: get images/ got 403`);
		}

		// Get from docs/ -> not 403
		const mpDocsOk = await s3req(mpClient, 'GET', `/${S3_TEST_BUCKET}/docs/readme.md`);
		if (mpDocsOk.status !== 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  multi-prefix: get docs/ -> ${mpDocsOk.status} (not 403)`);
		} else {
			state.fail++;
			state.errors.push('multi-prefix: get docs/ should not be 403');
			console.log(`  ${red('FAIL')}  multi-prefix: get docs/ got 403`);
		}

		// Get from secrets/ -> 403
		const mpSecBad = await s3req(mpClient, 'GET', `/${S3_TEST_BUCKET}/secrets/token.txt`);
		if (mpSecBad.status === 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  multi-prefix: get secrets/ -> 403`);
		} else {
			state.fail++;
			state.errors.push(`multi-prefix: get secrets/ should be 403, got ${mpSecBad.status}`);
			console.log(`  ${red('FAIL')}  multi-prefix: get secrets/ (got ${mpSecBad.status})`);
		}

		// Get from root-level key -> 403
		const mpRootBad = await s3req(mpClient, 'GET', `/${S3_TEST_BUCKET}/root-file.txt`);
		if (mpRootBad.status === 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  multi-prefix: get root-level key -> 403`);
		} else {
			state.fail++;
			state.errors.push(`multi-prefix: get root-level key should be 403, got ${mpRootBad.status}`);
			console.log(`  ${red('FAIL')}  multi-prefix: get root-level (got ${mpRootBad.status})`);
		}

		// List bucket -> 200 (has bucket resource)
		const mpListOk = await s3req(mpClient, 'GET', `/${S3_TEST_BUCKET}?list-type=2&max-keys=1`);
		if (mpListOk.status !== 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  multi-prefix: list bucket -> ${mpListOk.status} (not 403)`);
		} else {
			state.fail++;
			state.errors.push('multi-prefix: list bucket should not be 403');
			console.log(`  ${red('FAIL')}  multi-prefix: list bucket got 403`);
		}
	}

	// ─── 22. S3 Key Extension Condition ─────────────────────────

	section('S3 Key Extension Condition');

	// Allow PutObject only for .jpg and .png files
	const EXT_POLICY = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['s3:PutObject', 's3:GetObject'],
				resources: ['account:*', `bucket:${S3_TEST_BUCKET}`, `object:${S3_TEST_BUCKET}/*`],
				conditions: [{ field: 'key.extension', operator: 'in', value: ['jpg', 'png', 'webp'] }],
			},
		],
	};
	const extCred = await admin('POST', '/admin/s3/credentials', {
		name: 'smoke-s3-ext-cond',
		policy: EXT_POLICY,
		upstream_token_id: ctx.s3UpstreamId,
	});
	assertStatus('create extension-condition S3 cred -> 200', extCred, 200);
	const extAk = extCred.body?.result?.credential?.access_key_id;
	const extSk = extCred.body?.result?.credential?.secret_access_key;
	if (extAk) state.createdS3Creds.push(extAk);

	if (extAk && extSk) {
		const extClient = s3client(extAk, extSk);

		// Put .jpg -> 200
		const extPutJpgUrl = `${BASE}/s3/${S3_TEST_BUCKET}/uploads/photo-${Date.now()}.jpg`;
		const extPutJpgSigned = await extClient.sign(extPutJpgUrl, {
			method: 'PUT',
			headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'content-type': 'image/jpeg' },
			body: 'fake jpg',
		});
		const extPutJpgRes = await fetch(extPutJpgSigned);
		if (extPutJpgRes.ok) {
			state.pass++;
			console.log(`  ${green('PASS')}  ext-cond: put .jpg -> ${extPutJpgRes.status}`);
		} else {
			state.fail++;
			state.errors.push(`ext-cond: put .jpg should succeed, got ${extPutJpgRes.status}`);
			console.log(`  ${red('FAIL')}  ext-cond: put .jpg (got ${extPutJpgRes.status})`);
		}
		// Clean up
		try {
			const cs = await fullClient.sign(extPutJpgUrl, {
				method: 'DELETE',
				headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
			});
			await fetch(cs);
		} catch {
			/* best effort */
		}

		// Put .txt -> 403 (extension not in allowed set)
		const extPutTxtUrl = `${BASE}/s3/${S3_TEST_BUCKET}/uploads/doc-${Date.now()}.txt`;
		const extPutTxtSigned = await extClient.sign(extPutTxtUrl, {
			method: 'PUT',
			headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'content-type': 'text/plain' },
			body: 'not allowed',
		});
		const extPutTxtRes = await fetch(extPutTxtSigned);
		if (extPutTxtRes.status === 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  ext-cond: put .txt -> 403 (wrong extension)`);
		} else {
			state.fail++;
			state.errors.push(`ext-cond: put .txt should be 403, got ${extPutTxtRes.status}`);
			console.log(`  ${red('FAIL')}  ext-cond: put .txt (got ${extPutTxtRes.status})`);
		}
		if (extPutTxtRes.body && !extPutTxtRes.bodyUsed) await extPutTxtRes.text().catch(() => {});

		// Get .png -> not 403
		const extGetPng = await s3req(extClient, 'GET', `/${S3_TEST_BUCKET}/images/logo.png`);
		if (extGetPng.status !== 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  ext-cond: get .png -> ${extGetPng.status} (not 403)`);
		} else {
			state.fail++;
			state.errors.push('ext-cond: get .png should not be 403');
			console.log(`  ${red('FAIL')}  ext-cond: get .png got 403`);
		}

		// Get .exe -> 403
		const extGetExe = await s3req(extClient, 'GET', `/${S3_TEST_BUCKET}/bin/malware.exe`);
		if (extGetExe.status === 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  ext-cond: get .exe -> 403`);
		} else {
			state.fail++;
			state.errors.push(`ext-cond: get .exe should be 403, got ${extGetExe.status}`);
			console.log(`  ${red('FAIL')}  ext-cond: get .exe (got ${extGetExe.status})`);
		}
	}

	// ─── 23. S3 Key Prefix Condition ────────────────────────────

	section('S3 Key Prefix Condition');

	// Allow all s3 ops but only on keys under uploads/ directory (using key.prefix field)
	const KEY_PREFIX_POLICY = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
				resources: ['account:*', `bucket:${S3_TEST_BUCKET}`, `object:${S3_TEST_BUCKET}/*`],
				conditions: [{ field: 'key.prefix', operator: 'eq', value: 'uploads/' }],
			},
		],
	};
	const kpCred = await admin('POST', '/admin/s3/credentials', {
		name: 'smoke-s3-key-prefix',
		policy: KEY_PREFIX_POLICY,
		upstream_token_id: ctx.s3UpstreamId,
	});
	assertStatus('create key-prefix S3 cred -> 200', kpCred, 200);
	const kpAk = kpCred.body?.result?.credential?.access_key_id;
	const kpSk = kpCred.body?.result?.credential?.secret_access_key;
	if (kpAk) state.createdS3Creds.push(kpAk);

	if (kpAk && kpSk) {
		const kpClient = s3client(kpAk, kpSk);

		// Get from uploads/ -> not 403
		const kpGetOk = await s3req(kpClient, 'GET', `/${S3_TEST_BUCKET}/uploads/file.txt`);
		if (kpGetOk.status !== 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  key-prefix: get uploads/file.txt -> ${kpGetOk.status} (not 403)`);
		} else {
			state.fail++;
			state.errors.push('key-prefix: get uploads/file.txt should not be 403');
			console.log(`  ${red('FAIL')}  key-prefix: get uploads/file.txt got 403`);
		}

		// Get from downloads/ -> 403 (different prefix)
		const kpGetBad = await s3req(kpClient, 'GET', `/${S3_TEST_BUCKET}/downloads/file.txt`);
		if (kpGetBad.status === 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  key-prefix: get downloads/file.txt -> 403`);
		} else {
			state.fail++;
			state.errors.push(`key-prefix: get downloads/file.txt should be 403, got ${kpGetBad.status}`);
			console.log(`  ${red('FAIL')}  key-prefix: get downloads/file.txt (got ${kpGetBad.status})`);
		}

		// Get root-level key (no prefix) -> 403
		const kpGetRoot = await s3req(kpClient, 'GET', `/${S3_TEST_BUCKET}/root.txt`);
		if (kpGetRoot.status === 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  key-prefix: get root.txt (no prefix) -> 403`);
		} else {
			state.fail++;
			state.errors.push(`key-prefix: get root.txt should be 403, got ${kpGetRoot.status}`);
			console.log(`  ${red('FAIL')}  key-prefix: get root.txt (got ${kpGetRoot.status})`);
		}
	}

	// ─── 24. S3 Nested Directory Deny ───────────────────────────

	section('S3 Nested Directory Deny');

	// Allow s3:* on bucket, deny GetObject + PutObject on secrets/** AND deny DeleteObject on archive/**
	const NESTED_DENY_POLICY = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['s3:*'],
				resources: ['account:*', `bucket:${S3_TEST_BUCKET}`, `object:${S3_TEST_BUCKET}/*`],
			},
			{
				effect: 'deny',
				actions: ['s3:GetObject', 's3:PutObject'],
				resources: [`object:${S3_TEST_BUCKET}/secrets/*`],
			},
			{
				effect: 'deny',
				actions: ['s3:DeleteObject'],
				resources: [`object:${S3_TEST_BUCKET}/archive/*`],
			},
		],
	};
	const ndCred = await admin('POST', '/admin/s3/credentials', {
		name: 'smoke-s3-nested-deny',
		policy: NESTED_DENY_POLICY,
		upstream_token_id: ctx.s3UpstreamId,
	});
	assertStatus('create nested-deny S3 cred -> 200', ndCred, 200);
	const ndAk = ndCred.body?.result?.credential?.access_key_id;
	const ndSk = ndCred.body?.result?.credential?.secret_access_key;
	if (ndAk) state.createdS3Creds.push(ndAk);

	if (ndAk && ndSk) {
		const ndClient = s3client(ndAk, ndSk);

		// GetObject from public/ -> not 403 (no deny matches)
		const ndGetPub = await s3req(ndClient, 'GET', `/${S3_TEST_BUCKET}/public/page.html`);
		if (ndGetPub.status !== 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  nested-deny: get public/ -> ${ndGetPub.status} (allowed)`);
		} else {
			state.fail++;
			state.errors.push('nested-deny: get public/ should not be 403');
			console.log(`  ${red('FAIL')}  nested-deny: get public/ got 403`);
		}

		// GetObject from secrets/ -> 403
		const ndGetSec = await s3req(ndClient, 'GET', `/${S3_TEST_BUCKET}/secrets/api-key.txt`);
		if (ndGetSec.status === 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  nested-deny: get secrets/ -> 403`);
		} else {
			state.fail++;
			state.errors.push(`nested-deny: get secrets/ should be 403, got ${ndGetSec.status}`);
			console.log(`  ${red('FAIL')}  nested-deny: get secrets/ (got ${ndGetSec.status})`);
		}

		// PutObject to secrets/ -> 403
		const ndPutSecUrl = `${BASE}/s3/${S3_TEST_BUCKET}/secrets/new-${Date.now()}.txt`;
		const ndPutSecSigned = await ndClient.sign(ndPutSecUrl, {
			method: 'PUT',
			headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'content-type': 'text/plain' },
			body: 'denied',
		});
		const ndPutSecRes = await fetch(ndPutSecSigned);
		if (ndPutSecRes.status === 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  nested-deny: put secrets/ -> 403`);
		} else {
			state.fail++;
			state.errors.push(`nested-deny: put secrets/ should be 403, got ${ndPutSecRes.status}`);
			console.log(`  ${red('FAIL')}  nested-deny: put secrets/ (got ${ndPutSecRes.status})`);
		}
		if (ndPutSecRes.body && !ndPutSecRes.bodyUsed) await ndPutSecRes.text().catch(() => {});

		// DeleteObject from secrets/ -> not 403 (deny is only GetObject+PutObject on secrets)
		const ndDelSec = await s3req(ndClient, 'DELETE', `/${S3_TEST_BUCKET}/secrets/nonexistent.txt`);
		if (ndDelSec.status !== 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  nested-deny: delete secrets/ -> ${ndDelSec.status} (delete not denied)`);
		} else {
			state.fail++;
			state.errors.push('nested-deny: delete secrets/ should not be 403 (only get+put denied)');
			console.log(`  ${red('FAIL')}  nested-deny: delete secrets/ got 403`);
		}

		// DeleteObject from archive/ -> 403
		const ndDelArch = await s3req(ndClient, 'DELETE', `/${S3_TEST_BUCKET}/archive/old-report.pdf`);
		if (ndDelArch.status === 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  nested-deny: delete archive/ -> 403`);
		} else {
			state.fail++;
			state.errors.push(`nested-deny: delete archive/ should be 403, got ${ndDelArch.status}`);
			console.log(`  ${red('FAIL')}  nested-deny: delete archive/ (got ${ndDelArch.status})`);
		}

		// PutObject to archive/ -> not 403 (deny is only DeleteObject on archive)
		const ndPutArchUrl = `${BASE}/s3/${S3_TEST_BUCKET}/archive/new-${Date.now()}.txt`;
		const ndPutArchSigned = await ndClient.sign(ndPutArchUrl, {
			method: 'PUT',
			headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'content-type': 'text/plain' },
			body: 'allowed',
		});
		const ndPutArchRes = await fetch(ndPutArchSigned);
		if (ndPutArchRes.ok) {
			state.pass++;
			console.log(`  ${green('PASS')}  nested-deny: put archive/ -> ${ndPutArchRes.status} (not denied)`);
		} else {
			state.fail++;
			state.errors.push(`nested-deny: put archive/ should succeed, got ${ndPutArchRes.status}`);
			console.log(`  ${red('FAIL')}  nested-deny: put archive/ (got ${ndPutArchRes.status})`);
		}
		// Clean up
		try {
			const cs = await fullClient.sign(ndPutArchUrl, {
				method: 'DELETE',
				headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
			});
			await fetch(cs);
		} catch {
			/* best effort */
		}

		// ListBuckets -> 200 (has account:*)
		const ndLb = await s3req(ndClient, 'GET', '/');
		if (ndLb.status === 200) {
			state.pass++;
			console.log(`  ${green('PASS')}  nested-deny: ListBuckets -> 200`);
		} else {
			state.fail++;
			state.errors.push(`nested-deny: ListBuckets should be 200, got ${ndLb.status}`);
			console.log(`  ${red('FAIL')}  nested-deny: ListBuckets (got ${ndLb.status})`);
		}
	}

	// ─── 25. S3 Deny by Extension (no .exe, .sh, .bat) ─────────

	section('S3 Deny by Extension');

	const DENY_EXT_POLICY = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['s3:*'],
				resources: ['account:*', `bucket:${S3_TEST_BUCKET}`, `object:${S3_TEST_BUCKET}/*`],
			},
			{
				effect: 'deny',
				actions: ['s3:PutObject'],
				resources: [`object:${S3_TEST_BUCKET}/*`],
				conditions: [{ field: 'key.extension', operator: 'in', value: ['exe', 'sh', 'bat'] }],
			},
		],
	};
	const deCred = await admin('POST', '/admin/s3/credentials', {
		name: 'smoke-s3-deny-ext',
		policy: DENY_EXT_POLICY,
		upstream_token_id: ctx.s3UpstreamId,
	});
	assertStatus('create deny-extension S3 cred -> 200', deCred, 200);
	const deAk = deCred.body?.result?.credential?.access_key_id;
	const deSk = deCred.body?.result?.credential?.secret_access_key;
	if (deAk) state.createdS3Creds.push(deAk);

	if (deAk && deSk) {
		const deClient = s3client(deAk, deSk);

		// Put .txt -> 200
		const dePutTxtTs = Date.now();
		const dePutTxtUrl = `${BASE}/s3/${S3_TEST_BUCKET}/safe-${dePutTxtTs}.txt`;
		const dePutTxtSigned = await deClient.sign(dePutTxtUrl, {
			method: 'PUT',
			headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'content-type': 'text/plain' },
			body: 'safe file',
		});
		const dePutTxtRes = await fetch(dePutTxtSigned);
		if (dePutTxtRes.ok) {
			state.pass++;
			console.log(`  ${green('PASS')}  deny-ext: put .txt -> ${dePutTxtRes.status}`);
		} else {
			state.fail++;
			state.errors.push(`deny-ext: put .txt should succeed, got ${dePutTxtRes.status}`);
			console.log(`  ${red('FAIL')}  deny-ext: put .txt (got ${dePutTxtRes.status})`);
		}
		// Clean up
		try {
			const cs = await fullClient.sign(dePutTxtUrl, {
				method: 'DELETE',
				headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
			});
			await fetch(cs);
		} catch {
			/* best effort */
		}

		// Put .exe -> 403
		const dePutExeUrl = `${BASE}/s3/${S3_TEST_BUCKET}/malware-${Date.now()}.exe`;
		const dePutExeSigned = await deClient.sign(dePutExeUrl, {
			method: 'PUT',
			headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'content-type': 'application/octet-stream' },
			body: 'not allowed',
		});
		const dePutExeRes = await fetch(dePutExeSigned);
		if (dePutExeRes.status === 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  deny-ext: put .exe -> 403`);
		} else {
			state.fail++;
			state.errors.push(`deny-ext: put .exe should be 403, got ${dePutExeRes.status}`);
			console.log(`  ${red('FAIL')}  deny-ext: put .exe (got ${dePutExeRes.status})`);
		}
		if (dePutExeRes.body && !dePutExeRes.bodyUsed) await dePutExeRes.text().catch(() => {});

		// Put .sh -> 403
		const dePutShUrl = `${BASE}/s3/${S3_TEST_BUCKET}/script-${Date.now()}.sh`;
		const dePutShSigned = await deClient.sign(dePutShUrl, {
			method: 'PUT',
			headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'content-type': 'text/plain' },
			body: '#!/bin/bash',
		});
		const dePutShRes = await fetch(dePutShSigned);
		if (dePutShRes.status === 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  deny-ext: put .sh -> 403`);
		} else {
			state.fail++;
			state.errors.push(`deny-ext: put .sh should be 403, got ${dePutShRes.status}`);
			console.log(`  ${red('FAIL')}  deny-ext: put .sh (got ${dePutShRes.status})`);
		}
		if (dePutShRes.body && !dePutShRes.bodyUsed) await dePutShRes.text().catch(() => {});

		// GetObject .exe -> not 403 (deny only on PutObject)
		const deGetExe = await s3req(deClient, 'GET', `/${S3_TEST_BUCKET}/nonexistent.exe`);
		if (deGetExe.status !== 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  deny-ext: get .exe -> ${deGetExe.status} (deny only on put)`);
		} else {
			state.fail++;
			state.errors.push('deny-ext: get .exe should not be 403 (deny on put only)');
			console.log(`  ${red('FAIL')}  deny-ext: get .exe got 403`);
		}
	}

	// ─── 26. S3 Overlapping Allow + Deny Prefixes ───────────────

	section('S3 Overlapping Allow + Deny Prefixes');

	// Allow entire bucket, deny secrets/*, but re-allow secrets/public/*
	// Note: deny overrides allow in AWS/GK model, so secrets/public/* should still be denied
	const OVERLAP_POLICY = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['s3:*'],
				resources: ['account:*', `bucket:${S3_TEST_BUCKET}`, `object:${S3_TEST_BUCKET}/*`],
			},
			{
				effect: 'deny',
				actions: ['s3:GetObject'],
				resources: [`object:${S3_TEST_BUCKET}/restricted/*`],
			},
			{
				effect: 'allow',
				actions: ['s3:GetObject'],
				resources: [`object:${S3_TEST_BUCKET}/restricted/public-readme.txt`],
			},
		],
	};
	const olCred = await admin('POST', '/admin/s3/credentials', {
		name: 'smoke-s3-overlap',
		policy: OVERLAP_POLICY,
		upstream_token_id: ctx.s3UpstreamId,
	});
	assertStatus('create overlap S3 cred -> 200', olCred, 200);
	const olAk = olCred.body?.result?.credential?.access_key_id;
	const olSk = olCred.body?.result?.credential?.secret_access_key;
	if (olAk) state.createdS3Creds.push(olAk);

	if (olAk && olSk) {
		const olClient = s3client(olAk, olSk);

		// GetObject from public/ -> not 403
		const olGetPub = await s3req(olClient, 'GET', `/${S3_TEST_BUCKET}/public/hello.txt`);
		if (olGetPub.status !== 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  overlap: get public/ -> ${olGetPub.status} (allowed)`);
		} else {
			state.fail++;
			state.errors.push('overlap: get public/ should not be 403');
			console.log(`  ${red('FAIL')}  overlap: get public/ got 403`);
		}

		// GetObject from restricted/secret.txt -> 403 (deny matches)
		const olGetSec = await s3req(olClient, 'GET', `/${S3_TEST_BUCKET}/restricted/secret.txt`);
		if (olGetSec.status === 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  overlap: get restricted/secret.txt -> 403`);
		} else {
			state.fail++;
			state.errors.push(`overlap: get restricted/secret.txt should be 403, got ${olGetSec.status}`);
			console.log(`  ${red('FAIL')}  overlap: get restricted/secret.txt (got ${olGetSec.status})`);
		}

		// GetObject from restricted/public-readme.txt -> 403 (deny overrides allow in deny-first model)
		const olGetPubReadme = await s3req(olClient, 'GET', `/${S3_TEST_BUCKET}/restricted/public-readme.txt`);
		if (olGetPubReadme.status === 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  overlap: get restricted/public-readme.txt -> 403 (deny overrides allow)`);
		} else {
			state.fail++;
			state.errors.push(`overlap: get restricted/public-readme.txt should be 403 (deny overrides), got ${olGetPubReadme.status}`);
			console.log(`  ${red('FAIL')}  overlap: get restricted/public-readme.txt (got ${olGetPubReadme.status})`);
		}

		// PutObject to restricted/ -> not 403 (deny only on GetObject)
		const olPutSecUrl = `${BASE}/s3/${S3_TEST_BUCKET}/restricted/new-${Date.now()}.txt`;
		const olPutSecSigned = await olClient.sign(olPutSecUrl, {
			method: 'PUT',
			headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'content-type': 'text/plain' },
			body: 'writing to restricted is ok',
		});
		const olPutSecRes = await fetch(olPutSecSigned);
		if (olPutSecRes.ok) {
			state.pass++;
			console.log(`  ${green('PASS')}  overlap: put restricted/ -> ${olPutSecRes.status} (deny on get only)`);
		} else {
			state.fail++;
			state.errors.push(`overlap: put restricted/ should succeed, got ${olPutSecRes.status}`);
			console.log(`  ${red('FAIL')}  overlap: put restricted/ (got ${olPutSecRes.status})`);
		}
		// Clean up
		try {
			const cs = await fullClient.sign(olPutSecUrl, {
				method: 'DELETE',
				headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
			});
			await fetch(cs);
		} catch {
			/* best effort */
		}
	}

	// ─── 27. S3 Key Filename Condition ──────────────────────────

	section('S3 Key Filename Condition');

	// Deny PutObject when filename starts with "." (hidden files)
	const HIDDEN_FILE_POLICY = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['s3:*'],
				resources: ['account:*', `bucket:${S3_TEST_BUCKET}`, `object:${S3_TEST_BUCKET}/*`],
			},
			{
				effect: 'deny',
				actions: ['s3:PutObject'],
				resources: [`object:${S3_TEST_BUCKET}/*`],
				conditions: [{ field: 'key.filename', operator: 'starts_with', value: '.' }],
			},
		],
	};
	const hfCred = await admin('POST', '/admin/s3/credentials', {
		name: 'smoke-s3-hidden-deny',
		policy: HIDDEN_FILE_POLICY,
		upstream_token_id: ctx.s3UpstreamId,
	});
	assertStatus('create hidden-file-deny S3 cred -> 200', hfCred, 200);
	const hfAk = hfCred.body?.result?.credential?.access_key_id;
	const hfSk = hfCred.body?.result?.credential?.secret_access_key;
	if (hfAk) state.createdS3Creds.push(hfAk);

	if (hfAk && hfSk) {
		const hfClient = s3client(hfAk, hfSk);

		// Put normal file -> 200
		const hfPutOkTs = Date.now();
		const hfPutOkUrl = `${BASE}/s3/${S3_TEST_BUCKET}/data/report-${hfPutOkTs}.csv`;
		const hfPutOkSigned = await hfClient.sign(hfPutOkUrl, {
			method: 'PUT',
			headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'content-type': 'text/csv' },
			body: 'col1,col2',
		});
		const hfPutOkRes = await fetch(hfPutOkSigned);
		if (hfPutOkRes.ok) {
			state.pass++;
			console.log(`  ${green('PASS')}  hidden-deny: put normal file -> ${hfPutOkRes.status}`);
		} else {
			state.fail++;
			state.errors.push(`hidden-deny: put normal file should succeed, got ${hfPutOkRes.status}`);
			console.log(`  ${red('FAIL')}  hidden-deny: put normal file (got ${hfPutOkRes.status})`);
		}

		// Put hidden file (.hidden-cfg) -> 403
		// NOTE: We use .hidden-cfg instead of .env/.gitignore because Cloudflare's WAF
		// blocks requests to well-known sensitive filenames, returning its own 403 before
		// the request reaches our Worker. Using a custom dot-prefixed name isolates
		// the IAM deny logic from WAF interference.
		const hfPutBadUrl = `${BASE}/s3/${S3_TEST_BUCKET}/config/.hidden-cfg`;
		const hfPutBadSigned = await hfClient.sign(hfPutBadUrl, {
			method: 'PUT',
			headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'content-type': 'text/plain' },
			body: 'SECRET_KEY=xxx',
		});
		const hfPutBadRes = await fetch(hfPutBadSigned);
		if (hfPutBadRes.status === 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  hidden-deny: put .hidden-cfg -> 403`);
		} else {
			state.fail++;
			state.errors.push(`hidden-deny: put .hidden-cfg should be 403, got ${hfPutBadRes.status}`);
			console.log(`  ${red('FAIL')}  hidden-deny: put .hidden-cfg (got ${hfPutBadRes.status})`);
		}
		if (hfPutBadRes.body && !hfPutBadRes.bodyUsed) await hfPutBadRes.text().catch(() => {});

		// Put hidden file (.secret-data) -> 403
		const hfPutSecUrl = `${BASE}/s3/${S3_TEST_BUCKET}/repo/.secret-data`;
		const hfPutSecSigned = await hfClient.sign(hfPutSecUrl, {
			method: 'PUT',
			headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'content-type': 'text/plain' },
			body: 'node_modules',
		});
		const hfPutSecRes = await fetch(hfPutSecSigned);
		if (hfPutSecRes.status === 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  hidden-deny: put .secret-data -> 403`);
		} else {
			state.fail++;
			state.errors.push(`hidden-deny: put .secret-data should be 403, got ${hfPutSecRes.status}`);
			console.log(`  ${red('FAIL')}  hidden-deny: put .secret-data (got ${hfPutSecRes.status})`);
		}
		if (hfPutSecRes.body && !hfPutSecRes.bodyUsed) await hfPutSecRes.text().catch(() => {});

		// GetObject on the normal file we just uploaded -> not 403 (proves GET works with this key)
		const hfGetNormalUrl = `${BASE}/s3/${S3_TEST_BUCKET}/data/report-${hfPutOkTs}.csv`;
		const hfGetNormalSigned = await hfClient.sign(hfGetNormalUrl, {
			method: 'GET',
			headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
		});
		const hfGetNormalRes = await fetch(hfGetNormalSigned);
		if (hfGetNormalRes.body && !hfGetNormalRes.bodyUsed) await hfGetNormalRes.text().catch(() => {});
		if (hfGetNormalRes.status !== 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  hidden-deny: get normal file -> ${hfGetNormalRes.status} (deny on put only)`);
		} else {
			state.fail++;
			state.errors.push('hidden-deny: get normal file should not be 403 (deny on put only)');
			console.log(`  ${red('FAIL')}  hidden-deny: get normal file got 403`);
		}

		// Clean up the normal file after GET
		try {
			const cs = await fullClient.sign(hfPutOkUrl, {
				method: 'DELETE',
				headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
			});
			await fetch(cs);
		} catch {
			/* best effort */
		}

		// DeleteObject .hidden-cfg -> not 403 (deny only on PutObject, not Delete)
		const hfDelHiddenUrl = `${BASE}/s3/${S3_TEST_BUCKET}/config/.hidden-cfg`;
		const hfDelHiddenSigned = await hfClient.sign(hfDelHiddenUrl, {
			method: 'DELETE',
			headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
		});
		const hfDelHiddenRes = await fetch(hfDelHiddenSigned);
		if (hfDelHiddenRes.body && !hfDelHiddenRes.bodyUsed) await hfDelHiddenRes.text().catch(() => {});
		if (hfDelHiddenRes.status !== 403) {
			state.pass++;
			console.log(`  ${green('PASS')}  hidden-deny: delete .hidden-cfg -> ${hfDelHiddenRes.status} (deny on put only)`);
		} else {
			state.fail++;
			state.errors.push('hidden-deny: delete .hidden-cfg should not be 403 (deny on put only)');
			console.log(`  ${red('FAIL')}  hidden-deny: delete .hidden-cfg got 403`);
		}
	}

	// ─── 28. S3 Analytics ───────────────────────────────────────

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
