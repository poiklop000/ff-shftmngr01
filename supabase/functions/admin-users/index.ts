// admin-users — user management endpoint for the Krones Canning Line Console
//
// The app authenticates with name + password: usernames are mapped to Supabase
// Auth email addresses as "<username>@app.local". This edge function performs
// all user administration using the service role (list, create, reset password,
// enable/disable, update, delete). Only signed-in users whose profile has
// role = 'admin' may call it.
//
// Request body (POST):  { action, ... }
//   list                      -> GET also supported
//   create      { username, password, displayName, role }
//   reset       { userId, password }
//   set-active  { userId, isActive }
//   update      { userId, displayName?, role? }
//   delete      { userId }
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const APP_DOMAIN = "@app.local";
const USERNAME_RE = /^[A-Za-z0-9_.-]{1,50}$/;
const VALID_ROLES = ["admin", "manager", "team_lead", "operator"] as const;
type Role = (typeof VALID_ROLES)[number];

function normalizeRole(value: unknown): Role {
  return VALID_ROLES.includes(value as Role) ? (value as Role) : "operator";
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getAdminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Supabase env not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function requireAdmin(req: Request, admin: ReturnType<typeof getAdminClient>) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("Not signed in");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new Error("Not signed in");
  const { data: profile } = await admin
    .from("profiles")
    .select("user_id, role, is_active, display_name, username")
    .eq("user_id", data.user.id)
    .maybeSingle();
  if (!profile || profile.role !== "admin" || !profile.is_active) {
    throw new Error("Admin access required");
  }
  return { userId: data.user.id, profile };
}

function validateCredentials(username: string, password: string, displayName: string) {
  if (!USERNAME_RE.test(username)) throw new Error("Username may only contain letters, numbers, dots, dashes, underscores (max 50 chars)");
  if (!displayName || displayName.trim().length === 0 || displayName.trim().length > 100) {
    throw new Error("Display name is required (max 100 chars)");
  }
  if (!password || password.length < 6) throw new Error("Password must be at least 6 characters");
  return { username: username.trim(), password, displayName: displayName.trim() };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
  } catch {
    return json({ error: "Server not configured" }, 500);
  }

  try {
    const { userId } = await requireAdmin(req, admin);

    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");

    if (req.method === "GET" || action === "list") {
      const { data: users, error } = await admin
        .from("profiles")
        .select("user_id, username, display_name, role, is_active, created_at")
        .order("created_at", { ascending: true });
      if (error) return json({ error: error.message }, 400);
      return json({ users });
    }

    if (action === "create") {
      const { username, password, displayName } = validateCredentials(body.username ?? "", body.password ?? "", body.displayName ?? "");
      const role = normalizeRole(body.role);
      const email = `${username.toLowerCase()}${APP_DOMAIN}`;

      const { data: created, error: cErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { display_name: displayName },
      });
      if (cErr) return json({ error: cErr.message }, 400);
      if (!created?.user) return json({ error: "Failed to create user" }, 400);

      const { error: pErr } = await admin.from("profiles").insert({
        user_id: created.user.id,
        username,
        display_name: displayName,
        role,
        is_active: true,
      });
      if (pErr) {
        await admin.auth.admin.deleteUser(created.user.id).catch(() => {});
        return json({ error: pErr.message }, 400);
      }
      return json({ user: { user_id: created.user.id, username, display_name: displayName, role, is_active: true } });
    }

    if (action === "reset") {
      const { userId: targetId, password } = body;
      if (!targetId || !password || String(password).length < 6) {
        return json({ error: "User ID and a password of at least 6 characters are required" }, 400);
      }
      const { error } = await admin.auth.admin.updateUserById(String(targetId), { password: String(password) });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "set-active") {
      const targetId = String(body.userId ?? "");
      if (!targetId) return json({ error: "User ID is required" }, 400);
      if (targetId === userId) return json({ error: "You cannot disable your own account" }, 400);
      const { error } = await admin.from("profiles").update({ is_active: Boolean(body.isActive) }).eq("user_id", targetId);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "update") {
      const targetId = String(body.userId ?? "");
      if (!targetId) return json({ error: "User ID is required" }, 400);
      const patch: Record<string, string> = {};
      if (body.displayName !== undefined) {
        const dn = String(body.displayName).trim();
        if (!dn || dn.length > 100) return json({ error: "Display name is required (max 100 chars)" }, 400);
        patch.display_name = dn;
      }
      if (body.role !== undefined) patch.role = normalizeRole(body.role);
      if (Object.keys(patch).length === 0) return json({ error: "Nothing to update" }, 400);
      const { error } = await admin.from("profiles").update(patch).eq("user_id", targetId);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "delete") {
      const targetId = String(body.userId ?? "");
      if (!targetId) return json({ error: "User ID is required" }, 400);
      if (targetId === userId) return json({ error: "You cannot delete your own account" }, 400);
      const { error } = await admin.auth.admin.deleteUser(targetId);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Request failed" }, 401);
  }
});
