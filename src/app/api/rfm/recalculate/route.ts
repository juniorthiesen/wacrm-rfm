import { NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { recalculateUserRFM } from "@/lib/rfm/engine";

// Manual trigger for the RFM engine. Called from the /dashboard/rfm
// page after a big sync, or any time the operator wants fresh scores
// without waiting for the next webhook delivery.
//
// Uses the service-role client because RFM scans all orders and
// upserts metrics across the tenant — both are RLS-friendly under the
// user's own row but it's a no-op to switch to admin for an idempotent
// per-user operation, and it skips the extra RLS hop.

function adminClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export async function POST() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const result = await recalculateUserRFM(adminClient(), user.id);
  if (!result.success) {
    return NextResponse.json(
      { error: "Recalculation failed" },
      { status: 500 },
    );
  }
  return NextResponse.json({
    success: true,
    updated_count: result.updatedCount,
  });
}
