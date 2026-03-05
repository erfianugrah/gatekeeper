/** Shared DO stub accessor. All route files use the same DO name ("account"). */

const DO_NAME = 'account';

export function getStub(env: Env) {
	return env.PURGE_RATE_LIMITER.get(
		env.PURGE_RATE_LIMITER.idFromName(DO_NAME),
	);
}
