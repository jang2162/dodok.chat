import {
  type Announcements,
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { SidebarLayout } from "@dodok/shared";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from "react";
import { moveItem, moveSection } from "./layout";
import { holdSidebar, useUpdateSidebar } from "./queries";

// 사이드바 개인 섹션의 끌어다 놓기(사이드바 섹션 스펙 B5) — 마우스(조금 움직여야 시작 — 링크 누르기와 갈린다)·터치(길게 눌러)·
// 키보드(줄의 링크·섹션 머리에서 스페이스로 들고, 화살표로 옮기고, 스페이스·엔터로 놓고, Esc 로 취소). 놓으면 배치를 바꾸는 저장
// 하나. 끌기 중에 온 다른 탭의 배치는 놓은 뒤 그리고, 놓은 자리는 그 배치 위에서 다시 계산한다(끌던 항목이 손에서 사라지지 않게)

/** 끌 수 있는 것·놓을 자리. container·sectionId 가 null 이면 기본 절(「채널」·「다이렉트 메시지」) */
export type DndData =
  | { kind: "item"; id: string; label: string; container: string | null }
  | { kind: "section"; id: string; label: string }
  | { kind: "zone"; sectionId: string | null; label: string };

const itemKey = (id: string) => `item:${id}`;
const sectionKey = (id: string) => `section:${id}`;
const zoneKey = (sectionId: string | null) => `zone:${sectionId ?? "base"}`;

/**
 * 놓은 자리 → 배치 바꾸기. 놓을 수 없는 자리면 받은 배치 그대로. `after` 는 같은 목록에서 아래로 옮겼는가(그 항목·섹션 뒤에 놓는다 — 끌던
 * 동안 그 줄이 위로 비켜섰다). 자리는 놓을 때의 배치(끌기 중 온 다른 탭의 배치일 수 있다)에서 놓은 줄을 찾아 정한다
 */
export function dropChange(
  active: DndData,
  over: DndData,
  after = false,
): (layout: SidebarLayout) => SidebarLayout {
  return (layout) => {
    if (active.kind === "section") {
      if (over.kind !== "section" || over.id === active.id) return layout;
      const rest = layout.sections.filter((s) => s.id !== active.id);
      const index = rest.findIndex((s) => s.id === over.id);
      return index < 0 ? layout : moveSection(layout, active.id, index + (after ? 1 : 0));
    }
    if (active.kind !== "item") return layout;
    if (over.kind === "zone")
      return moveItem(
        layout,
        active.id,
        over.sectionId === null ? null : { sectionId: over.sectionId, index: Infinity },
      );
    if (over.kind === "section") return moveItem(layout, active.id, { sectionId: over.id, index: Infinity });
    if (over.container === null) return moveItem(layout, active.id, null);
    if (over.id === active.id) return layout;
    const section = layout.sections.find((s) => s.id === over.container);
    const index = section?.items.filter((id) => id !== active.id).indexOf(over.id) ?? -1;
    return index < 0
      ? layout
      : moveItem(layout, active.id, { sectionId: over.container, index: index + (after ? 1 : 0) });
  };
}

/** 같은 정렬 목록 안에서 아래로 옮겼는가 — @dnd-kit/sortable 이 data 에 싣는 목록 id·자리로 본다 */
function movedDown(active: { data: { current?: unknown } }, over: { data: { current?: unknown } }): boolean {
  type Sortable = { sortable?: { containerId: unknown; index: number } };
  const a = (active.data.current as Sortable | undefined)?.sortable;
  const o = (over.data.current as Sortable | undefined)?.sortable;
  return !!a && !!o && a.containerId === o.containerId && a.index < o.index;
}

const ActiveKindContext = createContext<DndData["kind"] | null>(null);

const nameOf = (data: unknown) => (data as DndData | undefined)?.label ?? "";

/** 스크린 리더 안내(라이브 영역) */
const announcements: Announcements = {
  onDragStart: ({ active }) =>
    `${nameOf(active.data.current)} 들기. 화살표로 옮기고 스페이스로 놓습니다. Esc 는 취소`,
  // 들자마자 제자리 위에 있다는 알림은 하지 않는다 — 「들기」 안내를 덮지 않게
  onDragOver: ({ active, over }) =>
    over?.id === active.id
      ? undefined
      : over
        ? `${nameOf(active.data.current)} → ${nameOf(over.data.current)}`
        : `${nameOf(active.data.current)} — 놓을 자리 없음`,
  onDragEnd: ({ active, over }) =>
    over
      ? `${nameOf(active.data.current)} 놓음 — ${nameOf(over.data.current)}`
      : `${nameOf(active.data.current)} 그대로`,
  onDragCancel: ({ active }) => `${nameOf(active.data.current)} 끌기 취소`,
};
const screenReaderInstructions = {
  draggable: "스페이스로 들고, 화살표로 옮기고, 스페이스로 놓습니다. Esc 는 취소입니다",
};

/** 끌기를 끝낸 바로 뒤의 클릭 하나를 먹는다 — 마우스를 놓은 자리가 링크면 그 채널로 가 버리지 않게 */
function swallowNextClick() {
  const stop = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 0);
}

