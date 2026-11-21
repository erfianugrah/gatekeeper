/**
 * fetchMock replacement for @cloudflare/vitest-pool-workers >= 0.13.
 *
 * `import { fetchMock } from "cloudflare:test"` (an undici MockAgent) was
 * removed in the vitest 4 migration of the pool. This keeps the subset of the
 * MockAgent API the suite uses, by intercepting globalThis.fetch:
 *   fetchMock.activate() / disableNetConnect() / assertNoPendingInterceptors()
 *   fetchMock.get(origin).intercept({ method?, path?, headers? })
 *     .reply(status, body?, { headers? })
 *     .reply((opts) => ({ statusCode, data, responseOptions: { headers } }))
 * Each interceptor matches once, first registered first (MockAgent default).
 */

type InterceptOptions = {
	method?: string;
	path?: string | RegExp;
	headers?: Record<string, string>;
};

type ReplyOptions = { headers?: Record<string, string> };

/** What MockAgent hands a reply callback. */
type ReplyCallbackOpts = {
	origin: string;
	path: string;
	method: string;
	headers: Record<string, string>;
	body: string | null;
};

type ReplyResult = { statusCode: number; data?: unknown; responseOptions?: ReplyOptions };

type Interceptor = {
	origin: string;
	opts: InterceptOptions;
	reply: (o: ReplyCallbackOpts) => ReplyResult;
	consumed: boolean;
};

let originalFetch: typeof fetch | null = null;
let netConnectDisabled = false;
const interceptors: Interceptor[] = [];

const toBody = (data: unknown): string | null =>
	data === undefined || data === null ? null : typeof data === 'string' ? data : JSON.stringify(data);

function matches(ri: Interceptor, url: URL, method: string, headers: Headers): boolean {
	if (url.origin !== new URL(ri.origin).origin) return false;
	if ((ri.opts.method ?? 'GET').toUpperCase() !== method.toUpperCase()) return false;
	const pathQuery = url.pathname + url.search;
	const p = ri.opts.path;
	if (p instanceof RegExp ? !p.test(pathQuery) : p !== undefined && pathQuery !== p) return false;
	for (const [k, v] of Object.entries(ri.opts.headers ?? {})) {
		if (headers.get(k) !== v) return false;
	}
	return true;
}

const display = (ri: Interceptor) => `${ri.opts.method ?? 'GET'} ${ri.origin}${ri.opts.path ?? ''}`;

export const fetchMock = {
	activate() {
		if (originalFetch) return;
		originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const req = new Request(input, init);
			const url = new URL(req.url);
			const ri = interceptors.find((i) => !i.consumed && matches(i, url, req.method, req.headers));
			if (!ri) {
				if (netConnectDisabled) {
					throw new Error(
						`fetchMock: no interceptor for ${req.method} ${req.url}\nregistered:\n${interceptors.map(display).join('\n') || '  (none)'}`,
					);
				}
				return originalFetch!(req);
			}
			ri.consumed = true;
			const body = req.body ? await req.text() : null;
			const out = ri.reply({
				origin: url.origin,
				path: url.pathname + url.search,
				method: req.method,
				headers: Object.fromEntries(req.headers),
				body,
			});
			// null-body statuses (204, 304) must not carry a body
			const nullBody = out.statusCode === 204 || out.statusCode === 304;
			return new Response(nullBody ? null : toBody(out.data), {
				status: out.statusCode,
				headers: out.responseOptions?.headers,
			});
		}) as typeof fetch;
	},

	disableNetConnect() {
		netConnectDisabled = true;
	},

	assertNoPendingInterceptors() {
		const pending = interceptors.filter((i) => !i.consumed);
		interceptors.length = 0;
		if (pending.length > 0) {
			throw new Error(`fetchMock: ${pending.length} pending interceptor(s):\n${pending.map(display).join('\n')}`);
		}
	},

	get(origin: string) {
		return {
			intercept(opts: InterceptOptions) {
				return {
					reply(statusOrFn: number | ((o: ReplyCallbackOpts) => ReplyResult), data?: unknown, extra?: ReplyOptions) {
						const reply =
							typeof statusOrFn === 'function'
								? statusOrFn
								: (o: ReplyCallbackOpts): ReplyResult => ({
										statusCode: statusOrFn,
										data: typeof data === 'function' ? data(o) : data,
										responseOptions: extra,
									});
						interceptors.push({ origin, opts, reply, consumed: false });
					},
				};
			},
		};
	},
};
