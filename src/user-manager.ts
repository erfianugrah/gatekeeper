/**
 * User management for built-in email/password authentication.
 * Stores users in Durable Object SQLite with PBKDF2-hashed passwords.
 *
 * This is an alternative to Cloudflare Access SSO — enables the dashboard
 * to work without any external identity provider.
 */

import { hashPassword, verifyPassword } from './password';
import { generateHexId } from './crypto';
import { queryAll } from './sql';
import type { AdminRole } from './types';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface User {
	id: string;
	email: string;
	role: AdminRole;
	created_at: number;
	updated_at: number;
}

/** Full row including password hash — never returned to clients. */
interface UserRow extends User {
	password_hash: string;
}

export interface CreateUserRequest {
	email: string;
	password: string;
	role: AdminRole;
}

// ─── Manager ────────────────────────────────────────────────────────────────

export class UserManager {
	constructor(private sql: SqlStorage) {}

	/** Create the users table if it doesn't exist. */
	initTable(): void {
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS users (
				id            TEXT PRIMARY KEY,
				email         TEXT NOT NULL UNIQUE,
				password_hash TEXT NOT NULL,
				role          TEXT NOT NULL DEFAULT 'viewer',
				created_at    INTEGER NOT NULL,
				updated_at    INTEGER NOT NULL
			)
		`);
	}

	/** Create a new user. Throws if email already exists. */
	async createUser(req: CreateUserRequest): Promise<User> {
		const email = req.email.toLowerCase().trim();

		// Check for duplicate email before insert — avoids SQL constraint errors
		// that propagate poorly across DO RPC boundaries in tests.
		const existing = this.getUserByEmail(email);
		if (existing) {
			throw new Error(`User with email ${req.email} already exists`);
		}

		const id = generateHexId('usr_', 12);
		const now = Date.now();
		const passwordHash = await hashPassword(req.password);

		this.sql.exec(
			`INSERT INTO users (id, email, password_hash, role, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			id,
			email,
			passwordHash,
			req.role,
			now,
			now,
		);

		console.log(JSON.stringify({ breadcrumb: 'user-created', userId: id, email: req.email, role: req.role }));

		return { id, email: req.email.toLowerCase().trim(), role: req.role, created_at: now, updated_at: now };
	}

	/** Verify email/password and return the user if valid. Returns null on failure. */
	async verifyCredentials(email: string, password: string): Promise<User | null> {
		const rows = queryAll<UserRow>(this.sql, 'SELECT * FROM users WHERE email = ?', email.toLowerCase().trim());
		if (rows.length === 0) {
			// Perform a dummy hash to prevent timing-based user enumeration
			await verifyPassword(password, '$pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
			return null;
		}

		const row = rows[0];
		const valid = await verifyPassword(password, row.password_hash);
		if (!valid) return null;

		return { id: row.id, email: row.email, role: row.role, created_at: row.created_at, updated_at: row.updated_at };
	}

	/** List all users (without password hashes). */
	listUsers(): User[] {
		return queryAll<User>(this.sql, 'SELECT id, email, role, created_at, updated_at FROM users ORDER BY created_at DESC');
	}

	/** Get a single user by ID. */
	getUser(id: string): User | null {
		const rows = queryAll<User>(this.sql, 'SELECT id, email, role, created_at, updated_at FROM users WHERE id = ?', id);
		return rows.length > 0 ? rows[0] : null;
	}

	/** Update a user's role. */
	updateUserRole(id: string, role: AdminRole): User | null {
		const existing = this.getUser(id);
		if (!existing) return null;

		const now = Date.now();
		this.sql.exec('UPDATE users SET role = ?, updated_at = ? WHERE id = ?', role, now, id);
		console.log(JSON.stringify({ breadcrumb: 'user-role-updated', userId: id, oldRole: existing.role, newRole: role }));

		return { ...existing, role, updated_at: now };
	}

	/** Update a user's password. */
	async updateUserPassword(id: string, newPassword: string): Promise<boolean> {
		const existing = this.getUser(id);
		if (!existing) return false;

		const now = Date.now();
		const passwordHash = await hashPassword(newPassword);
		this.sql.exec('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', passwordHash, now, id);
		console.log(JSON.stringify({ breadcrumb: 'user-password-updated', userId: id }));

		return true;
	}

	/** Delete a user. Returns true if found and deleted. */
	deleteUser(id: string): boolean {
		const existing = this.getUser(id);
		if (!existing) return false;

		this.sql.exec('DELETE FROM users WHERE id = ?', id);
		console.log(JSON.stringify({ breadcrumb: 'user-deleted', userId: id, email: existing.email }));

		return true;
	}

	/** Get a user by email. Used for merging Access SSO identity with built-in user record. */
	getUserByEmail(email: string): User | null {
		const rows = queryAll<User>(
			this.sql,
			'SELECT id, email, role, created_at, updated_at FROM users WHERE email = ?',
			email.toLowerCase().trim(),
		);
		return rows.length > 0 ? rows[0] : null;
	}

	/** Count total users. Used to detect first-run (no users = allow bootstrap). */
	countUsers(): number {
		const rows = queryAll<{ count: number }>(this.sql, 'SELECT COUNT(*) as count FROM users');
		return rows[0]?.count ?? 0;
	}
}
