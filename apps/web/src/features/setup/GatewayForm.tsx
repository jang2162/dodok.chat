import {
  type GatewaySetup,
  type GatewaySummary,
  GatewayName,
  GatewayUrl,
  type UpdateGatewayBody,
} from "@dodok/shared";
import { type ComponentProps, type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import { ApiRequestError } from "@/api/http";
import { detailField, validationField } from "@/api/formErrors";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/ui/dialog";
import { FieldError } from "@/ui/field-error";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { useCreateGateway, useUpdateGateway } from "./mutations";

type FieldName = "name" | "url" | "token";
type Errors = Partial<Record<FieldName | "form", string>>;

const NAME_PROBLEM = "이름은 1~32자로 적어 주세요.";
const URL_PROBLEM = "ws:// 또는 wss:// 로 시작하는 주소를 입력하세요.";
const URL_USERINFO = "주소에 사용자 이름·비밀번호를 넣을 수 없습니다.";
const TOKEN_PROBLEM = "Gateway 토큰을 입력하세요.";
const NAME_TAKEN = "이미 쓰이는 이름입니다 — 다른 이름을 입력하세요.";

/**
 * 주소 검사 — shared `GatewayUrl` 로 가르고 화면 문구만 고정한다(스키마 문구는 보이지 않는다). 사용자 정보는 스키마의
 * refine(custom 이슈)이 따로 거절한다
 */
function urlProblem(url: string): string | undefined {
  const parsed = GatewayUrl.safeParse(url);
  if (parsed.success) return undefined;
  return parsed.error.issues.some((i) => i.code === "custom") ? URL_USERINFO : URL_PROBLEM;
}

function problems(name: string, url: string, token: string, tokenRequired: boolean): Errors {
  const errors: Errors = {};
  if (!GatewayName.safeParse(name).success) errors.name = NAME_PROBLEM;
  const u = urlProblem(url);
  if (u) errors.url = u;
  if (tokenRequired && token === "") errors.token = TOKEN_PROBLEM;
  return errors;
}

/**
 * 서버가 막은 까닭을 칸에 — 이름 겹침(409 details.field name)은 이름 칸, VALIDATION 은 메시지가 가리킨 칸의 고정 문구.
 * 그 밖(네트워크·5xx·404)은 undefined — 전역 토스트가 알린다
 */
function serverErrors(e: unknown): Errors | undefined {
  if (!(e instanceof ApiRequestError)) return undefined;
  if (e.code === "CONFLICT")
    return detailField(e, ["name"])
      ? { name: NAME_TAKEN }
      : { form: "저장하지 못했습니다. 다시 시도해 주세요." };
  if (e.code === "VALIDATION") {
    const field = validationField(e.message, ["name", "url", "token"] as const);
    if (field === "name") return { name: NAME_PROBLEM };
    if (field === "url") return { url: URL_PROBLEM };
    if (field === "token") return { token: TOKEN_PROBLEM };
    return { form: "입력을 확인해 주세요." };
  }
  return undefined;
}

/** 라벨·입력·오류 한 벌 — 오류는 입력의 설명(aria-describedby)으로 잇는다 */
function Field({
  label,
  error,
  ...input
}: { label: string; error: string | undefined } & Omit<ComponentProps<"input">, "id">) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        aria-invalid={error !== undefined || undefined}
        aria-describedby={error !== undefined ? `${id}-error` : undefined}
        autoCapitalize="none"
        autoComplete="off"
        spellCheck={false}
        {...input}
      />
      <FieldError id={`${id}-error`}>{error}</FieldError>
    </div>
  );
}

/**
 * Gateway 추가·수정 대화상자(멀티 Gateway 스펙 「웹」 절의 「연결 페이지」). 수정의 토큰 칸은 비어 「바꾸려면 입력」이고 비워 두면 본문에
 * 싣지 않는다 — 공유 토큰은 서버가 내보내지 않는다(스펙 결정 4). 수정은 바뀐 칸만 싣는다: 이름만 바꾸면 어댑터가 다시 붙지 않는다
 */
