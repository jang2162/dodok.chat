---
load: always
---

# ruler 소스와 생성물

## 지침 소스는 `.guideline/`·프로젝트 `.ruler/*.md`·`ruler.project.toml` 이고, 에이전트가 읽는 파일은 생성물이다

| 구분 | 파일 |
| --- | --- |
| 받은 사본(커밋, 직접 고치지 않음) | `.guideline/`(`rules/<스택 경로>/`, `skills/`, `agents/`, `mcp/`) |
| 프로젝트 소스(수정 대상) | `.ruler/*.md`(예: `.ruler/50-project.md`), 바꿈 `.guideline/overrides/<스택 경로>/` |
| 설정(수정 대상) | `.ruler/ruler.project.toml` |
| `guideline apply` 의 생성물(gitignore) | `.ruler/<스택 경로>/`, `.ruler/guideline.md`, `.ruler/skills/`, `.ruler/agents/`, `.ruler/ruler.toml`, `docs/guideline/` |
| ruler 의 생성물(gitignore) | `AGENTS.md`(Claude Code 도 이것을 읽는다), 에이전트별 설정·스킬 경로(`.codex/config.toml`, `.claude/`, `.agents/`, `.mcp.json` 등), 이들의 `.bak` |

생성물에 지침을 써 넣지 않는다. 지침을 고치려면 소스를 고치고 `guideline apply` 를 돌린다(ruler 까지 돈다).

`.guideline/` 의 사본은 지침 서버에서 받은 것이다. 직접 고치지 않는다 — 고칠 것은 `guideline propose` 로 올리고(에이전트는 `guideline-export` 스킬), 이 프로젝트에만 다르게 할 것은 바꿈에 쓴다. 직접 고친 사본은 다음 `guideline update` 에서 건너뛰어지거나 원본과 조용히 갈라진다.

- **Why:** 생성물은 다음 apply 에서 통째로 덮어써진다. `.ruler/<스택>/` 이나 `ruler.toml` 을 고치면 apply 한 번에 사라지고, 생성물이 소스로 다시 읽히는 설정이면 apply 마다 자기 자신을 덧붙여 중복 헤더로 오염된다.
- **How to apply:** 어떤 파일이 생성물인지 헷갈리면 `.gitignore` 의 두 블록을 본다. 블록 안에 있으면 생성물이다. ruler 설정(에이전트, `output_path`, `nested`, 프로젝트가 직접 쓰는 MCP 서버)은 `.ruler/ruler.project.toml` 에 쓴다.

## Claude Code 도 `AGENTS.md` 를 읽게 하고 저장소에 `CLAUDE.md` 를 두지 않는다

`.ruler/ruler.project.toml` 의 `[agents.claude]` 에 `output_path = "AGENTS.md"` 를 두어 생성물을 `AGENTS.md` 한 벌로 만든다(세팅은 `docs/guideline/ruler/SETUP.md`). 저장소 안에 `CLAUDE.md`·`.claude/CLAUDE.md`·`CLAUDE.local.md` 를 만들지 않는다. `/init` 등이 만들었으면 지운다.

- **Why:** Claude Code 는 작업 디렉터리나 그 위에 이 세 파일 중 하나라도 있으면 `AGENTS.md` 를 읽지 않고 그 파일만 읽는다. 하나만 남아도 ruler 지침 전체가 경고 없이 빠진다. `~/.claude/CLAUDE.md` 는 이 판정에 들지 않아 함께 읽힌다.
- **How to apply:** 개인 지침은 `CLAUDE.local.md` 대신 `~/.claude/CLAUDE.md` 에 쓴다. 지침이 안 먹는 것 같으면 `/memory` 목록에 `AGENTS.md` 경로가 있는지, `claude --version` 이 v2.1.281 이상인지 본다.

## `guideline-manage` 와 ruler 는 devDependency 로 고정하고 설치본으로 부른다

`pnpx @intellectronica/ruler apply` 가 아니라 `pnpm exec guideline apply` 로 부른다(또는 그것을 감싼 패키지 스크립트). `prepare` 는 `guideline apply` 를 부른다.

- **Why:** `pnpx` 는 `pnpm dlx` 의 별칭이라 `node_modules` 를 무시하고 부를 때마다 레지스트리의 **최신본**을 받는다. 사람과 시점마다 다른 ruler 가 생성물을 만들게 된다. 설치본으로 부르면 lockfile 이 버전의 단일 원천이 되고, 설치가 안 됐으면 조용히 다른 버전을 쓰는 대신 실패한다. `prepare` 가 `ruler apply` 만 부르면 클론과 새 워크트리에서 `.ruler/<스택>/`·`ruler.toml` 이 없는 채로 ruler 가 돌아, 공용 지침이 빠진 `AGENTS.md` 와 모든 에이전트 몫의 파일이 생긴다.
- **How to apply:** `package.json` 의 `devDependencies` 에 `guideline-manage` 와 `@intellectronica/ruler` 를 넣고 `"prepare": "guideline apply"` 로 둔다. `package.json` 이 없는 저장소는 셋업 단계(Orca 면 `orca.yaml` 의 `scripts.setup`)에서 `guideline apply` 를 부른다.

## `guideline apply` 는 저절로 돌지 않는다 — 소스를 고친 턴과 새 체크아웃 직후에 직접 돌린다

`prepare` 스크립트에 걸어 둔 apply 는 **install 할 때만** 돈다. 소스를 고쳤다고 돌지 않는다. 새로 클론했거나 새 워크트리를 만든 직후에는 생성물이 하나도 없다.

- **Why:** 생성물은 gitignore 되어 `git status` 에 뜨지 않는다. 안 돌려도 경고가 없고 리뷰에도 안 걸리므로, 다른 에이전트와 다음 세션이 낡은 지침을 최신인 줄 알고 주입받는다. 원칙과 나머지 근거는 `base` 스택 「생성물을 직접 편집하지 않는다」 절.
- **How to apply:** git 루트에서 apply 를 돌린 뒤 `git status` 를 본다. 생성물은 ignore 되므로 **추적 파일 변경이 없어야 정상**이다(생성물 경로가 새로 생겼으면 `.gitignore` 블록만 바뀐다). 소스 변경만 커밋한다. `ruler apply` 만 따로 돌리지 않는다 — 조합 없이 돌면 위 Why 의 고장이 난다.
  ```bash
  pnpm exec guideline apply
  git status
  ```

## `.gitignore` 의 도구 블록은 손으로 고치지 않는다

생성물은 커밋하지 않고, `.gitignore` 의 `# START guideline generated files` … `# END guideline generated files` 블록과 `# START Ruler Generated Files` … `# END Ruler Generated Files` 블록이 가린다. 두 블록은 apply 가 갱신한다.

- **Why:** apply 가 블록 안을 다시 쓰므로 손으로 넣은 줄은 다음 apply 에서 사라진다.
- **How to apply:** 새 생성물 경로를 가려야 하면 소스나 `ruler.project.toml` 을 고치고 apply 를 돌려 블록이 스스로 바뀌게 한다. 생성물이 아닌 파일을 가려야 하면 블록 **바깥**에 적는다. 나만 쓰는 파일은 `.gitignore` 대신 `"$(git rev-parse --git-common-dir)/info/exclude"` 에 쓴다.
