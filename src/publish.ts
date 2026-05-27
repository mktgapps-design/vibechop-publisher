import { getComposio } from "./composio";
import { Storage } from "@google-cloud/storage";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { unlink } from "fs/promises";

const storage = new Storage();
const BUCKET = process.env.GCS_BUCKET_NAME ?? "";

type FileDescriptor = { name: string; mimetype: string; s3key: string };

async function generateSignedUrl(
  gcsKey: string,
  expiresInSec: number,
): Promise<string> {
  const [url] = await storage
    .bucket(BUCKET)
    .file(gcsKey)
    .getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + expiresInSec * 1000,
    });
  return url;
}

async function downloadToTemp(gcsKey: string): Promise<string> {
  const signedUrl = await generateSignedUrl(gcsKey, 15 * 60);
  const ext = gcsKey.split(".").pop() || "mp4";
  const dest = join(tmpdir(), `vc-pub-${randomUUID()}.${ext}`);

  const resp = await fetch(signedUrl);
  if (!resp.ok || !resp.body) {
    throw new Error(`GCS download failed: ${resp.status} ${resp.statusText}`);
  }

  const nodeStream = Readable.fromWeb(resp.body as any);
  await pipeline(nodeStream, createWriteStream(dest));
  return dest;
}

async function stageToComposio(
  gcsKey: string,
  toolSlug: string,
  toolkitSlug: string,
): Promise<FileDescriptor> {
  const composio = getComposio();
  const tempPath = await downloadToTemp(gcsKey);
  try {
    const uploaded = await composio.files.upload({
      file: tempPath,
      toolSlug,
      toolkitSlug,
    });
    return uploaded as FileDescriptor;
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

type PublishParams = {
  composioUserId: string;
  connectedAccountId: string;
  platform: "youtube" | "instagram";
  gcsKey: string;
  title: string;
  description: string;
  tags?: string[];
  privacyStatus?: string;
  categoryId?: string;
};

export async function publishClip(params: PublishParams): Promise<{
  externalId: string | null;
  externalUrl: string | null;
}> {
  const composio = getComposio();

  if (params.platform === "youtube") {
    return publishToYouTube(composio, params);
  } else {
    return publishToInstagram(composio, params);
  }
}

async function publishToYouTube(
  composio: ReturnType<typeof getComposio>,
  params: PublishParams,
) {
  let title = params.title || "Untitled Clip";
  if (!title.includes("#Shorts")) title = `${title} #Shorts`;

  let desc = params.description || "";
  if (!desc.includes("#Shorts")) desc = desc ? `${desc}\n\n#Shorts` : "#Shorts";

  const fileDescriptor = await stageToComposio(
    params.gcsKey,
    "YOUTUBE_MULTIPART_UPLOAD_VIDEO",
    "youtube",
  );

  const session = await composio.create(params.composioUserId, {
    toolkits: ["youtube"],
    connectedAccounts: { youtube: params.connectedAccountId },
  });

  const result = await session.execute("YOUTUBE_MULTIPART_UPLOAD_VIDEO", {
    title,
    description: desc,
    categoryId: params.categoryId || "22",
    privacyStatus: params.privacyStatus || "public",
    tags: [...(params.tags || []), "Shorts"],
    videoFile: fileDescriptor,
  });

  const resultObj = (result ?? {}) as Record<string, unknown>;
  const dataObj = (resultObj.data ?? resultObj) as Record<string, unknown>;
  const videoObj = (dataObj.video ?? dataObj) as Record<string, unknown>;
  const externalId = String(
    videoObj.id ?? dataObj.id ?? resultObj.id ?? resultObj.videoId ?? "",
  );

  return {
    externalId: externalId || null,
    externalUrl: externalId ? `https://youtube.com/watch?v=${externalId}` : null,
  };
}

async function publishToInstagram(
  composio: ReturnType<typeof getComposio>,
  params: PublishParams,
) {
  const session = await composio.create(params.composioUserId, {
    toolkits: ["instagram"],
    connectedAccounts: { instagram: params.connectedAccountId },
  });

  const igUserRes = await session.execute("INSTAGRAM_GET_USER_INFO", {
    ig_user_id: "me",
  });
  const igUserData = ((igUserRes as Record<string, unknown>)?.data ??
    igUserRes) as Record<string, unknown>;
  const igUserId = String(igUserData?.id ?? "");
  if (!igUserId) {
    throw new Error("Could not resolve Instagram user ID");
  }

  const fileDescriptor = await stageToComposio(
    params.gcsKey,
    "INSTAGRAM_POST_IG_USER_MEDIA",
    "instagram",
  );

  const containerResult = await session.execute("INSTAGRAM_POST_IG_USER_MEDIA", {
    ig_user_id: igUserId,
    video_file: fileDescriptor,
    caption: params.description || params.title || "",
    media_type: "REELS",
  });

  const containerObj = (containerResult ?? {}) as Record<string, unknown>;
  const containerData = (containerObj.data ?? containerObj) as Record<string, unknown>;
  const creationId = String(containerData.creation_id ?? containerData.id ?? "");

  if (!creationId) {
    throw new Error(`Instagram container creation failed: ${JSON.stringify(containerResult)}`);
  }

  const publishResult = await session.execute(
    "INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH",
    {
      ig_user_id: igUserId,
      creation_id: String(creationId),
      max_wait_seconds: 120,
    },
  );

  const resultObj = (publishResult ?? {}) as Record<string, unknown>;
  const externalId = String(resultObj.id ?? resultObj.media_id ?? "");

  return {
    externalId: externalId || null,
    externalUrl: externalId
      ? `https://www.instagram.com/reel/${externalId}/`
      : null,
  };
}
