import { describe, expect, it, vi } from "vitest";
import { pushWithDraftGuard } from "./navigationGuard";
describe("shell navigation guard", () => {
  it("does not change route when a draft view cancels", () => {
    const prevent = (e: Event) => e.preventDefault();
    window.addEventListener("mike:before-navigation", prevent);
    const router = { push: vi.fn() };
    try {
      expect(pushWithDraftGuard(router, "/projects")).toBe(false);
      expect(router.push).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("mike:before-navigation", prevent);
    }
    expect(pushWithDraftGuard(router, "/projects")).toBe(true);
    expect(router.push).toHaveBeenCalledWith("/projects");
  });
});
