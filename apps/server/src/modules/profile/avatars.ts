import { AVATAR_MAX_BYTES, AVATAR_MAX_PX, AVATAR_MIN_PX } from "@dodok/shared";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq, isNotNull } from "drizzle-orm";
import type { DbOrTx } from "../../db/client";
import { agents, users } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import { sniff } from "../attachments/sniff";
import { createBlobLocks } from "../attachments/store";

// 아바타 파일(프로필 스펙 2장·3.6) — `<DATA_DIR>/avatars/<sha256>.<ext>`. 첨부 저장소와 따로 둔다: 첨부 청소는 「어느 첨부 행도 안
// 가리키는 블롭」을 지우므로 같은 디렉터리면 아바타가 지워진다. 같은 내용이면 한 파일이고, users·agents 어느 행도 안 가리키게 되면 지운다

export type AvatarExt = "png" | "jpeg" | "webp";

const EXT_OF: Readonly<Record<string, AvatarExt>> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
};
export const AVATAR_MIME: Readonly<Record<AvatarExt, string>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** 아바타 파일 이름 — GET 경로가 이 모양이 아니면 디스크를 보지 않는다(경로 탈출 없음) */
export const AVATAR_FILE = /^[0-9a-f]{64}\.(png|jpeg|webp)$/;
const URL_PREFIX = "/api/v1/avatars/";

/** 올린 사진의 주소면 파일 이름, 바깥 https URL·null 이면 null */
export function avatarFileOf(url: string | null | undefined): string | null {
  if (!url?.startsWith(URL_PREFIX)) return null;
  const file = url.slice(URL_PREFIX.length);
  return AVATAR_FILE.test(file) ? file : null;
}

/** 같은 파일의 「쓰기 + 행 바꾸기」와 「참조 세기 + 지우기」를 줄 세운다 — 지우는 사이 같은 그림을 올린 사람의 파일이 사라지지 않게 */
export const avatarLocks = createBlobLocks();

/** 조건 — png·jpeg·webp(바이트로 판별), 256KB 이하, 정사각형, 한 변 64~512px. 어기면 VALIDATION(문구에 어긴 조건) */
export function checkAvatar(bytes: Uint8Array): AvatarExt {
  if (bytes.byteLength > AVATAR_MAX_BYTES)
    throw apiError("VALIDATION", `아바타는 ${AVATAR_MAX_BYTES / 1024}KB 이하여야 한다`, {
      maxBytes: AVATAR_MAX_BYTES,
    });
  const found = sniff(bytes);
  const ext = found.kind === "image" ? EXT_OF[found.mime] : undefined;
  if (!ext || found.width === undefined || found.height === undefined)
    throw apiError("VALIDATION", "아바타 형식은 png·jpeg·webp 만 받는다");
  if (found.width !== found.height) throw apiError("VALIDATION", "아바타는 정사각형이어야 한다");
  if (found.width < AVATAR_MIN_PX || found.width > AVATAR_MAX_PX)
    throw apiError("VALIDATION", `아바타 한 변은 ${AVATAR_MIN_PX}~${AVATAR_MAX_PX}px 이어야 한다`);
  return ext;
}

/** 확인하고 파일 이름·주소를 정한다(쓰지 않는다) */
export function prepareAvatar(bytes: Uint8Array): { file: string; url: string } {
  const ext = checkAvatar(bytes);
  const file = `${createHash("sha256").update(bytes).digest("hex")}.${ext}`;
  return { file, url: `${URL_PREFIX}${file}` };
}

/** 쓴다(이미 있으면 그대로) — 임시 파일에 쓰고 rename 해서 반쯤 쓴 파일이 보이지 않게. 그 파일의 잠금 안에서 부른다 */
export async function writeAvatarFile(dir: string, file: string, bytes: Uint8Array): Promise<void> {
  const path = join(dir, file);
  if (existsSync(path)) return;
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, bytes, { mode: 0o600 });
  await rename(tmp, path);
}

function referenced(db: DbOrTx, url: string): boolean {
  return (
    db.select({ id: users.id }).from(users).where(eq(users.avatarUrl, url)).get() !== undefined ||
    db.select({ id: agents.id }).from(agents).where(eq(agents.avatarUrl, url)).get() !== undefined
  );
}

/** 옛 주소를 놓는다 — users·agents 어디서도 안 가리키면 파일을 지운다. 바깥 URL·null 은 할 일이 없다 */
export async function releaseAvatar(db: DbOrTx, dir: string, url: string | null | undefined): Promise<void> {
  const file = avatarFileOf(url);
  if (file === null || !url) return;
  await avatarLocks.run(file, async () => {
    if (!referenced(db, url)) await rm(join(dir, file), { force: true });
  });
}

/** 부팅 때 한 번 — 어느 행도 안 가리키는 파일과 남은 임시 파일을 지운다. 지운 수 */
export async function sweepAvatars(db: DbOrTx, dir: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  const used = new Set(
    [
      ...db.select({ url: users.avatarUrl }).from(users).where(isNotNull(users.avatarUrl)).all(),
      ...db.select({ url: agents.avatarUrl }).from(agents).where(isNotNull(agents.avatarUrl)).all(),
    ]
      .map((r) => avatarFileOf(r.url))
      .filter((f): f is string => f !== null),
  );
  let removed = 0;
  for (const name of await readdir(dir)) {
    const stale = name.endsWith(".tmp") || (AVATAR_FILE.test(name) && !used.has(name));
    if (!stale) continue;
    await rm(join(dir, name), { force: true });
    removed += 1;
  }
  return removed;
}
