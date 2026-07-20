import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./globals.css";

if (window.location.pathname === "/") {
  window.location.replace("/playground");
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
