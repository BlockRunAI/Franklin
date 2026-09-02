import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library only auto-registers cleanup when vitest runs with
// `globals: true`. This suite imports its helpers explicitly, so unmount has to
// be wired up here — without it each render leaves its DOM behind and the next
// test's queries match several sidebars at once.
afterEach(cleanup);
