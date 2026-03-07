/**
 * S3-compatible XML utilities for error responses and request body parsing.
 */

// ─── XML error responses ────────────────────────────────────────────────────

/** Build an S3-compatible XML error response. */
export function s3XmlError(
	code: string,
	message: string,
	status: number,
	requestId?: string,
	extraHeaders?: Record<string, string>,
): Response {
	const rid = requestId || crypto.randomUUID();
	const xml = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<Error>',
		`<Code>${code}</Code>`,
		`<Message>${escapeXml(message)}</Message>`,
		`<RequestId>${rid}</RequestId>`,
		'</Error>',
	].join('\n');

	return new Response(xml, {
		status,
		headers: {
			'Content-Type': 'application/xml',
			'x-amz-request-id': rid,
			...extraHeaders,
		},
	});
}

/** Escape XML special characters in text content. */
export function escapeXml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── DeleteObjects XML parsing ──────────────────────────────────────────────

/** Parse object keys from a DeleteObjects XML body. */
export function parseDeleteObjectKeys(xml: string): string[] {
	const re = /<Key>([^<]+)<\/Key>/g;
	const keys: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = re.exec(xml)) !== null) {
		keys.push(decodeXmlEntities(match[1]));
	}
	return keys;
}

/** Decode basic XML entities (&amp; &lt; &gt; &apos; &quot;). */
export function decodeXmlEntities(s: string): string {
	return s
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&apos;/g, "'")
		.replace(/&quot;/g, '"');
}
