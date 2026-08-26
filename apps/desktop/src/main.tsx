import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/poppins/400.css"; // empty-title (regular)
import "@fontsource/poppins/400-italic.css"; // italic emphasis in the empty-title
import "@fontsource/poppins/600.css"; // wordmark
import App from "./App";
import "./styles/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
