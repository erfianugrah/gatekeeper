import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

// ─── Types ──────────────────────────────────────────────────────────────────

type Mode = 'loading' | 'login' | 'bootstrap';

interface ApiError {
	code: number;
	message: string;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function LoginPage() {
	const [mode, setMode] = useState<Mode>('loading');
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [confirm, setConfirm] = useState('');
	const [error, setError] = useState('');
	const [loading, setLoading] = useState(false);

	// On mount: check session, detect bootstrap mode
	useEffect(() => {
		(async () => {
			try {
				// Already logged in?
				const sessRes = await fetch('/auth/session', {
					credentials: 'include',
				});
				if (sessRes.ok) {
					window.location.replace('/dashboard/');
					return;
				}

				// Check if bootstrap is needed
				const bsRes = await fetch('/auth/bootstrap', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: '{}',
					credentials: 'include',
				});
				const bsData = await bsRes.json();
				if (
					bsData.errors?.[0]?.code === 400 // missing fields = bootstrap enabled
				) {
					setMode('bootstrap');
				} else {
					setMode('login');
				}
			} catch {
				setMode('login');
			}
		})();
	}, []);

	// Read ?error= from URL (server-side redirect with error)
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const urlError = params.get('error');
		if (urlError) {
			setError(urlError);
			// Clean up URL
			window.history.replaceState({}, '', window.location.pathname);
		}
	}, []);

	async function handleLogin(e: React.FormEvent) {
		e.preventDefault();
		setError('');
		setLoading(true);
		try {
			const res = await fetch('/auth/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ email, password }),
			});
			const data = await res.json();
			if (data.success) {
				window.location.replace('/dashboard/');
			} else {
				setError(data.errors?.map((e: ApiError) => e.message).join('; ') ?? 'Login failed');
			}
		} catch {
			setError('Network error — please try again');
		} finally {
			setLoading(false);
		}
	}

	async function handleBootstrap(e: React.FormEvent) {
		e.preventDefault();
		setError('');

		if (password !== confirm) {
			setError('Passwords do not match');
			return;
		}
		if (password.length < 12) {
			setError('Password must be at least 12 characters');
			return;
		}

		setLoading(true);
		try {
			const res = await fetch('/auth/bootstrap', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ email, password }),
			});
			const data = await res.json();
			if (data.success) {
				window.location.replace('/dashboard/');
			} else {
				setError(data.errors?.map((e: ApiError) => e.message).join('; ') ?? 'Failed to create account');
			}
		} catch {
			setError('Network error — please try again');
		} finally {
			setLoading(false);
		}
	}

	// Loading state
	if (mode === 'loading') {
		return (
			<div className="flex min-h-screen items-center justify-center bg-lovelace-950">
				<div className="text-muted-foreground text-sm">Loading...</div>
			</div>
		);
	}

	const isBootstrap = mode === 'bootstrap';

	return (
		<div className="flex min-h-screen items-center justify-center bg-lovelace-950 p-4">
			{/* Backdrop glow */}
			<div
				className="pointer-events-none fixed inset-0"
				style={{
					background: 'radial-gradient(ellipse 600px 400px at 50% 45%, rgba(197,116,221,0.08) 0%, transparent 70%)',
				}}
			/>

			<Card className="relative z-10 w-full max-w-sm border-lovelace-700 bg-lovelace-900">
				<CardHeader className="items-center text-center">
					{/* Shield icon */}
					<svg className="mb-2 h-12 w-12" viewBox="0 0 24 24" fill="none" strokeWidth="1.6" strokeLinejoin="round">
						<path d="M12 2 L3 6.5 L3 12 C3 18.5 6.8 23 12 24.5 C17.2 23 21 18.5 21 12 L21 6.5 Z" stroke="#c574dd" />
						<circle cx="12" cy="11" r="2.5" fill="#c574dd" />
						<rect x="11" y="13" width="2" height="4" rx="0.8" fill="#c574dd" />
					</svg>
					<CardTitle className="text-xl">{isBootstrap ? 'Welcome' : 'Sign in'}</CardTitle>
					<CardDescription>{isBootstrap ? 'Create your admin account to get started' : 'Gatekeeper Dashboard'}</CardDescription>
				</CardHeader>
				<CardContent>
					{isBootstrap && (
						<div className="mb-4 rounded-md border border-lv-purple/20 bg-lv-purple/5 px-3 py-2 text-xs text-lv-purple">
							No users exist yet. This form creates the first admin account.
						</div>
					)}

					{/* Native form fallback — JS overrides with preventDefault */}
					<form
						method="POST"
						action={isBootstrap ? '/auth/bootstrap' : '/auth/login'}
						onSubmit={isBootstrap ? handleBootstrap : handleLogin}
						className="space-y-4"
					>
						<div className="space-y-2">
							<Label htmlFor="email">Email</Label>
							<Input
								id="email"
								name="email"
								type="email"
								required
								autoComplete="email"
								autoFocus
								placeholder="you@example.com"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
							/>
						</div>

						<div className="space-y-2">
							<Label htmlFor="password">Password</Label>
							<Input
								id="password"
								name="password"
								type="password"
								required
								autoComplete={isBootstrap ? 'new-password' : 'current-password'}
								minLength={isBootstrap ? 12 : undefined}
								placeholder={isBootstrap ? 'Min 12 characters' : ''}
								value={password}
								onChange={(e) => setPassword(e.target.value)}
							/>
						</div>

						{isBootstrap && (
							<div className="space-y-2">
								<Label htmlFor="confirm">Confirm password</Label>
								<Input
									id="confirm"
									name="confirm"
									type="password"
									required
									autoComplete="new-password"
									minLength={12}
									value={confirm}
									onChange={(e) => setConfirm(e.target.value)}
								/>
							</div>
						)}

						{error && <div className="rounded-md border border-lv-red/30 bg-lv-red/10 px-3 py-2 text-sm text-lv-red">{error}</div>}

						<Button type="submit" className="w-full" disabled={loading}>
							{loading ? (isBootstrap ? 'Creating account...' : 'Signing in...') : isBootstrap ? 'Create admin account' : 'Sign in'}
						</Button>
					</form>
				</CardContent>
			</Card>
		</div>
	);
}
