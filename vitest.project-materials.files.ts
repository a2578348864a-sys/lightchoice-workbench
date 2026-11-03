// 依赖外部项目材料（../06_测试与验证/、本机 Downloads 真实 XLSX、
// resolveProjectMaterialsRoot）的测试，默认 npm test 排除。
// 这些用例只在具备项目材料根的机器上手动运行：npx vitest run <文件>。
export const PROJECT_MATERIALS_TEST_FILES = [
  "lib/marketScreeningBatchLoader.test.ts",
  "lib/marketScreeningBatchManifest.test.ts",
  "lib/marketScreeningBatchReadiness.test.ts",
  "lib/marketScreeningWorkbench.test.ts",
  "lib/stage15ScreeningPreview.test.ts",
  "lib/stage15ScreeningPreviewGuidance.test.ts",
  "lib/stage15ScreeningPreviewLoader.test.ts",
] as const;
