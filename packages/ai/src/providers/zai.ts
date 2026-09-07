import type { Api, Model, ThinkingLevelMap } from "../types.js";

const GLM_5_3_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: "low",
	medium: null,
	high: "high",
	xhigh: null,
	max: "max",
} satisfies ThinkingLevelMap;

export function getZaiThinkingLevelMap(model: Model<Api>): ThinkingLevelMap | undefined {
	let isZai = model.provider === "zai";
	try {
		isZai ||= new URL(model.baseUrl).hostname === "api.z.ai";
	} catch {
		// Custom providers can leave the base URL unresolved until request time.
	}
	if (!isZai || !/^glm-5\.3(?:-|$)/i.test(model.id)) return undefined;
	// https://docs.z.ai/guides/capabilities/thinking: GLM-5.3 requires low/high/max.
	return GLM_5_3_THINKING_LEVEL_MAP;
}