export function GatewayForm({
  gateway,
  trigger,
}: {
  /** 있으면 그 Gateway 를 고친다, 없으면 추가 */
  gateway?: GatewaySetup;
  trigger: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [formKey, setFormKey] = useState(0);
  function onOpenChange(next: boolean) {
    setOpen(next);
    // 다시 열 때 빈 폼(추가)·지금 값(수정)으로 시작한다
    if (!next) setFormKey((k) => k + 1);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        {gateway ? (
          <EditForm key={formKey} gateway={gateway} onDone={() => onOpenChange(false)} />
        ) : (
          <AddForm key={formKey} onDone={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AddForm({ onDone }: { onDone: () => void }) {
  return <GatewayFormBody onSaved={onDone} />;
}

/**
 * Gateway 추가 폼 본문 — 「연결 추가」 화면이 대화상자 없이 그린다(`embedded`). 저장하면 서버가 준 요약(id)을 넘긴다
 */
export function GatewayFormBody({
  onSaved,
  embedded = false,
}: {
  onSaved: (gateway: GatewaySummary) => void;
  embedded?: boolean;
}) {
  const create = useCreateGateway();
  return (
    <GatewayFields
      title="Gateway 추가"
      description="OpenClaw Gateway 의 WS 주소와 공유 토큰을 넣습니다. 저장하면 이 서버가 곧바로 붙습니다."
      submitLabel="추가"
      pendingLabel="추가하는 중…"
      initial={{ name: "", url: "" }}
      tokenRequired
      pending={create.isPending}
      embedded={embedded}
      onSubmit={(values, fail) =>
        create.mutate(values, { onSuccess: onSaved, onError: (e) => fail(serverErrors(e)) })
      }
    />
  );
}

function EditForm({ gateway, onDone }: { gateway: GatewaySetup; onDone: () => void }) {
  const update = useUpdateGateway(gateway.id);
  return (
    <GatewayFields
      title={`「${gateway.name}」 수정`}
      description="주소나 토큰을 바꾸면 이 Gateway 만 다시 붙고, 진행 중인 런은 「다시 실행」 카드로 닫힙니다."
      submitLabel="저장"
      pendingLabel="저장하는 중…"
      initial={{ name: gateway.name, url: gateway.url }}
      tokenRequired={false}
      pending={update.isPending}
      onSubmit={(values, fail) => {
        const body: UpdateGatewayBody = {};
        if (values.name !== gateway.name) body.name = values.name;
        if (values.url !== gateway.url) body.url = values.url;
        if (values.token !== "") body.token = values.token;
        if (Object.keys(body).length === 0) return onDone();
        update.mutate(body, { onSuccess: onDone, onError: (e) => fail(serverErrors(e)) });
      }}
    />
  );
}

function GatewayFields({
  title,
  description,
  submitLabel,
  pendingLabel,
  initial,
  tokenRequired,
  pending,
  onSubmit,
  embedded = false,
}: {
  /** 대화상자 밖(「연결 추가」 화면)에 그린다 — 제목·버튼 줄을 대화상자 부품 없이 */
  embedded?: boolean;
  title: string;
  description: string;
  submitLabel: string;
  pendingLabel: string;
  initial: { name: string; url: string };
  tokenRequired: boolean;
  pending: boolean;
  /** 앞뒤 공백을 걷은 값 — 서버가 막으면 `fail` 로 칸 오류를 돌려준다 */
  onSubmit: (
    values: { name: string; url: string; token: string },
    fail: (errors: Errors | undefined) => void,
  ) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [url, setUrl] = useState(initial.url);
  const [token, setToken] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  // 렌더된 `pending` 만으로는 같은 틱의 둘째 제출을 못 막는다 — TanStack 이 관찰자에게 알리는 것이 다음 태스크라서다.
  // 성공하면 대화상자가 닫혀 이 폼이 사라지고, 실패하면 `fail` 이 표지를 내린다
  const sending = useRef(false);

  function edit(field: FieldName, set: (v: string) => void) {
    return (e: { target: { value: string } }) => {
      set(e.target.value);
      setErrors((prev) => ({ ...prev, [field]: undefined, form: undefined }));
    };
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending || sending.current) return;
    const values = { name: name.trim(), url: url.trim(), token: token.trim() };
    const found = problems(values.name, values.url, values.token, tokenRequired);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    sending.current = true;
    onSubmit(values, (server) => {
      sending.current = false;
      setErrors(server ?? {});
    });
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-4" aria-label={embedded ? title : undefined}>
      {embedded ? (
        <p className="text-sm text-muted-foreground">{description}</p>
      ) : (
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
      )}
      <Field
        label="이름"
        placeholder="예: 사무실"
        value={name}
        maxLength={64}
        onChange={edit("name", setName)}
        error={errors.name}
      />
      <Field
        label="주소"
        placeholder="wss://gateway.example.com"
        value={url}
        onChange={edit("url", setUrl)}
        error={errors.url}
      />
      <Field
        label="토큰"
        type="password"
        placeholder={tokenRequired ? undefined : "바꾸려면 입력"}
        value={token}
        onChange={edit("token", setToken)}
        error={errors.token}
      />
      <FieldError>{errors.form}</FieldError>
      {embedded ? (
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? pendingLabel : submitLabel}
          </Button>
        </div>
      ) : (
        <DialogFooter>
          <Button type="submit" disabled={pending}>
            {pending ? pendingLabel : submitLabel}
          </Button>
        </DialogFooter>
      )}
    </form>
  );
}
