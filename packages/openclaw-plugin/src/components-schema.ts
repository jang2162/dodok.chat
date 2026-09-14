/**
 * message 툴에 끼울 `components` 스키마 조각. shared 의 components v1 을 그대로 JSON Schema 로 노출한다.
 * `openclaw` 를 import 하지 않는다 — TypeBox `TSchema` 로의 캐스트는 `channel.ts` 가 한다.
 */
import { ComponentsV1 } from "@dodok/shared/components";
import { z } from "zod";

/** 모델에게 보여 줄 설명. 제약은 스키마가 강제하지만 설명에도 적어야 모델이 처음부터 맞춘다 */
export const COMPONENTS_DESCRIPTION =
  "dodok interactive UI (components v1). Blocks: section, separator, actions (≤5 buttons or 1 select), media, file; " +
  "optional modal (≤5 fields). Button ids are [a-z0-9_-]. Clicks come back as a normal inbound message.";

function buildComponentsJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ComponentsV1, { io: "input" }) as Record<string, unknown>;
  delete schema["$schema"];
  return { ...schema, description: COMPONENTS_DESCRIPTION };
}

export const componentsJsonSchema: Record<string, unknown> = buildComponentsJsonSchema();
