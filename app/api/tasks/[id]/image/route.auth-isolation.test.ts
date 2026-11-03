import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkAccessPassword: vi.fn(),
  getAccessContext: vi.fn(),
  isSandboxTaskId: vi.fn(),
  getSandboxTask: vi.fn(),
  getTaskProductImageBuffer: vi.fn(),
  extractTaskProductImageFromResultJson: vi.fn(),
}));

vi.mock("@/lib/server/accessPassword", () => ({
  checkAccessPassword: mocks.checkAccessPassword,
  getAccessContext: mocks.getAccessContext,
}));

vi.mock("@/lib/server/demoSandbox", () => ({
  isSandboxTaskId: mocks.isSandboxTaskId,
  getSandboxTask: mocks.getSandboxTask,
}));

vi.mock("@/lib/server/taskProductImage", () => ({
  getTaskProductImageBuffer: mocks.getTaskProductImageBuffer,
  extractTaskProductImageFromResultJson: mocks.extractTaskProductImageFromResultJson,
}));

import { GET } from "./route";

const IMAGE = { buffer: Buffer.from("fake-image-bytes"), mimeType: "image/jpeg" };

function call(taskId: string) {
  return GET(
    new Request(`http://localhost/api/tasks/${taskId}/image`) as never,
    { params: Promise.resolve({ id: taskId }) },
  );
}

describe("AUTH-002 · 任务图片路由对象授权", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkAccessPassword.mockReturnValue(null);
    mocks.getAccessContext.mockReturnValue({ mode: "owner", token: "owner-token" });
    mocks.isSandboxTaskId.mockImplementation((id: string) => id.startsWith("sandbox_"));
    mocks.getTaskProductImageBuffer.mockResolvedValue(IMAGE);
    mocks.extractTaskProductImageFromResultJson.mockResolvedValue(IMAGE);
  });

  it("Owner 读取正式任务图片：正常返回字节流", async () => {
    const response = await call("task-formal-1");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(mocks.getTaskProductImageBuffer).toHaveBeenCalledWith("task-formal-1");
  });

  it("Demo/访客读取正式任务图片：404，且完全不触达正式任务数据", async () => {
    mocks.getAccessContext.mockReturnValue({ mode: "demo", demoAccessId: "visitor-a" });

    const response = await call("task-formal-1");

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("image_unavailable");
    expect(mocks.getTaskProductImageBuffer).not.toHaveBeenCalled();
  });

  it("Owner 传入 sandbox 任务 id：404，不读取任何任务数据", async () => {
    const response = await call("sandbox_task_1");

    expect(response.status).toBe(404);
    expect(mocks.getSandboxTask).not.toHaveBeenCalled();
    expect(mocks.getTaskProductImageBuffer).not.toHaveBeenCalled();
  });

  it("Demo 读取同一 demoAccessId 的 sandbox 任务图片：正常返回", async () => {
    mocks.getAccessContext.mockReturnValue({ mode: "demo", demoAccessId: "visitor-a" });
    mocks.getSandboxTask.mockReturnValue({ id: "sandbox_task_1", resultJson: "{}" });

    const response = await call("sandbox_task_1");

    expect(response.status).toBe(200);
    expect(mocks.getSandboxTask).toHaveBeenCalledWith("visitor-a", "sandbox_task_1");
    expect(mocks.getTaskProductImageBuffer).not.toHaveBeenCalled();
  });

  it("Demo 读取不属于自己的 sandbox 任务：404", async () => {
    mocks.getAccessContext.mockReturnValue({ mode: "demo", demoAccessId: "visitor-b" });
    mocks.getSandboxTask.mockReturnValue(null);

    const response = await call("sandbox_task_1");

    expect(response.status).toBe(404);
    expect(mocks.getSandboxTask).toHaveBeenCalledWith("visitor-b", "sandbox_task_1");
  });

  it("无访问上下文：401", async () => {
    mocks.getAccessContext.mockReturnValue(null);

    const response = await call("task-formal-1");

    expect(response.status).toBe(401);
    expect(mocks.getTaskProductImageBuffer).not.toHaveBeenCalled();
  });
});
