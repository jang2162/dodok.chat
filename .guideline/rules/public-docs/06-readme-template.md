---
load: reference
when: "새 저장소의 README.md 나 README.<lang>.md 를 처음 만들 때"
---

# README 템플릿

## 새 README 는 이 뼈대를 복사해 시작하고, 해당 없는 선택 섹션은 지운다

`< >` 안을 바꾼다. 후원 섹션은 승인된 플랫폼이 있을 때만 이 스택 「후원 링크」 대로 License 앞에 넣는다.

````markdown
<!-- README.md (English, source) -->
<p align="center"><b>English</b> | <a href="README.ko.md">한국어</a></p>

<p align="center">
  <img src="docs/manual/images/logo.png" width="120" alt="<Project name> logo">
</p>

<h1 align="center"><Project name></h1>

<p align="center"><What it does, for whom, how — one line></p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/<owner>/<repo>" alt="Release">
  <img src="https://img.shields.io/github/actions/workflow/status/<owner>/<repo>/ci.yml" alt="Build">
  <img src="https://img.shields.io/github/license/<owner>/<repo>" alt="License">
</p>

<p align="center">
  <img src="docs/manual/images/demo.gif" width="700" alt="<One sentence describing what the demo shows>">
</p>

## Overview

<The problem this solves, 1–2 sentences>
<How this project solves it, 1–2 sentences>
<Who it is for, 1 sentence>

## Features

- <Feature 1, starting with a verb>
- <Feature 2>
- <Feature 3>

## Installation

Requirements: <OS>, <runtime and version>

```bash
<install command>
```

Verify the installation:

```bash
<version command>
```

## Quick Start

1. <First step>

   ```bash
   <command>
   ```

2. <Second step>
3. Result:

   ![<Description of the result screen>](docs/manual/images/quickstart-result.png)

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `<key>` | `<value>` | <description> |

## Documentation

- [Getting Started](docs/manual/en/getting-started.md)
- [Configuration](docs/manual/en/configuration.md)
- [Troubleshooting](docs/manual/en/troubleshooting.md)

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## License

<License name>. See [LICENSE](LICENSE) for details.
````

`README.ko.md` 는 같은 뼈대를 복사해 만든다.

- 맨 위에 `<!-- source: README.md @ vX.Y.Z -->` 를 남긴다.
- 언어 전환 줄을 `<a href="README.md">English</a> | <b>한국어</b>` 로 바꾼다.
- 섹션 제목을 소개 · 주요 기능 · 설치 · 빠른 시작 · 설정 · 문서 · 기여하기 · 후원 · 라이선스로 옮긴다.
- 문서 링크를 `docs/manual/ko/` 로 바꾼다.

- **Why:** 뼈대에서 시작하면 섹션 순서와 언어 전환 줄, 이미지·문서 경로가 이 스택의 다른 규칙과 처음부터 맞는다.
- **How to apply:** 다 쓴 뒤 이 스택 「배포 전 확인」 의 목록을 돈다.
