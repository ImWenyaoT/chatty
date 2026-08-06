import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./globals.css";
import App from "./App.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("Chatty cannot start: #root is missing");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
