import type { FileListItem } from "@dodok/shared";
import { SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { ApiRequestError, NetworkError } from "@/api/http";
import { AttachmentImage } from "@/features/attachments/AttachmentGrid";
import { FileCard } from "@/features/attachments/FileCard";
import { useImageViewer } from "@/features/attachments/ImageViewer";
import { attachmentHref } from "@/features/attachments/url";
import { useLoadAutomationAuthors } from "@/features/automations/queries";
import { useAuthors } from "@/features/messages/useAuthors";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { useGoToFile } from "./goToFile";
import { FILES_DEBOUNCE_MS, type FileFilters, useDebounced, useFiles } from "./queries";

const DAY = new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric" });
const SELECT =
  "h-8 min-w-0 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

type Kind = "all" | "image" | "file";
const KINDS: ReadonlyArray<{ id: Kind; label: string }> = [
  { id: "all", label: "전체" },
  { id: "image", label: "사진" },
  { id: "file", label: "파일" },
];

/** 올린 사람 고르기의 후보 하나 — 이름은 부르는 쪽이 작성자 규칙(`useAuthors`)으로 푼다 */
export type AuthorOption = { type: "user" | "agent"; id: string };
export type ConversationOption = { id: string; name: string };

/** 파일 탭을 불러오지 못했다 — 원인 한 줄 */
function errorText(e: unknown): string {
  if (e instanceof NetworkError) return "서버에 연결할 수 없습니다";
  if (e instanceof ApiRequestError) return `파일을 불러오지 못했습니다 — ${e.message}`;
  return "파일을 불러오지 못했습니다";
}

/**
 * 파일함 몸통(파일함 스펙 「꼴」) — 거름 줄 · 사진 격자 · 파일 줄 · 빈 상태 · 「더 보기」. 패널 「파일」 탭(`channelId` 를 준다)과 전체 화면
 * (`conversations` 를 준다 — 대화 고르기)이 같이 쓴다. 「전체」는 받은 한 줄기(최신순)를 사진 칸·파일 칸으로 가른다 — 「더 보기」가 두 칸을
 * 함께 늘린다. 자기 서버 경로로 못 푸는 이미지는 메시지 첨부처럼 파일 칸으로 간다.
 * 거름은 이 컴포넌트의 상태다(주소에 싣지 않는다) — 부르는 쪽이 채널마다 `key` 를 바꿔 옮기면 초기화된다(Review Focus 5)
 */
export function FilesView({
  channelId,
  authors,
  conversations,
  where,
  wide = false,
}: {
  channelId?: string;
  authors: readonly AuthorOption[];
  conversations?: readonly ConversationOption[];
  /** 줄의 「어디」 칸 — 패널은 세션 제목(한 줄기 direct 는 없음), 전체 화면은 「#채널 · 세션」·「DM · 이름」 */
  where: (item: FileListItem) => string | undefined;
  /** 전체 화면 — 넓으면 격자 6열 */
  wide?: boolean;
}) {
  const [kind, setKind] = useState<Kind>("all");
  const [input, setInput] = useState("");
  const [author, setAuthor] = useState("");
  const [conversation, setConversation] = useState("");
  const q = useDebounced(input.trim(), FILES_DEBOUNCE_MS);
  const filters = useMemo<FileFilters>(() => {
    const [authorType, authorId] = author ? (author.split(":") as [AuthorOption["type"], string]) : [];
    return {
      ...(kind === "all" ? {} : { kind }),
      ...(q ? { q } : {}),
      ...(authorType && authorId ? { authorType, authorId } : {}),
      ...(conversation ? { channelId: conversation } : {}),
    };
  }, [kind, q, author, conversation]);
  const filtered = kind !== "all" || input.trim() !== "" || author !== "" || conversation !== "";
  const clear = () => {
    setKind("all");
    setInput("");
    setAuthor("");
    setConversation("");
  };

  const query = useFiles(channelId === undefined ? {} : { channelId }, filters);
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const photos = items.filter((i) => i.attachment.kind === "image" && attachmentHref(i.attachment));
  const others = items.filter((i) => !photos.includes(i));
  const { author: authorOf } = useAuthors();
  useLoadAutomationAuthors(items);
  const go = useGoToFile();
  const { open, viewer } = useImageViewer(
    photos.map((i) => ({
      src: attachmentHref(i.attachment) ?? "",
      name: i.attachment.name,
      downloadHref: attachmentHref(i.attachment, { download: true }),
      onGoToMessage: () => go(i),
    })),
  );

  const body = query.isPending ? (
    <p role="status" className="px-4 py-3 text-sm text-muted-foreground">
      불러오는 중…
    </p>
  ) : query.isError && !query.isFetchNextPageError ? (
    <div className="flex flex-col items-start gap-2 px-4 py-3">
      <p role="alert" className="text-sm text-destructive">
        {errorText(query.error)}
      </p>
      <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
        다시 시도
      </Button>
    </div>
  ) : items.length === 0 ? (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground">
      {filtered ? (
        <>
          <p>조건에 맞는 파일이 없습니다</p>
          <Button variant="outline" size="sm" onClick={clear}>
            거름 지우기
          </Button>
        </>
      ) : (
        <p>아직 주고받은 파일이 없습니다</p>
      )}
    </div>
  ) : (
    <div className="flex flex-col gap-4 px-4 py-3">
      {photos.length > 0 && (
        <section aria-label="사진" className="flex flex-col gap-2">
          {kind === "all" && <h3 className="text-xs font-medium text-muted-foreground">사진</h3>}
          <div className={cn("grid grid-cols-3 gap-2", wide && "md:grid-cols-6")}>
            {photos.map((i, n) => (
              <AttachmentImage
                key={`${i.messageId}:${i.attachment.id}`}
                attachment={i.attachment}
                single={false}
                onOpen={(el) => open(n, el)}
              />
            ))}
          </div>
        </section>
      )}
      {others.length > 0 && (
        <section aria-label="파일" className="flex flex-col gap-2">
          {kind === "all" && <h3 className="text-xs font-medium text-muted-foreground">파일</h3>}
          <ul className="flex flex-col gap-2">
            {others.map((i) => {
              const place = where(i);
              return (
                <li key={`${i.messageId}:${i.attachment.id}`}>
                  <FileCard
                    name={i.attachment.name}
                    size={i.attachment.size}
                    mime={i.attachment.mime}
                    href={attachmentHref(i.attachment, { download: true })}
                    meta={
                      <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                        <span>{authorOf(i).name}</span>
                        {place && (
                          <>
                            <span aria-hidden>·</span>
                            <span className="max-w-48 truncate" title={place}>
                              {place}
                            </span>
                          </>
                        )}
                        <span aria-hidden>·</span>
                        <time dateTime={i.createdAt}>{DAY.format(new Date(i.createdAt))}</time>
                        {i.channelArchived && <span className="rounded-sm bg-muted px-1">보관됨</span>}
                      </span>
                    }
                    actions={
                      <Button variant="ghost" size="sm" className="shrink-0" onClick={() => go(i)}>
                        메시지로 가기
                      </Button>
                    }
                  />
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {query.isFetchNextPageError && (
        <p role="alert" className="text-sm text-destructive">
          {errorText(query.error)}
        </p>
      )}
      {query.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            더 보기
          </Button>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <div role="group" aria-label="종류" className="flex shrink-0 rounded-md border p-0.5">
          {KINDS.map((k) => (
            <Button
              key={k.id}
              variant={kind === k.id ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2"
              aria-pressed={kind === k.id}
              onClick={() => setKind(k.id)}
            >
              {k.label}
            </Button>
          ))}
        </div>
        <div className="flex min-w-32 flex-1 items-center gap-1 rounded-md border px-2">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            aria-label="이름으로 찾기"
            placeholder="이름으로 찾기"
            maxLength={100}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="h-7 border-0 px-0 shadow-none focus-visible:ring-0"
          />
        </div>
        {conversations && (
          <select
            aria-label="대화"
            className={SELECT}
            value={conversation}
            onChange={(e) => setConversation(e.target.value)}
          >
            <option value="">모든 대화</option>
            {conversations.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <select
          aria-label="올린 사람"
          className={SELECT}
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
        >
          <option value="">모두</option>
          {authors.map((a) => (
            <option key={`${a.type}:${a.id}`} value={`${a.type}:${a.id}`}>
              {authorOf({ authorType: a.type, authorId: a.id }).name}
            </option>
          ))}
        </select>
      </div>
      {body}
      {viewer}
    </div>
  );
}
