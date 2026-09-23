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

/** `media` 항목·`file`·링크 버튼의 `url` 설명(스펙 결정 5) — 모델은 첨부 id 를 모르므로 같은 메시지의 파일 이름으로 가리킨다 */
export const ARTIFACT_URL_DESCRIPTION =
  "https:// URL, 또는 이 메시지와 함께 `media` 로 보낸 파일은 `artifact://<파일 이름>` 으로 가리킨다.";

/** 스키마 안의 모든 `url` 속성(components v1 에서는 media 항목·file·버튼 셋뿐)에 설명을 붙인다. 모양은 바꾸지 않는다 */
function describeUrls(node: unknown): void {
  if (Array.isArray(node)) {
    for (const child of node) describeUrls(child);
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  const properties = record["properties"] as Record<string, unknown> | undefined;
  const url = properties?.["url"];
  if (properties && url && typeof url === "object") {
    properties["url"] = { ...(url as Record<string, unknown>), description: ARTIFACT_URL_DESCRIPTION };
  }
  for (const child of Object.values(record)) describeUrls(child);
}

function buildComponentsJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ComponentsV1, { io: "input" }) as Record<string, unknown>;
  delete schema["$schema"];
  describeUrls(schema);
  return { ...schema, description: COMPONENTS_DESCRIPTION };
}

export const componentsJsonSchema: Record<string, unknown> = buildComponentsJsonSchema();
