import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockVerifyCronBearer, mockCleanupOrphanedMedia } = vi.hoisted(() => ({
  mockVerifyCronBearer: vi.fn(),
  mockCleanupOrphanedMedia: vi.fn(),
}));

vi.mock("@/lib/api/cron-auth", () => ({
  verifyCronBearer: mockVerifyCronBearer,
}));

vi.mock("@/lib/storage/media-gc", () => ({
  cleanupOrphanedMedia: mockCleanupOrphanedMedia,
}));

import { POST } from "./route";

function request(query = ""): NextRequest {
  return new NextRequest(`https://app.example.com/api/cron/media-gc${query}`, {
    method: "POST",
    headers: { Authorization: "Bearer secret" },
  });
}

describe("POST /api/cron/media-gc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "secret";
    mockVerifyCronBearer.mockReturnValue(true);
    mockCleanupOrphanedMedia.mockResolvedValue({ deleted: 0, retained: 0 });
  });

  it("passes an exact dry-run flag to garbage collection", async () => {
    const response = await POST(request("?dryRun=1"));

    expect(response.status).toBe(200);
    expect(mockCleanupOrphanedMedia).toHaveBeenCalledWith({ dryRun: true });
  });

  it("rejects invalid or unknown query parameters", async () => {
    const invalidValue = await POST(request("?dryRun=yes"));
    const unknownParameter = await POST(request("?unexpected=1"));

    expect(invalidValue.status).toBe(400);
    expect(unknownParameter.status).toBe(400);
    expect(mockCleanupOrphanedMedia).not.toHaveBeenCalled();
  });
});
