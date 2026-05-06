// React entry point.
// Keep application bootstrapping here so App.jsx can focus on UI state and flows.
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "../style.css";

createRoot(document.getElementById("root")).render(<App />);
