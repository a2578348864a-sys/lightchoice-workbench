import { describe, expect, it } from "vitest";
import { boundedFormData, boundedJsonBody, BoundedJsonBodyError } from "@/lib/server/v5ApiRoute";

describe("boundedJsonBody", () => {
  it("parses valid JSON within the byte budget", async () => {
    const request = new Request("http://local.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "buyer voice" }),
    });
    await expect(boundedJsonBody(request, 128)).resolves.toEqual({ text: "buyer voice" });
  });

  it("rejects declared oversize requests before reading the body", async () => {
    const request = new Request("http://local.test", {
      method: "POST",
      headers: { "content-length": "1000", "content-type": "application/json" },
      body: "{}",
    });
    await expect(boundedJsonBody(request, 32)).rejects.toMatchObject({
      code: "REQUEST_BODY_TOO_LARGE",
      status: 413,
    });
  });

  it("enforces the limit on a streamed body without Content-Length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ text: "over limit" })));
        controller.close();
      },
    });
    const request = new Request("http://local.test", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(request.headers.has("content-length")).toBe(false);
    await expect(boundedJsonBody(request, 4)).rejects.toBeInstanceOf(BoundedJsonBodyError);
  });

  it("fails closed for malformed JSON", async () => {
    const request = new Request("http://local.test", { method: "POST", body: "{" });
    await expect(boundedJsonBody(request, 32)).rejects.toMatchObject({ code: "INVALID_JSON", status: 400 });
  });

  it("enforces the byte limit on chunked multipart uploads without Content-Length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("--test-boundary\r\nlarge payload"));
        controller.close();
      },
    });
    const request = new Request("http://local.test", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=test-boundary" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(request.headers.has("content-length")).toBe(false);
    await expect(boundedFormData(request, 16)).rejects.toBeInstanceOf(BoundedJsonBodyError);
    await expect(boundedFormData(new Request("http://local.test", { method: "POST", body: "{}" }), 128))
      .rejects.toMatchObject({ code: "INVALID_FORM_DATA", status: 400 });
  });

  it("parses valid multipart form data inside the byte budget", async () => {
    const form = new FormData();
    form.append("file", new Blob(["reviewText\nGreat bottle"]), "voice.csv");
    const request = new Request("http://local.test", { method: "POST", body: form });
    const parsed = await boundedFormData(request, 1024);
    expect(parsed.get("file")).toBeInstanceOf(File);
  });
});
