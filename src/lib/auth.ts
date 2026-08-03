import { supabase } from '@/lib/supabase';

const APP_DOMAIN = '@app.local';

export type Role = 'admin' | 'manager' | 'team_lead' | 'operator';

export interface AppProfile {
  user_id: string;
  username: string;
  display_name: string;
  role: Role;
  is_active: boolean;
  created_at: string;
}

export function toAuthEmail(username: string): string {
  return `${username.trim().toLowerCase()}${APP_DOMAIN}`;
}

export function fromAuthEmail(email: string): string {
  return email.replace(APP_DOMAIN, '');
}

export async function signIn(username: string, password: string): Promise<AppProfile> {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: toAuthEmail(username),
    password,
  });
  if (error) throw new Error('Invalid name or password.');
  if (!data.user) throw new Error('Sign-in failed.');
  const profile = await fetchProfile(data.user.id);
  if (!profile) throw new Error('No profile found for this account.');
  if (!profile.is_active) {
    await supabase.auth.signOut();
    throw new Error('This account has been disabled.');
  }
  return profile;
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}

export async function changePassword(newPassword: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw new Error(error.message);
}

export async function fetchProfile(userId: string): Promise<AppProfile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('user_id, username, display_name, role, is_active, created_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as AppProfile | null) ?? null;
}

async function callAdmin<T>(payload: Record<string, unknown>): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error('Not signed in.');
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; [k: string]: unknown };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export async function adminListUsers(): Promise<AppProfile[]> {
  const { users } = await callAdmin<{ users: AppProfile[] }>({ action: 'list' });
  return users;
}

export async function adminCreateUser(input: { username: string; password: string; displayName: string; role: Role }): Promise<AppProfile> {
  const { user } = await callAdmin<{ user: AppProfile }>({ action: 'create', ...input });
  return user;
}

export async function adminResetPassword(userId: string, password: string): Promise<void> {
  await callAdmin<{ ok: true }>({ action: 'reset', userId, password });
}

export async function adminSetActive(userId: string, isActive: boolean): Promise<void> {
  await callAdmin<{ ok: true }>({ action: 'set-active', userId, isActive });
}

export async function adminUpdateUser(userId: string, patch: { displayName?: string; role?: Role }): Promise<void> {
  await callAdmin<{ ok: true }>({ action: 'update', userId, ...patch });
}

export async function adminDeleteUser(userId: string): Promise<void> {
  await callAdmin<{ ok: true }>({ action: 'delete', userId });
}
