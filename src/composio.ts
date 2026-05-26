import { Composio } from "@composio/core";
import { tmpdir } from "os";

let _client: Composio | null = null;

export function getComposio(): Composio {
  if (_client) return _client;
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) throw new Error("COMPOSIO_API_KEY must be set");
  _client = new Composio({
    apiKey,
    dangerouslyAllowAutoUploadDownloadFiles: true,
    fileUploadDirs: [tmpdir()],
  });
  return _client;
}
