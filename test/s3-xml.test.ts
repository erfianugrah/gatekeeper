import { describe, it, expect } from 'vitest';
import { escapeXml, parseDeleteObjectKeys, decodeXmlEntities, s3XmlError } from '../src/s3/xml';

// --- Tests ---

describe('escapeXml', () => {
	it('escapes ampersand', () => {
		expect(escapeXml('foo & bar')).toBe('foo &amp; bar');
	});

	it('escapes less-than', () => {
		expect(escapeXml('a < b')).toBe('a &lt; b');
	});

	it('escapes greater-than', () => {
		expect(escapeXml('a > b')).toBe('a &gt; b');
	});

	it('escapes all three in combination', () => {
		expect(escapeXml('<script>alert("xss")&</script>')).toBe('&lt;script&gt;alert("xss")&amp;&lt;/script&gt;');
	});

	it('returns empty string as-is', () => {
		expect(escapeXml('')).toBe('');
	});

	it('returns safe string as-is', () => {
		expect(escapeXml('hello world 123')).toBe('hello world 123');
	});

	it('handles multiple ampersands', () => {
		expect(escapeXml('a&b&c')).toBe('a&amp;b&amp;c');
	});
});

describe('decodeXmlEntities', () => {
	it('decodes &amp;', () => {
		expect(decodeXmlEntities('foo &amp; bar')).toBe('foo & bar');
	});

	it('decodes &lt;', () => {
		expect(decodeXmlEntities('a &lt; b')).toBe('a < b');
	});

	it('decodes &gt;', () => {
		expect(decodeXmlEntities('a &gt; b')).toBe('a > b');
	});

	it('decodes &apos;', () => {
		expect(decodeXmlEntities('it&apos;s')).toBe("it's");
	});

	it('decodes &quot;', () => {
		expect(decodeXmlEntities('say &quot;hello&quot;')).toBe('say "hello"');
	});

	it('decodes all entities together', () => {
		expect(decodeXmlEntities('&lt;a href=&quot;/&amp;x&quot;&gt;it&apos;s&lt;/a&gt;')).toBe('<a href="/&x">it\'s</a>');
	});

	it('returns unencoded string as-is', () => {
		expect(decodeXmlEntities('plain text')).toBe('plain text');
	});

	it('handles empty string', () => {
		expect(decodeXmlEntities('')).toBe('');
	});
});

describe('parseDeleteObjectKeys', () => {
	it('parses single key', () => {
		const xml = '<Delete><Object><Key>photos/2024/img.jpg</Key></Object></Delete>';
		expect(parseDeleteObjectKeys(xml)).toEqual(['photos/2024/img.jpg']);
	});

	it('parses multiple keys', () => {
		const xml = `
			<Delete>
				<Object><Key>file1.txt</Key></Object>
				<Object><Key>file2.txt</Key></Object>
				<Object><Key>dir/file3.txt</Key></Object>
			</Delete>
		`;
		expect(parseDeleteObjectKeys(xml)).toEqual(['file1.txt', 'file2.txt', 'dir/file3.txt']);
	});

	it('returns empty array when no keys', () => {
		expect(parseDeleteObjectKeys('<Delete></Delete>')).toEqual([]);
	});

	it('returns empty array for empty string', () => {
		expect(parseDeleteObjectKeys('')).toEqual([]);
	});

	it('decodes XML entities in keys', () => {
		const xml = '<Delete><Object><Key>files/a &amp; b.txt</Key></Object></Delete>';
		expect(parseDeleteObjectKeys(xml)).toEqual(['files/a & b.txt']);
	});

	it('handles keys with special chars (encoded)', () => {
		const xml = '<Delete><Object><Key>path/with &lt;angle&gt; brackets.txt</Key></Object></Delete>';
		expect(parseDeleteObjectKeys(xml)).toEqual(['path/with <angle> brackets.txt']);
	});

	it('handles keys with unicode', () => {
		const xml = '<Delete><Object><Key>日本語/ファイル.txt</Key></Object></Delete>';
		expect(parseDeleteObjectKeys(xml)).toEqual(['日本語/ファイル.txt']);
	});

	it('handles keys with spaces', () => {
		const xml = '<Delete><Object><Key>my documents/report final.pdf</Key></Object></Delete>';
		expect(parseDeleteObjectKeys(xml)).toEqual(['my documents/report final.pdf']);
	});

	it('handles realistic AWS S3 multi-delete body', () => {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Quiet>true</Quiet>
  <Object><Key>logs/2024/01/access.log</Key></Object>
  <Object><Key>logs/2024/02/access.log</Key></Object>
  <Object><Key>tmp/upload_abc123.part</Key></Object>
</Delete>`;
		expect(parseDeleteObjectKeys(xml)).toEqual(['logs/2024/01/access.log', 'logs/2024/02/access.log', 'tmp/upload_abc123.part']);
	});

	it('can be called multiple times (regex lastIndex reset)', () => {
		const xml1 = '<Delete><Object><Key>a.txt</Key></Object></Delete>';
		const xml2 = '<Delete><Object><Key>b.txt</Key></Object></Delete>';
		expect(parseDeleteObjectKeys(xml1)).toEqual(['a.txt']);
		expect(parseDeleteObjectKeys(xml2)).toEqual(['b.txt']);
	});
});

describe('s3XmlError', () => {
	it('returns correct status code', async () => {
		const res = s3XmlError('AccessDenied', 'Access Denied', 403);
		expect(res.status).toBe(403);
	});

	it('returns XML content type', async () => {
		const res = s3XmlError('NoSuchKey', 'Not found', 404);
		expect(res.headers.get('Content-Type')).toBe('application/xml');
	});

	it('includes x-amz-request-id header', async () => {
		const res = s3XmlError('InternalError', 'Server error', 500);
		expect(res.headers.get('x-amz-request-id')).toBeTruthy();
	});

	it('uses provided requestId', async () => {
		const res = s3XmlError('AccessDenied', 'Denied', 403, 'custom-req-id');
		expect(res.headers.get('x-amz-request-id')).toBe('custom-req-id');
		const body = await res.text();
		expect(body).toContain('<RequestId>custom-req-id</RequestId>');
	});

	it('body contains XML error structure', async () => {
		const res = s3XmlError('NoSuchBucket', 'The bucket does not exist', 404);
		const body = await res.text();
		expect(body).toContain('<?xml version="1.0" encoding="UTF-8"?>');
		expect(body).toContain('<Error>');
		expect(body).toContain('<Code>NoSuchBucket</Code>');
		expect(body).toContain('<Message>The bucket does not exist</Message>');
		expect(body).toContain('</Error>');
	});

	it('escapes special chars in message', async () => {
		const res = s3XmlError('Error', 'user <script> & injection', 400);
		const body = await res.text();
		expect(body).toContain('user &lt;script&gt; &amp; injection');
		expect(body).not.toContain('<script>');
	});
});
