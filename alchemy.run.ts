import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { ChatAgent, MemoryAgent } from "./src/server/index.ts";

// Every user's memory is one git repo in this Artifacts namespace. Repos are created at runtime.
export const Memories = Cloudflare.Artifacts.Namespace("Memories", { namespace: "shared-memory" });

export const App = Cloudflare.Website.Vite("App", {
  main: "./src/server/index.ts",
  // Trial: served at the workers.dev URL. To put it on a zone in this account, restore:
  //   domain: { name: "memory.example.com", redirects: ["www.memory.example.com"] },
  compatibility: { date: "2026-09-01" },
  assets: {
    notFoundHandling: "single-page-application",
    runWorkerFirst: ["/agents/*", "/api", "/api/*", "/auth/*"],
  },
  observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
  env: {
    MemoryAgent: Cloudflare.DurableObject<MemoryAgent>("MemoryAgent"),
    ChatAgent: Cloudflare.DurableObject<ChatAgent>("ChatAgent"),
    MEMORIES: Memories,
    // Workers AI binding: account-level, nothing to provision, no API key.
    AI: Cloudflare.Workers.AI,
    // Signs login sessions. Any long random string (e.g. `openssl rand -hex 32`).
    AUTH_SECRET: Config.Redacted("AUTH_SECRET"),
    // Cloudflare Access (human sign-in): the team domain and this app's AUD tag, e.g.
    //   https://<team>.cloudflareaccess.com  ·  the AUD tag under Access → Applications → your app.
    // Until both are set the UI has no sign-in; agents still work via MEMORY_API_KEY.
    ACCESS_TEAM_DOMAIN: Config.String("ACCESS_TEAM_DOMAIN").pipe(Config.withDefault("")),
    ACCESS_AUD: Config.String("ACCESS_AUD").pipe(Config.withDefault("")),
    // Optional admin key: `Authorization: Bearer <MEMORY_API_KEY>` reaches any user's /api. Unset = off.
    MEMORY_API_KEY: Config.Redacted("MEMORY_API_KEY").pipe(Config.withDefault(Redacted.make(""))),
  },
});

export default Alchemy.Stack(
  "shared-memory",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const app = yield* App;
    return { url: app.url };
  }),
);