/** 섹션들과 기본 두 절을 감싼다 — 한 판 위에서 섹션 사이·기본 절로 옮긴다 */
export function SidebarDndProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const update = useUpdateSidebar();
  const [activeKind, setActiveKind] = useState<DndData["kind"] | null>(null);
  const release = useRef<(() => void) | undefined>(undefined);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      // 엔터는 링크 열기·접기로 남긴다 — 들기는 스페이스만
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    }),
  );
  const finish = useCallback(() => {
    release.current?.();
    release.current = undefined;
    setActiveKind(null);
  }, []);
  const onDragStart = useCallback(
    ({ active }: DragStartEvent) => {
      release.current?.();
      release.current = holdSidebar(qc);
      setActiveKind((active.data.current as DndData | undefined)?.kind ?? null);
    },
    [qc],
  );
  const onDragEnd = useCallback(
    ({ active, over, activatorEvent }: DragEndEvent) => {
      // 미뤄 둔 다른 탭의 배치를 먼저 그리고, 놓은 자리는 그 위에서 계산한다
      finish();
      if (!(activatorEvent instanceof KeyboardEvent)) swallowNextClick();
      const a = active.data.current as DndData | undefined;
      const o = over?.data.current as DndData | undefined;
      if (a && o && over) update(dropChange(a, o, movedDown(active, over)));
    },
    [finish, update],
  );
  return (
    <ActiveKindContext.Provider value={activeKind}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        accessibility={{ announcements, screenReaderInstructions }}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={finish}
      >
        {children}
      </DndContext>
    </ActiveKindContext.Provider>
  );
}

/** 기본 절은 순서를 사람이 정하지 않는다 — 다른 줄이 비켜서지 않는다 */
const noShift = () => null;

/** 한 목록의 줄들 — 섹션 안은 순서가 바뀌고, 기본 절(sectionId null)은 놓으면 섹션에서 빠질 뿐이다 */
export function ItemsContext({
  ids,
  sectionId,
  children,
}: {
  ids: string[];
  sectionId: string | null;
  children: ReactNode;
}) {
  return (
    <SortableContext
      items={ids.map(itemKey)}
      strategy={sectionId === null ? noShift : verticalListSortingStrategy}
    >
      {children}
    </SortableContext>
  );
}

export function SectionsContext({ ids, children }: { ids: string[]; children: ReactNode }) {
  return (
    <SortableContext items={ids.map(sectionKey)} strategy={verticalListSortingStrategy}>
      {children}
    </SortableContext>
  );
}

const transformStyle = (transform: Parameters<typeof CSS.Translate.toString>[0], transition?: string) => ({
  transform: CSS.Translate.toString(transform),
  transition,
});

/**
 * 한 줄(채널·DM)의 끌기 — 줄 전체를 마우스·터치로 끌고, 키보드는 줄의 링크에서 스페이스. `rowRef` 를 줄 틀에 단다(링크를 그 안에서
 * 찾아 키보드 손잡이로 삼는다)
 */
export function useItemDnd(itemId: string, label: string, container: string | null) {
  const activeKind = useContext(ActiveKindContext);
  const data: DndData = { kind: "item", id: itemId, label, container };
  const sortable = useSortable({
    id: itemKey(itemId),
    data,
    disabled: { draggable: false, droppable: activeKind !== null && activeKind !== "item" },
  });
  const { setNodeRef, setActivatorNodeRef } = sortable;
  const describedBy = sortable.attributes["aria-describedby"];
  const rowRef = useCallback(
    (el: HTMLElement | null) => {
      setNodeRef(el);
      const link = el?.querySelector<HTMLElement>("a") ?? null;
      setActivatorNodeRef(link);
      // 링크는 줄 컴포넌트(채널·DM 줄) 안이라 속성을 직접 단다 — 「끌 수 있음」 안내
      link?.setAttribute("aria-describedby", describedBy);
      link?.setAttribute("aria-roledescription", "끌 수 있는 항목");
    },
    [setNodeRef, setActivatorNodeRef, describedBy],
  );
  return {
    rowRef,
    rowProps: {
      ...sortable.listeners,
      "data-dnd-node": "",
      "data-dragging": sortable.isDragging || undefined,
      "data-over": (sortable.isOver && !sortable.isDragging) || undefined,
      style: transformStyle(sortable.transform, sortable.transition),
    },
  };
}

/** 섹션 하나의 끌기 — 묶음 전체가 움직이고 머리가 손잡이다. 머리는 항목을 놓는 자리이기도 하다(맨 아래로 넣기) */
export function useSectionDnd(sectionId: string, name: string) {
  const activeKind = useContext(ActiveKindContext);
  const sortable = useSortable({
    id: sectionKey(sectionId),
    data: { kind: "section", id: sectionId, label: name } satisfies DndData,
    disabled: { draggable: false, droppable: activeKind !== "section" },
  });
  const zone = useDroppable({
    id: zoneKey(sectionId),
    data: { kind: "zone", sectionId, label: name } satisfies DndData,
    disabled: activeKind !== "item",
  });
  return {
    blockRef: sortable.setNodeRef,
    blockProps: {
      "data-dnd-node": "",
      "data-dragging": sortable.isDragging || undefined,
      style: transformStyle(sortable.transform, sortable.transition),
    },
    headerRef: zone.setNodeRef,
    headerProps: {
      ...sortable.listeners,
      "data-dnd-node": "",
      "data-over": zone.isOver || undefined,
    },
    handleRef: sortable.setActivatorNodeRef,
    handleProps: {
      "aria-describedby": sortable.attributes["aria-describedby"],
      "aria-roledescription": "끌 수 있는 섹션",
    },
  };
}

/** 기본 절 머리 — 여기에 놓으면 섹션에서 뺀다 */
export function useBaseZone(label: string) {
  const activeKind = useContext(ActiveKindContext);
  const zone = useDroppable({
    id: `${zoneKey(null)}:${label}`,
    data: { kind: "zone", sectionId: null, label } satisfies DndData,
    disabled: activeKind !== "item",
  });
  return { ref: zone.setNodeRef, props: { "data-dnd-node": "", "data-over": zone.isOver || undefined } };
}
