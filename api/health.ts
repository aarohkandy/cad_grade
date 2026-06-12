import type { VercelRequest, VercelResponse } from "@vercel/node";
import { dataset } from "../src/server/items";
import { methodAllowed, noStore } from "../src/server/http";
import { getSupabase, supabaseConfigured } from "../src/server/supabase";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  noStore(res);
  if (!methodAllowed(req, res, ["GET"])) return;
  const supabase = getSupabase();
  let supabaseStatus: "not_configured" | "ok" | "error" = supabaseConfigured() ? "error" : "not_configured";
  let supabaseMessage = "";
  if (supabase) {
    const { error } = await supabase.from("item_stats").select("item_id").limit(1);
    if (error) {
      supabaseMessage = error.message;
    } else {
      supabaseStatus = "ok";
    }
  }
  res.status(200).json({
    ok: true,
    app: "capybara-arena",
    datasetId: dataset.datasetId,
    itemCount: dataset.itemCount,
    supabase: supabaseStatus,
    supabaseMessage,
  });
}
