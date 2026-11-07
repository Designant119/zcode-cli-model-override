import type { ModelSelection } from "@zcode/provider";
import type { ProviderRegistryModelSource } from "./provider-registry-model-runtime.js";
import {
  requireRegistryThoughtLevel,
  resolveRegistryModelSelection,
  type ResolvedRegistrySelection,
} from "./provider-registry-selection.js";

/**
 * 解析 -p 单次调用覆盖（CLI --model/--reasoning）为完整 Registry Selection。
 *
 * 覆盖不落任何默认值：新会话把它当初始选择（首条 entry 正常记录实际使用的模型），
 * resume 只影响本进程回合、不改会话已保存的选择。规则见
 * docs/design/v2/tui-model-selection.md「Headless Invocation Override」。
 */
export function resolveInvocationModelSelection(input: {
  registry: ProviderRegistryModelSource;
  override: { model?: string; reasoning?: string };
  /** 本次运行原本会使用的选择（新会话为配置默认，resume 为恢复的保存意图）。 */
  base?: ModelSelection;
}): ModelSelection {
  const { registry, override, base } = input;

  if (override.model !== undefined) {
    const resolved = resolveInvocationModelRef(registry, override.model);
    // 与显式 /model 选择同规则：缺省档位取目录默认（最高档），显式档位必须受支持。
    const level = requireRegistryThoughtLevel(
      resolved,
      override.reasoning ?? resolved.model.config.optionSpecs.reasoningLevel.values.at(-1)!,
    );
    return {
      providerId: resolved.provider.providerId,
      modelId: resolved.model.modelId,
      options: { reasoningLevel: level },
    };
  }

  // 只给档位：调整 base 的模型；没有 base 时无从调整，必须显式报错而不是静默换模型。
  if (!base) {
    throw new Error(
      "--reasoning has no model to adjust for this run; pass --model as well, or select/configure a model first.",
    );
  }
  const resolved = resolveRegistryModelSelection(registry, base);
  if (!resolved) {
    throw new Error(
      `--reasoning cannot adjust model ${base.providerId}/${base.modelId}: it is not available in the Provider Registry. Pass --model to select a runnable model.`,
    );
  }
  const level = requireRegistryThoughtLevel(resolved, override.reasoning!);
  return { ...base, options: { ...base.options, reasoningLevel: level } };
}

/**
 * 定位 --model 指向的模型。`provider/model` 精确匹配；裸模型 ID 先精确、
 * 再大小写不敏感唯一匹配——官方目录 ID 带大小写（GLM-5.3-Flash），历史配置
 * 与用户输入常是小写（glm-5.3-flash），精确匹配会让覆盖静默失效回退默认模型。
 */
function resolveInvocationModelRef(
  registry: ProviderRegistryModelSource,
  requested: string,
): ResolvedRegistrySelection {
  const trimmed = requested.trim();
  const providers = registry.getView().providers.filter(
    (provider) => provider.config.visibility !== "hidden",
  );

  const separator = trimmed.indexOf("/");
  if (separator > 0 && separator < trimmed.length - 1) {
    const providerId = trimmed.slice(0, separator);
    const modelId = trimmed.slice(separator + 1);
    const matched = providers
      .filter((provider) => provider.providerId === providerId)
      .flatMap((provider) =>
        provider.models
          .filter((model) => model.modelId === modelId)
          .map((model) => ({ provider, model })),
      );
    if (matched.length === 1) {
      return { provider: matched[0].provider, model: matched[0].model, selection: { providerId, modelId } };
    }
    throw new Error(
      `Unknown model: ${trimmed}. Use provider/model with ids from the selectable catalog.`,
    );
  }

  const exact = matchModelById(providers, (modelId) => modelId === trimmed);
  if (exact) return exact;
  const lower = trimmed.toLowerCase();
  const caseInsensitive = matchModelById(providers, (modelId) => modelId.toLowerCase() === lower);
  if (caseInsensitive) return caseInsensitive;

  const modelIds = providers.flatMap((provider) => provider.models.map((model) => `${provider.providerId}/${model.modelId}`));
  throw new Error(
    `Unknown model: ${trimmed}. Available: ${modelIds.slice(0, 8).join(", ")}${modelIds.length > 8 ? ", …" : ""}`,
  );
}

function matchModelById(
  providers: ReturnType<ProviderRegistryModelSource["getView"]>["providers"],
  matches: (modelId: string) => boolean,
): ResolvedRegistrySelection | undefined {
  const matched = providers.flatMap((provider) =>
    provider.models
      .filter((model) => matches(model.modelId))
      .map((model) => ({ provider, model })),
  );
  if (matched.length === 1) {
    return {
      provider: matched[0].provider,
      model: matched[0].model,
      selection: {
        providerId: matched[0].provider.providerId,
        modelId: matched[0].model.modelId,
      },
    };
  }
  if (matched.length > 1) {
    const refs = matched.map(({ provider, model }) => `${provider.providerId}/${model.modelId}`);
    throw new Error(`Ambiguous model id: ${matched[0].model.modelId}. Use one of: ${refs.join(", ")}`);
  }
  return undefined;
}
