// ─── Request-level condition fields ─────────────────────────────────────────
// Extracted from inbound request headers / CF properties at request time.
// Merged into every RequestContext's fields for policy evaluation.

/**
 * Extract client IP, country, ASN, and time fields from an inbound request.
 * These are available on Cloudflare Workers via standard headers and the `cf` object.
 */
export function extractRequestFields(request: Request): Record<string, string> {
	const fields: Record<string, string> = {};

	// Client IP — always present on Cloudflare
	const ip = request.headers.get('cf-connecting-ip');
	if (ip) fields.client_ip = ip;

	// Country — 2-letter ISO code from Cloudflare
	const country = request.headers.get('cf-ipcountry');
	if (country) fields.client_country = country;

	// ASN — from the cf object (Cloudflare-specific request property)
	const cf = (request as any).cf;
	if (cf?.asn !== undefined) fields.client_asn = String(cf.asn);

	// Time fields — computed at request time
	const now = new Date();
	fields['time.hour'] = String(now.getUTCHours());
	fields['time.day_of_week'] = String(now.getUTCDay());
	fields['time.iso'] = now.toISOString();

	return fields;
}
