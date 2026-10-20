import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";

// 브라우저에게 웹과 API 는 같은 출처다 — 서버 REST 에 CORS 가 없고, 세션 쿠키(httpOnly)가 wire 핸드셰이크에도 붙는다(스펙 2.5)
const api = process.env.DODOK_API_ORIGIN ?? "http://127.0.0.1:3000";

// 개발 모드 서비스 워커는 켤 때만(VITE_PWA_DEV=1). 한 번 등록된 SW 는 그 오리진(localhost:<포트>)에 남아
// 같은 포트에 뜨는 다른 앱·preview 의 탐색에도 닿는다 — 개발 기본 포트 5173 은 다른 프로젝트와 겹칠 수 있다.
// 끄면 virtual:pwa-register 가 아무것도 하지 않는 registerSW 로 바뀌어 startPwa 도 등록하지 않는다
const pwaDev = process.env.VITE_PWA_DEV === "1";

// 빌드마다 바뀌는 값 — 오프라인 사본은 이 값이 다르면 버린다(pwa/persist.ts `buster`). 테스트(vitest)에도 정의된다.
// 빈 문자열도 「없음」으로 본다 — 빈 값으로 고정되면 웹이 바뀌어도 사본이 버려지지 않는다(루트 Dockerfile web 단계의 VITE_BUILD_ID)
const buildId = process.env.VITE_BUILD_ID || new Date().toISOString();

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  plugins: [
    react(),
    tailwindcss(),
    // 서비스 워커는 직접 쓴다(src/sw.ts) — 푸시 핸들러가 들어가야 해서 generateSW 로는 안 된다(스펙 결정 6)
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "prompt",
      injectRegister: false, // main.tsx 가 startPwa 로 등록한다
      manifest: {
        name: "dodok",
        short_name: "dodok",
        description: "사람과 AI 에이전트가 같은 채널에서 대화하는 메신저",
        lang: "ko",
        start_url: "/",
        scope: "/",
        display: "standalone",
        // 라이트 배경 토큰 --background oklch(0.975 0.002 265) 의 sRGB 값(theme/tokens.css). 다크는 index.html 의 meta 가 맡는다
        background_color: "#f6f7f8",
        theme_color: "#f6f7f8",
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          { src: "maskable-icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      // 아이콘은 globPatterns 가 이미 담는다 — 매니페스트 아이콘을 따로 더하면 같은 항목이 두 번 들어간다
      includeManifestIcons: false,
      // 코드 하이라이트 조각(hl-*, 아래 chunkFileNames)은 미리 저장하지 않는다 — 코드 블록이 처음 보일 때만 받는 지연 로딩이라,
      // 미리 저장하면 설치마다 쓰지 않을 문법까지 전부 받는다. 오프라인에서 못 받으면 코드 블록은 칠하지 않은 모양 그대로다
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        globIgnores: ["**/node_modules/**/*", "**/hl-*.js"],
      },
      // navigateFallback 은 두지 않는다 — 두면 개발 SW 가 Vite 가 변환한 dev index.html 을 미리 저장해 탐색을 가로챈다
      devOptions: { enabled: pwaDev, type: "module" },
    }),
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    // chunkSizeWarningLimit 은 기본값 500 그대로 둔다 — 전역 임계값을 올리면 가장 큰 조각만이 아니라
    // 그 아래 조각들(index·editor)의 경고까지 같이 가린다. 경고는 코드 분할을 다시 볼 눈금으로 남긴다
    rolldownOptions: {
      output: {
        // 라우트 조각(코드 분할) 위에, 잘 바뀌지 않는 큰 라이브러리를 따로 둔다 — 받는 양은 같고 캐시가 오래 간다.
        // rolldown 1.2 에서 advancedChunks 는 codeSplitting 으로 옮겨졌다(모양은 그대로) — 옛 이름은 경고를 낸다.
        // markdown 은 초기 조각이다 — shiki 만 쓰는 hast-util-to-html·character-entities-html4·-legacy 를 여기로 끌어오지 않게
        // 정규식에서 뺀다(끌려오면 지연 로딩할 하이라이트 의존성이 첫 화면에 실린다)
        // shiki 가 든 조각(엔진·언어 문법)은 hl- 를 붙인다 — 서비스 워커 사전 저장에서 이름으로 뺀다(위 globIgnores)
        chunkFileNames: (chunk) =>
          chunk.moduleIds.some((id) => /node_modules[\\/](shiki|@shikijs)[\\/]/.test(id))
            ? "assets/hl-[name]-[hash].js"
            : "assets/[name]-[hash].js",
        codeSplitting: {
          groups: [
            // zod 와 jitless 설정(src/lib/zodJitless.ts)을 한 조각에 — 설정이 zod 를 import 하므로 따로 두면 zod 가 든 공용 조각이
            // 먼저 평가되고, 그 조각이 shared 스키마를 만들며 Function("") 탐지(CSP 위반 보고)를 한다
            { name: "zod", test: /node_modules[\\/]zod[\\/]|src[\\/]lib[\\/]zodJitless\.ts$/ },
            { name: "editor", test: /node_modules[\\/](@tiptap|prosemirror-|@floating-ui)/ },
            {
              name: "markdown",
              test: /node_modules[\\/](streamdown|remark|rehype|micromark|mdast|hast(?!-util-to-html)|unist|vfile|property-information|parse5|decode-named|character-entities(?!-html4|-legacy)|comma-separated|space-separated|html-|web-namespaces|zwitch|longest-streak|markdown-table|ccount|escape-string-regexp|devlop|trim-lines|bail|is-plain-obj|trough|extend|unified)/,
            },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: api },
      "/socket.io": { target: api, ws: true },
      "/llms.txt": { target: api },
      "/hooks": { target: api },
      // 바깥 MCP 클라이언트의 입구 — 「내 계정」의 `claude mcp add` 예시가 이 페이지 오리진을 쓰므로 개발 모드에서도 서버로 넘긴다
      "/mcp": { target: api },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    // waitFor 예산(5초, test/setup.ts)을 다 쓰고도 그 뒤 단언이 돌 자리가 있어야 한다 —
    // 기본 5초는 예산과 똑같아, 늘린 예산이 테스트 시간초과로 되돌아온다
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
