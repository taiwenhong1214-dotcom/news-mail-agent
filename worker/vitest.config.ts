import { defineConfig } from "vitest/config";

// .md 文件在 Worker 里由 wrangler 按 Text 规则打包；测试里用这个小插件做同样的事
export default defineConfig({
  plugins: [
    {
      name: "md-as-text",
      transform(code: string, id: string) {
        if (id.endsWith(".md")) return { code: `export default ${JSON.stringify(code)};`, map: null };
      },
    },
  ],
  test: { include: ["test/**/*.test.ts"] },
});
