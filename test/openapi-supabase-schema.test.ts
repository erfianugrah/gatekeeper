import openapi from '../openapi.json';
import { describe, expect, it } from 'vitest';

describe('OpenAPI - Supabase paths', () => {
	it('documents Supabase proxy and Supabase analytics endpoint security + metrics content type', () => {
		const paths = openapi.paths ?? {};

		const adminAnalyticsPaths = [
			'/admin/supabase/analytics/events',
			'/admin/supabase/analytics/summary',
			'/admin/supabase/analytics/timeseries',
		] as const;

		const expectedAdminSecurity = [{ AdminKeyAuth: [] }, { CloudflareAccess: [] }];
		for (const path of adminAnalyticsPaths) {
			const operation = paths[path]?.get;
			expect(operation).toBeDefined();
			expect(operation?.security).toEqual(expectedAdminSecurity);
		}

		const expectedApiKeySecurity = [{ ApiKeyAuth: [] }];
		const supabaseV1Methods = ['get', 'post', 'put', 'patch', 'delete'] as const;
		for (const method of supabaseV1Methods) {
			const operation = paths['/supabase/v1/{path}']?.[method];
			expect(operation).toBeDefined();
			expect(operation?.security).toEqual(expectedApiKeySecurity);
		}

		const supabaseV0Get = paths['/supabase/v0/{path}']?.get;
		expect(supabaseV0Get).toBeDefined();
		expect(supabaseV0Get?.security).toEqual(expectedApiKeySecurity);

		const supabaseMetricsGet = paths['/supabase/metrics/{ref}']?.get;
		expect(supabaseMetricsGet).toBeDefined();
		expect(supabaseMetricsGet?.security).toEqual(expectedApiKeySecurity);
		expect(supabaseMetricsGet?.responses?.['200']?.content?.['text/plain']).toBeDefined();
	});
});
