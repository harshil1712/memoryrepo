import type { ChatAgent } from "./chat-agent.ts";
import type { MemoryAgent } from "./memory-agent.ts";

/** Worker bindings, as declared in alchemy.run.ts (written out to avoid a type cycle with the agents). */
export interface Env {
  MemoryAgent: DurableObjectNamespace<MemoryAgent>;
  ChatAgent: DurableObjectNamespace<ChatAgent>;
  MEMORIES: Artifacts;
  /** Workers AI — chat and dream models run through this binding (no API key). */
  AI: Ai;
  /** Signs session tokens. Any long random string; changing it signs everyone out. */
  AUTH_SECRET: string;
  /** Cloudflare Access: the team domain, e.g. `https://<team>.cloudflareaccess.com`. Empty = no UI sign-in. */
  ACCESS_TEAM_DOMAIN: string;
  /** Cloudflare Access: this application's AUD tag. Empty = no UI sign-in. */
  ACCESS_AUD: string;
  /** Optional admin key: `Authorization: Bearer <MEMORY_API_KEY>` reaches any user's /api. Empty = off. */
  MEMORY_API_KEY: string;
}
