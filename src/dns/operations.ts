/**
 * DNS request classification and IAM context building.
 *
 * Maps incoming HTTP requests to DNS IAM actions and extracts condition fields
 * from request bodies for policy evaluation. Follows the same pattern as
 * purgeBodyToContexts() in src/iam.ts.
 */

import type { RequestContext } from '../policy-types';

// ─── DNS IAM actions ────────────────────────────────────────────────────────

export type DnsAction = 'dns:create' | 'dns:read' | 'dns:update' | 'dns:delete' | 'dns:batch' | 'dns:export' | 'dns:import';

// ─── DNS record body shape (subset used for condition extraction) ────────────

/** Minimal shape of a DNS record body — only the fields we extract for policy conditions. */
export interface DnsRecordFields {
	type?: string;
	name?: string;
	content?: string;
	proxied?: boolean;
	ttl?: number;
	comment?: string;
	tags?: string[];
}

/** Batch request body per the CF API. */
export interface DnsBatchBody {
	deletes?: Array<{ id: string }>;
	patches?: Array<DnsRecordFields & { id: string }>;
	puts?: Array<DnsRecordFields & { id: string }>;
	posts?: Array<DnsRecordFields>;
}

// ─── Condition field extraction ─────────────────────────────────────────────

/**
 * Extract DNS-specific condition fields from a record body.
 * Used for create, update (PATCH/PUT), and batch sub-operations.
 */
export function extractDnsFields(record: DnsRecordFields): Record<string, string | boolean> {
	const fields: Record<string, string | boolean> = {};

	if (record.type !== undefined) fields['dns.type'] = record.type;
	if (record.name !== undefined) fields['dns.name'] = record.name;
	if (record.content !== undefined) fields['dns.content'] = record.content;
	if (record.proxied !== undefined) fields['dns.proxied'] = record.proxied;
	if (record.ttl !== undefined) fields['dns.ttl'] = String(record.ttl);
	if (record.comment !== undefined) fields['dns.comment'] = record.comment;
	if (record.tags !== undefined && record.tags.length > 0) {
		fields['dns.tags'] = record.tags.join(',');
	}

	return fields;
}

// ─── Context builders ───────────────────────────────────────────────────────

/** Build a RequestContext for a DNS create (POST /dns_records). */
export function dnsCreateContext(zoneId: string, body: DnsRecordFields, requestFields?: Record<string, string>): RequestContext {
	return {
		action: 'dns:create',
		resource: `zone:${zoneId}`,
		fields: { ...(requestFields ?? {}), ...extractDnsFields(body) },
	};
}

/** Build a RequestContext for a DNS read (GET /dns_records or /dns_records/:id). */
export function dnsReadContext(zoneId: string, requestFields?: Record<string, string>, recordFields?: DnsRecordFields): RequestContext {
	return {
		action: 'dns:read',
		resource: `zone:${zoneId}`,
		fields: { ...(requestFields ?? {}), ...(recordFields ? extractDnsFields(recordFields) : {}) },
	};
}

/** Build a RequestContext for a DNS update (PATCH or PUT /dns_records/:id). */
export function dnsUpdateContext(zoneId: string, body: DnsRecordFields, requestFields?: Record<string, string>): RequestContext {
	return {
		action: 'dns:update',
		resource: `zone:${zoneId}`,
		fields: { ...(requestFields ?? {}), ...extractDnsFields(body) },
	};
}

/** Build a RequestContext for a DNS delete (DELETE /dns_records/:id). */
export function dnsDeleteContext(zoneId: string, requestFields?: Record<string, string>, recordFields?: DnsRecordFields): RequestContext {
	return {
		action: 'dns:delete',
		resource: `zone:${zoneId}`,
		fields: { ...(requestFields ?? {}), ...(recordFields ? extractDnsFields(recordFields) : {}) },
	};
}

/** Build a RequestContext for a DNS export (GET /dns_records/export). */
export function dnsExportContext(zoneId: string, requestFields?: Record<string, string>): RequestContext {
	return {
		action: 'dns:export',
		resource: `zone:${zoneId}`,
		fields: { ...(requestFields ?? {}) },
	};
}

/** Build a RequestContext for a DNS import (POST /dns_records/import). */
export function dnsImportContext(zoneId: string, requestFields?: Record<string, string>): RequestContext {
	return {
		action: 'dns:import',
		resource: `zone:${zoneId}`,
		fields: { ...(requestFields ?? {}) },
	};
}

/**
 * Decompose a batch request body into individual RequestContexts.
 * Each sub-operation (delete, patch, put, post) gets its own context
 * so the policy engine can authorize them independently.
 */
export function dnsBatchToContexts(
	zoneId: string,
	batch: DnsBatchBody,
	requestFields?: Record<string, string>,
	/** Pre-fetched record data for deletes/patches/puts (keyed by record ID). */
	prefetchedRecords?: Map<string, DnsRecordFields>,
): RequestContext[] {
	const contexts: RequestContext[] = [];
	const resource = `zone:${zoneId}`;
	const extra = requestFields ?? {};

	// Batch itself requires dns:batch
	contexts.push({ action: 'dns:batch', resource, fields: { ...extra } });

	if (batch.deletes) {
		for (const del of batch.deletes) {
			const record = prefetchedRecords?.get(del.id);
			contexts.push({
				action: 'dns:delete',
				resource,
				fields: { ...extra, ...(record ? extractDnsFields(record) : {}) },
			});
		}
	}

	if (batch.patches) {
		for (const patch of batch.patches) {
			contexts.push({
				action: 'dns:update',
				resource,
				fields: { ...extra, ...extractDnsFields(patch) },
			});
		}
	}

	if (batch.puts) {
		for (const put of batch.puts) {
			contexts.push({
				action: 'dns:update',
				resource,
				fields: { ...extra, ...extractDnsFields(put) },
			});
		}
	}

	if (batch.posts) {
		for (const post of batch.posts) {
			contexts.push({
				action: 'dns:create',
				resource,
				fields: { ...extra, ...extractDnsFields(post) },
			});
		}
	}

	return contexts;
}
