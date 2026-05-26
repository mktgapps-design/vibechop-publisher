import * as ff from "@google-cloud/functions-framework";
import { createClient } from "@supabase/supabase-js";
import { getComposio } from "./composio";
import { publishClip } from "./publish";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
);

ff.http("publishScheduled", async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { publicationId } = req.body as { publicationId?: string };
  if (!publicationId) {
    res.status(400).json({ error: "publicationId required" });
    return;
  }

  console.log(`[publisher] processing publication ${publicationId}`);

  try {
    const { data: pub, error: pubErr } = await supabase
      .from("clip_publications")
      .select(
        `id, clip_id, user_id, platform, status, title, description,
         social_connection_id,
         clips!inner(gcs_video_key)`,
      )
      .eq("id", publicationId)
      .single();

    if (pubErr || !pub) {
      console.log(`[publisher] publication not found: ${publicationId}`);
      res.status(200).json({ skipped: true, reason: "not_found" });
      return;
    }

    if (["published", "cancelled"].includes(pub.status)) {
      console.log(`[publisher] already ${pub.status}, skipping`);
      res.status(200).json({ skipped: true, reason: pub.status });
      return;
    }

    const { data: conn } = await supabase
      .from("social_connections")
      .select("composio_connected_account_id, composio_user_id, status")
      .eq("id", pub.social_connection_id)
      .single();

    if (!conn) {
      await supabase
        .from("clip_publications")
        .update({ status: "failed", error_message: "Social connection not found" })
        .eq("id", publicationId);
      res.status(200).json({ error: "connection_not_found" });
      return;
    }

    // Check token health before publishing
    try {
      const composio = getComposio();
      const account = await composio.connectedAccounts.get(
        conn.composio_connected_account_id,
      );
      const composioStatus = (account as Record<string, unknown>)?.status as string | undefined;
      if (composioStatus && ["EXPIRED", "FAILED"].includes(composioStatus.toUpperCase())) {
        await supabase
          .from("social_connections")
          .update({ status: "expired" })
          .eq("id", pub.social_connection_id);
        await supabase
          .from("clip_publications")
          .update({
            status: "failed",
            error_message: "Token expired, please reconnect your account",
          })
          .eq("id", publicationId);
        res.status(200).json({ error: "token_expired" });
        return;
      }
    } catch (healthErr) {
      console.warn("[publisher] health check failed, proceeding anyway:", healthErr);
    }

    await supabase
      .from("clip_publications")
      .update({ status: "pending" })
      .eq("id", publicationId);

    const clip = pub.clips as unknown as { gcs_video_key: string };

    const result = await publishClip({
      composioUserId: conn.composio_user_id,
      connectedAccountId: conn.composio_connected_account_id,
      platform: pub.platform as "youtube" | "instagram",
      gcsKey: clip.gcs_video_key,
      title: pub.title ?? "Untitled Clip",
      description: pub.description ?? "",
    });

    await supabase
      .from("clip_publications")
      .update({
        status: "published",
        external_id: result.externalId,
        external_url: result.externalUrl,
      })
      .eq("id", publicationId);

    console.log(`[publisher] published ${publicationId}:`, result);
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[publisher] failed ${publicationId}:`, errMsg);

    await supabase
      .from("clip_publications")
      .update({ status: "failed", error_message: errMsg.slice(0, 1000) })
      .eq("id", publicationId);

    res.status(200).json({ error: errMsg });
  }
});
