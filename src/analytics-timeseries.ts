/**
 * Shared time-series analytics query utility.
 *
 * Groups events by hourly buckets for any D1 analytics table.
 * Returns an array of { bucket: number, count: number, errors: number } objects
 * where bucket is the start of the hour (floored to the nearest hour, unix ms).
 */

import { MS_PER_DAY } from './constants';

const MS_PER_HOUR = 3_600_000;

/** Allowed table names for timeseries queries — prevents SQL injection via table parameter. */
const ALLOWED_TABLES = new Set(['purge_events', 's3_events', 'dns_events', 'cf_proxy_events']);

export interface TimeseriesBucket {
	/** Start of the hour (unix ms, floored). */
	bucket: number;
	/** Total requests in this bucket. */
	count: number;
	/** Requests with status >= 400 in this bucket. */
	errors: number;
}

export interface TimeseriesQuery {
	since?: number;
	until?: number;
}

/**
 * Query time-series data from any analytics table.
 *
 * @param db - D1 database binding
 * @param table - Table name (purge_events, s3_events, dns_events, cf_proxy_events)
 * @param filters - WHERE clause conditions and params (exclude since/until — handled by this function)
 * @param timeRange - Optional since/until override
 */
export async function queryTimeseries(
	db: D1Database,
	table: string,
	filters: { conditions: string[]; params: (string | number)[] },
	timeRange: TimeseriesQuery,
): Promise<TimeseriesBucket[]> {
	// Safelist check — all callers pass hardcoded table names but this guards against future misuse
	if (!ALLOWED_TABLES.has(table)) {
		throw new Error(`Invalid analytics table: ${table}`);
	}

	// Default: last 7 days if no since provided
	const now = Date.now();
	const since = timeRange.since ?? now - 7 * MS_PER_DAY;
	const until = timeRange.until ?? now;

	const allConditions = [...filters.conditions, 'created_at >= ?', 'created_at <= ?'];
	const allParams = [...filters.params, since, until];

	const where = allConditions.length > 0 ? `WHERE ${allConditions.join(' AND ')}` : '';

	// Floor created_at to the nearest hour: (created_at / 3600000) * 3600000
	// SQLite integer division truncates, which is exactly floor for positive numbers.
	const sql = `
		SELECT
			(created_at / ${MS_PER_HOUR}) * ${MS_PER_HOUR} AS bucket,
			COUNT(*) AS count,
			SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors
		FROM ${table}
		${where}
		GROUP BY bucket
		ORDER BY bucket ASC
	`;

	try {
		const result = await db
			.prepare(sql)
			.bind(...allParams)
			.all();

		return (result.results as any[]).map((row) => ({
			bucket: row.bucket as number,
			count: row.count as number,
			errors: (row.errors as number) ?? 0,
		}));
	} catch (e: any) {
		// Table may not exist yet if no events have been logged — return empty
		if (e.message?.includes('no such table')) return [];
		throw e;
	}
}
