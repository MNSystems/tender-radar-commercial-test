// Tender Radar KZ — protected first-search trigger (staging only).
// Required Edge Function secrets: SUPABASE_URL, SUPABASE_ANON_KEY,
// SUPABASE_SERVICE_ROLE_KEY, GH_INITIAL_SEARCH_TOKEN.
// Deploy only after rate limiting and end-to-end staging verification.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const allowedOrigin = "https://mnsystems.github.io";
const cors = {
  "Access-Control-Allow-Origin": allowedOrigin,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const response = (status: number, message: string) =>
  new Response(JSON.stringify({ message }), { status, headers: cors });

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (request.method !== "POST") return response(405, "Method not allowed");
  try {
    const bearer = request.headers.get("Authorization") || "";
    if (!bearer.startsWith("Bearer ")) return response(401, "Sign in required");
    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const githubToken = Deno.env.get("GH_INITIAL_SEARCH_TOKEN")!;
    if (!url || !anonKey || !serviceKey || !githubToken)
      return response(503, "Initial search is not configured");

    const scoped = createClient(url, anonKey, {
      global: { headers: { Authorization: bearer } },
      db: { schema: "commercial" },
    });
    const { data: { user }, error: userError } = await scoped.auth.getUser(bearer.slice(7));
    if (userError || !user) return response(401, "Invalid user session");

    const body = await request.json();
    const profileId = Number(body.profile_id);
    if (!Number.isSafeInteger(profileId) || profileId <= 0)
      return response(400, "Invalid profile");

    const admin = createClient(url, serviceKey, { db: { schema: "commercial" } });
    const { data: memberships, error: memberError } = await admin
      .from("client_users").select("client_id").eq("auth_user_id", user.id).eq("active", true);
    if (memberError || !memberships?.length) return response(403, "Client access missing");

    const { data: profile, error: profileError } = await admin
      .from("profiles").select("id,client_id,active,sources,created_at")
      .eq("id", profileId).single();
    if (profileError || !profile || !profile.active ||
        !memberships.some(m => m.client_id === profile.client_id))
      return response(403, "Profile not accessible");
    if (!(profile.sources || []).includes("goszakup"))
      return response(400, "Profile does not include Goszakup");

    // Staging safety: only newly created profiles, not arbitrary repeated historical searches.
    const ageMs = Date.now() - Date.parse(profile.created_at);
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 10 * 60 * 1000)
      return response(409, "Initial search window has expired");

    // Atomic single-use reservation: simultaneous requests cannot enqueue duplicates.
    // Migration must be applied before deploying this function.
    const { data: claimed, error: claimError } = await admin.rpc("claim_initial_search", {
      p_profile_id: profileId,
    });
    if (claimError) return response(503, "Initial search reservation unavailable");
    if (claimed !== true) return response(409, "Initial search already requested");

    const gh = await fetch(
      "https://api.github.com/repos/MNSystems/tender-radar-commercial/actions/workflows/initial-client-search.yml/dispatches",
      {
        method: "POST",
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${githubToken}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ref: "feature/initial-search-20261014",
          inputs: { profile_id: String(profileId) },
        }),
      },
    );
    if (!gh.ok) return response(502, "Initial search could not be queued");
    return response(202, "Initial search queued");
  } catch {
    return response(500, "Initial search request failed");
  }
});
