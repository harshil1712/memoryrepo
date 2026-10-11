import { wrapLanguageModel, type LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";

/**
 * Open-weight models with tool calling, served through Workers AI (the env.AI binding —
 * no API key, no egress). Prices are USD per 1M tokens as listed by Cloudflare (Oct 2026);
 * the binding reports no per-call cost, so the meter below uses these list prices.
 */
export type ModelInfo = { id: string; name: string; context: number; inPerM: number; outPerM: number };

export const MODELS: ModelInfo[] = [
  { id: "@cf/zai-org/glm-5.3", name: "GLM 5.3", context: 1_048_576, inPerM: 1.4, outPerM: 4.4 },
  { id: "@cf/zai-org/glm-5.3-flash", name: "GLM 5.3 Flash", context: 1_048_576, inPerM: 0.15, outPerM: 0.5 },
  { id: "@cf/deepseek-ai/deepseek-v4-pro-0813", name: "DeepSeek V4 Pro", context: 1_048_576, inPerM: 1.32, outPerM: 3.96 },
  { id: "@cf/deepseek-ai/deepseek-v4-flash-0731", name: "DeepSeek V4 Flash", context: 1_048_576, inPerM: 0.44, outPerM: 1.32 },
  { id: "@cf/moonshotai/kimi-k2.6", name: "Kimi K2.6", context: 262_144, inPerM: 0.95, outPerM: 4.0 },
  { id: "@cf/qwen/qwen3.8-27b", name: "Qwen3.8 27B", context: 262_144, inPerM: 0.45, outPerM: 3.2 },
  { id: "@cf/openai/gpt-oss-120b", name: "gpt-oss-120b", context: 128_000, inPerM: 0.35, outPerM: 0.75 },
  { id: "@cf/nvidia/nemotron-3-120b-a12b", name: "Nemotron 3 120B", context: 256_000, inPerM: 0.5, outPerM: 1.5 },
];

export const DEFAULT_CHAT_MODEL = "@cf/zai-org/glm-5.3";
export const DEFAULT_DREAM_MODEL = "@cf/deepseek-ai/deepseek-v4-pro-0813";

export const modelInfo = (id: string): ModelInfo => MODELS.find((m) => m.id === id) ?? { id, name: id, context: 200_000, inPerM: 0, outPerM: 0 };

export function resolveModel(id: string, ai: Ai): LanguageModel {
  return createWorkersAI({ binding: ai }).chat(id);
}

/** One model call, as reported by the provider. `input` includes `cached`. */
export type CallUsage = { model: string; input: number; cached: number; output: number; cost: number; ms: number };

/** Wrap a model so every call (each agent step) reports tokens, cost and time. */
export function metered(model: LanguageModel, modelId: string, onCall: (u: CallUsage) => void): LanguageModel {
  if (typeof model === "string") return model;
  type Usage = { inputTokens: { total?: number; cacheRead?: number }; outputTokens: { total?: number } };
  const report = (usage: Usage, ms: number) => {
    const input = usage.inputTokens.total ?? 0;
    const cached = usage.inputTokens.cacheRead ?? 0;
    const output = usage.outputTokens.total ?? 0;
    const info = modelInfo(modelId);
    const listPrice = (input * info.inPerM + output * info.outPerM) / 1_000_000;
    onCall({ model: modelId, input, cached, output, cost: listPrice, ms });
  };
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      wrapGenerate: async ({ doGenerate }) => {
        const t0 = Date.now();
        const result = await doGenerate();
        report(result.usage, Date.now() - t0);
        return result;
      },
      wrapStream: async ({ doStream }) => {
        const t0 = Date.now();
        const { stream, ...rest } = await doStream();
        const tap = new TransformStream({
          transform(part, controller) {
            if (part.type === "finish") report(part.usage, Date.now() - t0);
            controller.enqueue(part);
          },
        });
        return { stream: stream.pipeThrough(tap), ...rest };
      },
    },
  });
}
