import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// 브라우저에게 웹과 API 는 같은 출처다 — 서버 REST 에 CORS 가 없고, 세션 쿠키(httpOnly)가 wire 핸드셰이크에도 붙는다(스펙 2.5)
const api = process.env.DODOK_API_ORIGIN ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    // chunkSizeWarningLimit 은 기본값 500 그대로 둔다 — 전역 임계값을 올리면 가장 큰 조각만이 아니라
    // 그 아래 조각들(index·editor)의 경고까지 같이 가린다. 경고는 코드 분할을 다시 볼 눈금으로 남긴다
    rolldownOptions: {
      output: {
        // 라우트 조각(코드 분할) 위에, 잘 바뀌지 않는 큰 라이브러리를 따로 둔다 — 받는 양은 같고 캐시가 오래 간다.
        // rolldown 1.2 에서 advancedChunks 는 codeSplitting 으로 옮겨졌다(모양은 그대로) — 옛 이름은 경고를 낸다
        codeSplitting: {
          groups: [
            { name: "editor", test: /node_modules[\\/](@tiptap|prosemirror-|@floating-ui)/ },
            {
              name: "markdown",
              test: /node_modules[\\/](streamdown|remark|rehype|micromark|mdast|hast|unist|vfile|property-information|parse5|decode-named|character-entities|comma-separated|space-separated|html-|web-namespaces|zwitch|longest-streak|markdown-table|ccount|escape-string-regexp|devlop|trim-lines|bail|is-plain-obj|trough|extend|unified)/,
            },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: api }, "/socket.io": { target: api, ws: true } },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
  },
});
