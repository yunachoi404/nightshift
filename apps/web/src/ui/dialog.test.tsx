/**
 * Every dialog: focus moves in on open (a marked field, else the first field, else the main action), Tab stays
 * inside, Escape asks the owner, and focus goes back to whatever opened it.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import { Button, Dialog, Input } from "./primitives";

// jsdom has no modal dialogs.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new window.Event("close"));
  };
});

function Harness({ busy = false, withField = true }: { busy?: boolean; withField?: boolean }) {
  const [open, setOpen] = useState(false);
  const [closes, setCloses] = useState(0);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Rename</Button>
      <output aria-label="closes">{closes}</output>
      <Dialog
        open={open}
        onClose={() => {
          setCloses((n) => n + 1);
          if (!busy) setOpen(false);
        }}
      >
        <h2 className="dialog__title">Rename the board</h2>
        <p className="dialog__text">A short name reads best on the canvas.</p>
        {withField && <Input aria-label="Name" defaultValue="Board 1" />}
        <div className="dialog__actions">
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary">Rename board</Button>
        </div>
      </Dialog>
    </>
  );
}

const dialog = () => document.querySelector("dialog")!;

describe("Dialog", () => {
  it("focuses the first field, keeps Tab inside, and returns focus to the opener on Escape", () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Rename" });
    opener.focus();
    fireEvent.click(opener);

    expect(dialog().open).toBe(true);
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
    expect(dialog().getAttribute("aria-labelledby")).toBe(screen.getByText("Rename the board").id);
    expect(dialog().getAttribute("aria-describedby")).toBe(screen.getByText("A short name reads best on the canvas.").id);

    // Tab from the last control wraps to the first; Shift+Tab from the first wraps to the last.
    const main = screen.getByRole("button", { name: "Rename board" });
    main.focus();
    fireEvent.keyDown(main, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(main);

    fireEvent.keyDown(main, { key: "Escape" });
    expect(dialog().open).toBe(false);
    expect(document.activeElement).toBe(opener);
    expect(screen.getByLabelText("closes").textContent).toBe("1");
  });

  it("without a field, focuses the main action", () => {
    render(<Harness withField={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Rename board" }));
  });

  it("stays open when its owner declines to close", () => {
    render(<Harness busy />);
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Escape" });
    expect(screen.getByLabelText("closes").textContent).toBe("1");
    expect(dialog().open).toBe(true);
    expect(screen.getByLabelText("Name")).toBeTruthy();
  });

  it("closes on a click on the dimmed window, not on a drag that ends there", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    // A press inside the field, released over the backdrop.
    fireEvent.pointerDown(screen.getByLabelText("Name"));
    fireEvent.click(dialog());
    expect(dialog().open).toBe(true);

    fireEvent.pointerDown(dialog());
    fireEvent.click(dialog());
    expect(dialog().open).toBe(false);
  });
});
