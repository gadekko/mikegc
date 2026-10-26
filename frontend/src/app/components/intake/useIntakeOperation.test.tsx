import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useIntakeDraftWarning,
  useIntakeOperation,
} from "./useIntakeOperation";

vi.mock("@/app/lib/userFacingError", () => ({
  notifyError: vi.fn(),
  describeError: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());
const receipt = {
  request_id: "request-a",
  applied_version: 2,
  message_id: null,
  replayed: false,
};

describe("intake operation lifecycle", () => {
  it("retains the original operation after a lost response followed by denied access", async () => {
    const saved = vi.fn();
    const rejected = vi.fn();
    const command = vi
      .fn()
      .mockRejectedValueOnce(new Error("lost response"))
      .mockRejectedValueOnce({ status: 403 })
      .mockResolvedValue(receipt);
    const { result } = renderHook(() => useIntakeOperation(saved, rejected));
    await act(async () => result.current.execute(command));
    expect(rejected).toHaveBeenCalledExactlyOnceWith({ status: 403 });
    expect(result.current.uncertain).toBe(true);
    const other = vi.fn();
    await act(async () => result.current.execute(other));
    expect(other).not.toHaveBeenCalled();
    await act(async () => result.current.execute());
    expect(command).toHaveBeenCalledTimes(3);
    expect(saved).toHaveBeenCalledExactlyOnceWith(receipt);
    expect(result.current.locked).toBe(false);
  });

  it("releases a definitively rejected command after uncertainty and permits a new command", async () => {
    const rejected = vi.fn();
    const command = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce({ status: 409 });
    const { result } = renderHook(() => useIntakeOperation(vi.fn(), rejected));
    await act(async () => result.current.execute(command));
    expect(result.current.locked).toBe(false);
    const retry = vi.fn().mockResolvedValue(receipt);
    await act(async () => result.current.execute(retry));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledTimes(2);
  });

  it("does not retry or report results after unmount", async () => {
    let reject!: (error: unknown) => void;
    const pending = new Promise<never>((_, no) => {
      reject = no;
    });
    const command = vi.fn().mockReturnValue(pending);
    const saved = vi.fn();
    const rejected = vi.fn();
    const { result, unmount } = renderHook(() =>
      useIntakeOperation(saved, rejected),
    );
    let execution!: Promise<void>;
    act(() => {
      execution = result.current.execute(command);
    });
    unmount();
    await act(async () => {
      reject(new Error("offline"));
      await execution;
    });
    expect(command).toHaveBeenCalledTimes(1);
    expect(saved).not.toHaveBeenCalled();
    expect(rejected).not.toHaveBeenCalled();
  });
});

function Draft({ dirty = true }: { dirty?: boolean }) {
  useIntakeDraftWarning(dirty);
  return (
    <>
      <a href="/another-page">Another page</a>
      <a href="/another-page" target="_blank">
        New tab
      </a>
    </>
  );
}

describe("unsent draft navigation", () => {
  it("cancels internal link navigation when discard is declined", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Draft />);
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    fireEvent(screen.getByRole("link", { name: "Another page" }), event);
    expect(event.defaultPrevented).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("cancels workspace changes and removes the guard after the draft is clean", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const view = render(<Draft />);
    const event = new Event("mike:before-workspace-change", {
      cancelable: true,
    });
    expect(window.dispatchEvent(event)).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    view.rerender(<Draft dirty={false} />);
    expect(
      window.dispatchEvent(
        new Event("mike:before-workspace-change", { cancelable: true }),
      ),
    ).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("allows a confirmed workspace departure and unregisters on unmount", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const view = render(<Draft />);
    expect(
      window.dispatchEvent(
        new Event("mike:before-workspace-change", { cancelable: true }),
      ),
    ).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(
      window.dispatchEvent(
        new Event("mike:before-workspace-change", { cancelable: true }),
      ),
    ).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("warns before unloading the document", () => {
    render(<Draft />);
    const event = new Event("beforeunload", { cancelable: true });
    expect(window.dispatchEvent(event)).toBe(false);
  });
});
