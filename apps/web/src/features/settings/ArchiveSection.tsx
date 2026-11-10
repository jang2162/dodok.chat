import type { Channel } from "@dodok/shared";
import { useRef, useState } from "react";
import { useCanManage } from "@/api/queries";
import { useArchiveChannel } from "@/features/channels/mutations";
import { Button } from "@/ui/button";
import { ConfirmDialog } from "./ConfirmDialog";
import { Section } from "./Section";

/**
 * 설정 패널 맨 아래 「채널 보관」(채널 보관 스펙 「웹」 절, admin 이상 — member 에게는 섹션이 없다). 확인 뒤 보관하면 채널 캐시가
 * 보관된 채널로 바뀌어 패널·작성기 자리가 읽기 전용 안내로 바뀐다(이 섹션도 함께 사라진다)
 */
export function ArchiveSection({ channel }: { channel: Channel }) {
  const canManage = useCanManage();
  const archive = useArchiveChannel(channel.id);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  if (!canManage) return null;
  return (
    <Section title="채널 보관">
      <Button ref={opener} variant="outline" size="sm" className="self-start" onClick={() => setOpen(true)}>
        채널 보관
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="채널 보관"
        description={`#${channel.name} 을 보관합니다.`}
        confirmLabel="보관"
        pendingLabel="보관하는 중…"
        pending={archive.isPending}
        destructive
        returnFocus={opener}
        onConfirm={() => {
          void archive.run().then((done) => done && setOpen(false));
        }}
      />
    </Section>
  );
}
