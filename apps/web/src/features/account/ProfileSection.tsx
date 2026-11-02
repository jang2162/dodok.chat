import type { ReactNode } from "react";
import { useId } from "react";
import { useMe } from "@/api/queries";
import { AvatarPicker } from "./AvatarPicker";
import { useMyAvatar } from "./mutations";
import { StatusForm } from "./StatusForm";

/**
 * 「내 계정」 프로필 섹션(프로필 스펙 3.8) — 사진(바꾸기·지우기), 표시 이름(부르는 쪽이 칸을 넘긴다), 상태·상태 메시지·방해 금지 옵션
 */
export function ProfileSection({ displayName }: { displayName: ReactNode }) {
  const me = useMe().data;
  const avatar = useMyAvatar();
  const titleId = useId();
  if (!me) return null;
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-4">
      <h2 id={titleId} className="text-sm font-medium">
        프로필
      </h2>
      <AvatarPicker
        name={me.user.displayName || me.user.handle}
        currentUrl={me.user.avatarUrl}
        upload={(image) => avatar.upload.mutateAsync(image)}
        remove={() => avatar.remove.mutateAsync()}
      />
      {displayName}
      <StatusForm key={JSON.stringify(me.status ?? null)} status={me.status} />
    </section>
  );
}
