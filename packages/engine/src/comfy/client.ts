import { Comfy } from "@comfyorg/sdk";

/**
 * The SDK takes its target from COMFY_BASE_URL at construction and has no base-URL option. Set it just
 * for the (synchronous) constructor and put the environment back. COMFY_API_KEY is hidden too: the SDK
 * would otherwise send a Comfy Cloud key to our local proxy.
 */
export function createComfyClient(baseUrl: string): Comfy {
  const prevBase = process.env.COMFY_BASE_URL;
  const prevKey = process.env.COMFY_API_KEY;
  process.env.COMFY_BASE_URL = baseUrl;
  delete process.env.COMFY_API_KEY;
  try {
    return new Comfy({ clientInfo: "nightshift-engine" });
  } finally {
    if (prevBase === undefined) delete process.env.COMFY_BASE_URL;
    else process.env.COMFY_BASE_URL = prevBase;
    if (prevKey !== undefined) process.env.COMFY_API_KEY = prevKey;
  }
}
