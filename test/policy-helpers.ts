/**
 * Shared test helpers for policy engine tests.
 */

import type { PolicyDocument, RequestContext, Statement, Condition } from '../src/policy-types';

export function makePolicy(...statements: Statement[]): PolicyDocument {
	return { version: '2025-01-01', statements };
}

export function allowStmt(actions: string[], resources: string[], conditions?: Condition[]): Statement {
	return { effect: 'allow', actions, resources, ...(conditions ? { conditions } : {}) };
}

export function denyStmt(actions: string[], resources: string[], conditions?: Condition[]): Statement {
	return { effect: 'deny', actions, resources, ...(conditions ? { conditions } : {}) };
}

export function makeCtx(action: string, resource: string, fields: Record<string, string | boolean> = {}): RequestContext {
	return { action, resource, fields };
}
