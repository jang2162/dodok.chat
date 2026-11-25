---
load: reference
when: "README 에 후원 섹션을 넣거나 .github/FUNDING.yml 을 만들 때"
---

# 후원 링크

## 승인되어 링크가 실제로 열리는 플랫폼만, README 의 후원 섹션 한 곳에 넣는다

- 승인되어 후원 페이지가 열리는 플랫폼만 넣는다. 승인 전에는 README 에도 `FUNDING.yml` 에도 넣지 않는다.
- 자리는 README 아래쪽 기여 방법 다음, 라이선스 앞의 `## Support`(한국어 README 는 `## 후원`) 한 곳이다. 위쪽 배지 줄에는 넣지 않는다.
- 문구는 1~2문장으로 짧게 쓰고, 후원을 요구하거나 기능 사용과 잇지 않는다.
- 플랫폼별 배지는 같은 스타일로 한 줄에 나란히 둔다.

| 플랫폼 | 링크 형식 | 배지 이미지 |
| --- | --- | --- |
| GitHub Sponsors | `https://github.com/sponsors/<username>` | `https://img.shields.io/badge/Sponsor-EA4AAA?logo=githubsponsors&logoColor=white` |
| Ko-fi | `https://ko-fi.com/<username>` | `https://img.shields.io/badge/Ko--fi-FF5E5B?logo=ko-fi&logoColor=white` |
| Buy Me a Coffee | `https://buymeacoffee.com/<username>` | `https://img.shields.io/badge/Buy%20Me%20a%20Coffee-FFDD00?logo=buymeacoffee&logoColor=black` |

- **Why:** 승인 전 GitHub Sponsors 링크는 404 가 뜬다. 공개 첫 화면의 죽은 링크는 유지되지 않는 저장소로 읽힌다.
- **How to apply:** 넣기 전에 각 플랫폼 링크를 브라우저로 열어 후원 페이지가 뜨는지 본다. 아래 순서로 넣는다.

1. `.github/FUNDING.yml` 을 만들고 승인된 플랫폼만 적는다. GitHub 저장소 위쪽에 **Sponsor** 버튼이 생긴다.

   ```yaml
   github: [<username>]
   ko_fi: <username>
   buy_me_a_coffee: <username>
   ```

2. `README.md` 의 Contributing 과 License 사이에 아래 섹션을 넣는다. 승인되지 않은 플랫폼 줄은 지운다.

   ```markdown
   ## Support

   If this project helps you, consider supporting its development.

   [![GitHub Sponsors](https://img.shields.io/badge/Sponsor-EA4AAA?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/<username>)
   [![Ko-fi](https://img.shields.io/badge/Ko--fi-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/<username>)
   [![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/<username>)
   ```

3. `README.ko.md` 에도 같은 배지를 넣고, 제목은 `## 후원`, 문구는 「이 프로젝트가 도움이 되었다면 후원으로 개발을 응원해 주세요.」 로 쓴다.
4. 각 배지를 눌러 후원 페이지가 열리는지 확인한다.
