/**
 * Session management for built-in authentication.
 * Stores sessions in Durable Object SQLite with random 256-bit tokens.
 *
 * Sessions are HttpOnly, Secure, SameSite=Lax cookies.
 * Expired sessions are cleaned up lazily on access and by the retention cron.
 */

import { generateHexId } from './crypto';
import { queryAll } from './sql';
import type { AdminRole } from './types';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Session cookie name. */
export const SESSION_COOKIE = 'gk_session';

/** Default session lifetime: 24 hours (ms). */
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Maximum session lifetime: 30 days (ms). */
const MAX_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Session {
	id: string;
	user_id: string;
	email: string;
	role: AdminRole;
	created_at: number;
	expires_at: number;
}

// ─── Manager ────────────────────────────────────────────────────────────────

export class SessionManager {
	constructor(private sql: SqlStorage) {}

	/** Create the sessions table if it doesn't exist. */
	initTable(): void {
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS sessions (
				id         TEXT PRIMARY KEY,
				user_id    TEXT NOT NULL,
				email      TEXT NOT NULL,
				role       TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL
			)
		`);

		// Index for user lookups (e.g. "revoke all sessions for user X")
		this.sql.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)');
		// Index for expiry cleanup
		this.sql.exec('CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at)');
	}

	/** Create a new session for a user. Returns the session token (the id). */
	createSession(userId: string, email: string, role: AdminRole, ttlMs?: number): Session {
		const id = generateHexId('ses_', 32);
		const now = Date.now();
		const ttl = Math.min(ttlMs ?? DEFAULT_SESSION_TTL_MS, MAX_SESSION_TTL_MS);
		const expiresAt = now + ttl;

		this.sql.exec(
			`INSERT INTO sessions (id, user_id, email, role, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			id,
			userId,
			email,
			role,
			now,
			expiresAt,
		);

		console.log(JSON.stringify({ breadcrumb: 'session-created', userId, email, expiresIn: ttl }));

		return { id, user_id: userId, email, role, created_at: now, expires_at: expiresAt };
	}

	/** Validate a session token. Returns the session if valid and not expired, null otherwise. */
	validateSession(sessionId: string): Session | null {
		const rows = queryAll<Session>(this.sql, 'SELECT * FROM sessions WHERE id = ?', sessionId);
		if (rows.length === 0) return null;

		const session = rows[0];
		if (session.expires_at <= Date.now()) {
			// Lazily delete expired session
			this.sql.exec('DELETE FROM sessions WHERE id = ?', sessionId);
			return null;
		}

		return session;
	}

	/** Delete a specific session (logout). */
	deleteSession(sessionId: string): boolean {
		const rows = queryAll<{ id: string }>(this.sql, 'SELECT id FROM sessions WHERE id = ?', sessionId);
		if (rows.length === 0) return false;

		this.sql.exec('DELETE FROM sessions WHERE id = ?', sessionId);
		return true;
	}

	/** Delete all sessions for a user (e.g. after password change or user deletion). */
	deleteUserSessions(userId: string): number {
		const rows = queryAll<{ id: string }>(this.sql, 'SELECT id FROM sessions WHERE user_id = ?', userId);
		if (rows.length === 0) return 0;

		this.sql.exec('DELETE FROM sessions WHERE user_id = ?', userId);
		console.log(JSON.stringify({ breadcrumb: 'sessions-revoked', userId, count: rows.length }));
		return rows.length;
	}

	/** Delete all expired sessions. Called by the retention cron. Returns number deleted. */
	deleteExpired(): number {
		const now = Date.now();
		const rows = queryAll<{ id: string }>(this.sql, 'SELECT id FROM sessions WHERE expires_at <= ?', now);
		if (rows.length === 0) return 0;

		this.sql.exec('DELETE FROM sessions WHERE expires_at <= ?', now);
		console.log(JSON.stringify({ breadcrumb: 'sessions-expired-cleanup', count: rows.length }));
		return rows.length;
	}

	/** Build the Set-Cookie header value for a session. */
	static buildCookie(sessionId: string, maxAgeSec: number): string {
		return `${SESSION_COOKIE}=${sessionId}; Path=/; Max-Age=${maxAgeSec}; Secure; HttpOnly; SameSite=Lax`;
	}

	/** Build a Set-Cookie header that clears the session cookie. */
	static clearCookie(): string {
		return `${SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
	}
}
