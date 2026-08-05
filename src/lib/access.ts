import type { Role } from '@/lib/auth';

export type View = 'calculator' | 'tracker' | 'live' | 'board' | 'downtime' | 'analytics' | 'saved-records' | 'admin';

export const VALID_VIEWS: View[] = [
  'calculator',
  'tracker',
  'live',
  'board',
  'downtime',
  'analytics',
  'saved-records',
  'admin',
];

// Pages each role is allowed to open by default. Per-user overrides live in
// profiles.page_access and are resolved by userAllowedViews().
export const ROLE_ACCESS: Record<Role, View[]> = {
  operator: ['live', 'board', 'downtime', 'calculator'],
  team_lead: ['live', 'board', 'tracker', 'downtime', 'calculator', 'saved-records'],
  manager: ['live', 'board', 'tracker', 'downtime', 'calculator', 'analytics', 'saved-records'],
  admin: ['live', 'board', 'tracker', 'downtime', 'calculator', 'analytics', 'saved-records', 'admin'],
};

// Page options shown on the Admin page's access editor. The Admin page itself
// is always admin-only and can never be granted to other roles.
export const ACCESSIBLE_PAGE_OPTIONS: { id: View; label: string }[] = [
  { id: 'live', label: 'Live' },
  { id: 'board', label: 'Board' },
  { id: 'tracker', label: 'Monitoring' },
  { id: 'downtime', label: 'Downtime' },
  { id: 'calculator', label: 'Calculator' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'saved-records', label: 'Saved Records' },
];

export function roleDefaultPages(role: Role): View[] {
  return ROLE_ACCESS[role] ?? ROLE_ACCESS.operator;
}

export function userAllowedViews(profile: { role: Role; page_access: string[] | null }): View[] {
  const defaults = roleDefaultPages(profile.role);
  const override =
    profile.page_access && profile.page_access.length > 0
      ? profile.page_access.filter((p): p is View => (VALID_VIEWS as string[]).includes(p))
      : null;
  let views: View[] = override ?? defaults;
  // Admins can never lose the Admin page (prevents locking themselves out).
  if (profile.role === 'admin' && !views.includes('admin')) {
    views = [...views, 'admin'];
  }
  return views;
}
