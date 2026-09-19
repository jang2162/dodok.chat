import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { App } from "./App";

it("앱 셸이 뜬다", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: "dodok" })).toBeInTheDocument();
});
