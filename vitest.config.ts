import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";
import { PROJECT_MATERIALS_TEST_FILES } from "./vitest.project-materials.files";

// Release packaging 测试依赖 Windows turbopack 布局（.next/node_modules hashed
// external modules）。CI 用 webpack 构建，无该布局；CI 上跳过，本地/部署前验证。
// 动态 loopback Bridge、Smoke 控制器和 Image migration fixtures 已重新纳入 CI；
// 剩余 release 构建布局限制见 docs/development/v5-testing-reality.md。
const CI_EXCLUDED_TESTS = process.env.CI === "true"
  ? [
      "scripts/release/release-package.test.ts",
    ]
  : [];

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    // Bound I/O concurrency for real SQLite/evidence fixtures; keep the 5s deadline.
    maxWorkers: 2,
    // 依赖仓库外项目材料（../06_测试与验证/）的测试不进入默认回归；
    // 历史验收与实验脚本保留在 scripts/archive/，不属于默认回归入口；
    // 需要复盘时可在对应归档目录中单独运行。
    // Preserved runtime/build snapshots in .tmp are artifacts, not source test suites.
    exclude: [...PROJECT_MATERIALS_TEST_FILES, ...CI_EXCLUDED_TESTS, "spikes/**", "scripts/archive/**", "node_modules/**", "**/.tmp/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
      // Mock Next.js server-only directive for test environment
      "server-only": path.resolve(__dirname, "__mocks__/server-only.ts"),
    },
  },
});
