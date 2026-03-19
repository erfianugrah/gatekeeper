# Plan: Inapplicable Condition Handling in Policy Engine

## Problem

When a user creates a policy statement like `allow purge:* where host contains erfi.io`, they expect all purge types to work (URLs, hosts, tags, prefixes, everything). But the policy engine denies tag and prefix purges because the `host` field doesn't exist in their request context — and missing fields cause conditions to fail.

The user's mental model: "I scoped this key to erfi.io, so all purge operations for that zone should work." The engine's actual behavior: "The `host` field is missing from a tag purge context, so the condition `host contains erfi.io` fails, and the statement doesn't match."

**Current workaround**: Split into two statements (one for URL/host purges with the host condition, one for tag/everything purges without conditions). The UI shows inapplicable condition warnings to guide users toward this.

## Goal

Make conditions on fields that don't exist in a request context behave intuitively:

- `allow purge:* where host contains erfi.io` should allow tag purges (host condition is inapplicable → skip)
- `deny purge:* where host contains evil.com` should NOT deny tag purges (host condition is inapplicable → deny doesn't fire)

## Design Options

### Option A: Effect-aware skip (recommended)

Change `evaluateLeaf` to accept a `skipMissing` flag:

- **Allow statements**: missing field → condition vacuously true (skip it)
- **Deny statements**: missing field → condition fails (deny doesn't fire)

This means: "a condition about an irrelevant field should not affect the outcome."

Pass the flag from `matchesStatement` based on `stmt.effect`.

**Pros**: Intuitive user experience. Single statement covers all purge types.
**Cons**: Changes core security-sensitive evaluation. Requires passing effect through the call stack.

### Option B: Field-applicability metadata

Define which fields are applicable to which actions (e.g., `host` applies to `purge:url`, `purge:host`; `tag` applies to `purge:tag`). The engine checks if a condition's field is applicable to the current action before evaluating it. If not applicable, skip the condition.

**Pros**: More explicit. The skip decision is based on domain knowledge, not just presence/absence.
**Cons**: Couples the policy engine to domain-specific knowledge. New actions would require updating the metadata table.

### Option C: No engine change — UI auto-splits

Keep the engine as-is. When the user saves a statement with `purge:*` and a condition that only applies to some purge types, the UI automatically splits it into multiple statements behind the scenes.

**Pros**: No security model change. Engine stays simple.
**Cons**: Policy JSON becomes more complex. Editing round-trips may be confusing.

**Recommendation**: Option A. It's the simplest change to the engine, matches user intent, and both allow and deny cases are handled correctly.

## Truth Table: Current Behavior (to preserve for deny)

| Effect | Operator            | Field Present & Matches | Field Present & No Match | Field Missing                                       |
| ------ | ------------------- | ----------------------- | ------------------------ | --------------------------------------------------- |
| allow  | eq/ne/contains/etc. | condition true          | condition false          | **false** (statement doesn't match → implicit deny) |
| allow  | exists              | true                    | N/A                      | **false**                                           |
| allow  | not_exists          | false                   | N/A                      | **true**                                            |
| deny   | eq/ne/contains/etc. | condition true          | condition false          | **false** (deny doesn't fire)                       |
| deny   | exists              | true                    | N/A                      | **false** (deny doesn't fire)                       |
| deny   | not_exists          | false                   | N/A                      | **true** (deny fires)                               |

## Truth Table: Proposed Behavior (Option A)

| Effect | Operator            | Field Present & Matches | Field Present & No Match | Field Missing                                                   |
| ------ | ------------------- | ----------------------- | ------------------------ | --------------------------------------------------------------- |
| allow  | eq/ne/contains/etc. | condition true          | condition false          | **true** (vacuously satisfied → skip)                           |
| allow  | exists              | true                    | N/A                      | **false** (exists means "field must be present" — still strict) |
| allow  | not_exists          | false                   | N/A                      | **true** (unchanged)                                            |
| deny   | eq/ne/contains/etc. | condition true          | condition false          | **false** (unchanged — deny doesn't fire)                       |
| deny   | exists              | true                    | N/A                      | **false** (unchanged)                                           |
| deny   | not_exists          | false                   | N/A                      | **true** (unchanged)                                            |

**Key difference**: For allow statements with non-exists/not_exists operators, missing fields now return `true` instead of `false`.

**Exception**: `exists` operator on allow statements should NOT be skipped when the field is missing. `exists` explicitly asks "is this field present?" — answering "yes" when the field is absent would be incorrect. Same for `not_exists` on deny.

## Scenarios to Verify

### Scenario 1: `allow purge:* where host contains erfi.io`

| Request                           | Field `host` | Current    | Proposed       |
| --------------------------------- | ------------ | ---------- | -------------- |
| URL purge `https://erfi.io/page`  | `erfi.io`    | ✅ allowed | ✅ allowed     |
| URL purge `https://evil.com/page` | `evil.com`   | ❌ denied  | ❌ denied      |
| Host purge `erfi.io`              | `erfi.io`    | ✅ allowed | ✅ allowed     |
| Tag purge `static-v2`             | **missing**  | ❌ denied  | ✅ **allowed** |
| Prefix purge `erfi.io/assets`     | **missing**† | ❌ denied  | ✅ **allowed** |
| Purge everything                  | **missing**  | ❌ denied  | ✅ **allowed** |

†Prefix context has `prefix` field but not `host`.

### Scenario 2: `deny purge:* where host contains evil.com`

| Request                           | Field `host` | Current                        | Proposed                       |
| --------------------------------- | ------------ | ------------------------------ | ------------------------------ |
| URL purge `https://evil.com/page` | `evil.com`   | ❌ denied                      | ❌ denied                      |
| URL purge `https://good.com/page` | `good.com`   | ✅ allowed                     | ✅ allowed                     |
| Tag purge `anything`              | **missing**  | ✅ allowed (deny doesn't fire) | ✅ allowed (deny doesn't fire) |

### Scenario 3: `allow workers:* where workers.script_name eq my-worker`

| Request                            | Field `workers.script_name` | Current    | Proposed       |
| ---------------------------------- | --------------------------- | ---------- | -------------- |
| Script settings for `my-worker`    | `my-worker`                 | ✅ allowed | ✅ allowed     |
| Script settings for `other-worker` | `other-worker`              | ❌ denied  | ❌ denied      |
| Account subdomain (no script)      | **missing**                 | ❌ denied  | ✅ **allowed** |

**This is the existing failing test case** (`test/cf-workers.test.ts` line 830). The test expects 403 because the field is missing. Under the proposed change, this would become 200 — the account-level action is allowed because the script-scoped condition is inapplicable.

**Decision needed**: Is this the correct behavior? Account subdomain operations aren't script-specific, so allowing them when the policy only scopes to `my-worker` seems correct. But if the intent is "this key can ONLY operate on `my-worker`", then account-level actions should be denied.

### Scenario 4: `allow purge:url where host exists`

| Request             | Field `host` | Current    | Proposed                              |
| ------------------- | ------------ | ---------- | ------------------------------------- |
| URL purge with host | present      | ✅ allowed | ✅ allowed                            |
| Tag purge           | **missing**  | ❌ denied  | ❌ **denied** (exists is NOT skipped) |

The `exists` operator is excluded from the skip behavior because it explicitly tests for field presence.

### Scenario 5: Mixed conditions (AND)

Policy: `allow purge:* where host contains erfi.io AND client_ip eq 1.2.3.4`

| Request                | `host`      | `client_ip` | Current    | Proposed                                  |
| ---------------------- | ----------- | ----------- | ---------- | ----------------------------------------- |
| URL purge from 1.2.3.4 | `erfi.io`   | `1.2.3.4`   | ✅ allowed | ✅ allowed                                |
| URL purge from 5.6.7.8 | `erfi.io`   | `5.6.7.8`   | ❌ denied  | ❌ denied                                 |
| Tag purge from 1.2.3.4 | **missing** | `1.2.3.4`   | ❌ denied  | ✅ **allowed** (host skipped, IP matches) |
| Tag purge from 5.6.7.8 | **missing** | `5.6.7.8`   | ❌ denied  | ❌ denied (host skipped, IP fails)        |

### Scenario 6: `deny purge:* where host exists`

| Request   | Field `host` | Current                        | Proposed                                                          |
| --------- | ------------ | ------------------------------ | ----------------------------------------------------------------- |
| URL purge | present      | ❌ denied                      | ❌ denied                                                         |
| Tag purge | **missing**  | ✅ allowed (deny doesn't fire) | ✅ allowed (deny doesn't fire — exists returns false for missing) |

## Existing Tests That Will Change Behavior

These tests currently expect `false`/403 for missing fields and will need updating:

1. **`test/cf-workers.test.ts`**: `account-level actions not blocked by script-scoped policy (no script_name field)`
   - Currently: expects 403 (field missing → condition fails → no allow)
   - Proposed: expects 200 (field missing → condition skipped → allow matches)
   - **Verify this is the desired behavior** — account-level actions allowed by a script-scoped key

2. **`test/purge.test.ts`**: `URL file purge with header condition` (3rd case — plain URL string, no headers)
   - Currently: expects 403 (header.CF-Device-Type missing → AND condition fails)
   - Proposed: expects 200 (header missing → skipped in allow; host matches → allowed)
   - **Verify this is the desired behavior** — should a header condition be optional?

3. **`test/policy-engine.test.ts`**: `non-exist field fails for string operators`
   - Currently: expects `false`
   - Proposed: depends on effect. For allow: expects `true` (skipped). For deny: still `false`.
   - **Update test to be effect-aware** — add separate allow and deny cases.

## Tests That MUST NOT Change

These tests verify behavior that must remain unchanged:

1. All deny-with-missing-field tests — deny should NOT fire when field is missing
2. `exists` operator tests — must still fail for missing fields (even in allow)
3. `not_exists` operator tests — must still pass for missing fields
4. All tests where the field IS present — no change in behavior

## Implementation Steps

### Step 1: Write the new tests FIRST (TDD)

Add to `test/policy-engine.test.ts`:

- `allow + eq + field missing → true (skipped)` (new)
- `deny + eq + field missing → false (deny doesn't fire)` (existing, verify)
- `allow + exists + field missing → false (NOT skipped)` (existing, verify)
- `deny + exists + field missing → false` (existing, verify)
- `allow + not_exists + field missing → true` (existing, verify)
- `allow + contains + field missing → true (skipped)` (new)
- `deny + contains + field missing → false` (new)
- `allow + in + field missing → true (skipped)` (new)
- `allow + gt + field missing → true (skipped)` (new)
- `deny + gt + field missing → false` (new)
- Mixed AND conditions: one applicable, one inapplicable (new)

Add integration tests:

- `allow purge:* where host contains X` + tag purge → allowed (new)
- `deny purge:* where host contains X` + tag purge → deny doesn't fire (new)
- `allow workers:* where script_name eq X` + account-level action → allowed (update existing)

### Step 2: Modify `evaluateLeaf`

```ts
function evaluateLeaf(cond: LeafCondition, fields: Record<string, string | boolean>, skipMissing = false): boolean {
	const fieldValue = fields[cond.field];
	if (cond.operator === 'exists') return fieldValue !== undefined && fieldValue !== null;
	if (cond.operator === 'not_exists') return fieldValue === undefined || fieldValue === null;
	if (fieldValue === undefined || fieldValue === null) return skipMissing;
	// ... rest unchanged
}
```

### Step 3: Modify `evaluateCondition`

Pass `skipMissing` through compound conditions (any/all/not).

### Step 4: Modify `matchesStatement`

```ts
function matchesStatement(stmt: Statement, ctx: RequestContext): boolean {
	if (!matchesAction(stmt.actions, ctx.action)) return false;
	if (!matchesResource(stmt.resources, ctx.resource)) return false;
	if (stmt.conditions && stmt.conditions.length > 0) {
		const skipMissing = stmt.effect === 'allow';
		for (const cond of stmt.conditions) {
			if (!evaluateCondition(cond, ctx.fields, 0, skipMissing)) return false;
		}
	}
	return true;
}
```

### Step 5: Update existing tests

Update the 3 tests identified above to expect the new behavior.

### Step 6: Add breadcrumb logging

Log when a condition is skipped due to a missing field:

```ts
if (fieldValue === undefined || fieldValue === null) {
	if (skipMissing) {
		console.log(JSON.stringify({ breadcrumb: 'condition-field-missing-skipped', field: cond.field, operator: cond.operator }));
	}
	return skipMissing;
}
```

### Step 7: Run the full test suite

All 1006 tests must pass. Run Playwright E2E tests too.

### Step 8: Update AGENTS.md

Document the new behavior in the Known Pitfalls or a new Policy Engine section.

## Branch

Create branch: `feat/inapplicable-condition-skip`

## Risk Assessment

- **Security**: Low risk. The change is conservative — deny rules are unchanged, and allow rules become more permissive only for fields that don't exist in the context (meaning the action type doesn't support that field).
- **Backward compatibility**: Breaking for users who rely on the current behavior where missing fields deny allow rules. This is unlikely to be intentional — it's more likely a source of confusion. But the Workers script-scoped policy test suggests it was an intentional design choice for that use case.
- **Rollback**: Easy — revert `evaluateLeaf` and `matchesStatement` to remove the `skipMissing` parameter.
